/**
 * Step 7 — 把假 generator 换成真的网络请求。
 *
 * 相对 Step 6 只换了「chunk 从哪来」：
 *   之前：一个本地 generator 直接 yield chunk
 *   现在：fetch 一个 SSE 服务器，自己读字节、分帧、翻译
 *
 * 对照真实代码：
 *   fetch + SSE        packages/llm/llm-deepseek/src/adapter.ts:120-147
 *   按 \n\n 分帧解析    packages/llm/llm-deepseek/src/sse.ts:13
 *   wire → chunk 翻译   packages/llm/llm-deepseek/src/translate.ts:104
 *
 * 运行：node mini-loop/step7-http-sse.mjs
 */

import { createServer } from 'node:http'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

// ── 1. 假模型服务器：说 Anthropic Messages 的 SSE 方言 ──────────────────
async function startMockModel() {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') return void res.writeHead(405).end()
    for await (const _ignored of req) {
      /* 读掉请求体 */
    }
    // 真实系统里这些 header 就是告诉对方"用 SSE 推给我"
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

    const send = async (event, delay = 50) => {
      await sleep(delay)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }

    await send({ type: 'message_start', message: { model: 'mock-model' } }, 10)
    await send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 10)
    for (const text of ['这个', '项目', '用的是', ' node:test']) {
      await send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    }
    await send({ type: 'content_block_stop', index: 0 }, 10)
    await send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 10)
    await send({ type: 'message_stop' }, 10)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

// ── 2. 分帧：网络给的是字节流，不是事件流 ──────────────────────────────
/**
 * SSE 用空行分隔每一帧，每帧里有一行 `data:` 带着 JSON。
 * 难点在于一个 TCP 包里可能塞了半帧、或者好几帧——所以要自己缓冲、按 \n\n 切。
 */
let rawShown = false
async function* parseSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const rawFrame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      if (!rawShown) {
        rawShown = true
        say(4, `原始字节的一帧: ${JSON.stringify(rawFrame)}`)
      }

      const dataLine = rawFrame.split('\n').find((line) => line.startsWith('data:'))
      if (dataLine) yield JSON.parse(dataLine.slice(5).trim())
    }
  }
}

// ── 3. 翻译：wire event → StreamChunk ─────────────────────────────────
/**
 * 这是两套不同的词汇。wire 说的是 content_block_delta / text_delta，
 * harness 内部说的是 text-delta。中间必须有人翻译，否则上层要懂 N 家厂商的协议。
 */
async function* translate(events) {
  const texts = new Map()
  for await (const event of events) {
    say(5, `wire ← ${event.type}`)
    switch (event.type) {
      case 'content_block_start':
        texts.set(event.index, '')
        yield { type: 'block-start', index: event.index, blockType: event.content_block.type }
        break
      case 'content_block_delta':
        texts.set(event.index, texts.get(event.index) + event.delta.text)
        yield { type: 'text-delta', index: event.index, text: event.delta.text }
        break
      case 'content_block_stop':
        yield { type: 'block-end', index: event.index, block: { type: 'text', text: texts.get(event.index) } }
        break
      case 'message_stop':
        yield { type: 'finish', reason: { kind: 'stop' } }
        break
      default:
        break // message_start / message_delta 暂时不关心
    }
  }
}

// ── 4. 一个真发 HTTP 的流 ─────────────────────────────────────────────
function httpModelStream(baseUrl) {
  return async function* stream(request) {
    say(4, `POST ${baseUrl}/messages`)
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'mock-model', messages: request.messages }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    say(4, `响应 ${response.status}，content-type=${response.headers.get('content-type')}`)
    yield* translate(parseSse(response.body))
  }
}

// ── 5. 循环骨架和前面完全一样 ─────────────────────────────────────────
class Attempt {
  constructor() {
    this.record = []
    this.blocks = []
    this.buffer = ''
  }
  push(chunk) {
    this.record.push({ time: Date.now(), chunk }) // ① 录制
    if (chunk.type === 'text-delta') this.buffer += chunk.text
    if (chunk.type === 'block-end') this.blocks.push(chunk.block) // ② 折叠
    say(5, `⚡ ③ 实时帧 ${chunk.type}${chunk.text ? ` "${chunk.text}"` : ''}`)
  }
}

class Agent {
  constructor(baseUrl) {
    this.stream = httpModelStream(baseUrl)
    this.log = []
  }

  append(type, data = {}) {
    this.log.push({ seq: this.log.length + 1, type, data })
  }

  deriveMessages() {
    return this.log
      .filter((event) => event.type === 'user/message')
      .map((event) => ({ role: 'user', content: event.data.text }))
  }

  async run(text) {
    say(1, 'turn/start {turn:1}')
    this.append('user/message', { text })
    say(2, 'step/start {turn:1, step:1}')

    const request = { messages: this.deriveMessages() }
    const live = new Attempt()
    for await (const chunk of this.stream(request)) {
      live.push(chunk)
    }

    this.append('assistant/message', { text: live.buffer })
    say(3, `② 折叠成完整消息: "${live.buffer}"`)
    say(3, `① 录像 ${live.record.length} 片`)
    say(2, 'step/end')
    say(1, "turn/end {reason:'completed'}")
  }
}

const { server, baseUrl } = await startMockModel()
say(0, `【本地 SSE 服务器】${baseUrl}/messages`)
say(0, '')
try {
  await new Agent(baseUrl).run('这个项目用什么测试框架？')
} finally {
  server.close()
}
