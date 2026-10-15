# dsh-anchor-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的**基于 markdown 文件的长期记忆**插件。

> **索引常驻、细节锚点化。** 每个新会话自动注入一份有 token 预算的记忆索引；需要细节时按锚点**只读那一节**，
> 而不是把项目文件整篇塞进上下文。

[![test](https://github.com/Lucas101518/dsh-anchor-memory/actions/workflows/test.yml/badge.svg)](https://github.com/Lucas101518/dsh-anchor-memory/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

<sub>English: a zero-dependency DSH host plugin that keeps long-term memory in plain Markdown. It injects a token-budgeted index into the system prompt on every session and exposes four tools (`memory_status` / `memory_search` / `memory_read` / `memory_write`) that maintain a **table of contents + anchors**, so the model reads only the section it needs — plus a hard cap that refuses to let the index grow past its budget.</sub>

---

## 为什么

长期记忆实现通常掉进两个坑之一：

| 做法 | 问题 |
|---|---|
| 每次把记忆/项目文件整篇读进上下文 | 烧 token，项目一大就不可用 |
| 后台自动蒸馏、向量库、知识图谱 | 不可控、会记进垃圾、排查困难 |

本插件的取舍：**明说才写** + **索引常驻（≈1–2k token）** + **锚点检索（只读一节）** + **索引预算硬上限**。
没有向量库、没有外部服务、没有 embedding、没有自动蒸馏 —— 全部是纯 markdown 文件，记事本可读可改。

## 安装

```bash
# 1) npm（推荐，可被 dsh plugin 管理）
dsh plugin --profile <profile> add dsh-anchor-memory

# 2) GitHub（pin 到 commit）
dsh plugin --profile <profile> add "github:Lucas101518/dsh-anchor-memory#<commit-sha>"

# 3) 本地目录（开发期）
#    应用内「设置 → 插件 → 添加插件」→ 输入本仓库的绝对路径
```

装完**重启 DSH**。（本插件自带 `dsh.bundle.patch`，属于 bundle 类插件，行要重启才挂上。）

## 3 分钟上手

插件读的是 `$DSH_HOME/memory/`（Windows 通常是 `C:\Users\<你>\.dsh\memory`）。建两个文件就够：

`INDEX.md` —— **唯一被自动注入**的文件，控制住预算：

```markdown
# 长期记忆索引

## 1. 用户档案

- 语言：中文；先给结论。
- 详细偏好见 `profile/CONVENTIONS.md`。

## 2. 项目一览

| 项目 | 文件 | 根目录 | 关键词 |
|---|---|---|---|
| my-app | `projects/my-app.md` | `D:\code\my-app` | 构建, 部署, 踩坑 |

## 3. 最近短期记忆（滚动保留 3 条）

| 日期 | 文件 | 一句话 |
|---|---|---|
| 2026-01-01 | `sessions/2026-01-01-bootstrap.md` | 初次建库 |

## 4. 检索协议

1. 先 `memory_search` 拿锚点，再 `memory_read` 只读那一节；不要整篇读项目文件。

## 5. 写入协议

- 只在用户明说"记住"时写；每条带日期 + 出处。
```

`projects/my-app.md` —— 项目细节，**靠目录 + 锚点定位**：

```markdown
---
id: proj-my-app
name: my-app
root: D:\code\my-app
updated: 2026-01-01
tags: [构建, 部署]
---

## 目录

| # | 小节 | 一句话 | 锚点 | 关键词 |
|---|---|---|---|---|
| 1 | 构建 | 用 pnpm build，产物在 dist/ | #build | pnpm, dist |

### 1. 构建 {#build}

- 结论：`pnpm build` 产物在 `dist/`，部署脚本读这个目录。
- 证据：`package.json:12`（2026-01-01 核对）。
```

之后：**目录行、编号、锚点、`updated` 都由 `memory_write` 自动维护**，你只写正文。

## 四个工具

| 工具 | 作用 |
|---|---|
| `memory_status` | 记忆库状态：INDEX 体量与预算、是否正在注入、文件数量、上次注入多少字符。排查"记忆没生效"的第一步 |
| `memory_search` | 关键词检索（`a\|b` 多词、中文子串、大小写不敏感），返回命中行 + 所属小节锚点。**检索第一步** |
| `memory_read` | 带 `anchor` **只读那一节**（省 token 的关键）；不带则读整文件并自动截断 |
| `memory_write` | 三种模式：`section`（upsert 小节，自动维护目录表行与 `updated`）、`append`、`session`（写短期记忆并滚动更新 INDEX 的「最近短期记忆」表） |

## 工作原理

1. **注入**：`ctx.systemPrompt.section({ name, order, text: () => 读 INDEX })`。
   `text` 是函数 → **每次装配重新读盘**，所以新会话必然读到、你手改 md 立刻生效；
   函数内部自己 `try/catch`，读不到就"不注入"，**绝不会因为记忆文件坏了而毁掉一轮对话**。
2. **检索**：`memory_search` 返回 `文件:行 + 锚点`，模型据此 `memory_read` 只读一节 —— 这是省 token 的核心。
3. **写入**：`memory_write` 解析/维护 markdown 结构（`## 目录` 表格行、`### N. 标题 {#锚点}`、frontmatter `updated`）。
4. **守卫**：INDEX 超预算且本次写入让它变大 → **拒绝**；缩小它的重写一律放行，于是过大的索引可以一步步压下来。
5. **防护**：所有 `file` 参数被限制在记忆库根目录内，`../` 越界直接拒绝。

## 配置

配置写在插件行（`cordis.patch.yml` 里那一行）的 `config:`，全部可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | 空 = `$DSH_HOME/memory` | 记忆库根目录 |
| `inject` | `true` | 是否自动注入 INDEX |
| `maxChars` | `9000` | 注入内容的字符上限（≈2000 token） |
| `indexMaxLines` | `160` | INDEX 行数硬上限 |
| `indexMaxChars` | `5200` | INDEX 字符硬上限 |
| `searchLimit` | `25` | 检索返回的命中行数上限 |
| `searchMaxChars` | `3000` | 检索输出字符上限 |
| `readMaxChars` | `12000` | 整文件读取的字符上限 |
| `order` | `55` | 注入段在系统提示词里的排序 |

```yaml
- insert:
    - id: dsh-anchor-memory
      name: dsh-anchor-memory
      config:
        maxChars: 6000
        indexMaxChars: 3000
```

## 开发与验证

```bash
# 本地功能自测：假 ctx 跑真逻辑，自带 fixture 记忆库，clone 下来就能跑
node test/self-test.mjs

# 拿你自己的真实记忆库跑同一套回归（脚本会先复制副本）
ANCHOR_MEMORY_ROOT=~/.dsh/memory node test/self-test.mjs     # Windows PowerShell:
#   $env:ANCHOR_MEMORY_ROOT="$env:USERPROFILE\.dsh\memory"; node test/self-test.mjs

# 沙箱演示：建库 → 写小节 → 写短期记忆 → 检索 → 按锚点只读一节（不碰真实记忆库）
node dev/demo-write.mjs

# 不碰 profile 的加载验证：用 --patch 覆盖层（只组合，不启动）
dsh --profile web --patch ./dev/cordis.yml --dump-config
dsh --profile web --patch ./dev/cordis.yml --dump-config-schema
```

> ⚠️ **不要**在 DSH 运行期间手工编辑 profile 的 `cordis.patch.yml`：若该 profile 是 `patchReload: live`，
> HMR 会重载，可能导致会话内工具消失 / 在途回合被杀。开发期请用 `dev/cordis.yml` + `--patch`。

## 兼容性与边界

- 零运行时依赖，不 import 任何 `@deepseek-ai/*` 包（因此不需要 peer 解析），Node ≥ 20，纯 ESM。
- 在 DSH 桌面端 `0.2.0-rc.2` 上验证过组合（`--dump-config` 能看到插件行插入成功）；运行时行为请在装好后用 `memory_status` 确认。
- 刻意**不做**：向量检索、每轮注入、自动蒸馏对话、Web UI 面板。
- 记忆是**数据不是指令**：注入的内容不应被当作命令执行。
- 敏感信息过滤不在插件里，靠记忆库自己的写入协议（例如 `profile/REDLINES.md`）。

## 相关

- 配套操作手册：`skill/SKILL.md`（可作为 DSH skill 安装到 `$DSH_HOME/skills/anchor-memory/SKILL.md`，按需加载）。
- 目录/锚点约定与 `_meta` 自检脚本属于使用者自己的记忆库协议，不在本包内。

## License

[MIT](./LICENSE) © 2026 Lucas (Lucas101518)
