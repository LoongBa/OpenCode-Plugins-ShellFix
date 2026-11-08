# OpenCode Plugins ShellFix 🔧

**Windows PowerShell 三大修复 + 七命令体系**

当前版本：**v2.3.4**

---

## 核心：命令错误、中文乱码、降噪压缩 Token、梳理上下文

在 Windows 上用 OpenCode 的开发者都遇到过：

### 1. export 命令错误，浪费 Token 还降智！

OpenCode 调用 bash 工具时，在 Windows Powershell 环境下经常调用错误，怎么也改不过来。多说几次 Agent 回答：

> 被你抓住了，我又犯错误了，看来形成肌肉记忆了。这次一定改正！

然后，依然是错的，摆烂。

但这样浪费对话不说，大量的错误信息充斥上下文，**浪费 Token 还降智**！

```bash
# Agent 输出这个（Linux bash 语法）👇
export CI=true
/exexport DB_HOST=localhost

# PowerShell 报错 👇
'export' 不是内部或外部命令，也不是可运行的程序或批处理文件。
```

### 2. 中文乱码，经典问题从未消失

比如读取文件列表，遇到中文返回乱码。所以，上下文中充斥着大量乱码。

```powershell
# 中文输出全是乱码 ❌
Write-Output "你好世界"
# 输出：浣犲ソ涓栫晫
```

### 3. 大量重复信息占用上下文，浪费 Token 还降智！

OpenCode 内置消除 git 等待交互的插件，但它会注入大量信息：

```powershell
# Git 卡住等待交互式输入 ❌
git commit -m "fix"
# 等待编辑器、等待凭据、进入分页器...
```

### 4. 复制粘贴，非遗传承

以及日常开发中的重复性劳动：

```
# 每次都要手写相同 prompt
帮我 review 一下代码
请解释一下这个函数
请验收版本 2.0

# 对话中的关键信息无法沉淀
"记住，这个项目的连接池是 HikariCP maxPoolSize=20"
→ 下次对话又忘了
```

---

## 四大基础修复，解决问题，摒弃噪音，拯救 Agent 心智

### ① 中文不乱码

每条命令前自动注入 UTF-8 编码设置：

```powershell
$OutputEncoding=[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;
```

PowerShell 非交互子进程默认输出编码为系统代码页（Windows 常见 GBK），导致中文乱码。插件强制设置管道、控制台和输入编码为 UTF-8 —— 既防输出乱码，也防命令字符串中的中文路径传输损坏。

> 优化：v2.1.1 将前缀从 120 字符压缩至 69 字符（-42%），v2.2.8 再压缩至 64 字符，v2.2.11 追加 `[Console]::InputEncoding` 增至 91 字符（输入+输出双保险）。

#### 解决思路对比：为什么选 ShellFix

中文乱码的根源是 opencode 用 `cross-spawn` 以 `pwsh -NoProfile` 启动子进程，跳过了 profile 丢失 UTF-8 设置。业界有四种解决思路，各有取舍：

| 思路 | 做法 | 生效范围 | 缺点 | 开箱即用 |
|------|------|----------|------|---------|
| **ShellFix 前缀注入**（本插件） | 每条命令自动注入 `[Console]::OutputEncoding=UTF8` | 仅 ShellFix 处理的命令 | 命令字符串变长（91 字符前缀） | ✅ 安装即用 |
| CMD Wrapper（Profile 型） | 过滤 `-NoProfile`，让用户自己的 profile 加载 | opencode 内所有命令 | 必须用户事先配好 profile（含 UTF-8 设置）；换机需重配 | ❌ 需手写 .cmd + 改配置 |
| CMD Wrapper（编码注入型） | `.cmd` → `.ps1` 链，注入 `chcp 65001` + 编码设置 | opencode 内所有命令 | `.ps1` 用 `Invoke-Expression` 有注入风险；额外进程链；换机需重配 | ❌ 需手写 .cmd + .ps1 + 改配置 |
| `powershell.config.json` | 设置 `Console:Encoding: utf-8` | 仅 PowerShell 7 | 只改 `$OutputEncoding`，够不到 `[Console]::OutputEncoding` | ❌ 不够用 |
| 注册表 `OEMCP=65001` | 全局代码页改 UTF-8 | 所有进程 | 依赖 GBK 的旧软件乱码 | ❌ 有全局风险 |

> 完整排查过程与三种方案实测对比 → [`docs/05-中文乱码排查记录.md`](docs/05-中文乱码排查记录.md)

**ShellFix 的优势：**

- **零配置零依赖**：安装插件即生效，不碰 profile、不碰注册表、不写 wrapper
- **不依赖 profile**：`-NoProfile` 下同样生效（前缀直接塞进命令字符串）
- **无全局副作用**：只影响自己的命令，不波及系统其他软件
- **自动兜底**：还能顺带处理输入编码 `[Console]::InputEncoding`（v2.2.11）

### ② export → $env: 自动转换

Agent 生成的 Linux export 语法被自动转换为 PowerShell 兼容写法：

| Agent 输出                   | 插件转换后                           |
| ---------------------------- | ------------------------------------ |
| `export FOO=bar`             | `$env:FOO="bar";`                    |
| `export FOO="hello world"`   | `$env:FOO="hello world";`            |
| `export FOO='hello $PATH'`   | `$env:FOO="hello \`$PATH";`          |
| `export K1=v1 K2=v2 && make` | `$env:K1="v1";$env:K2="v2"; && make` |

不再出现大量错误，减少重复对话。

**裸 `VAR=x` 也自动转换**（v2.2.10，`cmdRules.bareEnv` 默认 on）：

| Agent 输出      | 插件转换后              |
| --------------- | ----------------------- |
| `GIT_MASTER=1`  | `$env:GIT_MASTER="1";`  |
| `VAR=`          | `$env:VAR="";`          |

> 歧义排除：`$env:` 前缀、`export` 前缀、`echo a=b` 这类命令含 `=`、`if ($x = 5)` 比较、`cmd --flag k=v` 参数、`FOO=1 && make` 命令链均不误转。

**命令错误实时检测**（v2.2.10）：`tool.execute.after` 钩子匹配 PowerShell 中英文报错（`无法将"X"项识别为 cmdlet`、`X 不是内部或外部命令`、`The term 'X' is not recognized`、`X: command not found` 等 6 类），命中后：
- 记录到命令错误日志（`/shellfix cmd-errors` 可查看，跨会话累计次数）
- 在工具输出末尾追加实时提示 `[ShellFix 提示] ...`，Agent 下一轮立即可见
- 多次失败（≥2 次）还会通过 system prompt 注入兜底提醒

**`mkdir -p` 自动转换**（v2.2.11，`cmdRules.mkdir` 默认 on）：`mkdir -p foo/bar` → `New-Item -ItemType Directory -Force -Path 'foo/bar'`。排除多路径、非行首。

**`cat` / `grep` / `find` 单命令映射**（v2.2.11，`cmdRules.cat`/`grep`/`find` 默认 off）：

| Agent 输出 | 插件转换后 |
|-----------|-----------|
| `cat file.txt` | `Get-Content -Path 'file.txt' -Encoding UTF8` |
| `grep "hello world" file.txt` | `Select-String -Pattern 'hello world' -Path 'file.txt'` |
| `find . -name "*.ts"` | `Get-ChildItem -Path '.' -Recurse -Filter '*.ts'` |

> 排除管道/重定向（`cat`）、复杂参数如 `-r`（`grep`）、非 `-name` 模式（`find`）。默认关闭，按需启用。

### ③ Git 免交互，避免官方插件的啰嗦和浪费

在**进程初始化时**注入 16 个非交互环境变量，子进程自动继承，无需写进命令字符串：

| 变量                      | 值               | 防止                                  |
| ------------------------- | ---------------- | ------------------------------------- |
| `CI`                      | `true`           | 工具检测到 CI 后禁用交互模式          |
| `GIT_TERMINAL_PROMPT`     | `0`              | Git 弹出凭据询问窗口                  |
| `GIT_EDITOR` / `EDITOR`   | `:`              | Git 打开编辑器等你写 commit message   |
| `GIT_PAGER` / `PAGER`     | `cat`            | `git log` / `git diff` 进入分页器阻塞 |
| `GCM_INTERACTIVE`         | `never`          | Git 凭据管理器弹窗                    |
| `GIT_SEQUENCE_EDITOR`     | `:`              | `git rebase` 交互编辑                 |
| `GIT_MERGE_AUTOEDIT`      | `no`             | `git merge` 打开编辑器                |
| `VISUAL`                  | `""`             | 覆盖 `$VISUAL`                        |
| `npm_config_yes`          | `true`           | `npx` 弹确认                          |
| `PIP_NO_INPUT`            | `1`              | `pip` 非输入模式                      |
| `DEBIAN_FRONTEND`         | `noninteractive` | `apt` 等工具非交互                    |
| `HOMEBREW_NO_AUTO_UPDATE` | `1`              | Homebrew 自动更新                     |

#### 对比：官方 non-interactive-env 插件

OpenCode 的 `oh-my-openagent` 插件内置 `non-interactive-env 插件`，但大量的**命令前缀**，反而造成大量噪音、无效 Token：

```powershell
$env:CI="true";$env:DEBIAN_FRONTEND="noninteractive";... <你的命令>
```

每条命令都被追加一长串环境变量赋值。使用 ShellFix **命令字符串零污染**。

建议在 `~/.config/opencode/oh-my-openagent.jsonc` 中禁用内置插件：

```jsonc
{ "disabled_hooks": ["non-interactive-env"] }
```

### ④ Git 换行符降噪 — 节省 Token

`git diff`/`git add`/`git commit` 时 Git 常刷一堆换行符警告：

```
warning: in the working copy of 'foo.ts', LF will be replaced by CRLF the next time Git touches it
```

这是纯噪声：**不改变行为、浪费 token、干扰 Agent**。

通过 `ShellFix`自动消除，支持几种模式：

| 模式           | 方式                            | 生效范围         |
| -------------- | ------------------------------- | ---------------- |
| `auto`（默认） | 自动消除                        | 仅 OpenCode 进程 |
| `config`       | 输出 `git config --global` 命令 | 系统全局         |
| `off`          | 关闭，什么也不做                | —                |

命令：`/shellfix git-line-ending auto|config|off`

---

### ⑤ CodeMap 索引自动化（v2.3.0）

在 .NET 仓库中，插件自行维护 CodeMap 语义索引，让 Agent 的 `codemap_*` 工具随取随用，无需每次手工 `index_ensure_baseline`：

| 时机 | 动作 |
|------|------|
| 会话开始（`session.created`） | 幂等 `ensure_baseline`（已索引秒回）+ 磁盘清理检查 |
| `dotnet build` 成功 | 幂等 `ensure_baseline`（已索引秒回） |
| 编辑 `.cs` 文件 | **不再自动刷新 overlay**（overlay 由 Agent 侧 codemap MCP 维护，避免跨进程写同一 `overlay.wal`） |
| `~/.codemap` >1GB | 间隔 ≥24h 清理旧 baseline（keep_count=3 / 14 天，freed ≥100MB 才实删） |

- 仅 `.slnx/.sln/.csproj` 仓库触发，非 .NET 项目零开销
- 成功 log 一行（repo / elapsed / 符号数）；失败静默 + 5 分钟节流日志，连续失败 ≥3 次才一次性提醒
- 命令 `/codemap-index`：无参数=重建 baseline + 创建 workspace + 刷新 overlay（撞锁自动退避重试），`status`=索引状态，`cleanup`=清理旧 baseline
- 开关 `codemapIndex`（默认 ON）：`/shellfix codemap` 或 palette `shellfix.codemap`；palette `shellfix.codemap-run` 立即重建
- 底层直连 `codemap-mcp.exe`（stdio JSON-RPC），零运行时依赖；`SHELLFIX_CODEMAP_MCP` 可指定可执行文件路径

---

### ⑥ 调试提示 — toast + 计数（v2.3.1 / 四色统一 v2.3.2）

调试期「静默失败」场景的通用提示通道：统一 toast 提示 + 跨会话计数，带总开关：

| 场景 | 触发 | 提示内容 |
|------|------|----------|
| 思考截断 | `session.idle` 检测到末条回复「无正文 + 思考断尾」 | toast「思考截断」（红）+ 计数 |
| codemap 未建索引 | 调用 `codemap_*` 工具报 `repo_path is required` 等 | toast「CodeMap 未建索引」（橙）+ 指引（ensure_baseline / /codemap-index）+ 计数 |

**toast 四色（v2.3.2 全量统一）**——TUI 侧与服务端侧同色语义：

| 颜色 | variant | 语义 | 示例 |
|------|---------|------|------|
| 蓝 | `info` | 中性信息 | 列表为空、无副作用提示 |
| 绿 | `success` | 操作成功 | 已保存 / 已删除 / 开关切换 / 已发送模板 |
| 橙 | `warning` | 缺失或受阻 | 不存在 / 参数无效 / 内容为空 / 稍后重试 |
| 红 | `error` | 失败 | 渲染失败 / 保存失败 / 异常 |

- **不再有「填入输入框」的输出**：模板执行改为直接发送消息 + 绿色 toast 提示（v2.3.2）
- 总开关 `alertToasts`（默认 ON）：`palette shellfix.alerts` 或 `/shellfix alerts` 切换；**关闭后 toast 不弹、计数仍累计**（`alertCounts` 持久化 state.json）
- 计数 key：`think-cut` / `codemap-no-index`（跨会话累计，toast 文案带「(累计 N 次)」）
- 节流：同场景 5 分钟最多 1 条 toast，防连续工具调用刷屏
- 思考截断**仅提示不自愈**（自动续写自愈在 v2.4 内测）

---

## 七命令体系：V2内测

除四大修复外，还提供 6 个命令，所有命令**优先在 TUI 侧本地处理**，零 LLM 成本。

| 命令        | 类别       | 一句话                         |
| ----------- | ---------- | ------------------------------ |
| `/shellfix` | 平台管家   | 四大修复的开关 + 诊断          |
| `/my`       | 模板系统   | "帮我省打字" — 预设文本模板    |
| `/note`     | 笔记系统   | "记录和复用心智"               |
| `/auto`     | 自动化系统 | 自动注入上下文到 system prompt |
| `/kickme`   | 通知系统   | 关键词匹配时弹 toast 通知      |
| `/dynamic`  | 动态上下文 | 关键词触发时自动注入上下文     |
| `/codemap-index` | 索引维护 | .NET 仓库语义索引重建/状态/清理（v2.3.0） |

所有命令同时支持 palette 操作（`Ctrl+P` → 搜索命令名）。

---

### `/shellfix` — 平台管家

三大修复的开关和控制台：

```
/shellfix                   → 状态面板（编码、规则、日志、同步、git-line-ending）
/shellfix cmd               → 列出命令替换规则
/shellfix cmd <name> on/off → 开关规则（export/which/source/touch/rm/chmod/bareEnv/mkdir/cat/grep/find）
/shellfix encoding on/off   → 开关编码注入
/shellfix log on/off        → 开关日志输出
/shellfix doctor            → 环境诊断
/shellfix git-line-ending   → Git 换行符警告处理（auto/config/off）
/shellfix help              → 帮助
```

### `/my` — 模板系统

保存和执行预设文本模板，支持 `{0}` `{branch}` `{date}` 等变量：

```
/my ?                       → 列出所有模板
/my ? <name>                → 预览模板内容
/my <name> [args...]        → 执行模板（直接发送 + 绿色 toast 提示）
/my save <name> <content>   → 保存模板
/my rm <name>               → 删除模板
/my show <name>             → 查看模板原始内容
/my edit <name> [content]   → 编辑模板
/my sync                    → 同步远程模板仓库
/my sync-config             → 同步配置管理
```

内置模板包括 `ys`（验收）、`review`（代码审查）、`pr`（创建 PR）、`bug`（报告 Bug）、`commit`（Commit Message）、`explain`（解释代码）、`deploy`（部署）等。

### `/note` — 笔记系统

用 `#标签#` 格式存储和检索关键信息，支持层级标签：

```
/note ?                     → 列出所有顶层标签
/note ? <prefix>            → 浏览标签树
/note #tag#                 → 注入笔记内容到对话（直接发送）
/note #tag#:<content>       → 保存笔记
/note #tag#:last            → 保存上一条消息
/note rm #tag#              → 删除笔记
/note timeline              → 按时间线浏览笔记
```

支持自动采集：LLM 回复中的 `#标签#` 自动存为笔记。

### `/auto` — 自动化系统

自动注入上下文到 system prompt。v2.0 使用统一的 AutoRuleV2 规则管理，废弃旧模块系统：

```
/auto                       → 查看模块开关总览
/auto list                  → 列出所有模块状态
/auto <module>              → 切换模块开关
/auto mode prompt|auto|silent → 设置模式
/auto require <text>        → 注入当前任务目标
/auto req_rm                → 清除 require
/auto show <module>         → 查看模块内容
/auto reset                 → 恢复默认
/auto conditions            → 条件管理
/auto rule                  → 规则管理（AutoRuleV2）
/auto rule add <module> <trigger> → 添加规则
/auto rule rm <id>          → 删除规则
/auto rule on|off <id>      → 开关规则
```

7 个内置注入模块：

| 模块           | 用途                              | 默认 |
| -------------- | --------------------------------- | ---- |
| `coding`       | 编码规范（TS 严格模式）           | ON   |
| `windows`      | 平台提醒（Windows + PowerShell）  | ON   |
| `tech-stack`   | 技术栈声明                        | ON   |
| `review`       | Review 清单                       | OFF  |
| `security`     | 安全提醒                          | OFF  |
| `git`          | Git 规范                          | OFF  |
| `requirements` | 当前任务目标（通过 require 注入） | 动态 |

#### 条件引擎

注入模块支持 9 种条件谓词，按 AND 逻辑评估：

| 谓词          | 示例                   | 说明         |
| ------------- | ---------------------- | ------------ |
| `os`          | `os=win32`             | 平台匹配     |
| `arch`        | `arch=x64`             | CPU 架构     |
| `branch`      | `branch=feature/*`     | Git 分支通配 |
| `dirty`       | `dirty=true`           | 有未提交改动 |
| `tool_exists` | `tool_exists=dotnet`   | 工具是否存在 |
| `file_exists` | `file_exists=src/*.cs` | 文件是否存在 |
| `is_git_repo` | `is_git_repo=true`     | 是 Git 仓库  |
| `always`      | —                      | 始终匹配     |
| `never`       | —                      | 永不匹配     |

### `/kickme` — 通知系统

关键词/正则匹配时弹出 toast 通知：

```
/kickme                     → 列出所有规则
/kickme add <关键词> <标题> <消息> → 添加规则
/kickme rm <id>             → 删除规则
/kickme on|off <id>         → 开关规则
/kickme sound <id> on|off  → 开关提示音
```

### `/dynamic` — 动态上下文注入

检测用户消息中的关键词，自动注入相关上下文（v1.9 新增）：

```
/dynamic                    → 列出所有动态规则
/dynamic add <触发词> <注入内容> → 添加规则
/dynamic rm <id>            → 删除规则
/dynamic on|off <id>        → 开关规则
/dynamic cooldown <id> <秒>  → 设置冷却时间
```

**工作流程：**

1. 用户发送消息包含触发词 → TUI 侧检测匹配
2. 规则上下文通过 `chat.message` 钩子直接注入到用户消息中
3. 冷却机制防止重复触发
4. 回退方案：v1.9 的 `pendingDynamic` + `system.transform` 仍在

---

## 快速开始

### 方式一：npm 一键安装（推荐）

```bash
# 安装（自动加载，重启生效）
opencode plugin @tkwf/opencode-shellfix
```

或在 `~/.config/opencode/opencode.json` 中手动添加：

```json
{
  "plugin": ["@tkwf/opencode-shellfix"]
}
```

> **发布渠道迁移（v2.3.4）**：原包 `opencode-shellfix` 停在 **2.2.12**（旧 npm 账号邮箱不可达，无法继续发布），后续版本统一发布到 **`@tkwf/opencode-shellfix`**。旧包在账号恢复后会标记 `deprecated` 指向新包，请改用新包名。

> 需 TUI 调度器（palette 入口、事件订阅）？npm 包仅包含核心插件（`shell-fix.ts`）。完整体验请额外部署 TUI 文件（见方式二）。

### 方式二：手动复制

```bash
# 1. 创建全局插件目录
mkdir -p ~/.config/opencode/plugins/

# 2. 复制插件
cp src/shell-fix.ts ~/.config/opencode/plugins/
cp src/shell-fix-tui.ts ~/.config/opencode/plugins/

# 3. 重启 OpenCode，自动生效 ✅
```

或用部署脚本（自动备份旧版本）：

```powershell
.\deploy.ps1
```

> 如需 TUI 调度器（palette 入口、事件订阅），必须同时部署 `shell-fix-tui.ts`；仅需三大修复则可只部署 `shell-fix.ts`。

---

## 功能测试

### 四大基础功能

| 测试        | 操作                                      | 预期                            |
| ----------- | ----------------------------------------- | ------------------------------- |
| 中文不乱码  | `Write-Output "你好，世界！"`             | 正常显示中文                    |
| export 转换 | `export MY_TEST=hello; echo $env:MY_TEST` | 输出 `hello`                    |
| Git 免交互  | `git status`                              | 正常执行无弹窗                  |
| 版本检测    | `echo $env:SHELLFIX_VERSION`              | 输出 `2.1.1`                    |
| 状态面板    | 让 Agent 执行 `/shellfix`                 | 显示状态面板                    |
| 启动日志    | 查看 OpenCode 日志                        | 搜索 `[ShellFix] v2.1.1 loaded` |

### 动态上下文

```
# TUI 侧测试（无需 LLM）：
/dynamic add react "用户关注 React。参考：Hooks 规则、JSX 语法"
→ 当用户消息包含 "react" 时，自动注入相关上下文
```

### 通知规则

```
/kickme add error "发现错误" "消息中提到了 error"
→ 当用户或 LLM 消息包含 "error" 时弹出 toast
```

---

## 历史开发方案草案

---

## 兼容性

| 平台                 | 支持 | 说明                                    |
| -------------------- | ---- | --------------------------------------- |
| Windows + PowerShell | ✅    | 目标平台，完整支持                      |
| macOS / Linux        | ⚠️    | 编码前缀可能报 bash 错误，需关 encoding |
| OpenCode 版本        | ✅    | 需 ≥ 支持插件系统                       |

---