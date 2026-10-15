/**
 * dsh-anchor-memory 本地功能自测（零依赖，用假 ctx 跑真逻辑）
 *
 *   node test/self-test.mjs
 *
 * 默认用**自带的 fixture 记忆库**（在临时目录里现建），因此 clone 下来就能跑，不依赖你机器上的真实记忆库。
 * 想拿真实记忆库跑回归：设置 ANCHOR_MEMORY_ROOT 指向它（脚本会先复制一份副本再操作，不会改原件）。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as plugin from '../lib/index.js'

const work = mkdtempSync(join(tmpdir(), 'anchor-memory-test-'))

let pass = 0
const fails = []

function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  \u2713 ${label}`)
  } else {
    fails.push(label)
    console.log(`  \u2717 ${label}`)
  }
}

function throws(fn, needle, label) {
  try {
    fn()
    fails.push(`${label}（没有抛错）`)
    console.log(`  \u2717 ${label}（没有抛错）`)
  } catch (e) {
    ok(String(e.message).includes(needle), `${label} → "${String(e.message).slice(0, 70)}…"`)
  }
}

function localDate() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------- fixture 记忆库 ---------------- */

const FIXTURE = {
  'INDEX.md': `# 长期记忆索引

> 记忆库根：fixture。预算 ≈2000 token（上限 160 行 / 5200 字符）。
> 本文件由插件自动注入每个新会话。

## 1. 用户档案

- 语言：一律中文；先给结论。
- 细节见 \`profile/CONVENTIONS.md\`。

## 2. 红线

- 不把凭据写进记忆库。
- 完整清单见 \`profile/REDLINES.md\`。

## 3. 项目一览

| 项目 | 文件 | 根目录 | 关键词 |
|---|---|---|---|
| demo | \`projects/demo.md\` | \`E:\\demo\` | 演示, 踩坑 |

## 4. 最近短期记忆（滚动保留 3 条）

| 日期 | 文件 | 一句话 |
|---|---|---|
| 2026-01-01 | \`sessions/2026-01-01-demo.md\` | fixture 的初始短期记忆 |

## 5. 检索协议

1. 先 \`memory_search\` 拿锚点，再 \`memory_read\` 只读那一节。

## 6. 写入协议

- 只在用户明说"记住"时写。
`,
  'profile/CONVENTIONS.md': `# 工作方式

- 一律中文。
- 先给结论再给依据。
`,
  'profile/REDLINES.md': `# 红线

- 不写入密钥 / 凭据 / 他人隐私。
`,
  'projects/demo.md': `---
id: proj-demo
name: demo
root: E:\\demo
updated: 2026-01-01
tags: [demo]
---

# demo 项目

## 目录

| # | 小节 | 一句话 | 锚点 | 关键词 |
|---|---|---|---|---|
| 1 | 环境事实 | CLI 入口不在 PATH，要用绝对路径 | #env | CLI, PATH |
| 2 | 踩坑 | pnpm prune 会吃掉手工装进 node_modules 的插件 | #pitfalls | prune, HMR |

### 1. 环境事实 {#env}

- 结论：CLI 入口不在 PATH，脚本里要写绝对路径。
- 证据：fixture（2026-01-01）。

### 2. 踩坑 {#pitfalls}

- 结论：pnpm prune 会吃掉手工装进 node_modules 的插件；HMR 重载还会杀掉在跑的会话。
- 证据：fixture（2026-01-01）。
`,
  'sessions/2026-01-01-demo.md': `---
date: 2026-01-01
slug: demo
tags: [短期记忆]
---

# 短期记忆：fixture

## 做了什么

- 建了 fixture 记忆库。
`,
}

function buildFixture(dst) {
  for (const [rel, text] of Object.entries(FIXTURE)) {
    const p = join(dst, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text, 'utf8')
  }
}

/** 默认自带 fixture；给了 ANCHOR_MEMORY_ROOT 就用真实记忆库的一份副本 */
function prepareSource() {
  const envRoot = process.env.ANCHOR_MEMORY_ROOT
  if (envRoot && existsSync(join(envRoot, 'INDEX.md'))) {
    console.log(`记忆库源：${envRoot}（ANCHOR_MEMORY_ROOT，已复制副本）`)
    return { dir: envRoot, fixture: false }
  }
  const dir = join(work, 'fixture')
  buildFixture(dir)
  console.log('记忆库源：内置 fixture（未设置 ANCHOR_MEMORY_ROOT）')
  return { dir, fixture: true }
}

function makeCtx() {
  const captured = { sections: [], tools: [], warnings: [], infos: [] }
  const ctx = {
    logger: {
      info: (m) => captured.infos.push(String(m)),
      warn: (m) => captured.warnings.push(String(m)),
    },
    systemPrompt: {
      section: (o) => {
        captured.sections.push(o)
        return () => {}
      },
    },
    inject: (names, cb) => {
      captured.injectNames = names
      cb({ tools: { register: (t) => captured.tools.push(t) } })
    },
  }
  return { ctx, captured }
}

const source = prepareSource()
const tmpCopy = (name) => {
  const dst = join(work, name)
  cpSync(source.dir, dst, { recursive: true })
  return dst
}

console.log(`临时工作区：${work}\n`)

/* ---------------- 1. 入口契约 + 注入 ---------------- */
console.log('1) 插件入口与 INDEX 注入')
ok(plugin.name === 'dsh-anchor-memory', `name = ${plugin.name}`)
ok(Array.isArray(plugin.inject) && plugin.inject.includes('systemPrompt'), 'inject 含 systemPrompt')
ok(typeof plugin.apply === 'function', 'apply 是函数')

const rootA = tmpCopy('a')
const { ctx, captured } = makeCtx()
plugin.apply(ctx, { memoryDir: rootA })

ok(captured.sections.length === 1, '注册了 1 个 systemPrompt section')
const section = captured.sections[0]
ok(section.name === 'plugin:dsh-anchor-memory', `section.name = ${section.name}`)
ok(typeof section.text === 'function', 'section.text 是函数（每次装配重新求值）')
const injected = section.text()
ok(injected.includes('长期记忆索引'), '注入内容就是 INDEX 全文')
ok(injected.length > 200, `注入长度 ${injected.length} 字符`)
ok(section.text() === injected, '重复求值结果稳定')
ok(captured.tools.length === 4, `注册了 4 个工具：${captured.tools.map((t) => t.name).join(', ')}`)
ok(JSON.stringify(captured.injectNames) === '["tools"]', '通过 ctx.inject(["tools"]) 注册工具')
ok(captured.warnings.length === 0, '加载过程无警告')

for (const t of captured.tools) {
  const shapeOk =
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    t.description.length > 30 &&
    t.parameters && typeof t.parameters === 'object' &&
    t.output && typeof t.output.render === 'function' &&
    typeof t.execute === 'function'
  ok(shapeOk, `工具 ${t.name} 形状合法（description/parameters/output.render/execute）`)
  const blocks = t.output.render({}, 'sample')
  ok(Array.isArray(blocks) && blocks[0]?.type === 'text', `工具 ${t.name} 的 render 返回 ContentBlock[]`)
}

// 记忆库不存在时不注入、不抛错
const { ctx: ctx2, captured: cap2 } = makeCtx()
plugin.apply(ctx2, { memoryDir: join(work, 'empty') })
ok(cap2.sections[0].text() === '', 'INDEX 不存在时注入空字符串（不报错）')
ok(cap2.warnings.length === 0, '缺 INDEX 时也不产生警告')

// inject=false 时不注入
const { ctx: ctxOff, captured: capOff } = makeCtx()
plugin.apply(ctxOff, { memoryDir: rootA, inject: false })
ok(capOff.sections[0].text() === '', 'inject=false 时不注入')

// 未配置记忆库（目录里没有 INDEX）时同样不注入
const { ctx: ctx4, captured: cap4 } = makeCtx()
plugin.apply(ctx4, {})
ok(cap4.sections.length === 1 && cap4.tools.length === 4, '不传配置时用默认 memoryDir 正常加载（默认库存在与否都不崩）')
ok(typeof cap4.sections[0].text() === 'string', '默认配置下 text() 返回字符串（不抛错）')

// systemPrompt 服务缺失时降级但不崩
const { ctx: ctx3, captured: cap3 } = makeCtx()
delete ctx3.systemPrompt
plugin.apply(ctx3, { memoryDir: rootA })
ok(cap3.warnings.some((w) => w.includes('systemPrompt 服务不可用')), 'systemPrompt 缺失时只警告、工具仍注册')
ok(cap3.tools.length === 4, 'systemPrompt 缺失时工具仍注册')

// ctx.inject 缺失时退回直接注册
const direct = { logger: { info() {}, warn() {} }, systemPrompt: { section: () => () => {} }, tools: { register: () => {} } }
let directOk = true
try {
  plugin.apply(direct, { memoryDir: rootA })
} catch {
  directOk = false
}
ok(directOk, 'ctx.inject 缺失时不抛错（退回直接注册）')

/* ---------------- 2. 检索 / 读取 ---------------- */
console.log('\n2) memory_search / memory_read')
const tool = (name) => captured.tools.find((t) => t.name === name)
const search = tool('memory_search')
const read = tool('memory_read')
const write = tool('memory_write')
const statusTool = tool('memory_status')

const hits = plugin.search(rootA, 'prune|HMR', { searchLimit: 25 })
ok(hits.length > 0, `search("prune|HMR") 命中 ${hits.length} 行`)
ok(hits.some((h) => h.anchor === 'pitfalls'), '命中里带出锚点 #pitfalls')
ok(plugin.search(rootA, '检索协议', { searchLimit: 25 }).some((h) => h.file === 'INDEX.md'), 'INDEX.md 也参与检索')
const searchOut = await search.execute({ query: 'prune' })
ok(searchOut.includes('记忆检索') && searchOut.includes('memory_read'), 'search 输出含提示（用 memory_read 只读一节）')
ok(searchOut.length < 3000, `search 输出被限长（${searchOut.length} 字符）`)
ok((await search.execute({ query: '绝对不存在的关键词xyzzy' })).includes('没有命中'), '无命中时给出换词建议')
throws(() => plugin.search(rootA, '  ', {}), '缺少 query', '空 query 抛错')

const projRel = 'projects/demo.md'
const one = await read.execute({ file: projRel, anchor: 'pitfalls' })
ok(one.includes('pnpm prune 会吃掉手工装进 node_modules 的插件'), 'memory_read 按锚点读到正确小节')
const wholeLen = readFileSync(join(rootA, projRel), 'utf8').length
ok(one.length < wholeLen, `只读一节而非整篇（${one.length} 字符 < 全文件 ${wholeLen} 字符）`)
ok(
  (await read.execute({ file: 'INDEX.md', anchor: 'nothing-here' }).catch((e) => e.message)).includes('没有锚点'),
  '锚点不存在时提示先 search',
)
throws(() => plugin.readTarget(rootA, { readMaxChars: 100 }, { file: '../../etc/passwd' }), '路径越界', '路径越界被拒绝（不抛错则不安全）')
throws(() => plugin.readTarget(rootA, { readMaxChars: 100 }, { file: 'projects/nope.md' }), '没有这个文件', '文件不存在时报错')
ok((await read.execute({ file: 'INDEX.md' })).length > 100, '不带 anchor 时读整文件')

/* ---------------- 3. 写入：目录表自动维护 ---------------- */
console.log('\n3) memory_write：小节 upsert + 目录表维护')
const before = readFileSync(join(rootA, projRel), 'utf8')
const projRowsBefore = [...before.matchAll(/^\|\s*\d+\s*\|/gm)].length

const w1 = await write.execute({
  file: projRel,
  title: '自测小节',
  summary: '由 self-test 写入的临时小节',
  keywords: 'self-test, 自测',
  body: '- 结论：这条是小节写入的自测数据（fixture，self-test）\n- 证据：test/self-test.mjs',
})
ok(w1.includes('新增'), `首次写入 → ${w1}`)
const after = readFileSync(join(rootA, projRel), 'utf8')
const projRowsAfter = [...after.matchAll(/^\|\s*\d+\s*\|/gm)].length
ok(projRowsAfter === projRowsBefore + 1, `目录表自动加了一行（${projRowsBefore} → ${projRowsAfter}）`)
ok(/^### \d+\. 自测小节 \{#[\w\u4e00-\u9fff-]+\}$/m.test(after), '小节标题带编号与锚点')
ok(/^updated: \d{4}-\d{2}-\d{2}$/m.test(after) && after.includes(`updated: ${localDate()}`), 'frontmatter 的 updated 被刷新')
ok(/^\|\s*\d+\s*\|\s*自测小节\s*\|/m.test(after), '目录表里出现自测小节行')
ok(after.includes('由 self-test 写入的临时小节') && after.includes('self-test, 自测'), 'summary / keywords 写进了目录表行')

const w2 = await write.execute({ file: projRel, title: '自测小节', body: '- 结论：第二次写入，改为更新（self-test）' })
ok(w2.includes('更新'), `同标题再写 → ${w2}`)
const after2 = readFileSync(join(rootA, projRel), 'utf8')
ok([...after2.matchAll(/^\|\s*\d+\s*\|/gm)].length === projRowsAfter, '第二次写入没有重复加目录行')
ok(after2.includes('第二次写入') && !after2.includes('小节写入的自测数据'), '小节正文被替换（旧内容不再出现）')

// 按锚点更新（同标题不同写法也能定位）
const w2b = await write.execute({ file: projRel, anchor: '自测小节', title: '换个标题', body: '- 第三次：按锚点更新' })
ok(w2b.includes('更新'), `按 anchor 再写 → ${w2b}`)
ok(!readFileSync(join(rootA, projRel), 'utf8').includes('## 换个标题'), '按锚点更新时不会另起一节')

// 没有「## 目录」的文件（profile/INDEX）用二级标题
const w3 = await write.execute({ file: 'INDEX.md', title: '自测追加节', anchor: 'self-test-section', body: '- 临时内容' })
ok(w3.includes('新增'), `INDEX 里新增小节 → ${w3}`)
ok(/^## 自测追加节 \{#self-test-section\}$/m.test(readFileSync(join(rootA, 'INDEX.md'), 'utf8')), '无目录文件用二级标题 + 锚点')

// append 模式
const w4 = await write.execute({ file: 'profile/REDLINES.md', body: '- 自测追加行', mode: 'append' })
ok(w4.includes('已追加'), `append 模式 → ${w4}`)
ok(readFileSync(join(rootA, 'profile/REDLINES.md'), 'utf8').trimEnd().endsWith('- 自测追加行'), 'append 写在文件末尾')

ok((await write.execute({ file: projRel, title: 'x' }).catch((e) => e.message)).includes('缺少 body'), '缺 body 报错')
ok((await write.execute({ file: projRel, body: 'x' }).catch((e) => e.message)).includes('需要 title'), 'section 缺 title 报错')
throws(() => plugin.writeSection(rootA, { indexMaxLines: 999, indexMaxChars: 99999 }, { file: '../outside.md', title: 't', body: 'x' }), '路径越界', '写入也不能越界')

/* ---------------- 4. 短期记忆 + INDEX 滚动表 ---------------- */
console.log('\n4) memory_write(mode=session) 与 INDEX 滚动表')
const sessionRows = () => [...readFileSync(join(rootA, 'INDEX.md'), 'utf8').matchAll(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/gm)].length
const sessionOrder = () =>
  [...readFileSync(join(rootA, 'INDEX.md'), 'utf8').matchAll(/^\|\s*\d{4}-\d{2}-\d{2}\s*\|[^|]*\|([^|]*)\|/gm)].map((m) =>
    m[1].trim(),
  )
const rowsBefore = sessionRows()
ok(rowsBefore >= 1, `写入前「最近短期记忆」有 ${rowsBefore} 行`)
const s1 = await write.execute({ slug: 'self-test', summary: '自测写入的短期记忆', body: '## 做了什么\n- 跑自测', mode: 'session' })
ok(s1.includes('已写入短期记忆') && s1.includes('已更新'), `session 模式 → ${s1}`)
ok(existsSync(join(rootA, 'sessions', `${localDate()}-self-test.md`)), '短期记忆文件已创建')
ok(sessionRows() === Math.min(rowsBefore + 1, 3), `写入后表里有 ${sessionRows()} 行`)
ok(sessionOrder()[0].includes('自测写入的短期记忆'), '新行插在表首（最新的在最上面）')
ok((await write.execute({ mode: 'session', summary: '', body: 'x' }).catch((e) => e.message)).includes('缺少 summary'), 'session 缺 summary 报错')

for (let i = 0; i < 4; i++) {
  await write.execute({ slug: `roll-${i}`, summary: `滚动测试 ${i}`, body: '- x', mode: 'session' })
}
ok(sessionRows() === 3, `滚动保留 3 行（实际 ${sessionRows()}）`)
ok(sessionOrder()[0].includes('滚动测试 3'), '滚动后表首是最新一条')
ok(!sessionOrder().join('|').includes('滚动测试 0'), '被滚出去的最旧条目已被移除')

/* ---------------- 5. INDEX 硬上限守卫 ---------------- */
console.log('\n5) INDEX 硬上限守卫')
const tight = { memoryDir: rootA, indexMaxLines: 5, indexMaxChars: 200 }
throws(() => plugin.writeSection(rootA, tight, { file: 'INDEX.md', body: 'x'.repeat(50), mode: 'append' }), '超预算', '超限且变大 → 拒绝')
let shrinkOk = true
try {
  plugin.guardIndex('INDEX.md', 'x'.repeat(500), 'x'.repeat(100), tight)
} catch {
  shrinkOk = false
}
ok(shrinkOk, '超限但缩小 → 放行')
let underOk = true
try {
  plugin.guardIndex('projects/demo.md', 'x'.repeat(9999), 'x'.repeat(99999), tight)
} catch {
  underOk = false
}
ok(underOk, '非 INDEX 文件不受索引预算限制')

/* ---------------- 6. status 工具 ---------------- */
console.log('\n6) memory_status')
const st = await statusTool.execute({})
ok(st.includes('记忆库：') && st.includes('INDEX.md：') && st.includes('注入：开'), 'status 报告路径 / INDEX 体量 / 注入开关')
ok(st.includes('section 已注册'), 'status 确认注入段已注册')
ok(/≈\d+ token/.test(st), 'status 给出 token 估算')
ok(st.includes('memory_search') && st.includes('memory_write'), 'status 列出四个工具')

/* ---------------- 收尾 ---------------- */
rmSync(work, { recursive: true, force: true })
console.log(`\n${fails.length === 0 ? '全部通过' : '有失败'}：${pass} 项通过 / ${fails.length} 项失败`)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
