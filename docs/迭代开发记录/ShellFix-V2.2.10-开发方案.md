# v2.2.10 开发方案 — 命令错误检测激活 + 裸 VAR=x 转换

> 状态：✅ 已实现（2026-08-02）
> 版本：v2.2.10

---

## 一、背景与问题

### 1.1 cmd-errors 检测是"半成品"（v2.2.7 遗留）

v2.2.7 已建成 cmd-errors 的**记录 + 提醒基础设施**：

| 层 | 组件 | 位置 | 状态 |
|----|------|------|------|
| 状态 | `cmdErrors: CmdErrorEntry[]` + `addCmdError/getCmdErrors/markCmdErrorNotified/clearCmdErrors` | `src/lib/state.ts` 657-692 | ✅ 存在 |
| 提醒 | `system.transform` 注入 `[ShellFix] 注意：以下命令在 PowerShell 中不存在...`（失败 ≥2 次） | `src/shell-fix.ts` 509-514 | ✅ 存在 |
| 面板 | `shellfix.cmd-errors` palette 日志显示 | `src/shell-fix-tui.ts` 1389 | ✅ 存在 |

**但检测钩子从未接入** —— `addCmdError()` 在 `shell-fix.ts` line 90 import 后**零调用点**。结论：

- `cmdErrors` 恒为空数组 → `frequentErrors.length > 0` 恒 false → **提醒永不触发**
- v2.2.7 提交信息自认：`Proactive: addCmdError() API for future detection hooks to call`

**代码佐证**（ShellFix 源码审计）：

```typescript
// shell-fix.ts line 90-91：只有 import，无调用
addCmdError,   // ← 全文件唯一出现（除 state.ts 定义处）
getCmdErrors,  // ← line 510 有调用，但因数据为空永不触发
```

### 1.2 裸 `VAR=x`（无 export 前缀）不转换

当前 `applyExportRule` 只匹配 `^\s*export\s+` 开头：

```typescript
if (!EXPORT_RE.test(cmd)) return cmd;  // 裸 GIT_MASTER=1 直接 return
```

Agent 写出 `GIT_MASTER=1`（bash 内联赋值）时 PowerShell 报 `The term 'GIT_MASTER=1' is not recognized`，且不属于任何现有转换规则 → 裸错误。

### 1.3 报错后只有 Agent 自纠，无插件介入

观察到的流程：`GIT_MASTER=1` 报错 → Agent 看到错误后自纠为 `$env:GIT_MASTER="1"`。这个纠正是 LLM 行为，插件无任何参与。错误次数、上下文、提醒都不存在。

---

## 二、方案设计

### 2.1 激活错误检测：新增 `tool.execute.after` 钩子

API 签名（`docs/09-API-探索报告.md` 2.5 节）：

```typescript
"tool.execute.after"?: (input: {
    tool: string; sessionID: string; callID: string; args: any;
}, output: { title: string; output: string; metadata: any; }) => Promise<void>;
```

**设计：**

1. 仅在 `tool === "bash"` 时处理（其他工具输出不检测）
2. 从 `output.output` 提取错误模式，匹配到则调用 `addCmdError(failedCmd)`
3. **命令名提取**：从 `args.command` 取首个 token（去掉编码前缀后），或从错误文本正则提取
4. 错误匹配后**立即注入**实时提示，不等下轮 system.transform

**错误模式正则（PowerShell 中英文）：**

| 语言 | 模式 | 正则 |
|------|------|------|
| 中文 | `无法将"X"项识别为 cmdlet\函数\脚本文件\可运行程序` | `/无法将["'`]([^"'`]+)["'`]\s*项识别为\s*(?:cmdlet\|函数\|脚本文件\|可运行程序)/` |
| 中文 | `"X"不是内部或外部命令` | `/["'`]([^"'`]+)["'`]\s*不是内部或外部命令/` |
| 中文 | `找不到`（路径/文件） | `/找不到.*?["'`]([^"'`]+)["'`]/` |
| 英文 | `The term 'X' is not recognized as...` | `/The term ['"`]([^'"`]+)['"`] is not recognized/` |
| 英文 | `X: command not found` | `/([a-zA-Z_][\w.-]*): (?:command )?not found/` |
| 英文 | `Cannot find path/file 'X'` | `/Cannot find (?:path\|file) ['"`]([^'"`]+)['"`]/` |

**去重策略**：相同命令跨会话累计 count（复用现有 `addCmdError` 逻辑），触发提醒阈值 = count ≥ 2。

### 2.2 裸 `VAR=x` 转换规则（新增 cmdRule）

**匹配**：行首 `^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$`（无 `export` 前缀、非命令）

**歧义排除：**

| 排除场景 | 示例 | 正则是否自动排除 |
|----------|------|-----------------|
| `$env:X=` 已带前缀 | `$env:FOO="x"` | ✅ 行首 `$` 不在 `[A-Za-z_]` 范围 |
| 命令含 `=`（空格分隔） | `echo a=b` | ✅ `echo` 后为空格非 `=` |
| 比较运算符 | `if ($x = 5)` | ✅ `if` 后为空格非 `=` |
| 参数传递（非行首） | `cmd --flag k=v` | ✅ `cmd` 后为空格非 `=` |
| 命令链（后随 `&&`/`;`/`\|`） | `FOO=1 && make` | ✅ 值含 `&`/`;`/`\|` 时跳过 |
| 未加引号多 token | `FOO=hello world` | ✅ 值含空格且未加引号时跳过 |

**转换输出：** `GIT_MASTER=1` → `$env:GIT_MASTER="1";`（无值 `VAR=` → `$env:VAR="";`）

**值含引号支持：**

| 输入 | 输出 |
|------|------|
| `FOO="hello world"` | `$env:FOO="hello world";` |
| `FOO='single'` | `$env:FOO="single";` |
| `FOO=$PATH` | `$env:FOO="\`$PATH";`（`$` 转义，与 `applyExportRule` 一致） |
| `FOO=a=b` | `$env:FOO="a=b";` |

**开关**：新增 `cmdRules.bareEnv`（默认 on），可通过 `shellfix.bash` palette 面板切换。

### 2.3 实时提示注入

**现状**：`system.transform` 只在**下轮 LLM 调用**时注入 → Agent 需要再发起一次才能看到提示。

**改进**：`tool.execute.after` 检测到错误时，直接在工具输出的末尾追加实时提示：

```
[ShellFix 提示] 检测到 PowerShell 错误：`GIT_MASTER=1` 不是有效命令。
PowerShell 环境变量赋值请用：$env:GIT_MASTER="...";
```

**为什么不在 `experimental.chat.message` 注入？**

> 方案原稿提议走 `experimental.chat.message` 的 output 追加。实际实现时发现：`tool.execute.after` 的 `output.output` 为工具执行结果，修改后直接返回给 LLM，**实时性更强**（同一轮 agentic loop 内可见），且无需依赖 unstable 的 experimental API。`system.transform` ≥2 兜底保留。

**回退策略**：若 `tool.execute.after` 的 output 修改在某些平台不可用，`system.transform` 的 ≥2 阈值保持不变（跨会话持久兜底），无需降到 ≥1。

### 2.4 与现有机制的关系

| 机制 | 关系 |
|------|------|
| `applyExportRule` | 互补：`export X=1` 走旧规则，裸 `X=1` 走新规则 |
| `addCmdError` | 复用现有 API，补上缺失的调用点 |
| `system.transform` 提醒 | 保留为兜底（跨会话持久），`tool.execute.after` 为实时层 |
| `/shellfix cmd-errors` 面板 | 数据源从空数组变为真实记录，面板自动生效 |

---

## 三、实现细节

### 3.1 文件改动清单

| 文件 | 改动说明 |
|------|----------|
| `src/lib/state.ts` | `CmdRuleName` 加 `"bareEnv"`、`CmdRules` 加 `bareEnv: boolean`、`CMD_RULES_META` 加 bareEnv 条目、`DEFAULT_STATE` 加 `bareEnv: true`、`PLUGIN_VERSION` `"2.2.9"` → `"2.2.10"` |
| `src/shell-fix.ts` | 新增常量区（`PS_ERROR_PATTERNS` 6 条正则 + `BARE_ENV_RE`）、`applyBareEnvRule()` 函数、`buildErrorHint()` 函数、`tool.execute.after` 钩子、`tool.execute.before` 接入 `s.cmdRules.bareEnv` |
| `src/shell-fix-tui.ts` | 无改动（CMD_RULES_META 驱动 `showCmdRules` 面板，bareEnv 自动出现） |

### 3.2 核心代码

**`applyBareEnvRule()`：**

```typescript
const BARE_ENV_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function applyBareEnvRule(cmd: string): string {
  if (/^\s*\$env:/i.test(cmd)) return cmd;  // 已有 $env: 前缀
  if (EXPORT_RE.test(cmd)) return cmd;      // export 前缀

  const m = cmd.match(BARE_ENV_RE);
  if (!m) return cmd;

  const key = m[1];
  let val = m[2].trim();

  // 歧义排除：命令链 / 未引号多 token
  if (/[&;|]/.test(val)) return cmd;
  if (/\s/.test(val) && !/^["']/.test(val)) return cmd;

  // 去引号
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
    val = val.replace(/\\(["\\])/g, "$1");
  }

  return `$env:${key}="${escapePSDoubleQuoted(val)}";`;
}
```

**`tool.execute.after` 钩子：**

```typescript
"tool.execute.after": async (input, output) => {
  try {
    const tool = (input as { tool: string }).tool;
    if (tool !== "bash" && tool !== "pwsh") return;

    const cmd: string | undefined = (input as { args: { command?: string } }).args?.command;
    if (typeof cmd !== "string") return;

    const resultText: string = (output as { output: string }).output || "";
    if (!resultText) return;

    // 提取失败命令名：优先从错误文本正则捕获组
    let failedCmd = "";
    for (const re of PS_ERROR_PATTERNS) {
      const m = resultText.match(re);
      if (m && m[1]) { failedCmd = m[1].trim(); break; }
    }
    // 回退：错误文本命中正则但未捕获 → 取命令首 token
    if (!failedCmd && PS_ERROR_PATTERNS.some((re) => re.test(resultText))) {
      const stripped = cmd
        .replace(/^\s*(?:\$OutputEncoding=[^;]+;\s*)?\[Console\]::OutputEncoding=[^;]+;\s*/, "")
        .trim();
      failedCmd = stripped.split(/\s+/)[0] || "";
    }
    if (!failedCmd) return;

    addCmdError(failedCmd);

    // 实时提示：追加到工具输出末尾
    const hint = buildErrorHint(failedCmd);
    if (hint) {
      (output as { output: string }).output = `${resultText}\n\n${hint}`;
    }
  } catch (e) {
    console.error(`[ShellFix] tool.execute.after error:`, e);
  }
},
```

**`buildErrorHint()`：**

```typescript
function buildErrorHint(failedCmd: string): string {
  const bareEnvMatch = failedCmd.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (bareEnvMatch) {
    const key = bareEnvMatch[1];
    return `[ShellFix 提示] 检测到 PowerShell 错误：\`${failedCmd}\` 不是有效命令。\nPowerShell 环境变量赋值请用：$env:${key}="...";`;
  }
  return `[ShellFix 提示] 检测到 PowerShell 错误：\`${failedCmd}\` 在 PowerShell 中不存在。\n请使用 PowerShell 等效命令，或执行 /shellfix cmd-errors 查看记录。`;
}
```

### 3.3 `tool.execute.before` 集成

在命令替换链中，bareEnv 紧接 export 之后执行：

```typescript
// 命令替换（按开关执行）
if (s.cmdRules.export) {
  result = applyExportRule(result);
}
if (s.cmdRules.bareEnv) {
  result = applyBareEnvRule(result);
}
if (s.cmdRules.which) {
  result = applyWhichRule(result);
}
// ... 其余规则不变
```

---

## 四、测试验证

### 4.1 裸赋值转换测试（14 用例，14/14 通过）

| 用例 | 输入 | 期望输出 | 结果 |
|------|------|----------|------|
| 裸赋值 | `GIT_MASTER=1` | `$env:GIT_MASTER="1";` | ✅ |
| 无值 | `VAR=` | `$env:VAR="";` | ✅ |
| 带引号含空格 | `FOO="hello world"` | `$env:FOO="hello world";` | ✅ |
| 单引号 | `FOO='single'` | `$env:FOO="single";` | ✅ |
| 含 `$` 转义 | `FOO=$PATH` | `$env:FOO="\`$PATH";` | ✅ |
| export 前缀不动 | `export FOO=1` | `export FOO=1` | ✅ |
| 已有 `$env:` 前缀不动 | `$env:FOO="1"` | `$env:FOO="1"` | ✅ |
| 命令含 `=` 不动 | `echo a=b` | `echo a=b` | ✅ |
| 比较运算符不动 | `if ($x = 5)` | `if ($x = 5)` | ✅ |
| 参数传递不动 | `cmd --flag k=v` | `cmd --flag k=v` | ✅ |
| 命令链不动 | `FOO=1 && make` | `FOO=1 && make` | ✅ |
| 分号命令链不动 | `FOO=1; echo hi` | `FOO=1; echo hi` | ✅ |
| 值含 `=` | `FOO=a=b` | `$env:FOO="a=b";` | ✅ |
| 首尾空格 | `  GIT_MASTER=1  ` | `$env:GIT_MASTER="1";` | ✅ |

### 4.2 错误正则测试（6 用例，6/6 通过）

| 用例 | 错误文本 | 提取命令 | 结果 |
|------|----------|----------|------|
| 中文 cmdlet | `无法将"GIT_MASTER=1"项识别为cmdlet...` | `GIT_MASTER=1` | ✅ |
| 中文 cmd.exe | `'export' 不是内部或外部命令...` | `export` | ✅ |
| 中文找不到路径 | `找不到路径 "D:\\foo"...` | `D:\\foo` | ✅ |
| 英文 is not recognized | `The term 'which' is not recognized as...` | `which` | ✅ |
| 英文 command not found | `bash: git: command not found` | `git` | ✅ |
| 英文 Cannot find | `Cannot find path 'C:\\bar'...` | `C:\\bar` | ✅ |

### 4.3 LSP 诊断

`src/shell-fix.ts` 和 `src/lib/state.ts` 均为零错误。

---

## 五、交付清单

- [x] `src/shell-fix.ts` — 新增 `tool.execute.after` 钩子（错误模式正则 + `addCmdError` 调用）
- [x] `src/shell-fix.ts` — 实时提示注入（`tool.execute.after` 追加到工具输出，system.transform 兜底保留）
- [x] `src/lib/state.ts` — `cmdRules.bareEnv` 状态字段 + 默认值 + `PLUGIN_VERSION` 2.2.10
- [x] `src/shell-fix.ts` — `applyBareEnvRule()` + 排除歧义逻辑 + `cmdRules.bareEnv` 开关接入
- [x] `src/shell-fix-tui.ts` — 无需改动（CMD_RULES_META 驱动，`showCmdRules` 面板自动含 bareEnv）
- [x] 测试：14 转换用例 + 6 正则用例全部通过
- [x] 文档：CHANGELOG + README + 开发方案
- [x] 版本号 bump v2.2.9 → v2.2.10
- [x] 部署到 `~/.config/opencode/plugins/` 并验证

---

## 附：实现注记

### 与方案原稿的差异

| 条目 | 原方案 | 实际实现 | 原因 |
|------|--------|----------|------|
| 实时提示注入点 | `experimental.chat.message` output | `tool.execute.after` output.output | `tool.execute.after` 输出直接返回 LLM，实时性更强；experimental API 不稳定 |
| system.transform 阈值 | 降到 ≥1（回退策略） | 保持 ≥2（不变） | 实时层已覆盖首次错误，兜底只需跨会话持久，无需降级 |
| tui 命令支持 | `/shellfix cmd bareEnv on/off` | 通过 `CMD_RULES_META` 自动在 `shellfix.bash` 面板出现 | palette 面板是当前统一的配置入口，无需恢复已移除的斜杠 handler |

### 关键行号

- `state.ts` CmdRuleName: line 16
- `state.ts` CmdRules: lines 39-49
- `state.ts` CMD_RULES_META bareEnv: line 150
- `state.ts` DEFAULT_STATE.cmdRules: lines 179-189
- `state.ts` PLUGIN_VERSION: line 53
- `shell-fix.ts` PS_ERROR_PATTERNS: lines 233-244
- `shell-fix.ts` BARE_ENV_RE: line 247
- `shell-fix.ts` tool.execute.after: lines 467-507
- `shell-fix.ts` applyBareEnvRule: lines 705-735
- `shell-fix.ts` buildErrorHint: lines 738-746