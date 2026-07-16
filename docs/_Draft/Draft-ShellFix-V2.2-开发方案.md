# v2.2 开发方案 — 命令体系精简 + Palette 配置面板 + 命令错误追踪

> 当前版本：v2.2.9-dev
> 审核日期：2026-07-16

---

## 一、目标

### 1.1 精简命令体系

移除 4 个低使用率斜杠命令，仅保留高频命令 `/my` 和 `/auto`：

| 命令 | 操作 | 理由 |
|------|------|------|
| `/shellfix` | **移除** | 配置功能迁移到 Ctrl+P palette |
| `/note` | **移除** | 笔记功能未被实际使用 |
| `/kickme` | **移除** | 通知规则未被实际使用 |
| `/dynamic` | **移除** | 动态上下文未被实际使用 |
| `/my` | **保留** | 模板系统高频使用 |
| `/auto` | **保留** | 自动化系统活跃使用 |

### 1.2 Palette 配置入口重构

将 `/shellfix` 的所有配置功能重新实现为**独立 palette 子命令**，每条一个 Ctrl+P 入口，无需进入子菜单即可直达目标功能。纯 TUI 侧处理，零 LLM 成本。

| palette 入口 | 功能 |
|-------------|------|
| `shellfix` | 状态总览 |
| `shellfix.encoding` | 编码注入开关 |
| `shellfix.cmdrules` | 命令规则管理 |
| `shellfix.log` | 日志开关 |
| `shellfix.gitlineending` | Git 换行符模式 |
| `shellfix.doctor` | 环境诊断 |
| `shellfix.about` | 关于 + 联网检测更新（唯一显示版本号的入口） |
| `shellfix.help` | 帮助 |
| `shellfix.my` | 模板系统 |
| `shellfix.auto` | 自动化系统 |

### 1.3 "关于" + 检测更新

新增 `shellfix.about` palette 入口：
- 显示版本号、功能清单
- 通过 GitHub API 查询最新 release 版本
- 对比后提示"已是最新"或"新版本可用"

### 1.3 修复 Crash

- TUI 插件 state 加载失败时 palette 命令崩溃（`undefined.length`）
- `listTemplates()` 未加空值兜底

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shell-fix-tui.ts` | **修改** | 单个 shellfix 面板 → 8 条独立 palette 子命令 + 新增 about（含 GitHub API 检测更新）+ 移除死代码 + 修复 crash |
| `src/shell-fix.ts` | **修改** | 简化 PIPE_CMD_RE/SLASH_CMD_RE，移除已删除命令的 handler |
| `src/lib/state.ts` | **修改** | 版本号 v2.1.1 → v2.2.1 |
| `deploy.ps1` | **修改** | 新增 lib/ 目录部署，动态读取版本号 |
| `CHANGELOG.md` | **修改** | 新增 v2.2.0/2.2.1 变更记录 |
| `README.md` | **修改** | 版本号更新 |
| `~/.config/opencode/opencode.jsonc` | **修改** | `command` 节仅保留 my 和 auto |

---

## 三、详细设计

### 3.1 Palette 设计

**入口**：Ctrl+P → 每个配置项独立可见，搜索 `shellfix` 即可过滤。

**实现**：14 条独立 `TuiCommand`，各有一条 `name` + `title` + `namespace: "palette"`，点击直接执行。

**Palette 列表**（所有命令共用一个 `category` 分组标题 `ShellFix v${PLUGIN_VERSION}`，黄色显示）：

| 名称 | 标题 | 行为 |
|------|------|------|
| `shellfix` | `ShellFix status 状态总览` | DialogAlert 展示所有开关状态 |
| `shellfix.encoding` | `ShellFix encoding 中文不乱码` | DialogAlert 显示状态，确认后开关 |
| `shellfix.bash` | `ShellFix bash 适配 Powershell 避免出错` | DialogSelect 列出命令规则，点击切换 |
| `shellfix.log` | `ShellFix log 记录操作信息` | DialogAlert 显示状态，确认后开关 |
| `shellfix.git-env` | `ShellFix git-env 避免等待交互` | DialogAlert 展示 16 个已注入的环境变量 |
| `shellfix.git-eol` | `ShellFix git-eol 避免换行警告` | DialogAlert 展示当前模式 + 切换方法 |
| `shellfix.kickme` | `ShellFix kickme 关键词通知` | DialogAlert 展示规则数 + 用法 |
| `shellfix.banner` | `ShellFix banner 启动版本信息` | DialogAlert 显示状态，确认后开关 |
| `shellfix.sysinfo` | `ShellFix sysinfo 查看系统信息` | DialogAlert 展示 OS/版本/架构 + Shell 版本 |
| `shellfix.about` | `ShellFix about 版本与更新` | DialogAlert + 异步 GitHub API 检测更新 |
| `shellfix.help` | `ShellFix help 命令参考` | DialogAlert 展示所有 palette 命令 |
| `shellfix.my` | `ShellFix my 预设文本模板` | DialogAlert 展示模板列表 + `/my` 用法 |
| `shellfix.note` | `ShellFix note 笔记标签` | DialogAlert 展示笔记数 + `/note` 用法 |
| `shellfix.auto` | `ShellFix auto 自动注入上下文` | DialogAlert 展示模块状态 + `/auto` 用法 |
| `shellfix.cmd-errors` | `ShellFix cmd-errors 命令错误日志` | DialogAlert 展示失败命令列表 + 清除功能 |

> 原则：**版本号显示在 palette 黄色分组标题上**（如 `ShellFix v2.2.7`），每个 palette 条目标题不显示版本号。
> 原则：**无 emoji**，命令名用英文，简介用中文一目了然。
> 注意：`DialogSelect` 因 OpenCode TUI 内部渲染崩溃 bug，`my`/`auto`/`git-eol` 三个入口已改用 `DialogAlert`，交互操作通过斜杠命令。

### 3.2 移除的死代码

#### TUI 插件 (shell-fix-tui.ts)

| 移除内容 | 行数 | 说明 |
|---------|------|------|
| 原 palette 命令 shellfix.status/note/kickme/dynamic | ~80 行 | 替代为 8 条独立 palette 子命令 |
| note handler + 辅助函数 | ~110 行 | NOTE_SAVE_RE/NOTE_TAG_RE/listTagTree/saveNote 等 |
| kickme handler + 辅助函数 | ~95 行 | listKickmeRules/addKickmeRule 等 |
| dynamic handler + 辅助函数 | ~100 行 | listDynamicRules/addDynamicRule 等 |
| buildShellFixPanel/help/doctor | ~100 行 | 替换为内联 DialogAlert |
| autoCollectTags/checkKickmeRules/checkDynamicRules | ~80 行 | 事件订阅钩子相关 |
| setLastMessage/getLastMessage/_lastMessage | ~15 行 | note 系统缓存 |
| 事件订阅回调 | ~30 行 | session.next.prompted/ended |
| **合计移除** | **~610 行** | |

#### 服务端插件 (shell-fix.ts)

| 移除内容 | 说明 |
|---------|------|
| handleShellFixCommand + 子函数 | cmd/encoding/log/git-line-ending/doctor 处理 |
| handleNoteCommand | 笔记系统 |
| handleKickmeCommand | 通知规则 |
| handleDynamicCommand | 动态上下文 |
| buildShellFixPanel/buildShellFixHelp | 面板渲染 |
| tool.execute.after 钩子 | Git 换行符首次检测通知 |
| _gitLineEndingNotified 变量 | |
| SPECIAL_CMD_RE | 已废弃的匹配模式 |

### 3.3 Crash 修复

**根因**：`loadState()` 在 state 文件损坏或初次创建异常时可能返回 `undefined`，而 palette `run()` 直接访问返回值的属性/方法。

**修复方式**：所有 palette `run()` 函数中 `loadState()` 加 `|| {} as any` 兜底，`listTemplates()` 加 `|| []` 兜底。

### 3.4 命令错误追踪 (cmd-errors) — v2.2.7

**问题**：Agent 在 PowerShell 环境执行 Linux 命令（如 `NoWarn`、`head` 等），报错 `无法将"XXX"项识别为 cmdlet`，浪费 Token 且降低回答质量。

**方案**：三层次防御体系

#### 第一层：被动追踪（跨会话持久化）

- `PluginState.cmdErrors: CmdErrorEntry[]` 记录所有识别到的失败命令
- 每条记录含命令名、失败次数、首次/末次时间、是否已通知
- 通过 `addCmdError(cmd)` API 由各检测点调用

#### 第二层：主动提醒（system prompt 注入）

- `experimental.chat.system.transform` 钩子检查 `cmdErrors`
- 失败 ≥2 次的命令自动注入提醒：
  ```
  [ShellFix] 注意：以下命令在 PowerShell 中不存在，请使用等效命令：`NoWarn` (3 次)、`head` (2 次)。
  ```

#### 第三层：用户可见面板

- `shellfix.cmd-errors` palette 入口显示错误日志（命令名、次数、末次时间）
- 未通知的标记 `●`，查看后自动标记为已通知
- 点击确认可清除所有日志

#### 检测点（未来扩展）

| 检测点 | 方式 | 状态 |
|--------|------|------|
| `tool.execute.before` 主动检测 | 正则匹配可疑裸词 | 待完善 |
| `chat.message` 扫描错误消息 | 扫描用户消息中"无法将"模式 | 待实现 |
| 用户手动报告 | 通过 `/shellfix log-error` | 待实现 |

### 3.5 命令替换规则扩展 — v2.2.6

新增 `head` / `tail` 两条命令替换规则：

| 规则 | 匹配 | 替换 | 安全策略 |
|------|------|------|---------|
| `head` | `\| head [-n] N` | `\| Select-Object -First N` | 仅管道后匹配，默认 N=10 |
| `tail` | `\| tail [-n] N` | `\| Select-Object -Last N` | 仅管道后匹配，跳过 `tail -f`，默认 N=10 |

### 3.6 编码前缀重复检测 — v2.2.5

**问题**：ShellFix 注入编码前缀时，如果模板内容或脚本本身已含编码设置，会出现重复注入。

**修复**：注入前同时检测 4 种常见编码格式：

| 格式 | 示例 |
|------|------|
| ShellFix 格式 | `$z=[Text.Encoding]::UTF8;...` |
| 控制台编码 | `[Console]::OutputEncoding = ...` |
| PS7 格式 | `[System.Text.UTF8Encoding]::new($false)` |
| 环境变量 | `$OutputEncoding = ...` |

### 3.7 Palette 异常安全加固 — v2.2.3/2.2.4

**问题**：OpenCode TUI 的 `DialogSelect` 组件内部渲染存在崩溃 bug（`e.length` 在 `chunk-*.js` 中），导致 `shellfix.my`、`shellfix.auto`、`shellfix.git-eol` 三个入口崩溃。

**修复**：

| 版本 | 修复 |
|------|------|
| v2.2.3 | 所有 14 个 palette 入口的 `run()` 及回调函数加 try-catch（42 处） |
| v2.2.4 | 三个崩溃入口从 `DialogSelect` 改为 `DialogAlert` 纯文字展示，交互操作通过斜杠命令 |

### 3.8 Palette 标题命名规范

每个 palette 命令的 `title` 字段以 `ShellFix` 前缀开头，方便在 Ctrl+P 列表中快速区分。

**版本号统一放在 palette 分组标题上**：所有 ShellFix 命令使用同一个 `category` 值 `ShellFix v${PLUGIN_VERSION}`，Ctrl+P 中会显示一个黄色的 `ShellFix v2.2.8` 分组，其下是所有子命令。

**命名格式**：`ShellFix [英文命令名] [中文简介]`，无 emoji。

| name | title | category |
|------|-------|----------|
| `shellfix` | `ShellFix status 状态总览` | `ShellFix v2.2.8` |
| `shellfix.encoding` | `ShellFix encoding 中文不乱码` | `ShellFix v2.2.8` |
| `shellfix.bash` | `ShellFix bash 适配 Powershell 避免出错` | `ShellFix v2.2.8` |
| `shellfix.log` | `ShellFix log 记录操作信息` | `ShellFix v2.2.8` |
| `shellfix.git-env` | `ShellFix git-env 避免等待交互` | `ShellFix v2.2.8` |
| `shellfix.git-eol` | `ShellFix git-eol 避免换行警告` | `ShellFix v2.2.8` |
| `shellfix.kickme` | `ShellFix kickme 关键词通知` | `ShellFix v2.2.8` |
| `shellfix.banner` | `ShellFix banner 启动版本信息` | `ShellFix v2.2.8` |
| `shellfix.sysinfo` | `ShellFix sysinfo 查看系统信息` | `ShellFix v2.2.8` |
| `shellfix.about` | `ShellFix about 版本与更新` | `ShellFix v2.2.8` |
| `shellfix.help` | `ShellFix help 命令参考` | `ShellFix v2.2.8` |
| `shellfix.my` | `ShellFix my 预设文本模板` | `ShellFix v2.2.8` |
| `shellfix.note` | `ShellFix note 笔记标签` | `ShellFix v2.2.8` |
| `shellfix.auto` | `ShellFix auto 自动注入上下文` | `ShellFix v2.2.8` |
| `shellfix.cmd-errors` | `ShellFix cmd-errors 命令错误日志` | `ShellFix v2.2.8` |

### 3.9 安全提醒层（Agent 提醒） — v2.2.8 计划

**问题**：`rm -rf`、`sudo`、`chmod` 等命令有风险，但直接自动替换可能改变语义（如 `rm -rf` 换成 `Remove-Item -Recurse -Force` 可能误删）。需要更精细的处理方式。

**方案**：三层命令处理体系完善

```
自动替换（把握大）      ──▶ 已实现：export/head/tail 等
提醒 Agent（有风险）    ──▶ 新增：注入提示词让 Agent 自己修正
提醒用户（已出错）      ──▶ 已实现：cmd-errors 追踪
```

#### 检测模式

| 模式 | 示例 | 风险 | 处理方式 |
|------|------|------|---------|
| `rm -rf /` | `rm -rf /some/path` | 高危 | 提醒 Agent 确认路径后再执行 |
| `sudo` | `sudo apt install` | 中危 | 提醒 Agent Windows 不需要 sudo |
| `chmod` | `chmod +x script.sh` | 低危 | 提醒 Agent 用 PowerShell 等效命令 |
| `curl \| bash` | `curl -sSL ... \| bash` | 高危 | 提醒 Agent 安全风险 |

#### 冷却机制

- 每种模式独立冷却（`safetyCooldowns: Record<string, number>`）
- 冷却时间：5 分钟（300 秒），冷却期内不重复提醒同一种模式
- 冷却记录持久化到 `PluginState`

#### 注入方式

在 `experimental.chat.system.transform` 钩子中，检查 `pendingSafetyWarnings[]`，将未过期的提醒注入到 system prompt：

```
[ShellFix 安全提醒] 注意：你刚才使用了 `rm -rf` 命令。
Windows PowerShell 的 Remove-Item 行为不同，请确认路径正确后再执行。
```

#### 与现有机制的关系

| 机制 | 触发时机 | 目标 |
|------|---------|------|
| 自动替换（已有） | 命令执行前 | 修正命令 |
| 安全提醒（新增） | 命令执行前 | 让 Agent 自己修正 |
| cmd-errors（已有） | 命令执行后 | 记录错误，长期学习 |

---

## 四、交付清单

### v2.2.2 基础
- [x] `src/shell-fix-tui.ts` — 14 条独立 palette 子命令 + about（含 GitHub 检测更新）+ 无 emoji + 英文命名
- [x] `src/shell-fix.ts` — 简化命令匹配，移除已删除命令的 handler
- [x] `src/lib/state.ts` — 版本号 v2.2.2，所有状态字段
- [x] `deploy.ps1` — 新增 lib/ 目录部署，动态读取版本号
- [x] `CHANGELOG.md` — v2.2.2 变更记录
- [x] `README.md` — 版本号更新
- [x] 部署到 `~/.config/opencode/plugins/`（含 lib/ 目录）

### v2.2.3 异常安全
- [x] About 信息更新（作者：爱学习的龙爸 + 主页）
- [x] 所有 14 个 palette 入口 `run()` 及回调加 try-catch（42 处）
- [x] `showTemplateSystem/Editor/Help/Render` 全面保护
- [x] `showToggleInfo/CmdRules/GitLineEnding` 回调保护
- [x] `showAutoSystem/Help/ModeSelector` 回调保护

### v2.2.4 DialogSelect 崩溃修复
- [x] `shellfix.my` 从 DialogSelect 改为 DialogAlert
- [x] `shellfix.auto` 从 DialogSelect 改为 DialogAlert
- [x] `shellfix.git-eol` 从 DialogSelect 改为 DialogAlert

### v2.2.5 编码前缀重复检测
- [x] 检测 4 种常见编码格式，避免重复注入
- [x] 兼容 ShellFix 格式 / 控制台编码 / PS7 格式 / 环境变量格式

### v2.2.6 命令规则扩展
- [x] `head` 规则：`| head [-n] N` → `| Select-Object -First N`
- [x] `tail` 规则：`| tail [-n] N` → `| Select-Object -Last N`（跳过 `tail -f`）
- [x] 仅管道后匹配，默认 N=10，零误伤风险

### v2.2.7 命令错误追踪
- [x] `PluginState.cmdErrors` 持久化存储
- [x] `addCmdError/getCmdErrors/clearCmdErrors/markCmdErrorNotified` API
- [x] `experimental.chat.system.transform` 自动注入 ≥2 次失败命令提醒
- [x] `shellfix.cmd-errors` palette 入口：日志查看 + 清除
- [x] 文档更新：开发方案、设计文档

### v2.2.8 安全提醒层
- [x] `PluginState.safetyCooldowns` 冷却状态持久化
- [x] `PluginState.pendingSafetyWarnings` 待提醒安全警告
- [x] `tool.execute.before` 检测 rm -rf / sudo / chmod / curl|bash 等模式（4 种）
- [x] `experimental.chat.system.transform` 注入安全提醒
- [x] 独立冷却：每种模式 5 分钟不重复
- [x] `shellfix.safety` palette 入口查看/清除安全提醒
- [x] 文档更新：开发方案

### v2.2.9 PwshCheck — PowerShell 版本检测引导

#### 背景

OpenCode 在 Windows 上默认使用 `powershell.exe`（PS 5.1），即使系统已安装 `pwsh` 7+。已确认官方 `"shell": "pwsh"` 配置可解决此问题，但用户需手动添加。

#### 设计

**检测时机**：插件加载时（`setup`/模块初始化），一次性检测。

**检测逻辑**：

```
win32?
  ├─ 是 → 读取 ~/.config/opencode/opencode.jsonc
  │      ├─ 含 "shell":"...pwsh..." → 已配置，静默跳过
  │      └─ 不含 → 标记 pwshCheck.pending = true
  └─ 否 → 跳过（macOS/Linux 无此问题）
```

**状态字段**（`src/lib/state.ts`）：

```typescript
interface PwshCheckState {
  pending: boolean;       // 检测到问题，待处理
  dismissed: string;      // 'pending' | 'dismissed' | 'forever'
}
PluginState.pwshCheck: PwshCheckState;
```

| dismissed 值 | 含义 | 下次启动行为 |
|---|---|---|
| `pending` | 未处理 | 重新检测并提示 |
| `dismissed` | 以后再说 | 重新检测并提示 |
| `forever` | 不再提醒 | 跳过检测 |

**注入时机**：`experimental.chat.system.transform`，仅首轮（注入后设 `pending = false`）。

**Agent 交互协议**：注入的提示文本指导 Agent 询问用户，并提供三种处理路径：

```text
[ShellFix 系统配置] 检测到 OpenCode 当前使用 PowerShell 5.1。
建议切换为 pwsh 以获得完整 PS7 API 和 UTF-8 编码。

请询问用户：
1. "改"        → Agent 编辑 opencode.jsonc 添加 "shell": "pwsh"
2. "以后再说"  → Agent 编辑 shellfix-state.json，设 dismissed = "dismissed"
3. "不再提醒"  → Agent 编辑 shellfix-state.json，设 dismissed = "forever"
```

**不增加 palette 入口**：此为一次性引导，无需面板管理。

#### 交付清单

- [ ] `src/lib/state.ts` — `PwshCheckState` 接口 + `PluginState.pwshCheck` 字段 + `DEFAULT_STATE` 默认值 + `setPwshCheckDismissed()` API
- [ ] `src/shell-fix.ts` — 插件启动时检测 `opencode.jsonc` 是否含 `"shell": "...pwsh..."`
- [ ] `src/shell-fix.ts` — `experimental.chat.system.transform` 注入 Agent 交互协议
- [ ] 首次消费后 `pending = false`，避免重复注入
- [ ] Agent 通过修改 `shellfix-state.json` 回传选择结果
- [ ] 文档更新：CHANGELOG + 开发方案
