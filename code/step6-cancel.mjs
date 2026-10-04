/**
 * Step 6 — 取消。
 *
 * 场景：模型正在吐字，用户点了"停止"。
 * 关键不是"停下来"——而是停下来之后，已经吐出去的那半截怎么办。
 * 用户已经在屏幕上看到了，如果日志里没有，重放时内容就会凭空消失。
 *
 * 对照真实代码：
 *   cancel() 的实现        packages/core/agent-loop/src/agent.ts:175-181
 *   每块之前检查取消        packages/core/agent-loop/src/agent.ts:440-443
 *   已交付内容保留          packages/core/agent-loop/src/agent.ts:448-471
 *   轮次以 aborted 收尾      packages/core/agent-loop/src/agent.ts:366-371
 *
 * 运行：node mini-loop/step6-cancel.mjs
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

/** 慢慢吐字的假模型。连接被掐断时直接 return，模拟流结束。 */
async function* slowModelStream(signal) {
  say(4, 'attempt #1 发出请求')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (const text of ['这个', '项目', '用的是', ' node:test']) {
    await sleep(70)
    if (signal.aborted) return
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
  /** 取消时能保留下来的部分：用户已经看到的那截文本。 */
  interruptedBlocks() {
    return this.blocks.length > 0
      ? this.blocks.map((block) => block.text)
      : this.buffer.length > 0
        ? [this.buffer]
        : []
  }
}

class Agent {
  constructor(label) {
    this.label = label
    this.phase = 'idle'
    this.turnCount = 0
    this.log = []
    this.controller = new AbortController()
  }

  append(type, data = {}) {
    const seq = this.log.length + 1
    this.log.push({ seq, type, data })
    return seq
  }

  /** 模型历史只投影 user/message 和 assistant/message。 */
  deriveMessages() {
    const out = []
    for (const event of this.log) {
      if (event.type === 'user/message') out.push(`user: ${event.data.text}`)
      if (event.type === 'assistant/message') {
        out.push(`assistant: ${event.data.text}${event.data.interrupted ? '  (被中断)' : ''}`)
      }
    }
    return out
  }

  onFrame(frame) {
    if (frame.type === 'chunk' && frame.chunk.text) say(4, `⚡ ③ text-delta "${frame.chunk.text}"`)
  }

  followup(text) {
    this.pending = text
    if (this.phase === 'idle') this.driver = this.kick()
  }

  /** 用户点"停止"。真实代码默认还会清空待处理队列（agent.ts:176-179）。 */
  cancel(cause = { kind: 'user' }) {
    say(3, '[用户点了停止]')
    this.controller.abort(cause)
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
    this.append('user/message', { text: this.pending })

    const signal = this.controller.signal
    let turnEnds = 'completed'
    say(2, `step/start {turn:${this.turnCount}, step:1}`)
    try {
      await this.step(signal)
    } catch (error) {
      turnEnds = signal.aborted ? 'aborted' : 'error'
      if (signal.aborted) say(3, `取消原因: ${JSON.stringify(signal.reason)}`)
      else say(3, `出错: ${error.message}`)
    }
    say(2, 'step/end')
    say(1, `turn/end {reason:'${turnEnds}'}`)
  }

  async step(signal) {
    const live = new Attempt((frame) => this.onFrame(frame))
    live.start()

    try {
      for await (const chunk of slowModelStream(signal)) {
        // 每一块之前检查取消——这是取消唯一的生效点
        if (signal.aborted) throw signal.reason
        live.push(chunk)
      }
      if (signal.aborted) throw signal.reason
    } catch (error) {
      if (signal.aborted) {
        const content = live.interruptedBlocks()
        if (content.length > 0) {
          // 用户已经看到了 → 必须记进日志，否则重放时内容会消失
          this.append('assistant/message', { text: content.join(''), interrupted: true })
          say(3, `⚡ 保留已交付的 "${content.join('')}"（interrupted: true）`)
        } else {
          // 什么都没交付 → 只留一条仅日志的 attempt，不进模型历史
          this.append('assistant/attempt', { note: '未交付任何内容' })
          say(3, '⚡ 没有任何内容交付 → 只记 assistant/attempt（不进模型历史）')
        }
      }
      throw error
    }

    live.settle('assistant/message', () => this.append('assistant/message', { text: live.buffer }))
  }
}

function report(agent) {
  say(0, '')
  say(0, '日志：')
  for (const event of agent.log) {
    const extra = event.data.interrupted ? ' (interrupted)' : ''
    say(0, `  seq=${event.seq}  ${event.type}${extra}`)
  }
  say(0, '模型历史（下一轮会看到的内容）：')
  for (const line of agent.deriveMessages()) say(0, `  ${line}`)
}

// ── 场景 1：吐字途中点停止 → 已交付内容保留 ──────────────────────────
say(0, '【场景 1 · 模型吐到一半，用户点停止】')
{
  const agent = new Agent('a')
  agent.followup('这个项目用什么测试框架？')
  await sleep(180) // 等它吐出一两片
  agent.cancel()
  await agent.driver
  report(agent)
}

say(0, '')

// ── 场景 2：还没吐字就停止 → 什么都不留 ──────────────────────────────
say(0, '【场景 2 · 还没吐字就点停止】')
{
  const agent = new Agent('b')
  agent.followup('这个项目用什么测试框架？')
  agent.cancel() // 立刻取消
  await agent.driver
  report(agent)
}
