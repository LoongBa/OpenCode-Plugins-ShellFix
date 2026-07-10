# OpenCode Plugins ShellFix 🔧

**Windows PowerShell 三大修复：中文不乱码 · export 命令转换 · Git 免交互**

当前版本：**v1.2.0**

## 痛点

在 Windows 上用 OpenCode 的开发者都遇到过：

```bash
# Agent 输出这个（Linux bash 语法）👇
export CI=true
export DB_HOST=localhost

# PowerShell 报错 👇
'export' 不是内部或外部命令，也不是可运行的程序或批处理文件。
```

以及：

```powershell
# 中文输出全是乱码 ❌
Write-Output "你好世界"
# 输出：浣犲ソ涓栫晫
```

还有：

```powershell
# Git 卡住等待交互式输入 ❌
git commit -m "fix"
# 等待编辑器、等待凭据、进入分页器...
```

## 三大功能

### ① 中文不乱码

`tool.execute.before` 钩子在每条命令前自动注入 UTF-8 编码设置：

```powershell
$OutputEncoding=[Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
```

PowerShell 非交互子进程默认输出编码为系统代码页（Windows 常见 GBK），导致中文乱码。插件的编码前缀强制设置管道和控制台编码为 UTF-8。

### ② export → $env: 自动转换

Agent 生成的 Linux export 语法被自动拦截并转换为 PowerShell 兼容写法：

| Agent 输出 | 插件转换后 |
|-----------|-----------|
| `export FOO=bar` | `$env:FOO="bar";` |
| `export FOO="hello world"` | `$env:FOO="hello world";` |
| `export FOO='hello $PATH'` | `$env:FOO="hello \`$PATH";` |
| `export K1=v1 K2=v2 && make` | `$env:K1="v1";$env:K2="v2"; && make` |

### ③ Git 免交互

通过 `shell.env` 钩子在**进程初始化时**注入 16 个非交互环境变量，子进程自动继承，无需写进命令字符串：

| 变量 | 值 | 防止 |
|------|-----|------|
| `CI` | `true` | 工具检测到 CI 后禁用交互模式 |
| `GIT_TERMINAL_PROMPT` | `0` | Git 弹出凭据询问窗口 |
| `GIT_EDITOR` / `EDITOR` | `:` | Git 打开编辑器等你写 commit message |
| `GIT_PAGER` / `PAGER` | `cat` | `git log` / `git diff` 进入分页器阻塞 |
| `GCM_INTERACTIVE` | `never` | Git 凭据管理器弹窗 |
| `GIT_SEQUENCE_EDITOR` | `:` | `git rebase` 交互编辑 |
| `GIT_MERGE_AUTOEDIT` | `no` | `git merge` 打开编辑器 |
| `VISUAL` | `""` | 覆盖 `$VISUAL` |
| `npm_config_yes` | `true` | `npx` 弹确认 |
| `PIP_NO_INPUT` | `1` | `pip` 非输入模式 |
| `DEBIAN_FRONTEND` | `noninteractive` | `apt` 等工具非交互 |
| `HOMEBREW_NO_AUTO_UPDATE` | `1` | Homebrew 自动更新 |

> 注意：这些变量通过 `shell.env` 注入进程环境，**不写进命令字符串**，与 oh-my-openagent 的 `non-interactive-env` 插件（用 `tool.execute.before` 注入 `$env:CI="true"` 前缀）不同。如果同时启用两者，建议禁用 `non-interactive-env` 以避免命令前缀膨大。

## 架构

两个钩子解耦三个功能：

| 钩子 | 时机 | 功能 |
|------|------|------|
| `shell.env` | 进程初始化 | ③ Git 免交互（16 个环境变量） |
| `tool.execute.before` | 每条命令前 | ① 中文不乱码（编码前缀）+ ② export → $env: 转换 |

## 快速开始

```bash
# 1. 创建全局插件目录
mkdir -p ~/.config/opencode/plugins/

# 2. 复制插件
cp src/shell-fix.ts ~/.config/opencode/plugins/

# 3. 重启 OpenCode，自动生效 ✅
```

## 禁用 oh-my-openagent 的 non-interactive-env 插件

ShellFix 已通过 `shell.env` 覆盖 Git 免交互功能，且不产生命令前缀。建议禁用 oh-my-openagent 的 `non-interactive-env` 插件以避免重复：

在 `opencode.json` 中找到 plugin 配置，从 oh-my-openagent 的 hooks 列表中移除 `nonInteractiveEnv`，或在 oh-my-openagent 的配置文件中设置：

```json
{
  "omo": {
    "hooks": {
      "nonInteractiveEnv": false
    }
  }
}
```

## 验证安装

| 方法 | 操作 | 预期结果 |
|------|------|----------|
| 版本检测 | `echo $env:SHELLFIX_VERSION` | 输出 `1.2.0` |
| 状态指令 | 让 Agent 执行 `/shellfix` | 显示三大功能状态面板 |
| CI 变量 | `echo $env:CI` | 输出 `true` |
| 中文编码 | `Write-Output "你好，世界！"` | 正常显示中文 |
| export 转换 | `export MY_TEST=hello; echo $env:MY_TEST` | 输出 `hello` |
| Git 免交互 | `git status` | 正常执行，无交互提示 |
| 启动日志 | 查看 OpenCode 日志 | 搜索 `[ShellFix] v1.2.0 loaded` |

## 文件结构

```
OpenCode-Plugins-ShellFix/
├── README.md                  # 本文件
├── src/
│   └── shell-fix.ts           # 插件主代码 — 可直接部署到 .opencode/plugins/
└── docs/
    ├── 01-方案评估.md          # v1.0 — 原设计方案技术审查
    ├── 02-完整修复方案.md       # v1.0 — 修正后设计方案
    └── 03-安装与使用.md        # v1.0 — 安装、验证、FAQ、卸载指南（内容已落后于 v1.2.0）
```

## 核心能力示例

```typescript
// 输入（Agent 生成的 bash 命令）
export FOO=bar
export DB_HOST="localhost" DB_PORT=5432
export PATH="/usr/local/bin:$PATH"

// 输出（插件自动转换后，PowerShell 执行的最终命令）
$OutputEncoding=[Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$env:FOO="bar";$env:DB_HOST="localhost";$env:DB_PORT="5432";
$env:PATH="/usr/local/bin/`$PATH";
```

## 状态指令 `/shellfix`

让 Agent 执行 `/shellfix` 或 `#shellfix`，显示状态面板：

```
[ShellFix] v1.2.0
  ├ 中文不乱码: UTF-8 encoding prefix
  ├ export→$env: auto-convert
  └ Git 免交互: 16 env vars via shell.env
```

## 兼容性

| 平台 | 支持 | 说明 |
|------|------|------|
| Windows + PowerShell | ✅ | 目标平台，完整支持 |
| macOS / Linux | ⚠️ | 编码前缀可能报 bash 错误，需加平台判断 |
| OpenCode 版本 | ✅ | 需 ≥ 支持插件系统（`shell.env` + `tool.execute.before` 钩子） |

## 项目背景

本方案源于对原始设计的技术审查。审查发现原方案的 `shell.env` 用法基于虚构的 API 字段（`preCommand`、`vars`），实际 API 能力边界不同。本仓库提供经过真实 API 验证的完整修复方案。

详见 [`docs/01-方案评估.md`](docs/01-方案评估.md) 了解原始问题，和 [`docs/02-完整修复方案.md`](docs/02-完整修复方案.md) 了解基础设计。

## 许可证

MIT