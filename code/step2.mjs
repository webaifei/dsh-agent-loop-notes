/**
 * Step 2 — 让 step 出现。
 *
 * 场景：用户问"这个项目用什么测试框架？"，模型信息不够，
 * 得先调工具查一下，拿着结果再回答。所以一轮对话里会有好几次模型请求。
 * turn() 管一轮，step() 管这一轮里的其中一次请求。
 *
 * 相对 Step 1 只加了三样：
 *   1. turn() 里多了个内层 while
 *   2. 新增 step() 函数
 *   3. step() 的返回值决定内层循环走不走
 *
 * 运行：node mini-loop/step2.mjs
 */

let remaining = 2
let turnCount = 0
let modelCalls = 0 // 假模型被调用了几次，用来决定什么时候收尾

/**
 * 一次模型请求。
 *
 * 返回值是这一层最重要的东西：
 *   null         → 还欠一次请求，同一个 turn 开下一个 step
 *   'completed'  → 这个 turn 可以收尾了
 */
async function step(turn, stepNo) {
  modelCalls += 1
  console.log(`  step/start {turn:${turn}, step:${stepNo}}`)

  // 假模型：每 3 次调用里有 2 次要求继续，第 3 次收尾
  const done = modelCalls % 3 === 0
  console.log(`  step/end  → 模型返回 ${done ? "'completed'" : 'null（还欠一次请求）'}`)

  return done ? 'completed' : null
}

async function turn() {
  if (remaining <= 0) return false

  remaining -= 1
  turnCount += 1
  console.log(`turn/start {turn:${turnCount}}`)

  let stepNo = 0
  let turnEnds = null // 由 step() 的返回值决定

  while (true) {
    stepNo += 1
    const decision = await step(turnCount, stepNo)
    if (turnEnds === null) turnEnds = decision
    if (turnEnds) break
  }

  console.log('turn/end')
  return true
}

async function kick() {
  while (await turn()) {
    /* 还有工作 → 再开一个 turn */
  }
  console.log('· 驱动器归位 idle')
}

await kick()
