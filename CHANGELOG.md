# Changelog

## v2.3.2 (2026-11-08)

### 修复 — CodeMap overlay 跨进程锁冲突

- **自动路径退出 overlay 写路径**：编辑 `.cs` 不再触发 `refresh_overlay`（删除 `file.edited` 分支、`scheduleOverlayRefresh` / `flushOverlayRefresh`）；overlay 与 workspace 归 Agent 侧 codemap MCP 维护
- **根因**：workspace id 全局常量 `session` + overlay 路径 `~/.codemap/store/overlays/<ws>/` 不带仓库维度 → opencode 自带 `mcp.codemap` 与 ShellFix spawn 的进程同写 `overlay.wal` → `IOException: being used by another process` → `Workspace 'session' not found`
- **收窄可恢复正则**：`/timeout|exited|spawn failed|EPIPE|not found/i` → `/spawn failed|exited code=|codemap-mcp exited|EPIPE|timeout \d+ms/i`；workspace 业务错误不再白杀进程重试
- **锁冲突退避重试**：新增 `CodemapSession.callWithRetry()`（300ms / 1.2s / 3s），仅 `/codemap-index` 显式路径使用；`workspace.create` 重试 2 次
- **错误可读化**：`NOT FOUND: Workspace 'x' not found` → 「工作区 "x" 未创建（可能被其他 CodeMap 进程占用），稍后重试或执行 /codemap-index status」
- **失败日志节流**：`ensure_baseline` 失败同仓库 5 分钟最多 1 条（原来每次编辑刷一行）
- **显式命令保留完整能力**：`/codemap-index` 仍执行 重建 baseline → 创建 workspace → 刷新 overlay，失败项逐条显示

### 变更 — 输出通道统一为 toast 四色

- **不再有「填入输入框」的输出**：`/my <name>` 与 palette 模板执行改为 `appendPrompt` + `submitPrompt` **直接发送** + 绿色 toast「已发送 模板 "x"」
- **两侧四色统一**：TUI 侧 `api.ui.toast({ message, variant })`、服务端侧 `client.tui.showToast({ body: { variant } })`
  - 蓝 `info` = 中性信息；绿 `success` = 操作成功；橙 `warning` = 缺失/受阻；红 `error` = 失败
- **全量标注**：TUI 侧约 65 处通知（`DispatchResult.toast` + 直接 `api.ui.toast`）逐条按语义加 `variant`，所有 `catch` 分支统一红色
- **面板保留**：多行列表/状态面板（`/my ?`、`/auto`、`/shellfix doctor`）仍用 DialogAlert 可滚动阅读

## v2.3.1 (2026-11-07)

### 新功能 — 通用调试提示（toast + 计数）

- **通用通道** `src/lib/toast-alerts.ts`（新增）：`alertToast()` —— 统一 toast + 计数，5 分钟/场景节流防刷屏
- **总开关 `alertToasts`（默认 ON）**：`/shellfix alerts` 或 palette `shellfix.alerts` 切换；关闭后 toast 不弹但**计数仍累计**（`alertCounts` 持久化到 state.json，跨会话）
- **场景 A：思考截断**（`session.idle` 事件）——末条 assistant 消息「无正文 + 思考断尾 + 非 tool-calls」→ toast「思考截断」（error 红）+ 计数 `think-cut`；同消息只提示一次。**仅检测不自愈**（自动续写留 v2.4）
- **场景 B：codemap 未建索引**（`tool.execute.after`）——`codemap_*` 工具输出含 `repo_path is required` / `no repo has been indexed` / `Run index.ensure_baseline` → toast「CodeMap 未建索引」+ 指引（ensure_baseline / /codemap-index）+ 计数 `codemap-no-index`
- 状态面板 / help 清单新增 `alerts` 条目（补 v2.3.0 遗漏的 codemap / codemap-run 条目）
- 性能：计数走内存缓存 + 低频落盘（<1ms），触发场景均为低频事件，无感知

## v2.3.0 (2026-11-07)

### 新功能 — CodeMap 索引自动化（插件侧硬保证）

- **自带 MCP stdio 客户端**（`src/lib/codemap-mcp.ts`，零依赖）：直接 spawn `codemap-mcp.exe`，JSON-RPC 2.0 按行分隔；串行队列 + id 路由 + 空闲 5min 回收（Windows `taskkill /T /F`）；超时分层（initialize 15s / 普通调用 20s / `ensure_baseline` 180s）；进程异常退出时 flush 残留 buffer 并 reject 未决请求，下次调用自动重启
- **索引编排层**（`src/lib/codemap-indexer.ts`）：`repoKey`/`normalizeRepoRoot`/`detectDotnetRepo`（仅 .NET 仓库生效）、`runEnsure`（inFlight 去重 + 60s 持久化冷却）、`ensureWorkspace`、overlay 刷新 5s 防抖、`cleanupIfNeeded`（`~/.codemap` >1GB 且 24h 间隔，dry_run 预估 freed ≥100MB 才实删，keep_count=3 / older_than_days=14）
- **触发时机**（优先级：dotnet build 成功 > 会话开始 > `/codemap-index`）：`event` 钩子监听 `session.created`（幂等 ensure + workspace.create）、`file.edited`（`.cs` 变更 → refresh_overlay）、`session.deleted`（回收会话）
- **新命令 `/codemap-index`**：无参数=重建并刷新，`status`=状态（baseline/commit/符号数/workspace），`cleanup`=清理旧 baseline；`config` 钩子自注册，失败可在 `opencode.jsonc` 手动注册
- **新开关 `codemapIndex`（默认 true）**：`/shellfix codemap` 切换；TUI palette `shellfix.codemap`（切换）+ `shellfix.codemap-run`（立即重建）；状态面板新增 codemap 行（`ON 10962 sym 40.8s` / `OFF` / `ON FAILED xN`）
- **日志与降噪策略**：成功 log 一行（repo/elapsed/符号数）；失败静默，连续失败 ≥3 次才通过 `system.transform` 一次性提醒
- **Spike 实测**（方案 §4.1）：并发 ensure 无跨进程锁、无损坏（仅重复耗 CPU）；12s 强杀后无半写残留（暂存+原子落位），重跑 40.8s 成功 → 180s 超时安全

## v2.2.12 (2026-08-13)

### 新功能 — 编码环境变量注入 + PwshCheck 自动修复

- **编码环境变量注入**（新开关 `envInject`，默认 true）：在 `shell.env` 钩子中追加注入 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`LESSCHARSET=utf-8`，让 Python/Node/less 等子进程输出 UTF-8，从源头避免中文乱码
  - 子进程自动继承，零命令污染（与 CI_ENV_VARS 同机制）
  - TUI 入口：`shellfix.env-inject` palette 命令，状态面板显示 env-inject 行
- **PwshCheck 自动修复**（新开关 `autoFixPwsh`，默认 true）：检测到 PS 5.1 且 pwsh 已安装时，自动修改 `opencode.jsonc` 将 `"shell"` 设为 `"pwsh"`，无需 Agent 询问用户
  - 修改前备份原文件到 `opencode.jsonc.shellfix.bak`（仅首次）
  - 支持已有 `"shell"` 字段替换 / 无字段时在 `$schema` 后插入（纯正则，兼容 JSONC 注释）
  - 修复后通过 `system.transform` 一次性通知用户（`notifyAutoFix` 标记）
  - `autoFixPwsh=false` 时回退传统模式（system.transform 提示 Agent 询问）
  - TUI 入口：`shellfix.pwsh` palette 命令，状态面板显示 pwsh 行
- **P2/P3 推迟记录**：chcp .cmd 包装脚本（文章方案）与前缀 chcp 65001 均记录在开发方案中，推迟决策

## v2.2.11 (2026-08-13)

### 新功能 — 输入编码修复 + 命令映射扩展

- **输入编码修复**：编码前缀追加 `[Console]::InputEncoding=[Text.Encoding]::UTF8`，修复命令字符串中的中文（路径/字符串）经 stdin 传输时按 GBK 解码导致的字节错位 → ParserError
  - PS 前缀：`$OutputEncoding=[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;`
  - pwsh 前缀：`[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;`
  - 与输出编码共享 `s.encoding` 开关，无独立 toggle
  - guard regex（行 457）防御性补充 `[Console]::InputEncoding\s*=` 分支
  - stripping regex（行 491）改为宽容匹配，覆盖新旧 4 种前缀变体（修复原正则对 PS 前缀剥离失败的隐藏缺陷）
- **`mkdir -p` 自动转换**（新命令规则 `cmdRules.mkdir`，默认 on）：`mkdir -p foo/bar` → `New-Item -ItemType Directory -Force -Path 'foo/bar'`
  - 排除：不带 `-p`、多路径（未引号含空格）、非行首
- **`cat` / `grep` / `find` 单命令映射**（新命令规则，默认 off）：
  - `cmdRules.cat`：`cat file` → `Get-Content -Path 'file' -Encoding UTF8`（排除管道/重定向/命令链）
  - `cmdRules.grep`：`grep pattern file` → `Select-String -Pattern 'pattern' -Path 'file'`（支持引号模式，排除 `-r` 等复杂参数）
  - `cmdRules.find`：`find path -name "*.ts"` → `Get-ChildItem -Path 'path' -Recurse -Filter '*.ts'`（仅 `-name` 模式）
  - 统一 `stripOuterQuotes()` 剥离捕获路径/模式的成对引号，避免 `-Path '"foo bar"'` 引号成为路径的一部分

## v2.2.10 (2026-08-02)

### 新功能 — 命令错误检测激活 + 裸 VAR=x 自动转换

- **错误检测激活**（补上 v2.2.7 缺失的调用点）：新增 `tool.execute.after` 钩子，实时检测 PowerShell 中英文报错
  - 6 条错误正则：`无法将"X"项识别为 cmdlet/函数/脚本文件/可运行程序`、`"X" 不是内部或外部命令`、`找不到路径/文件 X`、`The term 'X' is not recognized`、`X: command not found`、`Cannot find path/file 'X'`
  - 命中后调用 `addCmdError()` 记录（跨会话累计 count），并在工具输出末尾追加实时提示 `[ShellFix 提示] ...`
  - `cmdErrors` 从恒空变为真实记录 → `shellfix.cmd-errors` 面板自动生效，`system.transform` 的 ≥2 次兜底提醒也能触发
- **裸 `VAR=x` 自动转换**（新命令规则 `cmdRules.bareEnv`，默认 on）：行首独立赋值 `GIT_MASTER=1` → `$env:GIT_MASTER="1";`
  - 歧义排除：`$env:` 前缀、`export` 前缀、命令含 `=`（`echo a=b`）、比较运算符（`if ($x = 5)`）、参数传递（`cmd --flag k=v`）、命令链（`FOO=1 && make`）均不转换
  - 与 `applyExportRule` 互补：`export X=1` 走旧规则，裸 `X=1` 走新规则

## v2.2.9 (2026-07-17)

### 新功能 — PwshCheck：PowerShell 版本检测引导

- **启动检测**：插件加载时检测 `opencode.jsonc` 是否含 `"shell": "...pwsh..."`
  - 已配置 → 静默跳过，标记 `dismissed = "accepted"`
  - 未配置但系统有 pwsh → 标记 `pending = true`
- **Agent 注入**：首轮用户消息通过 `system.transform` 注入交互协议
  - Agent 询问用户：改（编辑 opencode.jsonc）/ 以后再说 / 不再提醒
- **持久化**：`PluginState.pwshCheck` 字段，Agent 通过修改 `shellfix-state.json` 回传结果

### 修复

- **编码前缀不能跳过**：之前 `shellIsPwsh` 完全跳过编码前缀，但 `[Console]::OutputEncoding` 在中文 Windows 上默认 GB2312（CP936），导致 `Select-String` 等命令输出乱码
  - 移除了所有 `!shellIsPwsh` 守卫，始终注入完整前缀
  - 清理了 `shellIsPwsh` 死代码变量
- **readdirSync 导入缺失**：review 发现 `fileExists()` 函数使用了未导入的 `readdirSync`（之前 `shellIsPwsh` IIFE 引入后覆盖了 review 前版本的导入），补回
- **`"accepted" as any` 移除**：类型 `PwshCheckState.dismissed` 已包含 `"accepted"` 成员，无需类型绕过

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