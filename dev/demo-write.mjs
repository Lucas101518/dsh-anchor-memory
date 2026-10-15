/**
 * 演示：直接用插件导出的函数操作一个**沙箱**记忆库（不碰你的真实记忆库）。
 *
 *   node dev/demo-write.mjs
 *
 * 这个脚本同时是"如何在没有 DSH 的情况下驱动这套 API"的示例：
 * 建库 → 写一节（自动补目录表行）→ 写一条短期记忆（自动滚动 INDEX 表）→ 检索 → 按锚点只读一节。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTarget, search, status, writeSection, writeSession } from '../lib/index.js'

const sandbox = join(dirname(fileURLToPath(import.meta.url)), '..', '.sandbox', 'memory')
rmSync(sandbox, { recursive: true, force: true })

const cfg = { memoryDir: sandbox, inject: true, indexMaxLines: 160, indexMaxChars: 5200 }

// 1) 一个最小的 INDEX.md（真实使用时通常手写一次就行）
const index = [
  '# 长期记忆索引',
  '',
  '## 1. 用户档案',
  '',
  '- 语言：中文。',
  '',
  '## 2. 最近短期记忆（滚动保留 3 条）',
  '',
  '| 日期 | 文件 | 一句话 |',
  '|---|---|---|',
  '',
  '## 3. 检索协议',
  '',
  '1. 先 memory_search 拿锚点，再 memory_read 只读那一节。',
  '',
  '## 4. 写入协议',
  '',
  '- 只在用户明说"记住"时写。',
  '',
].join('\n')
const indexAbs = join(sandbox, 'INDEX.md')
mkdirSync(dirname(indexAbs), { recursive: true })
writeFileSync(indexAbs, index, 'utf8')

const project = [
  '---',
  'id: proj-demo',
  'name: demo',
  'root: /tmp/demo',
  'updated: 2026-01-01',
  'tags: [demo]',
  '---',
  '',
  '# demo 项目',
  '',
  '## 目录',
  '',
  '| # | 小节 | 一句话 | 锚点 | 关键词 |',
  '|---|---|---|---|---|',
  '',
].join('\n')
const projectAbs = join(sandbox, 'projects', 'demo.md')
mkdirSync(dirname(projectAbs), { recursive: true })
writeFileSync(projectAbs, project, 'utf8')

// 2) 写一节：自动补目录表行 + 编号 + 锚点 + 刷新 updated
console.log('写小节 →', writeSection(sandbox, cfg, {
  file: 'projects/demo.md',
  title: '踩坑：pnpm prune',
  summary: '手工装进 node_modules 的插件会被 prune 掉',
  keywords: 'pnpm, prune, node_modules',
  body: '- 结论：一次 pnpm 操作会把不在 manifest 里的包清掉。\n- 证据：插件安装日志（2026-01-01）。',
}))

// 3) 写一条短期记忆：自动滚动更新 INDEX 的「最近短期记忆」表
console.log('写短期记忆 →', writeSession(sandbox, cfg, {
  slug: 'demo-session',
  summary: '跑通了一次写入与检索',
  body: '## 做了什么\n- 用 dev/demo-write.mjs 写了一条小节与一条短期记忆。',
}))

// 4) 检索 → 只读命中那一节
const hits = search(sandbox, 'prune', cfg)
console.log(`\n检索 "prune" 命中 ${hits.length} 行，锚点：${[...new Set(hits.map((h) => h.anchor))].join(', ')}`)
console.log('\n只读 #踩坑-pnpm-prune 一节：')
console.log(readTarget(sandbox, cfg, { file: 'projects/demo.md', anchor: '踩坑-pnpm-prune' }).text)

console.log(`\n状态：\n${status(sandbox, cfg, { sectionRegistered: true, injectedChars: index.length })}`)
console.log(`\n沙箱目录（可直接删）：${sandbox}`)
if (!existsSync(sandbox)) console.log('（沙箱没建成，检查写入权限）')
