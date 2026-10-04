/**
 * Step 3 — 把「要不要继续」的决定权交给真实的输入队列。
 *
 * 场景：用户问"这个项目用什么测试框架？"
 * 模型信息不够，得先查一下 → 查完再回答。
 * 所以这一轮对话里出现了两次模型请求，这就是 step 存在的理由。
 *
 * 运行：node mini-loop/step3.mjs
 */

/**
 * 用户可能连发多条消息，也随时可能在模型干活时插话。
 * 两种输入要分开排队：
 *   next-turn —— 还没开始处理的新消息，一条开一个轮次
 *   next-step —— 当前轮次下一步要用到的东西（工具结果、运行时上下文）
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

  /**
   * 取一条输入。
   * 轮次边界只取一条新消息——剩下的留给下一个轮次，
   * 否则用户连发三条，模型会一次全看到，就分不清哪条对应哪次回复了。
   */
  claim(target) {
    const stepInput = this.nextStep.splice(0, this.nextStep.length)
    if (target !== 'next-turn') return stepInput
    return [...this.nextTurn.splice(0, 1), ...stepInput]
  }
}

const inbox = new Inbox()
let turnCount = 0
let modelCalls = 0

function deliver(text) {
  inbox.add('next-turn', text)
}

function preStep(target) {
  const messages = inbox.claim(target)
  console.log(`  pre-step claim(${target}) → ${messages.length} 条输入`)
  return messages
}

/**
 * 问模型一次。
 * 模型可能说"我还要查个工具"，那这一轮就不能结束，得带着工具结果再问一次。
 * 所以 null 表示"还欠一次请求"，而不是失败。
 */
function step(turn, stepNo, messages) {
  modelCalls += 1
  console.log(`  step/start {turn:${turn}, step:${stepNo}}`)
  console.log(`    输入: ${messages.join(' | ')}`)

  if (messages.some((message) => message.startsWith('工具结果'))) {
    console.log(`    模型调用 #${modelCalls} → 信息够了，给最终答案`)
    console.log('  step/end')
    return 'completed'
  }

  console.log(`    模型调用 #${modelCalls} → 要查资料，先调工具`)
  inbox.add('next-step', '工具结果：测试框架 = node:test + vitest')
  console.log('  step/end')
  return null
}

async function turn() {
  if (!inbox.hasPending) return false

  turnCount += 1
  console.log(`turn/start {turn:${turnCount}}`)

  let turnEnds = null
  let target = 'next-turn' // 轮次的第一步在轮次边界取输入
  let stepNo = 0

  while (true) {
    stepNo += 1
    const messages = preStep(target)
    const decision = step(turnCount, stepNo, messages)
    if (turnEnds === null) turnEnds = decision

    // 两个条件都满足才关轮次：① 模型说可以收尾 ② 没有下一步要用的输入了
    if (turnEnds && inbox.nextStep.length === 0) break
    target = 'next-step'
  }

  console.log('turn/end')
  return inbox.hasPending
}

async function kick() {
  while (await turn()) {
    /* 用户还排着别的消息 → 再开一个轮次 */
  }
  console.log('· 驱动器归位 idle')
}

deliver('这个项目用什么测试框架？')
await kick()
