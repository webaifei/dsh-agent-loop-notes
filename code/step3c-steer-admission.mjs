/**
 * Step 3c — 插话的准入校验。
 *
 * 场景：用户想在模型干活时插一句"只看 packages/core 下的"。
 * 但如果 agent 根本没在干活，这句话就没有地方可插——
 * 没有正在跑的轮次，也就没有"当前轮次的下一个 step"。
 *
 * 所以真实系统里 steer 有准入校验，inject 没有。
 *   packages/api/session-controller/src/commands.ts:477   steer 的校验
 *   packages/core/agent-loop/src/agent.ts:167-173         三个入口的实现
 *
 * 运行：node mini-loop/step3c-steer-admission.mjs
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

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
  constructor(label) {
    this.label = label
    this.inbox = new Inbox()
    this.phase = 'idle' // ← 校验就看这个
    this.turnCount = 0
  }

  get status() {
    return this.phase
  }

  /** 新消息：进 next-turn，空闲时唤醒驱动器。 */
  followup(text) {
    this.inbox.add('next-turn', text)
    if (this.phase === 'idle') this.driver = this.kick()
  }

  /**
   * 插话：进 next-step。
   * 准入校验在这里——没有正在跑的轮次，就没有下一步可插。
   */
  steer(text) {
    if (this.phase !== 'running') {
      throw new Error('session/steer-unavailable: current turn no longer accepts steering')
    }
    this.inbox.add('next-step', text)
  }

  /** 后台注入：进 next-step，不唤醒，也不校验——它只是排队等人来取。 */
  inject(text) {
    this.inbox.add('next-step', text)
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
      say(2, `pre-step claim(${target}) → ${messages.length} 条输入`)
      say(2, `step/start {turn:${this.turnCount}, step:${stepNo}}`)
      for (const message of messages) say(3, `输入: ${message}`)

      const decision = await this.step(stepNo)
      say(2, 'step/end')
      if (turnEnds === null) turnEnds = decision

      if (turnEnds && this.inbox.nextStep.length === 0) break
      target = 'next-step'
    }
    say(1, 'turn/end')
    return this.inbox.hasPending
  }

  /** 用 sleep 制造一个"模型正在干活"的时间窗口，好让外部插话。 */
  async step(stepNo) {
    await sleep(60)
    if (stepNo === 1) {
      say(3, '模型调用 → 要调工具')
      this.inbox.add('next-step', '工具结果：测试文件共 12 个')
      return null
    }
    say(3, '模型调用 → 给最终答案')
    return 'completed'
  }
}

// ── 场景 1：运行中插话 → 接受 ─────────────────────────────────────────
say(0, '【场景 1 · 模型干活时插话】')
{
  const agent = new Agent('a')
  agent.followup('帮我看下测试')
  await sleep(20) // 让它先跑起来
  say(1, `此刻 status = ${agent.status}`)
  agent.steer('只看 packages/core 下的')
  say(1, '✅ steer 被接受 → 落进 next-step')
  await agent.driver
}
say(0, '')

// ── 场景 2：空闲时插话 → 拒绝 ─────────────────────────────────────────
say(0, '【场景 2 · 空闲时插话】')
{
  const agent = new Agent('b')
  say(1, `此刻 status = ${agent.status}`)
  try {
    agent.steer('插一句话')
    say(1, '（不该到这里）')
  } catch (error) {
    say(1, `❌ 被拒绝：${error.message}`)
  }
  say(1, '')
  say(1, '对比 inject：它没有准入校验，只是放进队列不唤醒')
  agent.inject('后台上下文：当前工作区是 deepseek-harness')
  say(1, `→ next-step 队列里现在有 ${agent.inbox.nextStep.length} 条，但驱动器没被唤醒`)
  say(1, `→ 直到有人 followup，它才会被一起取走`)
  agent.followup('继续')
  await agent.driver
}
