/**
 * 把 Markdown 章节构建成单文件 index.html。
 *
 * 依赖（在仓库根目录安装）：marked、shiki
 *   npm i -D marked shiki
 *
 * 用法：
 *   node tools/build-page.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { marked } from 'marked'
import { createHighlighter } from 'shiki'

const ROOT = new URL('..', import.meta.url).pathname
const THEME = 'vitesse-dark'

const highlighter = await createHighlighter({
  themes: [THEME],
  langs: ['javascript', 'typescript', 'bash', 'json', 'markdown'],
})

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = highlighter.getLoadedLanguages().includes(lang) ? lang : 'text'
      const html = highlighter.codeToHtml(text, { lang: language, theme: THEME })
      return `<figure class="code"><figcaption>${language}</figcaption>${html}</figure>`
    },
  },
})

const render = (markdown) => marked.parse(markdown)

// ── 收集章节 ──────────────────────────────────────────────────────────
const files = readdirSync(ROOT)
  .filter((name) => /^ch\d+.*\.md$/.test(name))
  .sort()

const chapters = files.map((file, index) => {
  const markdown = readFileSync(join(ROOT, file), 'utf8')
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? basename(file, '.md')
  const short = title.replace(/^[一二三四五六七八九十]+、/, '')
  // 去掉正文里的 h1，标题交给外层容器渲染
  return {
    id: `ch${index + 1}`,
    file,
    title,
    short,
    html: render(markdown.replace(/^#\s+.+$/m, '')),
  }
})

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
// 取 README 标题后的前两段做导语；走 inline 渲染，否则反引号会原样显示
const lede = marked.parseInline(
  readme.replace(/^#\s+.+$/m, '').trim().split('\n\n').slice(0, 2).join(' '),
)

// ── 页面 ──────────────────────────────────────────────────────────────
const nav = chapters
  .map(
    (chapter, index) =>
      `<a href="#${chapter.id}" data-target="${chapter.id}"><span class="num">${String(index + 1).padStart(2, '0')}</span>${chapter.short}</a>`,
  )
  .join('\n')

const body = chapters
  .map(
    (chapter, index) => `
<section id="${chapter.id}" class="chapter">
  <div class="chapter-head">
    <span class="chapter-index">${String(index + 1).padStart(2, '0')}</span>
    <h2>${chapter.title.replace(/^[一二三四五六七八九十]+、/, '')}</h2>
  </div>
  ${chapter.html}
</section>`,
  )
  .join('\n')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>一个 agent loop，就是反复问「还有活吗」</title>
<meta name="description" content="从零写一遍 DeepSeek Harness 的 agent loop：三层循环、两条队列、一个 chunk 的三条路。">
<style>
:root{
  --bg:#fbfaf7; --panel:#fff; --fg:#191817; --muted:#6d6a63; --line:#e7e3da;
  --accent:#b45309; --accent-soft:#fdf3e3;
  --sidebar:264px; --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#141413; --panel:#1b1b19; --fg:#ecebe7; --muted:#96938b; --line:#2c2b28;
         --accent:#f0a45b; --accent-soft:#241d13; }
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}

.progress{position:fixed;top:0;left:0;right:0;height:2px;z-index:50;background:transparent}
.progress i{display:block;height:100%;width:0;background:var(--accent);transition:width .1s linear}

aside{position:fixed;top:0;bottom:0;left:0;width:var(--sidebar);padding:32px 20px 40px;
  border-right:1px solid var(--line);overflow-y:auto;background:var(--panel)}
.brand{font-size:13px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.brand-title{font-size:15px;font-weight:600;line-height:1.5;margin:0 0 24px;color:var(--fg)}
aside nav{display:flex;flex-direction:column;gap:2px}
aside nav a{display:flex;gap:10px;align-items:baseline;padding:8px 10px;border-radius:7px;
  color:var(--muted);text-decoration:none;font-size:14px;line-height:1.5;transition:.15s}
aside nav a:hover{background:var(--accent-soft);color:var(--fg)}
aside nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
aside nav .num{font:11px/1 var(--mono);opacity:.55}
.sidebar-foot{margin-top:28px;padding-top:18px;border-top:1px solid var(--line);
  font-size:12px;color:var(--muted);line-height:1.8}
.sidebar-foot a{color:var(--muted)}

main{margin-left:var(--sidebar);padding:0 56px 140px;max-width:900px}

.hero{padding:88px 0 40px;border-bottom:1px solid var(--line)}
.hero .kicker{font:12px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:18px}
.hero h1{font-size:40px;line-height:1.35;margin:0 0 20px;letter-spacing:-.01em}
.hero p{font-size:17px;color:var(--muted);margin:0 0 28px;max-width:640px}
.stats{display:flex;gap:28px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.stats b{color:var(--fg);font-weight:600}

.loops{margin:36px 0 0;font:12px/1.7 var(--mono);color:var(--muted)}
.loops .l1{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:12px 16px}
.loops .l2{border:1px solid var(--line);border-left:3px solid var(--muted);border-radius:8px;padding:12px 16px;margin:8px 0 8px 16px}
.loops .l3{border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:12px 16px;margin:8px 0 0 16px}
.loops em{font-style:normal;color:var(--fg)}

.chapter{padding:52px 0 8px;scroll-margin-top:24px}
.chapter-head{display:flex;align-items:baseline;gap:14px;margin-bottom:8px}
.chapter-index{font:13px/1 var(--mono);color:var(--accent);padding-top:6px}
.chapter-head h2{font-size:27px;margin:0;letter-spacing:-.01em}

article h2{font-size:21px;margin:44px 0 14px;padding-top:8px}
article h3{font-size:17px;margin:32px 0 10px;color:var(--fg)}
article p{margin:0 0 18px}
article strong{font-weight:600}
article a{color:var(--accent)}
article ul,article ol{padding-left:22px;margin:0 0 18px}
article li{margin:6px 0}
article blockquote{margin:0 0 22px;padding:12px 18px;border-left:3px solid var(--accent);
  background:var(--accent-soft);border-radius:0 7px 7px 0;font-size:14px;color:var(--muted)}
article blockquote p{margin:0}
article hr{border:0;border-top:1px solid var(--line);margin:40px 0}
article table{width:100%;border-collapse:collapse;margin:0 0 22px;font-size:14px}
article th,article td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
article th{color:var(--muted);font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase}
article code{font:13px/1.5 var(--mono);background:var(--accent-soft);padding:2px 6px;border-radius:5px}
.code{margin:0 0 24px;border-radius:10px;overflow:hidden;background:#1b1b1f}
.code figcaption{font:11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;
  color:#8b8b93;padding:10px 16px;border-bottom:1px solid #2a2a30}
.code pre{margin:0;padding:18px 16px;overflow-x:auto}
.code code{font:13px/1.75 var(--mono);background:none;padding:0}
.code .shiki{background:#1b1b1f !important}

footer{margin-left:var(--sidebar);padding:40px 56px 90px;border-top:1px solid var(--line);
  font-size:13px;color:var(--muted);max-width:900px}
footer a{color:var(--accent)}

@media (max-width:900px){
  aside{position:static;width:auto;border-right:0;border-bottom:1px solid var(--line);padding:20px}
  main,footer{margin-left:0;padding-left:22px;padding-right:22px}
  .hero{padding-top:48px}.hero h1{font-size:29px}
}
</style>
</head>
<body>
<div class="progress"><i id="bar"></i></div>

<aside>
  <div class="brand">DeepSeek Harness</div>
  <p class="brand-title">一个 agent loop<br>就是反复问「还有活吗」</p>
  <nav>${nav}</nav>
  <div class="sidebar-foot">
    <a href="https://github.com/webaifei/dsh-agent-loop-notes">源码仓库</a><br>
    对照 <a href="https://github.com/deepseek-ai/deepseek-harness">deepseek-harness</a>
  </div>
</aside>

<main>
  <header class="hero">
    <div class="kicker">从零写一遍</div>
    <h1>一个 agent loop<br>就是反复问「还有活吗」</h1>
    <p>${lede}</p>
    <div class="stats">
      <span><b>6</b> 章</span>
      <span><b>9</b> 个可运行文件</span>
      <span>对照 <b>agent.ts</b> 的 893 行</span>
    </div>
    <div class="loops">
      <div class="l1">kick() <em>—— 还有轮次吗</em>
        <div class="l2">turn() <em>—— 还欠请求吗</em>
          <div class="l3">step() <em>—— 这次成了吗</em></div>
        </div>
      </div>
    </div>
  </header>
  <article>${body}</article>
</main>

<footer>
  每章配的代码都在 <code>code/</code> 下，单独 <code>node</code> 就能跑，不依赖任何东西。
</footer>

<script>
const bar = document.getElementById('bar')
const links = [...document.querySelectorAll('aside nav a')]
const sections = links.map(a => document.getElementById(a.dataset.target))

addEventListener('scroll', () => {
  const h = document.documentElement
  bar.style.width = (h.scrollTop / (h.scrollHeight - h.clientHeight) * 100) + '%'

  let current = sections[0]
  for (const s of sections) if (s.getBoundingClientRect().top <= 120) current = s
  links.forEach(a => a.classList.toggle('active', a.dataset.target === current.id))
}, { passive: true })
</script>
</body>
</html>`

writeFileSync(join(ROOT, 'index.html'), html)
console.log(`✅ index.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB，${chapters.length} 章`)
