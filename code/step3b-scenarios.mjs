/**
 * Step 3b — 两个真实场景：什么时候会多出一个 turn，什么时候不会。
 *
 * 场景 1：用户连发两条消息
 *   模型处理第一条时，用户又发了第二条。第二条排在 next-turn 里，
 *   等第一轮结束、kick 再转一圈才轮到它 → 两个 turn。
 *
 * 场景 2：模型调工具期间用户插话
 *   用户补了一句"只看 packages/core 下的"。这走 steer，进 next-step，
 *   在同一个 turn 的下一个 step 生效 → 还是一个 turn。
 *
 * 运行：node mini-loop/step3b-scenarios.mjs
 */

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

/**
 * @param label - 打印用
 * @param onWorking - 模拟"模型正在干活时发生的事"，用来观察插话落在哪一层
 */
function makeAgent(label, onWorking) {
  const inbox = new Inbox()
  let turnCount = 0
  let modelCalls = 0

  /** 新消息 → 开一个新轮次。真实系统叫 followup。 */
  const followup = (text) => inbox.add('next-turn', text)
  /** 插话 → 进当前轮次的下一个 step，不新开轮次。真实系统叫 steer。 */
  const steer = (text) => inbox.add('next-step', text)

  async function step(stepNo) {
    modelCalls += 1
    if (stepNo === 1) {
      onWorking?.(steer) // 模型调工具期间，用户插话
      console.log(`      模型调用 #${modelCalls} → 要调工具`)
      inbox.add('next-step', '工具结果：测试文件共 12 个')
      return null
    }
    console.log(`      模型调用 #${modelCalls} → 给最终答案`)
    return 'completed'
  }

  async function turn() {
    if (!inbox.hasPending) return false
    turnCount += 1
    console.log(`  turn/start {turn:${turnCount}}`)

    let turnEnds = null
    let target = 'next-turn'
    let stepNo = 0

    while (true) {
      stepNo += 1
      const messages = inbox.claim(target)
      console.log(`    pre-step claim(${target}) → ${messages.length} 条输入`)
      console.log(`    step/start {turn:${turnCount}, step:${stepNo}}`)
      for (const message of messages) console.log(`      输入: ${message}`)

      const decision = await step(stepNo)
      console.log('    step/end')
      if (turnEnds === null) turnEnds = decision

      if (turnEnds && inbox.nextStep.length === 0) break
      target = 'next-step'
    }
    console.log('  turn/end')
    return inbox.hasPending
  }

  async function kick() {
    while (await turn()) {
      /* 还有排队输入 → 再开一轮 */
    }
    console.log('· 驱动器归位 idle')
    console.log('')
  }

  return { followup, steer, kick }
}

// ── 场景 1：连发两条 → 两个 turn ──────────────────────────────────────
console.log('【场景 1 · 用户连发两条】')
const a = makeAgent('a')
a.followup('这个项目用什么测试框架？')
a.followup('顺便看看 CI 怎么配的')
await a.kick()

// ── 场景 2：模型干活途中插话 → 还是一个 turn ──────────────────────────
console.log('【场景 2 · 模型调工具期间用户插话】')
const b = makeAgent('b', (steer) => {
  console.log('      [用户] 只看 packages/core 下的 → 落进 next-step')
  steer('用户插话：只看 packages/core 下的')
})
b.followup('帮我看下测试')
await b.kick()
