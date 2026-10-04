/**
 * Step 1 — 最外层循环。
 *
 * 场景：用户在界面上发了一条消息，系统要把它处理完。
 * 如果用户一口气发了三条，就得一条一条来：处理完一条，再看看还有没有下一条。
 * 「还有没有下一条」就是 kick() 里 while 的循环条件。
 *
 * 运行：node mini-loop/step1.mjs
 */

let remaining = 3 // 队列里排着 3 条待处理的消息
let turnCount = 0 // 轮次编号

/** 一个轮次。返回 true = 还有工作，false = 没活了。 */
async function turn() {
  if (remaining <= 0) return false

  remaining -= 1
  turnCount += 1

  console.log(`turn/start {turn:${turnCount}}`)
  console.log('turn/end')

  return true
}

/** 驱动器循环体。while 每转一圈，就是一个 turn。 */
async function kick() {
  while (await turn()) {
    /* 还有工作 → 再开一个 turn */
  }
  console.log('· 驱动器归位 idle')
}

await kick()
