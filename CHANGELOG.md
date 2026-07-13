# Changelog

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