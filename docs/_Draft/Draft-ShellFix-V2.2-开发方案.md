# v2.2 开发方案 — 命令体系精简 + Palette 配置面板

> 当前版本：v2.1.1 → 目标版本：v2.2.1
> 审核日期：2026-07-13

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

**实现**：9 条独立 `TuiCommand`，各有一条 `name` + `title`，点击直接执行，无需子菜单。

**Palette 列表**（所有命令共用一个 `category` 分组标题 `ShellFix v2.2.1`，黄色显示）：

| 名称 | 标题 | 行为 |
|------|------|------|
| `shellfix` | `ShellFix 📊 状态总览` | DialogAlert 展示所有开关状态 |
| `shellfix.encoding` | `ShellFix 🔤 编码注入` | 直接 toggle + toast |
| `shellfix.cmdrules` | `ShellFix 📝 命令规则` | DialogSelect 列出 6 条规则，点击切换 |
| `shellfix.log` | `ShellFix 📋 日志` | 直接 toggle + toast |
| `shellfix.gitlineending` | `ShellFix 🔧 Git 换行符` | DialogSelect 三选一 (auto/config/off) |
| `shellfix.doctor` | `ShellFix 🏥 环境诊断` | DialogAlert 展示 OS/版本/架构 + Shell 版本 |
| `shellfix.about` | `ShellFix ℹ️ 关于、检测更新` | DialogAlert + fetch GitHub API 检测更新 |
| `shellfix.help` | `ShellFix ❓ 帮助` | DialogAlert 展示所有 palette 命令 |
| `shellfix.my` | `ShellFix my — 模板系统` | 模板系统交互 |
| `shellfix.auto` | `ShellFix auto — 自动化系统` | 自动化系统交互 |

> 原则：**版本号显示在 palette 黄色分组标题上**（如 `ShellFix v2.2.1`），每个 palette 条目标题不显示版本号。

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

### 3.4 Palette 标题命名规范

每个 palette 命令的 `title` 字段以 `ShellFix` 前缀开头，方便在 Ctrl+P 列表中快速区分。

**版本号统一放在 palette 分组标题上**：所有 ShellFix 命令使用同一个 `category` 值 `ShellFix v2.2.1`，Ctrl+P 中会显示一个黄色的 `ShellFix v2.2.1` 分组，其下是所有子命令。

| name | title | category |
|------|-------|----------|
| `shellfix` | `ShellFix 📊 状态总览` | `ShellFix v2.2.1` |
| `shellfix.encoding` | `ShellFix 🔤 编码注入` | `ShellFix v2.2.1` |
| `shellfix.cmdrules` | `ShellFix 📝 命令规则` | `ShellFix v2.2.1` |
| `shellfix.log` | `ShellFix 📋 日志` | `ShellFix v2.2.1` |
| `shellfix.gitlineending` | `ShellFix 🔧 Git 换行符` | `ShellFix v2.2.1` |
| `shellfix.doctor` | `ShellFix 🏥 环境诊断` | `ShellFix v2.2.1` |
| `shellfix.about` | `ShellFix ℹ️ 关于、检测更新` | `ShellFix v2.2.1` |
| `shellfix.help` | `ShellFix ❓ 帮助` | `ShellFix v2.2.1` |
| `shellfix.my` | `ShellFix my — 模板系统` | `ShellFix v2.2.1` |
| `shellfix.auto` | `ShellFix auto — 自动化系统` | `ShellFix v2.2.1` |

---

## 四、交付清单

- [x] `src/shell-fix-tui.ts` — 单面板 → 8 条独立 palette 子命令 + about（含 GitHub 检测更新）+ 移除死代码 + crash 修复
- [x] `src/shell-fix.ts` — 简化命令匹配，移除已删除命令的 handler
- [x] `src/lib/state.ts` — 版本号 v2.1.1 → v2.2.1
- [x] `deploy.ps1` — 新增 lib/ 目录部署，动态读取版本号
- [x] `CHANGELOG.md` — v2.2.0 / v2.2.1 变更记录
- [x] `README.md` — 版本号更新
- [x] 部署到 `~/.config/opencode/plugins/`（含 lib/ 目录）
- [x] 最终验证 — palette 正常显示，about 可检测更新
