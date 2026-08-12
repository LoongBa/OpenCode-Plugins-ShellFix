# v2.2.11 开发方案 — 输入编码修复 + mkdir -p + cat/grep/find 命令映射

> 状态：📝 方案待审
> 版本：v2.2.11

---

## 一、背景与问题

### 1.1 命令输入中文乱码（#1 — 输入编码修复）

**问题**：命令字符串中的中文路径/字符串在传输到 PowerShell 时损坏。

**根因**：现有 `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;` 前缀只修复了**子进程输出编码**（命令结果不乱码），不修复**命令输入编码**（命令本身的中文通过 stdin 或管道传输时按系统代码页 GBK 解码，字节错位 → ParserError）。

**典型错误**：
```
$f="F:\LoongBa_Git\_TKWF\_Domain.SG\..."  ← 中文路径损坏
→ 字节错位 → $startLineNumber 被误解析
→ "Variable reference is not valid. ':' was not followed by..."
```

**对称性**：V2.2.10 已修复输出编码（`tool.execute.after` 错误检测 + 实时提示），V2.2.11 补上输入编码，形成"输入+输出"闭环。

### 1.2 `mkdir -p` 报错（#4）

**问题**：Agent 写出 `mkdir -p foo/bar` 时，PowerShell 报错：
```
mkdir : Missing argument in parameter list.
```
因为 `-p` 参数在 PowerShell 中不存在（`mkdir` 是 `New-Item -ItemType Directory` 的别名，不接受 `-p`）。

**现状**：无任何转换规则，Agent 看到错误后自纠，浪费 Token。

### 1.3 `cat` / `grep` / `find` 不存在（#5）

**问题**：Agent 写出 Linux 命令 `cat file`、`grep pattern file`、`find . -name "*.ts"`，在 PowerShell 中报错：
```
The term 'cat' is not recognized as a cmdlet...
The term 'grep' is not recognized as a cmdlet...
The term 'find' is not recognized as a cmdlet...
```

**注意**：PowerShell 7 中 `cat` 是 `Get-Content` 的别名，但 `cat -n` 等带参数形式仍会失败。`grep` 和 `find` 在 PowerShell 中完全不存在。

**现有同类规则**：`which` → `Get-Command`、`touch` → `New-Item`、`rm` → `Remove-Item` 等已有成熟的单命令映射模式。

---

## 二、方案设计

### 2.1 输入编码修复（#1）

**设计**：在现有编码前缀中追加 `[Console]::InputEncoding` 链式赋值，将输入编码也设置为 UTF-8。

**现有前缀：**
```
PS:   $OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;
PWSH: [Console]::OutputEncoding=[Text.Encoding]::UTF8;
```

**新前缀：**
```
PS:   $OutputEncoding=[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;
PWSH: [Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;
```

**原理**：`[Console]::InputEncoding` 控制 PowerShell 从 stdin 读取输入时使用的编码。设为 UTF-8 后，通过管道/stdin 传入的含中文命令字符串将被正确解码，不再出现字节错位导致的 ParserError。

**不加入 `chcp 65001`**：`chcp` 是 cmd.exe 内部命令，在 PowerShell 中需调 `chcp.com` 且有副作用（某些 Windows 版本上 `chcp 65001` 会导致部分原生工具崩溃）。`[Console]::InputEncoding` 是纯 PowerShell 原生方案，无副作用。

**不新增开关**：输入编码与输出编码共享同一个 `s.encoding` 开关，两者始终同时启用/禁用（互补功能，无独立开关意义）。

**保护：**
- 更新行 457 的正则，新增 `\[Console\]::InputEncoding\s*=` 分支，防止 `tool.execute.after` 中二次注入
- 更新行 491 的 stripping 正则，确保错误提取时也能正确剥离输入编码前缀

### 2.2 `mkdir -p` 转换规则（#4）

**匹配**：行首 `mkdir -p <路径>`（`-p` 参数 + 路径）

**转换**：`mkdir -p foo/bar` → `New-Item -ItemType Directory -Force -Path 'foo/bar'`

**歧义排除：**
| 场景 | 示例 | 处理 |
|------|------|------|
| `mkdir` 不带 `-p` | `mkdir foo` | 不转换（PowerShell 别名原生支持） |
| `mkdir -p` 多路径 | `mkdir -p a b` | 路径含空格时不转换（安全忽略） |
| `mkdir` 非行首 | `echo mkdir -p foo` | 不匹配（行首锚定） |

**开关**：新增 `cmdRules.mkdir`（默认 on），通过 `/shellfix cmd` 面板切换。

### 2.3 `cat` / `grep` / `find` 单命令映射（#5）

**三个独立规则**：

| 规则 | 匹配 | 转换 | 默认 |
|------|------|------|------|
| `cat` | `cat <路径>` | `Get-Content -Path '<路径>' -Encoding UTF8` | OFF |
| `grep` | `grep <模式> <路径>` | `Select-String -Pattern '<模式>' -Path '<路径>'` | OFF |
| `find` | `find <路径> -name '<模式>'` | `Get-ChildItem -Path '<路径>' -Recurse -Filter '<模式>'` | OFF |

**限定**：仅匹配**单命令**形态（无管道、无复杂参数）。`cat` 不处理 `-n` 等参数，`grep` 不处理 `-r`/`-i` 等参数，`find` 仅处理 `-name` 模式。

**歧义排除：**
| 场景 | 示例 | 处理 |
|------|------|------|
| 管道输入 | `grep pattern`（无路径，stdin 输入） | 不匹配（正则要求2参数） |
| 复杂参数 | `grep -r pattern dir` | 不匹配（`-r` 前缀不匹配简单模式） |
| 非行首 | `echo cat file` | 不匹配（行首锚定） |
| 文件含特殊字符 | `cat "file with spaces.txt"` | 正则支持引号内路径 |

**开关**：新增 `cmdRules.cat` / `cmdRules.grep` / `cmdRules.find`（默认 off），通过 `/shellfix cmd` 面板切换。

---

## 三、实现细节

### 3.1 文件改动清单

| 文件 | 改动说明 |
|------|----------|
| `src/lib/state.ts` | `CmdRuleName` 加 `"mkdir"` `"cat"` `"grep"` `"find"`、`CmdRules` 加 4 个 boolean、`CMD_RULES_META` 加 4 条目、`DEFAULT_STATE` 加 4 默认值、`PLUGIN_VERSION` → `"2.2.11"` |
| `src/shell-fix.ts` | 更新 `ENCODING_PREFIX_PS`/`ENCODING_PREFIX_PWSH` 常量（加 InputEncoding）、更新 guard regex（行 457）和 stripping regex（行 491）、新增 4 个 apply 函数、新增 4 个 if 块在 `tool.execute.before` 链中 |

**TUI 无需改动**：`CMD_RULES_META` 驱动 `showCmdRules` 面板，新规则自动出现。

### 3.2 核心代码

#### 编码前缀常量更新

```typescript
// 当前（V2.2.10）
const ENCODING_PREFIX_PS =
  "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
const ENCODING_PREFIX_PWSH =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;";

// 改为（V2.2.11）
const ENCODING_PREFIX_PS =
  "$OutputEncoding=[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;";
const ENCODING_PREFIX_PWSH =
  "[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;";
```

#### Guard regex 更新（行 457）

```typescript
// 当前：仅匹配 OutputEncoding 变体
!/^\s*(?:\$z=\[Text\.Encoding\]|\[Console\]::OutputEncoding\s*=|\[System\.Text\.UTF8Encoding\]|\$OutputEncoding\s*=)/i.test(result)

// 改为：追加 InputEncoding 匹配
!/^\s*(?:\$z=\[Text\.Encoding\]|\[Console\]::OutputEncoding\s*=|\[Console\]::InputEncoding\s*=|\[System\.Text\.UTF8Encoding\]|\$OutputEncoding\s*=)/i.test(result)
```

#### Stripping regex 更新（行 491）

**复核结论**：原正则 `(/^\s*(?:\$OutputEncoding=[^;]+;\s*)?\[Console\]::OutputEncoding=[^;]+;\s*/)` 有个隐藏缺陷——`[^;]+` 贪婪匹配会先吃掉整个前缀到第一个 `;`，导致后续必需部分 `\[Console\]::OutputEncoding=` 无字符可匹配 → **PS 前缀实际剥离失败**（仅 pwsh 前缀有效）。此缺陷在 V2.2.10 被掩盖（捕获组提取通常先成功），但 V2.2.11 直接照抄链式写法会彻底失效。

**改为宽容匹配**（同时覆盖新旧前缀 + InputEncoding）：

```typescript
// 改为：剥离任意 0-N 段编码前缀（$OutputEncoding / Console::Output/InputEncoding 链式均可）
.replace(/^\s*(?:\$OutputEncoding=[^;]+;\s*)?(?:\[Console\]::(?:Output|Input)Encoding=[^;]+;\s*)+/, "")
```

| 输入前缀 | 匹配结果 |
|----------|----------|
| `[Console]::OutputEncoding=[Text.Encoding]::UTF8;` | ✅ 剥离（pwsh 旧） |
| `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;` | ✅ 剥离（PS 旧） |
| `$OutputEncoding=[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;` | ✅ 剥离（PS 新） |
| `[Console]::OutputEncoding=[Console]::InputEncoding=[Text.Encoding]::UTF8;` | ✅ 剥离（pwsh 新） |

#### 新命令规则实现

**引号处理**：捕获的路径/模式若带引号，需先剥离外层引号再包单引号（否则 `-Path '"foo bar"'` 会把引号当路径一部分）。使用回调函数统一处理：

```typescript
// 正则常量
const MKDIR_P_RE = /^\s*mkdir\s+-p\s+(.+)$/;
const CAT_RE = /^\s*cat\s+(.+)$/;
const GREP_RE = /^\s*grep\s+(\S+)\s+(.+)$/;
const FIND_NAME_RE = /^\s*find\s+(\S+)\s+-name\s+['"](.+?)['"]\s*$/;

/** 剥离外层成对引号（"x" 或 'x'），其余原样返回 */
function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// apply 函数
function applyMkdirRule(cmd: string): string {
  return cmd.replace(MKDIR_P_RE, (_m, path: string) =>
    `New-Item -ItemType Directory -Force -Path '${stripOuterQuotes(path)}'`);
}

function applyCatRule(cmd: string): string {
  return cmd.replace(CAT_RE, (_m, path: string) =>
    `Get-Content -Path '${stripOuterQuotes(path)}' -Encoding UTF8`);
}

function applyGrepRule(cmd: string): string {
  return cmd.replace(GREP_RE, (_m, pattern: string, file: string) =>
    `Select-String -Pattern '${stripOuterQuotes(pattern)}' -Path '${stripOuterQuotes(file)}'`);
}

function applyFindRule(cmd: string): string {
  return cmd.replace(FIND_NAME_RE, (_m, dir: string, name: string) =>
    `Get-ChildItem -Path '${stripOuterQuotes(dir)}' -Recurse -Filter '${name}'`);
}
```

#### `tool.execute.before` 集成

在命令替换链中，新规则按以下顺序插入（export → bareEnv → mkdir → cat → grep → find → which → ...）：

```typescript
// 命令替换（按开关执行）
if (s.cmdRules.export)  { result = applyExportRule(result); }
if (s.cmdRules.bareEnv) { result = applyBareEnvRule(result); }
if (s.cmdRules.mkdir)   { result = applyMkdirRule(result); }   // 新增
if (s.cmdRules.cat)     { result = applyCatRule(result); }     // 新增
if (s.cmdRules.grep)    { result = applyGrepRule(result); }    // 新增
if (s.cmdRules.find)    { result = applyFindRule(result); }    // 新增
if (s.cmdRules.which)   { result = applyWhichRule(result); }
// ... 其余规则不变
```

### 3.3 状态定义变更

```typescript
// CmdRuleName 新增 4 个
export type CmdRuleName = "export" | "which" | "source" | "touch" | "rm" | "chmod" | "head" | "tail" | "bareEnv" | "mkdir" | "cat" | "grep" | "find";

// CmdRules 新增 4 个 boolean
export interface CmdRules {
  export: boolean;
  which: boolean;
  source: boolean;
  touch: boolean;
  rm: boolean;
  chmod: boolean;
  head: boolean;
  tail: boolean;
  bareEnv: boolean;
  mkdir: boolean;
  cat: boolean;
  grep: boolean;
  find: boolean;
}

// CMD_RULES_META 新增 4 条目
{ name: "mkdir", label: "mkdir -p→New-Item", description: "mkdir -p path → New-Item -ItemType Directory -Force", defaultOn: true },
{ name: "cat",   label: "cat→Get-Content",    description: "cat file → Get-Content -Path (单命令)",           defaultOn: false },
{ name: "grep",  label: "grep→Select-String",  description: "grep pattern file → Select-String (单命令)",     defaultOn: false },
{ name: "find",  label: "find→Get-ChildItem",  description: "find path -name '*.ts' → Get-ChildItem -Recurse", defaultOn: false },

// DEFAULT_STATE 新增 4 默认值
mkdir: true,
cat: false,
grep: false,
find: false,
```

---

## 四、测试验证

### 4.1 输入编码测试（4 用例）

| 用例 | 操作 | 预期 | 验证方式 |
|------|------|------|----------|
| 前缀正确 | 查看 `ENCODING_PREFIX_PS` 常量 | 含 `[Console]::InputEncoding=...=` | 代码审查 |
| 前缀正确(pwsh) | 查看 `ENCODING_PREFIX_PWSH` 常量 | 含 `[Console]::InputEncoding=...=` | 代码审查 |
| guard regex 识别 | 行 457 正则匹配 `[Console]::InputEncoding=` | 返回 true（不二次注入） | 代码审查 |
| stripping regex 剥离 | 行 491 正则剥离含 InputEncoding 的完整前缀 | 正确提取命令首 token | 代码审查 |

### 4.2 `mkdir -p` 转换测试（4 用例）

| 用例 | 输入 | 期望输出 | 结果 |
|------|------|----------|------|
| 基本路径 | `mkdir -p foo/bar` | `New-Item -ItemType Directory -Force -Path 'foo/bar'` | |
| 带引号路径 | `mkdir -p "foo bar"` | `New-Item -ItemType Directory -Force -Path 'foo bar'`（引号剥离） | |
| 不带 `-p` | `mkdir foo` | `mkdir foo`（不转换） | |
| 非行首 | `echo mkdir -p foo` | `echo mkdir -p foo`（不转换） | |

### 4.3 `cat` 转换测试（3 用例）

| 用例 | 输入 | 期望输出 | 结果 |
|------|------|----------|------|
| 基本 | `cat file.txt` | `Get-Content -Path 'file.txt' -Encoding UTF8` | |
| 带路径 | `cat src/main.ts` | `Get-Content -Path 'src/main.ts' -Encoding UTF8` | |
| 管道（不转换） | `cat file.txt \| grep foo` | `cat file.txt \| grep foo` | |

### 4.4 `grep` 转换测试（3 用例）

| 用例 | 输入 | 期望输出 | 结果 |
|------|------|----------|------|
| 基本 | `grep error log.txt` | `Select-String -Pattern 'error' -Path 'log.txt'` | |
| 带引号模式 | `grep "hello world" file.txt` | `Select-String -Pattern 'hello world' -Path 'file.txt'`（引号剥离） | |
| 无路径（不转换） | `grep error` | `grep error`（不匹配，正则需 2 参数） | |

### 4.5 `find` 转换测试（3 用例）

| 用例 | 输入 | 期望输出 | 结果 |
|------|------|----------|------|
| 基本 | `find . -name "*.ts"` | `Get-ChildItem -Path '.' -Recurse -Filter '*.ts'` | |
| 带路径 | `find src -name "*.cs"` | `Get-ChildItem -Path 'src' -Recurse -Filter '*.cs'` | |
| 无 -name（不转换） | `find . -type f` | `find . -type f`（不匹配） | |

### 4.6 LSP 诊断

`src/shell-fix.ts` 和 `src/lib/state.ts` 需为**零错误**。

---

## 五、交付清单

- [ ] `src/lib/state.ts` — `CmdRuleName` + `CmdRules` + `CMD_RULES_META` + `DEFAULT_STATE` + `PLUGIN_VERSION` 更新
- [ ] `src/shell-fix.ts` — `ENCODING_PREFIX_PS`/`PWSH` 常量更新（加 InputEncoding）
- [ ] `src/shell-fix.ts` — guard regex（行 457）更新，新增 `\[Console\]::InputEncoding\s*=`
- [ ] `src/shell-fix.ts` — stripping regex（行 491）更新，匹配链式 OutputEncoding+InputEncoding
- [ ] `src/shell-fix.ts` — 新增 `MKDIR_P_RE`/`CAT_RE`/`GREP_RE`/`FIND_NAME_RE` 正则常量
- [ ] `src/shell-fix.ts` — 新增 `applyMkdirRule`/`applyCatRule`/`applyGrepRule`/`applyFindRule` 函数
- [ ] `src/shell-fix.ts` — `tool.execute.before` 命令链新增 4 个 if 块
- [ ] 测试：编码 4 用例 + mkdir 4 用例 + cat 3 用例 + grep 3 用例 + find 3 用例 = 17 用例全部通过
- [ ] 文档：CHANGELOG + 开发方案 + 审核报告
- [ ] 版本号 bump v2.2.10 → v2.2.11
- [ ] 按照 `.sisyphus/rules.md` 流程：提交 → tag → 发布 → 部署

---

## 附：实现注记

### 与方案前稿的差异

| 条目 | 原思路 | 最终方案 | 原因 |
|------|--------|----------|------|
| 输入编码 fix | 加 `chcp 65001` | 仅加 `[Console]::InputEncoding` | `chcp` 有副作用，纯 PS 方案更安全 |
| 输入编码开关 | 独立 toggle | 复用 `s.encoding` | 输入输出编码互补，无独立开关意义 |
| `cat` 默认值 | ON | OFF | `cat` 在 pwsh 7 中是别名，多数情况已兼容 |
| `find` 范围 | 支持 `-type` 等 | 仅 `-name` | 保持简单，避免过度匹配 |

### 关键行号（V2.2.10 基准）

- `state.ts` CmdRuleName: line 16
- `state.ts` CmdRules: lines 39-49
- `state.ts` CMD_RULES_META: lines 142-152
- `state.ts` DEFAULT_STATE.cmdRules: lines 181-191
- `state.ts` PLUGIN_VERSION: line 54
- `shell-fix.ts` ENCODING_PREFIX_PS: line 202
- `shell-fix.ts` ENCODING_PREFIX_PWSH: line 205
- `shell-fix.ts` guard regex: line 457
- `shell-fix.ts` stripping regex: line 491
- `shell-fix.ts` tool.execute.before 命令链: lines 424-451
- `shell-fix.ts` apply 函数区: lines 693-776