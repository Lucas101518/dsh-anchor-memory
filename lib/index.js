/**
 * dsh-anchor-memory —— 基于 markdown 文件的长期记忆（DSH host 插件）
 *
 * 设计要点（与记忆库协议一致）：
 *  1. 自动注入：把 $DSH_HOME/memory/INDEX.md 作为系统提示词的一个 section 注入。
 *     `text` 用函数形式，每次装配重新读盘 —— 新会话必然读到，手改 md 立刻生效；
 *     函数内部自己 try/catch，绝不抛异常（抛出去会毁掉整轮请求）。
 *  2. 省 token：只常驻 INDEX（≈1000–2000 token）；项目细节靠 search → 只读命中那一节。
 *  3. 写入自动化：写项目文件时自动维护「## 目录」表行与 frontmatter 的 updated。
 *  4. 硬上限守卫：INDEX.md 超预算且本次写入让它变大 → 拒绝；缩小它的重写一律放行。
 *
 * 依赖：零。只用 node 内建；不 import 任何 @deepseek-ai/* 包，
 *      因此不需要在 profile 里解析 peer 依赖（最省事、最不容易炸）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname, resolve, sep, basename } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export const name = 'dsh-anchor-memory'
export const inject = ['systemPrompt']

const SECTION_NAME = 'plugin:dsh-anchor-memory'
const SUBDIRS = ['profile', 'projects', 'sessions']
const MAX_SESSION_ROWS = 5

const DEFAULT_CONFIG = {
  memoryDir: '', // 空 = $DSH_HOME/memory
  inject: true,
  maxChars: 9000, // 注入 INDEX 的字符上限（≈2000 token）
  indexMaxLines: 160,
  indexMaxChars: 5200,
  searchLimit: 25,
  searchMaxChars: 3000,
  readMaxChars: 12000,
  order: 55,
  versioning: 'auto', // auto = 有 .git 就提交，否则只做写前快照；git | snapshot | off
  historyMax: 20, // 每个文件保留最近多少份写前快照
  sessionRows: 5, // INDEX「最近短期记忆」表滚动保留几条
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g

export function estimateTokens(text) {
  const cjk = (String(text).match(CJK) ?? []).length
  return Math.ceil(cjk * 0.7 + (String(text).length - cjk) / 3.2)
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_CONFIG)) if (raw[k] !== undefined) cfg[k] = raw[k]
  }
  if (!cfg.memoryDir) {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    cfg.memoryDir = join(home, 'memory')
  }
  cfg.memoryDir = resolve(String(cfg.memoryDir))
  return cfg
}

function readText(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function writeTextSafe(p, text) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-anchor-memory`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, p) // Windows 上 Node 用 MOVEFILE_REPLACE_EXISTING，会覆盖
}

/* ------------------------------------------------------------------ *
 * 版本保留：保证"更新记忆绝不丢内容"
 *   1) 写前快照：旧内容进 _meta/history/<文件>.<时间戳>.md（每文件保留 cfg.historyMax 份）
 *   2) git 提交：记忆库有 .git 且系统有 git 时，每次写入后自动 commit（可 diff / 回滚 / 迁移）
 *   两步都是"尽力而为"：任何失败都被吞掉，绝不影响正常写入。
 * ------------------------------------------------------------------ */

export function snapshot(root, cfg, rel, text) {
  try {
    if (!text) return
    const name = rel.replace(/[\\/]/g, '__')
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17) // YYYYMMDDHHMMSSmmm（毫秒精度，连续写入也不会互相覆盖）
    const dir = join(root, '_meta', 'history')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${name}.${stamp}.md`)
    if (!existsSync(target)) writeTextSafe(target, text)
    const keep = Math.max(1, Number(cfg.historyMax) || 20)
    const mine = readdirSync(dir)
      .filter((f) => f.startsWith(`${name}.`) && f.endsWith('.md'))
      .sort()
    for (const f of mine.slice(0, Math.max(0, mine.length - keep))) {
      try {
        rmSync(join(dir, f), { force: true })
      } catch {
        /* 清理失败无所谓 */
      }
    }
  } catch {
    /* 快照失败不能影响写入 */
  }
}

export function gitCommit(root, message) {
  try {
    if (!existsSync(join(root, '.git'))) return false
    const base = ['-C', root, '-c', 'user.name=memory', '-c', 'user.email=memory@localhost']
    const opts = { timeout: 20000, windowsHide: true }
    const add = spawnSync('git', [...base, 'add', '-A'], opts)
    if (add.error || add.status !== 0) return false
    const commit = spawnSync('git', [...base, 'commit', '--quiet', '--no-verify', '-m', String(message).slice(0, 200)], opts)
    return !commit.error && commit.status === 0
  } catch {
    return false
  }
}

/** 记忆库格式版本标记：**只在新库或首次写入时创建，永不改写已有内容**（升级时靠它识别旧格式） */
function ensureFormatMarker(root) {
  try {
    const p = join(root, '_meta', 'format.json')
    if (existsSync(p)) return
    writeTextSafe(
      p,
      `${JSON.stringify(
        {
          formatVersion: 1,
          plugin: name,
          createdAt: new Date().toISOString(),
          note: '记忆库格式版本。新版插件只追加字段/小节，不重写已存在的内容；升级前请保留 _meta/history 与 .git。',
        },
        null,
        2,
      )}\n`,
    )
  } catch {
    /* 标记写不进去也不能影响写入 */
  }
}

/** 大幅缩短提醒：写入让文件缩水 ≥40% 时给出提示（内容可从快照 / git 回滚） */
function shrinkNote(oldText, next) {
  if (!oldText) return ''
  const delta = oldText.length - next.length
  if (delta <= 0 || delta < oldText.length * 0.4) return ''
  return ` ⚠️ 本次写入让该文件缩短了 ${delta} 字符（${oldText.length} → ${next.length}）；旧版本已留在 _meta/history/ 里，可用快照或 git 回滚。`
}

/**
 * 统一落盘出口：格式标记 → 写前快照 → 原子写 → git 提交。
 * 不变量（对"升级不丢记忆"的保证）：
 *   1. 用户数据只在 $DSH_HOME/memory 下被写入；插件运行时**从不写自己的包目录**；
 *   2. **从不删除用户的 .md**（唯一的 rm 是清理 _meta/history 里的过期快照）；
 *   3. 安装/升级插件（apply 阶段）只可能追加 _meta/plugin.log 诊断日志，**用户记忆文件零改动**；
 *   4. 任何写入都先留旧版本（快照 + git），所以内容永远可回滚。
 */
function persistWrite(root, cfg, rel, abs, oldText, next, message) {
  if (cfg.versioning !== 'off') {
    ensureFormatMarker(root)
    snapshot(root, cfg, rel, oldText)
  }
  writeTextSafe(abs, next)
  if (cfg.versioning === 'auto' || cfg.versioning === 'git') gitCommit(root, message)
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function slugify(s) {
  const out = String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return out || 'section'
}

function log(ctx, level, msg) {
  const line = `[dsh-anchor-memory] ${msg}`
  try {
    const logger = ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  } catch {
    /* 记录日志本身绝不能影响加载 */
  }
}

/** 诊断日志：追加到 <memoryDir>/_meta/plugin.log（DSH 的 console 输出看不到，这是唯一可靠通道） */
function diag(cfg, msg) {
  try {
    const dir = join(cfg.memoryDir, '_meta')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' })
  } catch {
    /* 诊断失败不影响加载 */
  }
}

function listFiles(root) {
  const files = []
  if (existsSync(join(root, 'INDEX.md'))) files.push('INDEX.md')
  for (const dir of SUBDIRS) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    let names = []
    try {
      names = readdirSync(abs).filter((n) => n.endsWith('.md'))
    } catch {
      continue
    }
    for (const n of names.sort()) files.push(`${dir}/${n}`)
  }
  return files
}

/** 把相对路径限制在记忆库内 */
function resolveInside(root, rel) {
  const clean = String(rel ?? '').trim().replace(/^[.][/\\]/, '')
  if (!clean) throw new Error('缺少 file 参数（例如 "projects/demo.md"）')
  const p = resolve(root, clean)
  if (p !== root && !p.startsWith(root + sep)) throw new Error(`路径越界，只允许记忆库内的相对路径：${clean}`)
  return { rel: clean.replace(/\\/g, '/'), abs: p }
}

/* ------------------------------------------------------------------ *
 * markdown 结构解析（标题 / 锚点 / 目录表）
 * ------------------------------------------------------------------ */

function parseHeading(line) {
  const m = /^(#{1,6})\s+(.*)$/.exec(line)
  if (!m) return null
  const level = m[1].length
  let title = m[2].trim()
  let anchor = ''
  const a = /\{#([^\s{}|]+)\}\s*$/.exec(title)
  if (a) {
    anchor = a[1]
    title = title.slice(0, a.index).trim()
  }
  return { level, title, anchor }
}

/** 一节的范围：[标题行, 结束行) —— 结束于下一个同级或更高级标题 */
function sectionRange(lines, startIdx) {
  const h = parseHeading(lines[startIdx])
  if (!h) return [startIdx, Math.min(startIdx + 1, lines.length)]
  for (let i = startIdx + 1; i < lines.length; i++) {
    const p = parseHeading(lines[i])
    if (p && p.level <= h.level) return [startIdx, i]
  }
  return [startIdx, lines.length]
}

function findTocBlock(lines) {
  const start = lines.findIndex((l) => /^#{1,6}\s*目录\s*$/.test(l.trim()))
  if (start < 0) return null
  let first = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) {
      first = i
      break
    }
    if (parseHeading(lines[i])) break
  }
  if (first < 0) return null
  let last = first
  while (last + 1 < lines.length && /^\s*\|/.test(lines[last + 1])) last++
  return { headerIdx: start, first, last }
}

/** 解析目录表行：| # | 小节 | 一句话 | #锚点 | 关键词 | */
function parseTocRows(lines, block) {
  const rows = []
  for (let i = block.first; i <= block.last; i++) {
    const cells = lines[i].split('|').map((s) => s.trim())
    if (cells.length < 7) continue
    if (!/^\d+$/.test(cells[1])) continue
    rows.push({
      line: i,
      num: Number(cells[1]),
      title: cells[2],
      summary: cells[3],
      anchor: cells[4].replace(/^#/, ''),
      keywords: cells[5],
    })
  }
  return rows
}

function clampTableRow(num, title, summary, anchor, keywords) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim()
  return `| ${num} | ${cell(title)} | ${cell(summary)} | #${cell(anchor)} | ${cell(keywords)} |`
}

/* ------------------------------------------------------------------ *
 * 记忆库操作（纯函数 + 文件 IO，便于自测）
 * ------------------------------------------------------------------ */

export function loadIndex(root) {
  return readText(join(root, 'INDEX.md'))
}

/** INDEX 硬上限守卫：超预算且变大 → 拒绝（导出以便自测直接覆盖） */
export function guardIndex(rel, oldText, newText, cfg) {
  if (basename(rel).toLowerCase() !== 'index.md') return
  const lines = newText.split(/\r?\n/).length
  const chars = newText.length
  const over = []
  if (lines > cfg.indexMaxLines) over.push(`${lines} 行 > ${cfg.indexMaxLines}`)
  if (chars > cfg.indexMaxChars) over.push(`${chars} 字符 > ${cfg.indexMaxChars}`)
  if (over.length > 0 && newText.length > oldText.length) {
    throw new Error(
      `INDEX.md 超预算（${over.join('；')}），且本次写入让它变大 —— 已拒绝。` +
        `请先把细节下沉到 profile/ 或 projects/ 文件，再写 INDEX（缩小 INDEX 的重写总是允许）。`,
    )
  }
}

function touchUpdated(text) {
  const d = today()
  if (/^updated:.*$/m.test(text)) return text.replace(/^updated:.*$/m, `updated: ${d}`)
  if (/^---\r?\n/.test(text)) return text.replace(/^---\r?\n/, `---\nupdated: ${d}\n`)
  return text
}

/**
 * 在项目/画像文件里 upsert 一节（带目录时自动维护表行）
 * @returns {{rel:string, anchor:string, action:'created'|'updated'|'appended', chars:number}}
 */
export function writeSection(root, cfg, { file, title, body, anchor, summary, keywords, mode = 'section' }) {
  if (!body || !String(body).trim()) throw new Error('缺少 body（要写入的内容）')
  const { rel, abs } = resolveInside(root, file)
  const oldText = readText(abs)
  let lines = oldText ? oldText.split(/\r?\n/) : []

  if (mode === 'append') {
    const next = `${oldText.replace(/\s*$/, '')}\n\n${String(body).trim()}\n`
    guardIndex(rel, oldText, next, cfg)
    persistWrite(root, cfg, rel, abs, oldText, next, `memory: append ${rel}`)
    return { rel, anchor: '', action: 'appended', chars: next.length, note: shrinkNote(oldText, next) }
  }

  if (!title) throw new Error('mode=section 需要 title')

  const wanted = anchor ? slugify(anchor) : slugify(title)
  let headingIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeading(lines[i])
    if (!h) continue
    if ((h.anchor && h.anchor === wanted) || (!h.anchor && h.title.replace(/^\d+[.、]\s*/, '') === title)) {
      headingIdx = i
      break
    }
  }

  let action = 'updated'
  const bodyLines = String(body).trim().split(/\r?\n/)

  if (headingIdx >= 0) {
    const h = parseHeading(lines[headingIdx])
    const [s, e] = sectionRange(lines, headingIdx)
    const headingLine = `### ${h.title}${h.anchor ? ` {#${h.anchor}}` : ''}`
    lines.splice(s, e - s, headingLine, '', ...bodyLines, '')
  } else {
    action = 'created'
    const block = findTocBlock(lines)
    const rows = block ? parseTocRows(lines, block) : []
    const num = rows.length > 0 ? Math.max(...rows.map((r) => r.num)) + 1 : 1
    // 有「## 目录」的项目文件用编号 + 锚点；没有目录的文件（profile/*.md、INDEX.md）用二级标题
    const headingLine = block ? `### ${num}. ${title} {#${wanted}}` : `## ${title} {#${wanted}}`
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
    lines.push(headingLine, '', ...bodyLines, '')
    if (block) {
      lines.splice(block.last + 1, 0, clampTableRow(num, title, summary, wanted, keywords))
    }
  }

  // 已有表行：更新 summary / keywords
  if (headingIdx >= 0 && (summary || keywords)) {
    const block = findTocBlock(lines)
    if (block) {
      for (const row of parseTocRows(lines, block)) {
        if (row.anchor !== wanted) continue
        lines[row.line] = clampTableRow(
          row.num,
          row.title,
          summary ?? row.summary,
          row.anchor,
          keywords ?? row.keywords,
        )
      }
    }
  }

  let next = touchUpdated(lines.join('\n'))
  if (!next.endsWith('\n')) next += '\n'
  guardIndex(rel, oldText, next, cfg)
  persistWrite(root, cfg, rel, abs, oldText, next, `memory: ${action} ${rel}${wanted ? `#${wanted}` : ''}`)
  return { rel, anchor: wanted, action, chars: next.length, note: shrinkNote(oldText, next) }
}

/** 滚动更新 INDEX 的「最近短期记忆」表 */
export function updateRecentSessions(root, cfg, { date, file, summary }) {
  const rel = 'INDEX.md'
  const abs = join(root, rel)
  const oldText = readText(abs)
  if (!oldText) return false
  const lines = oldText.split(/\r?\n/)
  const hIdx = lines.findIndex((l) => /^#{1,6}\s*.*最近短期记忆/.test(l))
  if (hIdx < 0) return false
  const [s, e] = sectionRange(lines, hIdx)
  let first = -1
  let last = -1
  for (let i = s; i < e; i++) {
    if (/^\s*\|/.test(lines[i])) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0 || last - first < 1) return false

  const rows = []
  for (let i = first + 2; i <= last; i++) {
    const cells = lines[i].split('|').map((x) => x.trim())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[1] ?? '')) continue
    rows.push({ date: cells[1], file: cells[2].replace(/`/g, ''), summary: cells[3] ?? '' })
  }
  const kept = rows.filter((r) => r.file !== file)
  kept.unshift({ date, file, summary })
  const cap = Math.max(1, Number(cfg.sessionRows) || MAX_SESSION_ROWS)
  const newRows = kept.slice(0, cap).map((r) => `| ${r.date} | \`${r.file}\` | ${r.summary} |`)
  lines.splice(first, last - first + 1, lines[first], lines[first + 1], ...newRows)

  let next = lines.join('\n')
  if (!next.endsWith('\n')) next += '\n'
  guardIndex(rel, oldText, next, cfg)
  persistWrite(root, cfg, rel, abs, oldText, next, `memory: recent-sessions ${rel}`)
  return true
}

/** 写一条短期记忆：sessions/<date>-<slug>.md + 更新 INDEX 表 */
export function writeSession(root, cfg, { slug, summary, body }) {
  if (!body || !String(body).trim()) throw new Error('缺少 body（本次会话的记忆内容）')
  if (!summary || !String(summary).trim()) throw new Error('缺少 summary（一句话摘要，会写进 INDEX 表格）')
  const date = today()
  const s = slugify(slug || summary)
  const rel = `sessions/${date}-${s}.md`
  const head = `---\ndate: ${date}\nslug: ${s}\ntags: [短期记忆]\n---\n\n# 短期记忆：${String(summary).trim()}\n\n`
  const text = `${head}${String(body).trim()}\n`
  const absSession = join(root, rel)
  const before = readText(absSession)
  persistWrite(root, cfg, rel, absSession, before, text, `memory: session ${rel}`)
  const indexed = updateRecentSessions(root, cfg, { date, file: rel, summary: String(summary).trim() })
  return { rel, indexed, chars: text.length, note: shrinkNote(before, text) }
}

/** 关键词检索：返回命中行 + 所属小节（锚点/标题） */
export function search(root, query, cfg) {
  const terms = String(query ?? '')
    .split('|')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (terms.length === 0) throw new Error('缺少 query（用 | 分隔多个关键词，例如 "prune|HMR"）')

  const hits = []
  for (const rel of listFiles(root)) {
    const text = readText(join(root, rel))
    if (!text) continue
    const lines = text.split(/\r?\n/)
    let cur = { anchor: '', title: '' }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const h = parseHeading(line)
      if (h) cur = { anchor: h.anchor || '', title: h.title }
      const low = line.toLowerCase()
      if (!terms.some((t) => low.includes(t))) continue
      let anchor = cur.anchor
      let title = cur.title
      const toc = /^\s*\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|\s*#([^\s|]+)\s*\|/.exec(line)
      if (toc) {
        anchor = toc[4]
        title = toc[2].trim()
      }
      hits.push({ file: rel, line: i + 1, anchor, title, text: line.trim().slice(0, 220) })
    }
  }
  return hits
}

/** 读一节（给 anchor）或整个文件（自动截断） */
export function readTarget(root, cfg, { file, anchor }) {
  const { rel, abs } = resolveInside(root, file)
  if (!existsSync(abs)) throw new Error(`记忆库中没有这个文件：${rel}`)
  const text = readText(abs)
  if (!anchor) {
    const truncated = text.length > cfg.readMaxChars
    return { rel, anchor: '', text: truncated ? `${text.slice(0, cfg.readMaxChars)}\n…（已截断；建议带 anchor 只读一节）` : text }
  }
  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((l) => {
    const h = parseHeading(l)
    return h && h.anchor === anchor
  })
  if (idx < 0) throw new Error(`${rel} 里没有锚点 #${anchor}（先用 memory_search 拿锚点，或读文件的「目录」小节）`)
  const [s, e] = sectionRange(lines, idx)
  return { rel, anchor, text: lines.slice(s, e).join('\n').trim() }
}

export function status(root, cfg, state = {}) {
  const idxAbs = join(root, 'INDEX.md')
  const index = readText(idxAbs)
  const files = listFiles(root)
  const counts = SUBDIRS.map((d) => `${d} ${files.filter((f) => f.startsWith(`${d}/`)).length}`).join(' / ')
  const lines = [
    `记忆库：${root}`,
    `  INDEX.md：${index ? `${index.split(/\r?\n/).length} 行 / ${index.length} 字符 / ≈${estimateTokens(index)} token（预算 ${cfg.indexMaxLines} 行 / ${cfg.indexMaxChars} 字符）` : '不存在'}`,
    `  注入：${cfg.inject ? '开' : '关'}${state.sectionRegistered ? '（系统提示词 section 已注册）' : '（未注册 section）'}`,
    `  上次注入：${state.injectedChars ? `${state.injectedChars} 字符（≈${Math.ceil(state.injectedChars / 4.5)} token 粗估）` : '尚未装配过'}`,
    `  文件：${files.length} 个（${counts}）`,
    `  工具：memory_status / memory_search / memory_read / memory_write`,
  ]
  if (!existsSync(idxAbs)) lines.push('  ⚠️ INDEX.md 缺失 —— 请先按协议创建记忆库')

  // 升级安全 / 版本保留状态（对"升级不丢记忆"的可观测承诺）
  const gitReady = existsSync(join(root, '.git'))
  const histDir = join(root, '_meta', 'history')
  let snapCount = 0
  try {
    snapCount = existsSync(histDir) ? readdirSync(histDir).length : 0
  } catch {
    /* 读不到就当 0 */
  }
  const fmt = /"formatVersion":\s*(\d+)/.exec(readText(join(root, '_meta', 'format.json')))
  lines.push(`  数据位置：${root}`)
  lines.push('  升级安全：数据在插件包之外，升级/卸载/重装插件都不会改动它（插件从不写自己的包目录，也不删用户 .md）')
  lines.push(
    `  版本保留：${gitReady ? 'git 已就绪（每次写入自动提交）' : '仅写前快照（可在记忆库执行 git init 以启用自动提交）'}；` +
      `快照 ${snapCount} 份${existsSync(histDir) ? `（${histDir}）` : ''}；格式版本 ${fmt ? fmt[1] : '未写入'}`,
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 注入文本
 * ------------------------------------------------------------------ */

function injectionText(cfg, state) {
  if (!cfg.inject) return ''
  try {
    const abs = join(cfg.memoryDir, 'INDEX.md')
    if (!existsSync(abs)) return ''
    let body = readText(abs)
    if (!body.trim()) return ''
    if (body.length > cfg.maxChars) {
      body = `${body.slice(0, cfg.maxChars)}\n\n…（记忆索引超出 maxChars=${cfg.maxChars} 被截断；请精简 INDEX.md）`
    }
    state.injectedChars = body.length
    state.lastInjectAt = new Date().toISOString()
    return body.trim()
  } catch {
    return '' // 绝不抛：抛出去会毁掉整轮
  }
}

/* ------------------------------------------------------------------ *
 * 工具注册（用原始 ToolDefinition，不依赖 defineTool）
 * ------------------------------------------------------------------ */

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  }
}

function formatHits(hits, query, cfg) {
  if (hits.length === 0) {
    return `记忆检索 "${query}"：没有命中。\n建议：换关键词（同义词 / 英文名 / 文件名），或用 memory_read({file:"projects/xxx.md"}) 直接读文件的「目录」小节。`
  }
  const groups = new Map()
  for (const h of hits) {
    const key = `${h.file}#${h.anchor || '-'}`
    if (!groups.has(key)) groups.set(key, { file: h.file, anchor: h.anchor, title: h.title, lines: [] })
    const g = groups.get(key)
    if (g.lines.length < 3) g.lines.push(`L${h.line} ${h.text}`)
  }
  const out = [`记忆检索 "${query}"：命中 ${hits.length} 行 / ${groups.size} 处小节`, '']
  let n = 0
  for (const g of groups.values()) {
    out.push(`${++n}. ${g.file}:${g.lines[0].split(' ')[0].slice(1)}${g.anchor ? ` #${g.anchor}` : ''}${g.title ? ` — ${g.title}` : ''}`)
    for (const l of g.lines) out.push(`   ${l}`)
    if (out.join('\n').length > cfg.searchMaxChars) {
      out.push('…（结果已截断，请缩小关键词范围）')
      break
    }
  }
  out.push('', '提示：用 memory_read({file, anchor}) 只读命中那一节，不要整篇读。')
  return out.join('\n')
}

function registerTools(c, cfg, state) {
  const tools = [
    {
      name: 'memory_status',
      description:
        '查看 md 长期记忆库的状态：INDEX.md 体量与预算、是否正在注入系统提示词、各类文件数量。' +
        '会话开始或怀疑记忆没生效时先调它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput(),
      async execute() {
        return status(cfg.memoryDir, cfg, state)
      },
    },
    {
      name: 'memory_search',
      description:
        '在长期记忆库（INDEX.md / profile/ / projects/ / sessions/）里按关键词检索，返回命中行与所属小节的锚点。' +
        '**检索记忆的第一步**：拿到锚点后用 memory_read 只读那一节，避免整篇读文件。' +
        '多个关键词用 | 分隔（任一命中即算），大小写不敏感，中文直接子串匹配。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，多个用 | 分隔，例如 "prune|HMR"' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const hits = search(cfg.memoryDir, args?.query, cfg)
        return formatHits(hits.slice(0, cfg.searchLimit), args?.query, cfg)
      },
    },
    {
      name: 'memory_read',
      description:
        '读记忆库里的内容。带 anchor 时**只读那一节**（推荐做法）；不带 anchor 时读整个文件（会自动截断）。' +
        'file 是记忆库内的相对路径，例如 "INDEX.md"、"projects/demo.md"、"profile/REDLINES.md"。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '记忆库内的相对路径' },
          anchor: { type: 'string', description: '小节锚点（不含 #），例如 "pitfalls"；省略则读整文件' },
        },
        required: ['file'],
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const r = readTarget(cfg.memoryDir, cfg, { file: args?.file, anchor: args?.anchor })
        return `【${r.rel}${r.anchor ? ` #${r.anchor}` : ''}】\n\n${r.text}`
      },
    },
    {
      name: 'memory_write',
      description:
        '把内容写进长期记忆库（只在用户明确要求"记住/写进记忆"或已确认你的提议时使用）。三种模式：\n' +
        '1) section（默认）：在某个文件里新增或更新一节，**自动维护该文件的「## 目录」表行与 frontmatter 的 updated**；' +
        '需要 file、title、body，可选 anchor（默认由 title 生成）、summary（写进目录表的一句话）、keywords。\n' +
        '2) append：把 body 追加到文件末尾，只需要 file、body。\n' +
        '3) session：写一条短期记忆（sessions/<日期>-<slug>.md）并滚动更新 INDEX 的「最近短期记忆」表，需要 summary、body，可选 slug。\n' +
        'INDEX.md 有硬上限：超预算且这次写入让它变大时会被拒绝 —— 请先把细节下沉到 profile/ 或 projects/。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'section（默认）| append | session' },
          file: { type: 'string', description: '记忆库内相对路径（mode=section/append 必填）' },
          title: { type: 'string', description: '小节标题（mode=section 必填）' },
          anchor: { type: 'string', description: '小节锚点（可选，默认由 title 生成）' },
          summary: { type: 'string', description: '写进目录表的一句话（section）/ 一句话摘要（session）' },
          keywords: { type: 'string', description: '目录表的关键词列，逗号分隔（可选）' },
          slug: { type: 'string', description: 'mode=session 的文件名 slug（可选）' },
          body: { type: 'string', description: '要写入的 markdown 正文；记忆条目请带上日期与出处' },
        },
        required: ['body'],
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const a = args ?? {}
        const mode = String(a.mode || 'section').toLowerCase()
        if (mode === 'session') {
          const r = writeSession(cfg.memoryDir, cfg, { slug: a.slug, summary: a.summary, body: a.body })
          return `已写入短期记忆：${r.rel}${r.indexed ? '（INDEX 的「最近短期记忆」表已更新）' : '（⚠️ INDEX 里没找到「最近短期记忆」表，未更新索引）'}${r.note ?? ''}`
        }
        const r = writeSection(cfg.memoryDir, cfg, {
          file: a.file,
          title: a.title,
          anchor: a.anchor,
          summary: a.summary,
          keywords: a.keywords,
          body: a.body,
          mode: mode === 'append' ? 'append' : 'section',
        })
        if (r.action === 'appended') return `已追加到 ${r.rel}（现在 ${r.chars} 字符）${r.note ?? ''}`
        return `已${r.action === 'created' ? '新增' : '更新'} ${r.rel} 的小节 #${r.anchor}（现在 ${r.chars} 字符${
          r.action === 'created' ? '，目录表已补行' : ''
        }）${r.note ?? ''}`
      },
    },
  ]

  let n = 0
  const problems = []
  for (const t of tools) {
    // 守卫：parameters 必须是合法 JSON Schema（顶层 type: 'object'）。
    // 非法 schema 会让模型服务端拒绝**每一次**请求（INVALID_REQUEST），
    // 所以宁可少注册一个工具，也绝不能把坏 schema 放进去。
    const p = t.parameters
    if (!p || p.type !== 'object' || typeof p.properties !== 'object') {
      problems.push(`${t.name}(schema)`)
      continue
    }
    try {
      c.tools.register(t)
      n++
    } catch (e) {
      problems.push(`${t.name}(${e?.message ?? e})`)
    }
  }
  if (problems.length > 0) log(c, 'warn', `以下工具未注册：${problems.join('；')}`)
  return n
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const state = { sectionRegistered: false, injectedChars: 0, lastInjectAt: '' }

  // 1) 自动注入：把 INDEX.md 作为系统提示词的一个 section
  try {
    const sp = ctx?.systemPrompt ?? (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined)
    if (sp && typeof sp.section === 'function') {
      sp.section({ name: SECTION_NAME, order: cfg.order, text: () => injectionText(cfg, state) })
      state.sectionRegistered = true
    } else {
      log(ctx, 'warn', 'systemPrompt 服务不可用：记忆不会被自动注入（工具仍可用）')
    }
  } catch (e) {
    log(ctx, 'warn', `注册注入段失败（记忆不会自动注入）：${e?.message ?? e}`)
  }

  // 2) 工具：**只能**通过 ctx.inject(['tools'], …) 取 tools 服务。
  //    ⚠️ Cordis 硬规则：没在 inject 里声明的服务，直接访问 ctx.tools 会抛
  //    `cannot get property "tools" without inject`，整个插件会激活失败（插件页显示"异常"）。
  //    所以这里绝不碰 ctx.tools，只在注入回调里用 c.tools。
  let registered = false
  const register = (c) => {
    if (registered) return
    registered = true
    try {
      const n = registerTools(c, cfg, state)
      log(ctx, 'info', `记忆库 ${cfg.memoryDir} 已加载：工具 ${n} 个，注入 ${cfg.inject ? '开' : '关'}`)
      diag(cfg, `registerTools ok=${n}`)
    } catch (e) {
      log(ctx, 'warn', `注册记忆工具失败：${e?.message ?? e}`)
      diag(cfg, `registerTools threw: ${e?.message ?? e}`)
    }
  }
  diag(cfg, `apply: hasInject=${typeof ctx?.inject === 'function'} section=${state.sectionRegistered}`)
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['tools'], register)
      diag(cfg, 'apply: tools via ctx.inject([tools])')
    } else {
      log(ctx, 'warn', 'ctx.inject 不可用：记忆工具未注册（自动注入仍然有效）')
      diag(cfg, 'apply: ctx.inject unavailable')
    }
  } catch (e) {
    log(ctx, 'warn', `注册记忆工具失败：${e?.message ?? e}`)
    diag(cfg, `tools registration threw: ${e?.message ?? e}`)
  }
}
