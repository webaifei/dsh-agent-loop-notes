/**
 * Step 8 — PTC：让模型写程序调工具（DSH 版）。
 *
 * 场景：和 Codex 的 code mode 解决同一个问题——模型要连做三步有依赖的工具调用。
 * DSH 的答案是：给它一段程序，程序跑完为止，不挂起。
 *
 * 三个和 Codex 不同的设计选择，在这个文件里都能看到：
 *   1. run_code 是模型唯一能直接调的工具，其他工具只在程序里可见
 *   2. 程序一次跑完，每次运行之间不保留状态
 *   3. 失败是结果里的字段，不是抛出的异常
 *
 * 对照 DSH：
 *   packages/ptc-runtime/ptc-runtime/src/types.ts   请求/结果词汇
 *   packages/core/tools/src/ptc.ts                  run_code 工具与模式折叠
 *
 * 运行：node code/step8-ptc.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** PTC 模式下，模型唯一能直接调用的工具名。 */
const RUN_CODE_NAME = 'run_code'

/** DSH 对模型的原文：指名任何其他工具的调用都会失败。 */
const PTC_ONLY_INSTRUCTION =
  `${RUN_CODE_NAME} 是唯一你能直接调用的工具——指名任何其他工具都会失败。` +
  '所有工具都要从程序里面调用。'

/** 注册表里的工具。在 PTC 模式下它们不作为独立工具暴露给模型。 */
const REGISTRY = {
  grep: async (args) => {
    await sleep(40)
    return { matches: ['src/parseDate.ts:12', 'src/format.ts:3'] }
  },
  read_file: async (args) => {
    await sleep(50)
    return { path: args.path, lines: 42 }
  },
}

/** 把注册表里的一部分工具包装成程序可见的全局命名空间。 */
function buildBindings(names) {
  const tools = Object.create(null) // 不能用原型对象：工具名可能是 __proto__ 之类
  for (const name of names) {
    tools[name] = async (args) => REGISTRY[name](args)
  }
  return [{ global: 'tools', functions: tools }]
}

/** 完成值必须是可无损序列化的 JSON，否则整次运行按 invalid-output 失败。 */
function isLosslessJson(value) {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isLosslessJson)
  if (typeof value === 'object') return Object.values(value).every(isLosslessJson)
  return false // 函数、undefined、Symbol、BigInt、循环引用等
}

/**
 * 等价于 DSH 的 ctx.ptcRuntime。
 * 契约里最重要的一条：**失败是结果里的字段，不是 run() 的 rejection。**
 */
class PtcRuntime {
  /**
   * @param program 程序源码，作为 async 函数体执行（顶层 await / return 可用）
   * @param bindingNames 这次运行允许调用的工具
   * @param timeoutMs 执行预算
   */
  async run({ program, bindingNames = [], timeoutMs = 1000 }) {
    const logs = []
    const capture = { log: (...args) => logs.push(args.map(String).join(' ')) }
    const bindings = buildBindings(bindingNames)

    const fail = (kind, message) => ({ logs, failure: { kind, message } })

    try {
      const fn = new Function('tools', 'console', `return (async () => { ${program} })()`)
      const executed = fn(bindings[0].functions, capture)

      const raced = await Promise.race([
        executed.then(
          (value) => ({ settled: true, value }),
          (error) => ({ settled: true, error }),
        ),
        sleep(timeoutMs).then(() => ({ settled: false })),
      ])

      if (!raced.settled) return fail('timeout', `execution budget of ${timeoutMs}ms expired`)
      if ('error' in raced) return fail('exception', String(raced.error?.message ?? raced.error))

      const value = raced.value ?? null
      if (!isLosslessJson(value)) {
        return fail('invalid-output', `completion value is not lossless JSON: ${typeof value}`)
      }
      return { logs, value }
    } catch (error) {
      // 编译失败（语法错误）也走这里
      return fail('exception', String(error?.message ?? error))
    }
  }
}

function report(outcome) {
  if (outcome.failure) {
    say(1, `failure.kind = '${outcome.failure.kind}'`)
    say(1, `failure.message = ${outcome.failure.message}`)
  } else {
    say(1, `value = ${JSON.stringify(outcome.value)}`)
  }
  if (outcome.logs.length > 0) say(1, `logs = ${JSON.stringify(outcome.logs)}`)
}

const runtime = new PtcRuntime()

say(0, `模型看到的工具清单：只有 ${RUN_CODE_NAME}`)
say(0, `（${PTC_ONLY_INSTRUCTION}）`)
say(0, '')

// ── 场景 A：正常跑完，返回完成值和打印输出 ───────────────────────────
say(0, '【场景 A · 三步工具调用，一次跑完】')
{
  const outcome = await runtime.run({
    bindingNames: ['grep', 'read_file'],
    program: `
      const hits = await tools.grep({ pattern: 'parseDate' })
      console.log('找到 ' + hits.matches.length + ' 处')
      const file = await tools.read_file({ path: hits.matches[0] })
      return file.lines
    `,
  })
  report(outcome)
}

say(0, '')

// ── 场景 B：程序抛错 → 是字段，不是异常 ─────────────────────────────
say(0, '【场景 B · 程序抛错】')
{
  const outcome = await runtime.run({
    bindingNames: ['grep'],
    program: `throw new Error('我写错了')`,
  })
  report(outcome)
}

say(0, '')

// ── 场景 C：超出执行预算 ─────────────────────────────────────────────
say(0, '【场景 C · 超出执行预算】')
{
  const outcome = await runtime.run({
    bindingNames: [],
    timeoutMs: 100,
    program: `await new Promise(r => setTimeout(r, 5000)); return 1`,
  })
  report(outcome)
}

say(0, '')

// ── 场景 D：完成值不能无损序列化 ─────────────────────────────────────
say(0, '【场景 D · 完成值不是 JSON】')
{
  const outcome = await runtime.run({
    bindingNames: [],
    program: `return () => 1`,
  })
  report(outcome)
}

say(0, '')

// ── 场景 E：每次运行不保留状态 ───────────────────────────────────────
say(0, '【场景 E · 两次运行之间状态不保留】')
{
  await runtime.run({ bindingNames: [], program: `const remembered = 42; console.log('第一次记住了 ' + remembered)` })
  const second = await runtime.run({
    bindingNames: [],
    program: `console.log('第二次想读回来：' + remembered)`,
  })
  report(second)
}
