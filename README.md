# OpenCode Plugins AutoFix 🔧

**自动解决 Windows PowerShell 下 OpenCode 的两个顽固问题：export 语法不兼容 + 中文乱码。**

当前版本：**v1.1.0**

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

## 解决方案

一个原生 OpenCode 插件，两个钩子解耦两个问题：

| 钩子 | 时机 | 解决 |
|------|------|------|
| `shell.env` | 进程初始化 | 预注入 18 个 CI 全局环境变量（含 `SHELLFIX_VERSION`） |
| `tool.execute.before` | 每条命令前 | ① 强制 UTF-8 编码 ② export → `$env:` 转换 |

**工作原理**：Agent 输出 `export FOO=bar` → 插件自动拦截 → 转为 `$env:FOO="bar";` → PowerShell 无痛执行。

## 快速开始

```bash
# 1. 创建全局插件目录
mkdir -p ~/.config/opencode/plugins/

# 2. 复制插件
cp src/shell-fix.ts ~/.config/opencode/plugins/

# 3. 重启 OpenCode，自动生效 ✅
```

## 验证安装

| 方法 | 操作 | 预期结果 |
|------|------|----------|
| 环境变量 | `echo $env:SHELLFIX_VERSION` | 输出 `1.1.0` |
| 状态指令 | 让 Agent 执行 `/shellfix` | 显示状态面板 |
| CI 变量 | `echo $env:CI` | 输出 `true` |
| 启动日志 | 查看 OpenCode 日志 | 搜索 `[ShellFix] v1.1.0 loaded` |

## 文件结构

```
OpenCode-Plugins-ShellFix/
├── README.md                  # 本文件
├── src/
│   └── shell-fix.ts           # 插件主代码 — 可直接部署到 .opencode/plugins/
└── docs/
    ├── 01-方案评估.md          # 对原设计方案的技术审查报告
    ├── 02-完整修复方案.md       # 完整的修正后设计方案
    └── 03-安装与使用.md        # 安装、验证、FAQ、卸载指南
```

## 核心能力

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

## 额外功能

### 启动通知

插件加载时在 OpenCode 日志中输出：

```
[ShellFix] v1.1.0 loaded — Windows PowerShell export/encoding fix active
```

### 状态指令 `/shellfix`

让 Agent 执行 `/shellfix` 或 `#shellfix`，显示状态面板：

```
[ShellFix] v1.1.0
  ├ Status: Active
  ├ Export syntax: $env:KEY=VAL auto-convert
  ├ Encoding: UTF-8 forced prefix
  └ CI vars: 18 pre-injected
```

### 环境变量 `SHELLFIX_VERSION`

插件自动注入 `$env:SHELLFIX_VERSION`，执行 `echo $env:SHELLFIX_VERSION` 即可确认插件是否生效。

## 项目背景

本方案源于对原始设计的技术审查。审查发现原方案的 `shell.env` 用法基于虚构的 API 字段（`preCommand`、`vars`），实际 API 能力边界不同。本仓库提供经过真实 API 验证的完整修复方案。

详见 [`docs/01-方案评估.md`](docs/01-方案评估.md) 了解全部问题，和 [`docs/02-完整修复方案.md`](docs/02-完整修复方案.md) 了解修正细节。

## 兼容性

| 平台 | 支持 | 说明 |
|------|------|------|
| Windows + PowerShell | ✅ | 目标平台，完整支持 |
| macOS / Linux | ⚠️ | 编码前缀可能报 bash 错误，需加平台判断 |
| OpenCode 版本 | ✅ | 需 ≥ 支持插件系统（`shell.env` + `tool.execute.before` 钩子） |

## 许可证

MIT
