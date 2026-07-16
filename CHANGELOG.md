# Changelog

## v2.2.8 (2026-07-16)

### 新功能 — 安全提醒层 + 编码前缀优化

- **安全提醒层**：在 `tool.execute.before` 检测 4 种危险命令模式（`rm -rf`、`sudo`、`chmod`、`curl|bash`），标记待提醒；Agent 下次收到 system prompt 时自动注入安全警告
  - 每模式独立 5 分钟冷却，持久化到 `PluginState.safetyCooldowns`
  - `shellfix.safety` palette 入口查看/清除冷却状态
- **编码前缀再优化**：v2.1.1 基础上再减 5 字符（69→64），pwsh 7+ 跳过 `$OutputEncoding` 仅 51 字符
  - bash 工具用链式赋值：`$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;`
  - pwsh 工具跳过 `$OutputEncoding`：`[Console]::OutputEncoding=[Text.Encoding]::UTF8;`
  - 管道/斜杠命令处理器也按工具类型选前缀

### 修复

- **`system.transform` 早期返回**：当无 auto 模块启用时，cmdErrors 和安全提醒被跳过不注入；改为先注入错误/安全提醒再判断是否返回
- **移除冗余守卫**：`s.safetyCooldowns !== undefined` 不再需要（`loadState` 深度合并始终提供默认值）

## v2.2.2 (2026-07-14)

### 微调 — Palette 标题 + 新功能

- **标题统一**：改为 `ShellFix [英文名] [简介]`，如 `ShellFix encoding 中文不乱码`，去掉表情符号
- **bash**: 改名+重定向（cmd→bash），介绍"适配 Powershell 避免出错"
- **sysinfo**: doctor→sysinfo，更直观
- **git-env**: 新增入口，展示 16 个非交互变量，提示关闭官方插件省 Token
- **kickme**: 加回 palette，显示规则数量和用法
- **banner**: 新增启动版本信息开关 (toggleShowVersion)
- **about**: 加入项目 GitHub 地址 + 作者 loongba.cn
- **status**: 更新显示所有模块状态（含 kickme/banner）
- 启动日志支持 showVersion 开关控制

## v2.2.1 (2026-07-13)

### 微调 — 分组标题 + 环境诊断增强

- **版本号移到黄色分组标题**：所有 ShellFix palette 命令共用 `ShellFix v2.2.1` 分组（Ctrl+P 黄色标签），入口标题不再显示版本号
- **环境诊断加入 Shell 版本**：Windows 检测 PowerShell 版本，Linux/macOS 检测 Bash 版本
- **新增 `shellfix.about`**：显示版本信息 + 通过 GitHub API 自动检测最新版本
- **新增 `shellfix.help`**：独立帮助入口
- **单面板→独立子命令**：撤销原来统一的 DialogSelect 面板，改为 8 条独立 palette TuiCommand，每条直接执行目标操作，无需子菜单
- `deploy.ps1` 修复：增加 lib/ 目录部署，动态读取版本号

## v2.2.0 (2026-07-13)

### 架构变更 — 命令系统精简

- **移除 4 个斜杠命令**：`/shellfix`、`/note`、`/kickme`、`/dynamic` 不再注册到 `opencode.jsonc` 和 `command.execute.before` 钩子
- **保留命令**：仅 `/my`（模板系统）和 `/auto`（自动化系统）
- `PIPE_CMD_RE` / `SLASH_CMD_RE` 简化为仅匹配 `my` 和 `auto`

### 新功能 — Ctrl+P Palette 修复配置

- 新增 `shellfix` palette 命令：通过 Ctrl+P 打开统一配置面板
- 支持交互式设置：
  - **状态总览** — 一览所有开关状态
  - **编码注入** — 一键切换 ON/OFF
  - **命令规则** — 逐条开关 export/which/source/touch/rm/chmod
  - **日志** — 一键切换 ON/OFF
  - **Git 换行符** — 选择 auto/config/off 模式
  - **环境诊断** — 查看 OS/版本/架构等
  - **帮助** — palette 命令说明
- 纯 TUI 侧 DialogSelect 交互，零 LLM 成本

### 代码清理

- TUI 插件：移除 600+ 行死代码（note/kickme/dynamic handler、autoCollectTags、checkKickmeRules、checkDynamicRules、_lastMessage 缓存、事件钩子订阅、shellfix 子命令处理器）
- 服务器插件：移除 `tool.execute.after` 钩子、`_gitLineEndingNotified`、`handleShellFixCommand`/`handleNoteCommand`/`handleKickmeCommand`/`handleDynamicCommand` 及相关函数
- cleaned up 导入依赖

## v2.1.1 (2026-07-13)

### 优化

- **编码前缀压缩**：120 字符 → 69 字符（-42%），每条命令节省 ~12 tokens
  - 旧：`$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);`
  - 新：`$z=[Text.Encoding]::UTF8;$OutputEncoding=[Console]::OutputEncoding=$z;`
  - 原理：共用变量 + 链式赋值，消除重复对象创建

## v2.1.0 (2026-07-13)

### 第四基础支柱 — Git 环境净化

新增 `/shellfix git-line-ending` 子命令，处理 Git 换行符纯噪声警告：

- **auto 模式（默认）**：通过 `shell.env` 注入 `GIT_CONFIG_COUNT` + `core.autocrlf=false` + `core.safecrlf=false`，仅 OpenCode 进程内生效
- **config 模式**：输出 `git config --global` 命令，用户可执行以永久生效
- **off 模式**：关闭，不注入任何配置
- `tool.execute.after` 钩子：首次检测到换行符警告时打印通知
- 状态面板显示当前模式（AUTO / CFG / OFF）

### 架构

- `shell.env` 钩子改为动态读取 `PluginState.gitLineEnding`，条件注入
- `tool.execute.after` 钩子新增（第一次接入该钩子）

## v2.0.0 (2026-07-13)

### 架构变更
- **废弃旧 auto.modules 路径**：从 PluginState 移除 `auto: AutoState`，全部迁移到 AutoRuleV2
- 自动迁移旧版 state 文件（`migrateState()` 在 `loadState()` 中自动执行）
- 新增 `autoMode`、`require`、`moduleConditions` 作为 PluginState 顶层字段
- 所有旧函数（`setAutoModule`、`getEnabledAutoModules` 等）重定向到 AutoRuleV2

### 新钩子
- `chat.message`：动态上下文直接注入用户消息（替代 v1.9 的 pendingDynamic + system.transform 双阶段方案）
- `experimental.session.compacting`：保护注入上下文不被会话压缩裁剪
- `experimental.chat.system.transform` 保留 pendingDynamic 消费作为回退

### 质量改进
- 版本号统一：`state.ts` 导出 `PLUGIN_VERSION`，两插件引用同一来源 → "2.0.0"
- 错误处理规范化：TUI palette 所有空 `catch {}` 改为有日志的 `catch (e) { console.error(...) }`
- 旧 `AutoState` 接口已移除

### 文档
- 新增 CHANGELOG.md
- 新增 v1.9 审核报告

## v1.9.0 (2026-07-13)

### 新功能
- DynamicRule 动态上下文注入系统：关键词/正则触发 → pendingDynamic 缓存 → system.transform 注入
- `/dynamic add|rm|on|off|cooldown` 命令 + palette 入口 + 冷却机制
- `checkDynamicRules()` 在 `session.next.prompted` / `text.ended` 中检测关键词

### 改进
- AutoRuleV2 统一配置：`/auto rule add|rm|on|off` 子命令
- `syncModuleToAutoRule` 向后兼容层
- 平台 API 探索报告：发现 10 个新钩子

## v1.8.0 (2026-07-13)

### 新功能
- `/kickme` 通知系统：关键词/正则匹配 → toast + 可选声音
- 标签 timeline 浏览：`/note timeline` 按时间线查看笔记
- 会话级自动注入：TUI 启动时 palette 弹窗引导

### 改进
- 事件订阅：`event.on("session.next.*")` 自动采集 #标签#
- `/my` 增强：`edit`、`sync --push`、`sync status`
- `/note` 增强：`:last` 保存上一条消息、`cache` 手动缓存

## v1.7.0

### 新功能
- 事件订阅：`session.next.prompted` / `text.ended` 事件监听
- `/my edit` 编辑模板
- `/my sync --push` 推送模板到远程仓库

### 改进
- 全面错误处理 + 统一错误格式
- 性能优化：条件评估缓存、分支名缓存
- `/auto` 重命名（原 `/in`）

## v1.6.0

### 新功能
- TUI 调度器：dispatch → 本地 handler → appendPrompt/showToast
- 四支柱体系：/shellfix + /my + /note + /auto
- 条件引擎：9 个谓词（os/arch/branch/dirty/tool_exists/file_exists/is_git_repo/always/never）
- `/auto` 模块化 + 条件引擎（旧名 `/in`）
- 代码模块化：state / template-store / auto-rules
- TUI API 修复：api.tui → api.client.tui

## v1.5.0

### 新功能
- 远程模板同步：`/my sync` 从 Git 仓库拉取模板
- 笔记系统：`/note` 命令集

## v1.4.0

### 新功能
- 模板系统：`/my` 命令集
- 内置模板：ys/review/pr/bug/commit/explain/deploy
- 模板渲染：`{0}` 位置参数、`{branch}` `{date}` 环境变量

## v1.3.0

### 新功能
- 自动化系统：`/in` 命令集（后更名为 `/auto`）
- 7 个注入模块
- 三种模式：prompt/auto/silent

## v1.2.0

### 新功能
- `/shellfix` 状态面板
- 命令替换规则：export/which/source/touch/rm/chmod
- doctor 环境诊断

## v1.1.0

### 改进
- 增加 `SHELLFIX_VERSION` 环境变量
- 优化编码注入前缀

## v1.0.0

### 初始版本
- 中文不乱码：`$OutputEncoding` + `[Console]::OutputEncoding` 自动注入
- `export → $env:` 自动转换
- Git 免交互：16 个环境变量通过 `shell.env` 注入