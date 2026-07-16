# OpenCode Plugins ShellFix 🔧

**Windows PowerShell 三大修复 + 六命令体系**

当前版本：**v2.2.8**

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
$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;
```

PowerShell 非交互子进程默认输出编码为系统代码页（Windows 常见 GBK），导致中文乱码。插件强制设置管道和控制台编码为 UTF-8。

> 优化：v2.1.1 将前缀从 120 字符压缩至 69 字符（-42%），v2.2.8 再压缩至 64 字符，pwsh 7+ 跳过 `$OutputEncoding` 进一步减至 51 字符。

### ② export → $env: 自动转换

Agent 生成的 Linux export 语法被自动转换为 PowerShell 兼容写法：

| Agent 输出                   | 插件转换后                           |
| ---------------------------- | ------------------------------------ |
| `export FOO=bar`             | `$env:FOO="bar";`                    |
| `export FOO="hello world"`   | `$env:FOO="hello world";`            |
| `export FOO='hello $PATH'`   | `$env:FOO="hello \`$PATH";`          |
| `export K1=v1 K2=v2 && make` | `$env:K1="v1";$env:K2="v2"; && make` |

不再出现大量错误，减少重复对话。

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

## 六命令体系：V2内测

除四大修复外，还提供 6 个命令，所有命令**优先在 TUI 侧本地处理**，零 LLM 成本。

| 命令        | 类别       | 一句话                         |
| ----------- | ---------- | ------------------------------ |
| `/shellfix` | 平台管家   | 四大修复的开关 + 诊断          |
| `/my`       | 模板系统   | "帮我省打字" — 预设文本模板    |
| `/note`     | 笔记系统   | "记录和复用心智"               |
| `/auto`     | 自动化系统 | 自动注入上下文到 system prompt |
| `/kickme`   | 通知系统   | 关键词匹配时弹 toast 通知      |
| `/dynamic`  | 动态上下文 | 关键词触发时自动注入上下文     |

所有命令同时支持 palette 操作（`Ctrl+P` → 搜索命令名）。

---

### `/shellfix` — 平台管家

三大修复的开关和控制台：

```
/shellfix                   → 状态面板（编码、规则、日志、同步、git-line-ending）
/shellfix cmd               → 列出命令替换规则
/shellfix cmd <name> on/off → 开关规则（export/which/source/touch/rm/chmod）
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
/my <name> [args...]        → 执行模板（填入输入框）
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
/note #tag#                 → 注入笔记内容到输入框
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