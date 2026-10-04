/**
 * Step 4 — 把假的「模型调用」换成真的流。
 *
 * 相对 step3c 只改了两处：
 *   1. 新增 mockModelStream()：一块一块吐响应的 async generator
 *   2. 新增 Attempt：每收到一块，同时喂给三条不同的路
 *   循环骨架（kick / turn / 队列）一行没动。
 *
 * 对照真实代码：
 *   chunk 的七种形态   packages/llm/llm/src/types.ts:452
 *   Attempt 三条路      packages/core/agent-loop/src/assistant-stream.ts:60
 *   消费流的 for await  packages/core/agent-loop/src/agent.ts:440-443
 *
 * 运行：node mini-loop/step4-stream.mjs
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

/**
 * 假模型。真实系统里这是一路 HTTP SSE（adapter.ts:120），
 * 但吐出来的就是下面几种 chunk。注意 delta 是【片段】，不是一个完整字符串。
 */
async function* mockModelStream(request) {
  say(3, `发给模型: ${request.messages.map((m) => m.content).join(' / ')}`)

  yield { type: 'block-start', index: 0, blockType: 'text' }

  const pieces = ['这个', '项目', '用的是', ' node:test']
  for (const text of pieces) {
    await sleep(60) // 模拟网络分片到达
    yield { type: 'text-delta', index: 0, text }
  }

  yield { type: 'block-end', index: 0, block: { type: 'text', text: pieces.join('') } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * 一次模型尝试。每收到一块，喂给三条路：
 *   ① 录制 —— 带时间戳存起来，永久保留，可回放
 *   ② 折叠 —— 拼成最终的完整消息内容
 *   ③ 实时帧 —— 只给界面看，不落盘
 * 三条路的需求不一样，所以必须分开走。
 */
class Attempt {
  constructor(emit) {
    this.emit = emit
    this.record = [] // ①
    this.blocks = [] // ②
    this.buffer = ''
    this.finish = undefined
  }

  start() {
    this.emit({ type: 'start' })
  }

  push(chunk) {
    this.record.push({ time: Date.now(), chunk }) // ①
    if (chunk.type === 'text-delta') this.buffer += chunk.text
    if (chunk.type === 'block-end') this.blocks.push(chunk.block) // ②
    if (chunk.type === 'finish') this.finish = chunk.reason
    this.emit({ type: 'chunk', chunk }) // ③
  }

  /** 真实签名：先写持久事件拿到 seq，再发终帧（assistant-stream.ts:78）。 */
  settle(eventType, append) {
    const seq = append()
    this.emit({ type: 'end', eventType, seq })
  }
}

class Inbox {
  constructor() {
    this.nextTurn = []
    this.nextStep = []
  }
  get hasPending() {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }
  add(target, message) {
    ;(target === 'next-turn' ? this.nextTurn : this.nextStep).push(message)
  }
  claim(target) {
    const stepInput = this.nextStep.splice(0, this.nextStep.length)
    if (target !== 'next-turn') return stepInput
    return [...this.nextTurn.splice(0, 1), ...stepInput]
  }
}

class Agent {
  constructor() {
    this.inbox = new Inbox()
    this.phase = 'idle'
    this.turnCount = 0
    this.log = [] // 会话日志：一切先记下来，模型历史再从日志投影
  }

  append(type, data = {}) {
    const seq = this.log.length + 1
    this.log.push({ seq, type, data })
    return seq
  }

  /** 模型历史来自日志投影，不是内存里的数组。 */
  deriveMessages() {
    return this.log
      .filter((event) => event.type === 'user/message')
      .map((event) => ({ role: 'user', content: event.data.text }))
  }

  followup(text) {
    this.inbox.add('next-turn', text)
    if (this.phase === 'idle') this.driver = this.kick()
  }

  /** 界面上的实时帧。真实系统里它走 agent/assistant-stream，永远不进日志。 */
  onFrame(frame) {
    if (frame.type === 'start') return say(4, '⚡ ③ 实时帧 start')
    if (frame.type === 'end') return say(4, `⚡ ③ 实时帧 end (${frame.eventType}, seq=${frame.seq})`)
    const { chunk } = frame
    say(4, `⚡ ③ 实时帧 ${chunk.type}${chunk.text ? ` "${chunk.text}"` : ''}`)
  }

  async kick() {
    this.phase = 'running'
    try {
      while (await this.turn()) {
        /* 还有排队输入 → 再开一轮 */
      }
    } finally {
      this.phase = 'idle'
    }
  }

  async turn() {
    if (!this.inbox.hasPending) return false
    this.turnCount += 1
    say(1, `turn/start {turn:${this.turnCount}}`)

    let turnEnds = null
    let target = 'next-turn'
    let stepNo = 0

    while (true) {
      stepNo += 1
      const messages = this.inbox.claim(target)
      for (const message of messages) this.append('user/message', { text: message })
      say(2, `step/start {turn:${this.turnCount}, step:${stepNo}}`)

      const decision = await this.step()
      say(2, 'step/end')
      if (turnEnds === null) turnEnds = decision

      if (turnEnds && this.inbox.nextStep.length === 0) break
      target = 'next-step'
    }
    say(1, 'turn/end')
    return this.inbox.hasPending
  }

  /** ← 只有这里变了：从「一行 console.log」变成真的消费一个流。 */
  async step() {
    const request = { messages: this.deriveMessages() }

    const live = new Attempt((frame) => this.onFrame(frame))
    // 先发 start 帧再开流：所以下面 mockModelStream 里那句"发给模型"
    // 会出现在 ③ start 之后——generator 是惰性的，第一次 next() 才真正开始执行。
    live.start()

    for await (const chunk of mockModelStream(request)) {
      live.push(chunk) // ← 一块一块地处理
    }

    live.settle('assistant/message', () =>
      this.append('assistant/message', { text: live.buffer }),
    )

    say(3, `② 折叠成完整消息: "${live.buffer}"`)
    say(3, `① 录像 ${live.record.length} 片（永久，可回放）· finish=${live.finish.kind}`)
    return 'completed'
  }
}

say(0, '【一次流式请求】')
const agent = new Agent()
agent.followup('这个项目用什么测试框架？')
await agent.driver
say(0, '')
say(0, '日志里存了什么：')
for (const event of agent.log) say(0, `  seq=${event.seq}  ${event.type}`)
