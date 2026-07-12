# ShellFix 完整设计方案

> 一个插件，四支柱 + 执行层 + TUI 调度器
> 当前版本 v1.6.0（未提交）→ 目标版本 v1.7.0

---

## 1. 体系概述

### 四命令 + 平台修复

```
┌──────────┬──────────────┬──────────────────┬────────────────────────┐
│  命令     │  类别        │  触发方式        │  一句话                │
├──────────┼──────────────┼──────────────────┼────────────────────────┤
│ /shellfix │ 平台修复     │ 手动 / 自动      │ "让 PowerShell 好用"    │
│ /my       │ 模板系统     │ 手动            │ "帮我省打字"            │
│ /note     │ 笔记系统     │ 手动 / 自动      │ "记录和复用心智"        │
│ /auto     │ 自动化系统   │ 自动 + 手动管理  │ "让 AI 更懂上下文"      │
└──────────┴──────────────┴──────────────────┴────────────────────────┘
```

### 架构分层

```
ShellFix
│
├── 📡 会话层（四命令）—— 作用于输入框和 LLM 回复
│   │                  所有命令优先在 TUI 侧本地处理
│   │
│   ├── /auto    自动化规则定义
│   │   ├── session_start → inject_system_prompt（旧注入模块）
│   │   ├── user_input    → replace / warn（拦截替换）
│   │   ├── llm_output    → collect / notify（自动采集）
│   │   └── 规则管理：list / on/off / mode / require / conditions
│   │
│   ├── /my      手动使用模板
│   │   ├── 渲染 {0}{branch}{date} → appendPrompt 填入输入框
│   │   ├── CRUD：save / rm / show / edit / list / ?
│   │   └── 同步：sync / sync-config / sync --push
│   │
│   ├── /note    手动采集笔记
│   │   ├── #tag#:content 保存 → toast
│   │   ├── #tag# 取出 → appendPrompt
│   │   ├── #tag#:last / cache 缓存上条消息
│   │   └── 层级标签浏览：? / ? <prefix> / rm
│   │
│   └── /kickme  [规划] 条件通知
│       ├── event.on → 匹配条件 → toast + 声音
│       └── 共享条件引擎（与 /auto 同）
│
├── 🔧 执行层（/shellfix）—— 作用于 shell 命令
│   ├── shell.env → 16 Git 免交互变量
│   ├── tool.execute.before → 编码注入 + 6条命令替换
│   └── 管理：cmd / encoding / log / doctor
│
└── ⚙️ 系统层
    ├── TUI 调度器：dispatch → local handler → appendPrompt/showToast
    │   └── 未匹配 → 回退到服务器 command.execute.before（无 LLM）
    ├── 状态持久化：~/.config/opencode/shellfix-state.json
    ├── 条件引擎：os/arch/branch/dirty/tool_exists/file_exists/is_git_repo
    └── 事件订阅：event.on("session.next.*") → 自动触发 /auto /kickme
```

### 前缀设计原则

- `/shellfix` — 保留原名，避免与其它插件撞车
- `/my` — 短且低频，不会被自然语言误触发
- `/note` — 直观
- `/auto` — 旧名 `/in`（v1.6→v1.7 重命名），涵盖自动化语义

---

## 2. 命令体系总表

```
/shellfix <sub> [args]    — 平台修复管家
├── (无参数)               → 状态面板
├── cmd [name] [on/off]   → 命令替换规则管理
├── encoding [on/off]     → 编码注入控制
├── log [on/off]          → 日志输出控制
├── doctor                → 环境诊断
└── help                  → 帮助

/my <sub> [args...]       — 模板系统
├── ?                     → 列出所有模板
├── ? <name>              → 预览模板内容
├── <name> [args...]      → 渲染模板，填入输入框
├── save <name> <content> → 保存模板
├── rm <name>             → 删除模板
├── show <name>           → 查看原始内容
├── edit <name> [content] → 编辑模板
├── sync                  → 同步远程仓库
└── sync-config           → 同步配置管理

/note <sub> [args]        — 笔记系统
├── ?                     → 列出所有顶层标签
├── ? <prefix>            → 浏览标签树
├── #tag#                 → 注入笔记内容到输入框
├── #tag#:<content>       → 保存笔记
├── #tag#:last            → 保存上一条消息
├── cache <text>          → 手动缓存消息
└── rm #tag#              → 删除笔记

/auto <sub> [args]        — 自动化系统
├── list                  → 列出所有模块 + 状态
├── <module>              → 切换模块开关
├── mode [prompt|auto|silent] → 设置模式
├── require <text>        → 临时注入任务目标
├── req_rm                → 清除 require
├── show <module>         → 查看模块内容
├── reset                 → 恢复默认
├── conditions [args]     → 条件引擎管理
└── help                  → 帮助
```

---

## 3. TUI 调度器架构

### 执行流程

```
用户操作（Ctrl+P 或 输入框）
  │
  ├─ TUI 调度器 dispatch(cmd, args)
  │   ├─ handlers.get(cmd) → LocalHandler(args)
  │   │   ├─ 返回 { output } → api.client.tui.appendPrompt({ text })
  │   │   │                   → 填入输入框，用户按回车发送
  │   │   ├─ 返回 { toast }  → api.ui.toast({ message })
  │   │   │                   → 瞬时通知，无需用户操作
  │   │   └─ 返回 null       → 未处理
  │   │
  │   └─ 未处理 → api.client.tui.executeCommand({ command: "|cmd args" })
  │               → 服务器 command.execute.before 处理
  │               → 返回 { parts: [text] }，无 LLM 调用
  │
  └─ LLM 不参与 ✅
```

### 本地 vs 服务器

| 处理方式 | 执行位置 | 有无 LLM | 响应速度 |
|---------|---------|---------|---------|
| TUI 本地 | TUI 进程（客户端） | 无 | 即时 |
| 服务器 command.execute.before | 服务器进程（后端） | 无 | 数毫秒 |
| LLM 调用 | 服务器 + LLM | 有 | 数秒 |

### 本地处理器注册表

| 命令 | TUI 本地处理 | 服务器回退项 |
|------|------------|-------------|
| `/shellfix` | 面板 / cmd / encoding / log / doctor / help | — |
| `/my` | ? / 渲染 / show | save / rm / edit / sync |
| `/note` | ? / #tag# / #tag#:content / rm | :last / cache |
| `/auto` | list / 切换 / mode / require / show / reset / conditions | — |

---

## 4. 存储层设计

### 4.1 目录结构

```
~/.config/opencode/
├── plugins/shell-fix.ts          ← 插件代码
├── plugins/shell-fix-tui.ts      ← TUI 插件代码
│
├── shellfix-state.json           ← 状态持久化
│
└── templates/                    ← 模板 + 笔记存储
    ├── index.json                ← 合并索引
    └── remote/                   ← Git 同步目录
```

### 4.2 状态模型

```typescript
interface PluginState {
  version: string;
  encoding: boolean;          // 编码注入开关
  log: boolean;               // 日志输出
  cmdRules: {                 // 命令替换规则
    export: boolean;
    which: boolean;
    source: boolean;
    touch: boolean;
    rm: boolean;
    chmod: boolean;
  };
  auto: {                     // 自动化系统（旧名 inject）
    modules: Record<string, boolean>;
    mode: "prompt" | "auto" | "silent";
    require: string;
    conditions: Record<string, InjectCondition[]>;
  };
  sync: SyncConfig;           // 远程同步配置
}
```

### 4.3 模板/笔记存储

```
~/.config/opencode/templates/index.json

{
  "version": 1,
  "templates": [
    { "name": "ys", "template": "请验收版本 {0}...", "builtin": true, ... }
  ],
  "notes": [
    { "tag": "arch/db", "content": "连接池 10 连接", "created": "..." }
  ]
}
```

三层优先级：builtin < remote < user

---

## 5. ShellFix 详细设计（不变）

参见 §4 历史文档，核心功能：

| 钩子 | 功能 |
|------|------|
| `shell.env` | 16 个 Git 免交互环境变量 |
| `tool.execute.before` | 编码注入 + 6条命令替换（export/which/source/touch/rm/chmod）|

---

## 6. /my 模板系统详细设计

### 6.1 模板渲染

**支持的变量：**

| 变量 | 来源 | 示例 |
|------|------|------|
| `{0}` `{1}`... | 位置参数 | `/my ys 1.8` → `{0}=1.8` |
| `{date}` | 当天日期 | `2026-07-12` |
| `{time}` | 当前时间 | `14:30` |
| `{datetime}` | 组合 | `2026-07-12 14:30` |
| `{user}` | 系统用户名 | `coffe` |
| `{branch}` | Git 当前分支 | `feature/xxx` |
| `{project}` | 项目目录名 | `project-name` |
| `{cwd}` | 工作目录 | `/path/to/project` |

### 6.2 内置模板

| 名 | 用途 | 模板 |
|----|------|------|
| `ys` | 验收 | `请验收版本 {0}` |
| `review` | 代码审查 | `请 review {branch} 的 {0}` |
| `pr` | 创建 PR | `PR: {0}\n改动说明\n...` |
| `bug` | 报告 Bug | `Bug: {0}\n环境: {1}\n...` |
| `commit` | Commit Message | `{0}({1}): {2}` |
| `explain` | 解释代码 | `请解释 {0} 代码\n{1}` |
| `deploy` | 部署 | `请部署版本 {0} 到 {1}` |

---

## 7. /note 笔记系统详细设计

### 7.1 概念

笔记通过 `#层级/标签#` 格式存储和检索，与 `/my` 共享同一存储引擎（`~/.config/opencode/templates/index.json` 的 `notes` 分区）。

### 7.2 标签层级

```
#架构/存储层#        → 两级标签，/ 为层级分隔符
#架构/钩子设计#      → 同级不同子
#规则/编码规范#      → 另一棵树
```

查询 `#架构#` 时显示子级，查询 `#架构/存储层#` 时输出内容。

### 7.3 命令语法

```
/note ?                    → 列出所有顶层标签
/note ? 架构               → 列出 #架构/ 下的子标签
/note #架构/存储层#        → 注入笔记内容到输入框
/note #架构/存储层#:内容   → 保存笔记
/note #架构/存储层#:last   → 保存上一条消息
/note cache <text>         → 手动缓存文本
/note rm #架构/存储层#     → 删除笔记
```

### 7.4 自动采集（规划）

通过 `event.on("session.next.text.ended")` 监听 LLM 回复，正则匹配 `#标签#` 自动采集到笔记。

---

## 8. /auto 自动化系统详细设计

### 8.1 模块列表

| 模块名 | 用途 | 内容摘要 | 默认 | 条件 |
|--------|------|---------|------|------|
| `coding` | 编码规范 | TS 严格模式、命名规范 | **on** | always |
| `windows` | 平台提醒 | "Windows + PowerShell" | **on** | os=win32 |
| `tech-stack` | 技术栈声明 | 项目技术栈自动检测 | **on** | always |
| `review` | Review 清单 | 逻辑/边界/性能/安全 | off | always |
| `security` | 安全提醒 | 凭据/SQL注入/XSS | off | always |
| `git` | Git 规范 | 分支命名/commit 格式 | off | is_git_repo |
| `requirements` | 当前目标 | 通过 `/auto require` 临时注入 | 动态 | always |

### 8.2 三种模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `auto` | 自动注入，不提示 | 稳定期，信任规则 |
| `prompt` | 会话启动时引导选择 | 调试期，灵活开关 |
| `silent` | 不注入 | 不需要时 |

### 8.3 条件引擎

| 谓词 | 示例 | 说明 |
|------|------|------|
| `os` | `os=win32` | 平台匹配（glob） |
| `arch` | `arch=x64` | CPU 架构 |
| `branch` | `branch=feature/*` | Git 分支通配 |
| `dirty` | `dirty=true` | 有未提交改动 |
| `tool_exists` | `tool_exists=dotnet` | 工具是否存在 |
| `file_exists` | `file_exists=src/*.cs` | 文件是否存在 |
| `is_git_repo` | `is_git_repo=true` | 是 Git 仓库 |
| `always` | — | 始终匹配 |
| `never` | — | 永不匹配 |

条件评估逻辑：手动开关 ON + 条件全匹配 → 生效。AND 逻辑。

### 8.4 注入机制

通过 `experimental.chat.system.transform` 钩子在每次 LLM 调用前，将已启用模块的内容追加到 system prompt。

---

## 9. 技术栈

- 语言：TypeScript（零外部运行时依赖）
- 服务器插件：`@opencode-ai/plugin` — Hooks API
- TUI 插件：`@opencode-ai/plugin/tui` — TuiPlugin API
- 状态存储：JSON 文件（`~/.config/opencode/`）
- Git 同步：原生 `git` CLI 调用（`execSync`）
- 构建：OpenCode 原生加载（`.ts` 直接运行）

---

## 10. 版本规划

```
v1.6.0 — 平台基础（已完成，未提交）
├── /auto 模块化 + 条件引擎（旧名 /in）
├── 代码模块化：state / template-store / auto-rules
├── TUI 调度器：dispatch → 本地 handler
├── TUI API 修复：api.tui → api.client.tui
└── /auto 重命名（原 /in）

v1.7.0 — 增强与稳定（规划中）
├── /my 增强：edit / sync --push
├── /note 增强：:last 真正实现 / cache 手动缓存
├── 事件订阅：event.on → 自动采集 #标签#
├── 全面错误处理 + 统一错误格式
└── 性能优化：条件评估缓存 / 分支名缓存

v1.8.0 — 自动化升级
├── /kickme 通知系统
├── /auto 自动化管线（user_input / llm_output 拦截）
├── 会话级自动注入（TUI 启动提示）
└── 标签 timeline 浏览

v2.0.0 — 正式版
├── 全量文档 + CHANGELOG
├── 完整测试覆盖
└── MCP Server（可选）
```

---

## 11. 文件结构

```
OpenCode-Plugins-ShellFix/
├── README.md
├── src/
│   ├── shell-fix.ts           ← 服务器插件（Hooks）
│   ├── shell-fix-tui.ts       ← TUI 插件（调度器）
│   └── lib/
│       ├── state.ts           ← 状态持久化
│       ├── template-store.ts  ← 模板/笔记存储
│       └── auto-rules.ts      ← 自动化模块定义
├── docs/
│   ├── D0-ShellFix-全功能设计.md  ← 本文
│   ├── 01-方案评估.md
│   ├── 02-完整修复方案.md
│   └── _Draft/               ← 历史方案草稿
└── .opencode/
    ├── opencode.json          ← "plugin": ["list"]
    └── node_modules/          ← @opencode-ai/plugin
```

---

## 12. 命名变更记录

| v1.6.0 | v1.7.0 | 原因 |
|--------|--------|------|
| `inject-modules.ts` | `auto-rules.ts` | /in → /auto 重命名 |
| `InjectState` / `InjectMode` | `AutoState` / `AutoMode` | 同上 |
| `INJECT_MODULES` | `AUTO_MODULES` | 同上 |
| `/in` 命令 | `/auto` 命令 | 语义扩展：注入 → 自动化 |
| `api.tui.executeCommand` | `api.client.tui.executeCommand` | API 路径修复 |
| 三支柱 | 四支柱 + 执行层 | 架构升级 |