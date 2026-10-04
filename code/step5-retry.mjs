/**
 * Step 5 — 第三层循环：请求重试（attempt）。
 *
 * 相对 step4 只改了 step()：里面多了一个 while。
 * 这层只干一件事——请求失败时重发。它和 step 的区别是关键：
 *   重试不重跑组装、不重复追加用户消息、不新开 step。
 *
 * 对照真实代码：
 *   attempt 循环        packages/core/agent-loop/src/agent.ts:407
 *   失败后问监听器        packages/core/agent-loop/src/agent.ts:494-509
 *   错误变成终结 chunk   packages/llm/llm/src/index.ts:1146
 *
 * 运行：node mini-loop/step5-retry.mjs
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

/**
 * 会失败的假模型。
 * 注意它失败时不是抛异常，而是吐一个 finish chunk——
 * 真实系统的 adapter 边界就是这么做的（llm/index.ts:1146），
 * 这样上层不用区分"流里的错误"和"网络异常"。
 */
async function* flakyModelStream(request, attemptNo, alwaysFail) {
  say(4, `attempt #${attemptNo} 发出请求: ${request.messages.map((m) => m.content).join(' / ')}`)
  yield { type: 'block-start', index: 0, blockType: 'text' }

  if (attemptNo === 1 || alwaysFail) {
    yield { type: 'text-delta', index: 0, text: '这个' }
    await sleep(30)
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '连接中断', code: 'TRANSPORT' } } }
    return
  }

  for (const text of ['这个', '项目', '用的是', ' node:test']) {
    await sleep(40)
    yield { type: 'text-delta', index: 0, text }
  }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '这个项目用的是 node:test' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class Attempt {
  constructor(emit) {
    this.emit = emit
    this.record = []
    this.blocks = []
    this.buffer = ''
    this.finish = undefined
  }
  start() {
    this.emit({ type: 'start' })
  }
  push(chunk) {
    this.record.push({ time: Date.now(), chunk })
    if (chunk.type === 'text-delta') this.buffer += chunk.text
    if (chunk.type === 'block-end') this.blocks.push(chunk.block)
    if (chunk.type === 'finish') this.finish = chunk.reason
    this.emit({ type: 'chunk', chunk })
  }
  settle(eventType, append) {
    const seq = append()
    this.emit({ type: 'end', eventType, seq })
  }
}

class Agent {
  constructor(label, { onRequestError = null, alwaysFail = false } = {}) {
    this.label = label
    this.onRequestError = onRequestError // 监听器：返回 { kind:'retry' } 才会重试
    this.alwaysFail = alwaysFail
    this.phase = 'idle'
    this.turnCount = 0
    this.log = []
  }

  append(type, data = {}) {
    const seq = this.log.length + 1
    this.log.push({ seq, type, data })
    return seq
  }

  deriveMessages() {
    return this.log
      .filter((event) => event.type === 'user/message')
      .map((event) => ({ role: 'user', content: event.data.text }))
  }

  onFrame(frame) {
    if (frame.type === 'end') return say(4, `⚡ ③ end (${frame.eventType}, seq=${frame.seq})`)
    if (frame.type === 'chunk' && frame.chunk.text) say(4, `⚡ ③ text-delta "${frame.chunk.text}"`)
  }

  followup(text) {
    this.log.length // 保持接口一致
    this.pending = text
    if (this.phase === 'idle') this.driver = this.kick()
  }

  async kick() {
    this.phase = 'running'
    try {
      await this.turn()
    } finally {
      this.phase = 'idle'
    }
  }

  async turn() {
    this.turnCount += 1
    say(1, `turn/start {turn:${this.turnCount}}`)

    // 用户消息只追加这一次——重试不会重复追加
    this.append('user/message', { text: this.pending })

    let turnEnds = 'completed'
    say(2, `step/start {turn:${this.turnCount}, step:1}`)
    try {
      await this.step()
    } catch (error) {
      turnEnds = 'error'
      say(2, `这一轮以 error 结束：${error.message}`)
    }
    say(2, 'step/end')
    say(1, `turn/end {reason:'${turnEnds}'}`)
  }

  /** ← 相对 step4 只有这里变了：外面多了一层 attempt 循环。 */
  async step() {
    // 组装只做一次。重试复用它——这是"重试不是新 step"的关键。
    const request = { messages: this.deriveMessages() }

    let attemptNo = 0
    while (true) {
      attemptNo += 1
      const live = new Attempt((frame) => this.onFrame(frame))
      live.start()
      for await (const chunk of flakyModelStream(request, attemptNo, this.alwaysFail)) {
        live.push(chunk)
      }

      // 流以 error/aborted 收尾 → 问监听器要不要重试
      if (live.finish.kind === 'error' || live.finish.kind === 'aborted') {
        say(3, `attempt #${attemptNo} 失败：${live.finish.failure.message}（${live.finish.failure.code}）`)
        const action = this.onRequestError?.(live.finish.failure)
        if (action?.kind !== 'retry') {
          throw new Error(`请求失败且无人重试：${live.finish.failure.message}`)
        }
        say(3, `监听器返回 retry → 复用同一份组装，再发一次`)
        continue // ← 回到 attempt 循环顶部，stepNo 不变、用户消息不重复
      }

      live.settle('assistant/message', () => this.append('assistant/message', { text: live.buffer }))
      say(3, `② 折叠成完整消息: "${live.buffer}"`)
      say(3, `① 录像 ${live.record.length} 片 · 共 ${attemptNo} 次 attempt`)
      return
    }
  }
}

// ── 场景 1：第一次失败，重试成功 ─────────────────────────────────────
say(0, '【场景 1 · 第一次请求失败，重试后成功】')
{
  const agent = new Agent('a', { onRequestError: () => ({ kind: 'retry' }) })
  agent.followup('这个项目用什么测试框架？')
  await agent.driver

  say(0, '')
  say(0, '日志里存了什么（注意 user/message 只有一条）：')
  for (const event of agent.log) say(0, `  seq=${event.seq}  ${event.type}`)
}

say(0, '')

// ── 场景 2：没人接管失败，这一轮以 error 结束 ────────────────────────
say(0, '【场景 2 · 失败且无人重试】')
{
  const agent = new Agent('b', { alwaysFail: true })
  agent.followup('这个项目用什么测试框架？')
  await agent.driver
}
