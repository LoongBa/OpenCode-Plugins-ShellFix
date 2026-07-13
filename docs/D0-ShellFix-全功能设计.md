# ShellFix 完整设计方案

> 一个插件，三大修复 + TUI 调度器 + MCP
> 当前版本 v2.2.2

---

## 1. 体系概述

### 命令体系

```
斜杠命令（仅 2 个）：/my  /auto
Ctrl+P palette：13 个子命令，统一在 ShellFix 分组下
```

| 入口 | 类型 | 一句话 |
|------|------|--------|
| `status` | palette | 所有配置一览 |
| `encoding` | palette | 中文不乱码 |
| `bash` | palette | bash→PowerShell 适配 |
| `log` | palette | 记录操作信息 |
| `git-env` | palette | 16 个非交互变量避免等待 |
| `git-eol` | palette | 避免换行警告 |
| `kickme` | palette | 关键词通知 |
| `banner` | palette | 启动版本信息开关 |
| `sysinfo` | palette | 查看系统信息 |
| `about` | palette | 版本与更新 |
| `help` | palette | 命令参考 |
| `/my` | slash + palette | 预设文本模板 |
| `/auto` | slash + palette | 自动注入上下文 |

### 架构分层

```
ShellFix
│
├── TUI 调度器（13 条 palette 命令）
│   ├── status        状态总览
│   ├── encoding      编码注入开关
│   ├── bash          bash→PowerShell 适配
│   ├── log           日志开关
│   ├── git-env       非交互环境变量
│   ├── git-eol       换行符警告处理
│   ├── kickme        关键词通知（用法帮助）
│   ├── banner        启动版本信息开关
│   ├── sysinfo       系统诊断
│   ├── about         版本与更新检测
│   ├── help          命令参考
│   ├── /my           模板系统
│   └── /auto         自动化系统
│
├── 🔧 执行层（shell-fix.ts）
│   ├── shell.env → 16 个非交互环境变量
│   ├── tool.execute.before → 编码注入 + 6 条命令替换
│   ├── experimental.session.compacting → 保护关键上下文
│   └── experimental.chat.system.transform → 自动注入
│
└── ⚙️ 系统层
    ├── TUI 本地处理：dispatch → 本地 handler → toast/dialog
    ├── 状态持久化：~/.config/opencode/shellfix-state.json
    ├── 版本号：单一事实来源 src/lib/state.ts PLUGIN_VERSION
    ├── 分组标题：ShellFix vX.Y.Z（黄色标签，Ctrl+P 可见）
    └── 启动日志：可由 banner 开关控制显示
```

### 前缀设计原则

- `ShellFix` — palette 分组前缀，所有子命令统一归在黄色标签下
- `/my` — 短且低频，不会被自然语言误触发
- `/auto` — 涵盖自动化语义

---

## 2. Palette 命令总表（Ctrl+P）

```
ShellFix v2.2.2  ← 黄色分组标题
├── status       状态总览
├── encoding     中文不乱码
├── bash         适配 Powershell 避免出错
├── log          记录操作信息
├── git-env      避免等待交互
├── git-eol      避免换行警告
├── kickme       关键词通知
├── banner       启动版本信息
├── sysinfo      查看系统信息
├── about        版本与更新
├── help         命令参考
├── my           预设文本模板
└── auto         自动注入上下文
```

### 斜杠命令（2 个）

```
/my <sub> [args...]       — 模板系统（slash + palette）
├── ?                     → 列出所有模板
├── ? <name>              → 预览模板内容
├── <name> [args...]      → 渲染模板，填入输入框
├── save <name> <content> → 保存模板
├── rm <name>             → 删除模板
├── show <name>           → 查看原始内容
├── edit <name> [content] → 编辑模板
├── sync                  → 同步远程仓库
└── sync-config           → 同步配置管理

/auto <sub> [args]        — 自动化系统（slash + palette）
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

### 已移除的命令（v2.2）

| 命令 | 原因 |
|------|------|
| `/shellfix` | 配置功能迁移到 palette |
| `/note` | 笔记功能未被使用，V3 规划 tag 系统替代 |
| `/kickme` | 通知规则管理通过 LLM 斜杠命令，palette 仅展示帮助 |
| `/dynamic` | 动态上下文未被使用 |

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
| `status` | DialogAlert 展示所有开关状态 | — |
| `encoding` | toggle + toast | — |
| `bash` | DialogSelect 切换 6 条规则 | — |
| `log` | toggle + toast | — |
| `git-env` | DialogAlert 展示 16 个变量 | — |
| `git-eol` | DialogSelect 三选一模式 | — |
| `kickme` | DialogAlert 展示规则数量 + 用法 | — |
| `banner` | toggle + toast | — |
| `sysinfo` | DialogAlert 展示 OS/Shell 版本 | — |
| `about` | DialogAlert + GitHub API 检测更新 | — |
| `help` | DialogAlert 命令参考 | — |
| `/my` | 模板选择/编辑/渲染 | save / rm / edit / sync |
| `/auto` | 模块切换/模式设置/列表 | — |

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
v2.2.x — 当前系列
├── v2.2.0  命令体系精简：移除 4 个斜杠命令，保留 /my /auto
├── v2.2.1  单面板→独立 palette 子命令 + 分组标题显示版本号
├── v2.2.2  标题规范化（无 emoji，ShellFix [英文] [简介]）
│           git-env/banner/kickme 新增入口
│           sysinfo/bash 改名
│           TUI/逻辑分离
│           启动日志开关
│
v3.0（规划）
├── Tag 系统：自动/手动打标签
│   ├── 注入提示词让 LLM 根据规则自动打标签
│   └── experimental.session.compacting 保护标签不被压缩
├── MCP Server
│   ├── Resources：按标签浏览/检索
│   ├── Tools：CRUD 标签（LLM 可直接管理）
│   └── Notifications：标签变化事件
├── 外部通知系统
│   ├── api.ui.toast() 即时气泡
│   └── BurntToast 系统通知（Windows Action Center）
└── kickme 增强
    ├── 条件规则引擎
    ├── 频率限制/冷却
    └── 跨会话匹配
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

| v1.6.0 | v1.7.0 | v2.2.x | 原因 |
|--------|--------|--------|------|
| `inject-modules.ts` | `auto-rules.ts` | — | /in → /auto |
| `InjectState` / `InjectMode` | `AutoState` / `AutoMode` | — | 同上 |
| `INJECT_MODULES` | `AUTO_MODULES` | — | 同上 |
| `/in` | `/auto` | — | 语义扩展 |
| `api.tui.executeCommand` | `api.client.tui.executeCommand` | — | API 路径修复 |
| — | 三支柱 + 执行层 | 13 条 palette + 2 slash | 体系升级 |
| — | — | `doctor` → `sysinfo` | 更直观 |
| — | — | `cmd` → `bash` | 语义更准 |
| — | — | `/shellfix` `/note` `/kickme` `/dynamic` | 移除，迁移到 palette |

---

## 13. V3 规划 — 外部通知系统

### 13.1 动机

kickme 目前通过 `api.ui.toast()` 在 OpenCode 内弹气泡，但：
- 用户关闭 OpenCode 或切到后台时看不到
- 无法做到 Windows 系统级通知（Action Center 留存）
- 缺乏按钮/输入等交互能力

### 13.2 方案对比

| 方案 | 原理 | 延迟 | 功能 | 集成难度 |
|------|------|------|------|---------|
| `api.ui.toast()` | OpenCode TUI API | 0ms | 纯文本气泡 | 零 |
| **BurntToast** (PowerShell) | WinRT Toast API | ~300-800ms/次 | 按钮/输入/图片/进度条/Action Center | 低（execSync 调用） |
| node-notifier | SnoreToast.exe C++ 子进程 | ~50-100ms | 基础 toast（按钮有 bug） | 中（需打包 exe） |
| node-powertoast + NodeRT | 原生 WinRT 绑定 | ~50ms | 全功能 | 中（需编译） |

**推荐方案：BurntToast**

优势：
- 纯 PowerShell 模块，无需编译
- 支持按钮、输入框、选择框、进度条、Hero 图片
- `-Urgent` 参数可突破 Focus Assist
- Action Center 完整集成（历史记录、分组、替换）
- 事件回调（Activated/Dismissed/Failed）支持

劣势：
- 每次 spawn PowerShell 进程开销 ~300-800ms
- 需要用户预先 `Install-Module -Name BurntToast`
- 自定义 AppId 在 v1.0.0 被移除（显示为 PowerShell）

### 13.3 架构设计

```
kickme 关键词匹配 → api.ui.toast()       ← 即时气泡（OpenCode 内）
                  ↓ 条件满足时追加
            spawn BurntToast              ← 系统通知（Windows Action Center）
                  ↓
            New-BurntToastNotification
              -Text "消息内容"
              -Button "打开" -Arguments "url"
              -Urgent (突破专注助手)
              -UniqueIdentifier (去重/替换)
```

**调用方式（从 TUI 插件）：**

```typescript
const { execSync } = require("child_process");
execSync(
  `powershell -NoProfile -Command "Import-Module BurntToast; New-BurntToastNotification -Text '${msg}' -Button '打开' -Arguments '...'"`,
  { timeout: 5000, windowsHide: true }
);
```

**优化方案：** 保持一个常驻 PowerShell 进程，通过 stdin 管道输入命令，避免每次 spawn 的 ~300ms 进程创建开销。

### 13.4 V3 路线图

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| P0 | kickme 恢复为 palette 入口 + 斜杠命令管理 | ✅ 已完成 |
| P1 | 定义 Windows 通知条件规则（匹配变体/频率限制） | 高 |
| P2 | 集成 BurntToast 作为系统通知后端 | 高 |
| P3 | 新增 note/tag + notification MCP Server | 中 |
|   | - MCP 资源：`shellfix://kickme/rules` | |
|   | - MCP 工具：`kickme_add_rule` / `kickme_send_notification` | |
|   | - MCP 通知：事件驱动，LLM 可调用 | |
| P4 | 跨平台通知（macOS: notification-center, Linux: notify-send）| 低 |

### 13.5 技术约束

- BurntToast 要求 Windows 10+ / Server 2019+
- 无管理员权限也可运行（需 `-Scope CurrentUser` 安装模块）
- SYSTEM 账户下不能直接弹通知（需 `Invoke-Command` 回用户会话）
- 通知时长：标准 7s / 长 25s（无法常驻，除非用 `IncomingCall` 场景）
- 点击事件需要 PowerShell 进程保持存活