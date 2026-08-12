# v2.2.12 开发方案 — 编码环境变量注入 + PwshCheck 自动修复

> 状态：📝 方案待审
> 版本：v2.2.12

---

## 一、背景与问题

### 1.1 编码环境变量缺失（P0）

**问题**：Agent 生成的 Python/Node 等命令输出的中文在 PowerShell 中仍可能乱码，因为 Python 默认输出编码不是 UTF-8，Node 日志也可能因编码问题截断。ShellFix 当前只修复了 PowerShell 自身的编码，但**子进程**（Python、Node、less 等）的输出编码不受影响。

**根因**：Python 在 Windows 上默认输出编码为系统代码页（GBK），即使 PowerShell 的 `[Console]::OutputEncoding` 设为 UTF-8，Python 子进程仍输出 GBK → 按 UTF-8 解码 → 乱码。

**解决方案**：在进程初始化时注入 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`LESSCHARSET=utf-8` 等环境变量，子进程自动继承，从源头输出 UTF-8。

**已有基础设施**：`CI_ENV_VARS`（16 个非交互变量）通过 `shell.env` 钩子在进程初始化时注入，子进程自动继承，零命令污染。V2.2.12 复用此机制。

### 1.2 PwshCheck 仅建议不修复（P1）

**问题**：V2.2.9 的 PwshCheck 只能在 `system.transform` 中注入协议文本，依赖 Agent 去询问用户并手动修改配置。流程长（Agent 问 → 用户答 → Agent 改 → 重启），成功率低。

**现状**：
```
检测到 PS 5.1 → system.transform 注入协议
→ Agent 询问用户 → 用户回复 → 用户手动改配置
→ 重启 OpenCode → 生效
```

**目标**：插件直接在启动时自动修改 `opencode.jsonc`，将 `"shell"` 设为 `"pwsh"`，用户无感修复。同时提供一键还原开关。

**现有条件**：检测逻辑已存在（行 330-358），`opencode.jsonc` 路径已知，`writeFileSync` 可用。只需补上"写入"环节。

---

## 二、方案设计

### 2.1 P0：编码环境变量注入（`envInject`）

**设计**：新增 `envInject: boolean` 状态字段（默认 true），启用时在 `shell.env` 钩子中追加注入编码相关环境变量。关闭时跳过。

**环境变量清单：**

| 变量 | 值 | 影响 |
|------|-----|------|
| `PYTHONUTF8` | `1` | Python 3.7+ 强制 UTF-8 模式 |
| `PYTHONIOENCODING` | `utf-8` | Python stdin/stdout/stderr 编码 |
| `LESSCHARSET` | `utf-8` | less 分页器字符集（影响 git log 等） |

**注入方式**：在 `shell.env` 钩子中，`CI_ENV_VARS` 循环之后、`git-line-ending` 条件之前，追加：

```typescript
if (s.envInject) {
  out.env["PYTHONUTF8"] = "1";
  out.env["PYTHONIOENCODING"] = "utf-8";
  out.env["LESSCHARSET"] = "utf-8";
}
```

**与 git-line-ending 模式的关系**：git-line-ending 是三态（auto/config/off），envInject 是简单二态（on/off）。因为编码环境变量要么全注入要么不注入，没有"部分"方案。

**开关**：新增 `/shellfix env-inject on/off` 斜杠命令 + `shellfix.env-inject` palette 入口。

**状态面板**：在 `showShellFixStatus` 中新增一行 `env-inject     ON/OFF`。

### 2.2 P1：PwshCheck 自动修复（`autoFixPwsh`）

**设计**：升级现有 PwshCheck 检测逻辑，新增 `autoFixPwsh: boolean` 状态字段（默认 true）。启用时，检测到 PS 5.1 且未配置 pwsh 时，**自动修改 `opencode.jsonc`** 将 `"shell"` 设为 `"pwsh"`，并弹出 toast 通知。

**完整流程：**

```
启动时检测（行 330-358 升级版）：
  1. 平台是 win32 + dismissed !== "forever"
  2. 读取 opencode.jsonc → 检查是否已配置 "shell": "pwsh"
     → 已配置 → 标记 accepted，不做任何事（现有逻辑）
     → 未配置 → 检查 pwsh 是否已安装
       → 未安装 → 跳过（无法修复）
       → 已安装 → 判断 autoFixPwsh 状态
         → autoFixPwsh = true（默认）：
           a. 备份 opencode.jsonc → opencode.jsonc.shellfix.bak
           b. 修改 opencode.jsonc，添加/修改 "shell": "pwsh"
           c. 标记 dismissed = "accepted"
           d. 弹出 toast："已将 OpenCode 默认 shell 切换为 pwsh，重启后生效"
         → autoFixPwsh = false：
           → 保持现有行为（system.transform 提示，不自动修复）
```

**JSONC 修改策略**（不依赖 JSONC 解析器，纯正则操作）：

```typescript
let content = readFileSync(configPath, "utf-8");

// 情况 1：已有 "shell" 字段 → 替换值
if (/"shell"\s*:\s*"[^"]*"/.test(content)) {
  content = content.replace(/"shell"\s*:\s*"[^"]*"/, '"shell": "pwsh"');
}
// 情况 2：无 "shell" 字段 → 在 "$schema" 行后插入
else {
  content = content.replace(
    /("\$schema"\s*:\s*"[^"]*")/,
    '$1,\n  "shell": "pwsh"'
  );
}

// 写回
writeFileSync(configPath, content, "utf-8");
```

**还原机制**：`/shellfix pwsh on/off` 切换 `autoFixPwsh` 状态。
- `off`：从备份 `opencode.jsonc.shellfix.bak` 恢复（如果存在），或删除 `"shell"` 字段
- `on`：重新执行自动修复

**安全性**：
- 修改前备份原文件到 `opencode.jsonc.shellfix.bak`
- 修改操作在 try-catch 中，任何失败静默跳过（不阻塞启动）
- 仅修改 `"shell"` 字段，不触碰其他配置

**向后兼容**：现有 `PwshCheckState` 接口不变，新增 `autoFixPwsh` 字段在 `PluginState` 中，`deepMerge` 自动补默认值。

### 2.3 P2：chcp .cmd 包装（记录，推迟决策）

**文章方案**：通过 `shell-utf8.cmd` → `shell-utf8-impl.ps1` 包装脚本，在进程启动前执行 `chcp 65001`。

**推迟原因**：
- 架构复杂（引入 .cmd → .ps1 链式调用）
- `Invoke-Expression` 存在注入风险
- 与现有前缀方案互补但非替代
- 收益与复杂度不成正比

**未来考虑**：可将此方案作为 `shellfix.doctor` 的可选建议，由用户决定是否采用。

### 2.4 P3：前缀 chcp 65001（记录，推迟决策）

**文章方案**：在编码前缀中直接加 `chcp 65001>$null;`。

**推迟原因**：
- 之前已验证直接加前缀效果有限（非交互模式无物理控制台，chcp 影响有限）
- `chcp 65001` 有已知副作用（某些 Windows 版本 C 运行时崩溃）
- 若用户需要，可手动在 Profile 中配置

---

## 三、实现细节

### 3.1 文件改动清单

| 文件 | 改动说明 |
|------|----------|
| `src/lib/state.ts` | 新增 `envInject: boolean` + `autoFixPwsh: boolean` 字段、`DEFAULT_STATE` 默认值、`PLUGIN_VERSION` → `"2.2.12"` |
| `src/shell-fix.ts` | `shell.env` 钩子追加编码环境变量注入（`s.envInject` 门控）；升级 PwshCheck 检测逻辑（`autoFixPwsh` 门控自动修复）；移除或替换 `system.transform` 中 PwshCheck 协议文本 |
| `src/shell-fix-tui.ts` | 新增 `shellfix.env-inject` palette 入口 + `showEnvInject` 函数；新增 `shellfix.pwsh` palette 入口 + `showPwshCheck` 函数；更新状态面板 |

### 3.2 核心代码

#### 状态定义变更

```typescript
// PluginState 新增 2 个字段
export interface PluginState {
  // ... 现有字段 ...
  envInject: boolean;        // P0: 编码环境变量注入开关
  autoFixPwsh: boolean;      // P1: 自动修复开关
}

// DEFAULT_STATE 新增 2 个默认值
envInject: true,             // 默认开启
autoFixPwsh: true,           // 默认开启
```

#### `shell.env` 钩子更新

```typescript
"shell.env": async (_input, output) => {
  const out = output as { env: Record<string, string> };
  const s = loadState();
  // 基础 Git 免交互环境变量
  for (const [key, val] of Object.entries(CI_ENV_VARS)) {
    out.env[key] = val;
  }
  // P0: 编码环境变量注入（v2.2.12）
  if (s.envInject) {
    out.env["PYTHONUTF8"] = "1";
    out.env["PYTHONIOENCODING"] = "utf-8";
    out.env["LESSCHARSET"] = "utf-8";
  }
  // git-line-ending: 条件注入 Git 配置环境变量
  if (s.gitLineEnding !== "off") {
    // ... 现有逻辑不变 ...
  }
},
```

#### PwshCheck 检测逻辑升级

```typescript
// ── PwshCheck 升级版（v2.2.12）—— 自动修复 ────
if (process.platform === "win32" && state.pwshCheck.dismissed !== "forever") {
  try {
    const configPath = join(os.homedir(), ".config", "opencode", "opencode.jsonc");
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      const hasPwshShell = /"shell"\s*:\s*"[^"]*pwsh[^"]*"/i.test(content);
      if (hasPwshShell) {
        state.pwshCheck.pending = false;
        state.pwshCheck.dismissed = "accepted";
        saveState(state);
      } else if (state.pwshCheck.dismissed !== "accepted") {
        let pwshFound = false;
        try {
          execSync("where pwsh", { stdio: "ignore" });
          pwshFound = true;
        } catch { /* pwsh 未安装 */ }
        if (pwshFound) {
          if (state.autoFixPwsh) {
            // 自动修复：修改 opencode.jsonc
            try {
              const backupPath = configPath + ".shellfix.bak";
              // 备份（仅首次）
              if (!existsSync(backupPath)) {
                copyFileSync(configPath, backupPath);
              }
              let newContent = content;
              if (/"shell"\s*:\s*"[^"]*"/.test(newContent)) {
                newContent = newContent.replace(/"shell"\s*:\s*"[^"]*"/, '"shell": "pwsh"');
              } else {
                newContent = newContent.replace(
                  /("\$schema"\s*:\s*"[^"]*")/,
                  '$1,\n  "shell": "pwsh"'
                );
              }
              writeFileSync(configPath, newContent, "utf-8");
              state.pwshCheck.pending = false;
              state.pwshCheck.dismissed = "accepted";
              saveState(state);
              // toast 通知由 TUI 侧在启动时检测并弹出
            } catch (e) {
              console.error(`[ShellFix] PwshCheck auto-fix failed:`, e);
            }
          } else {
            // 传统模式：设置 pending，由 system.transform 提示
            state.pwshCheck.pending = true;
            saveState(state);
          }
        }
      }
    }
  } catch { /* 静默跳过 */ }
}
```

#### `system.transform` 中 PwshCheck 协议文本更新

```typescript
// PwshCheck（v2.2.12）：自动修复已执行，仅通知
const pwshPending = s.pwshCheck.pending && s.pwshCheck.dismissed === "pending";
if (pwshPending) {
  out.content += `\n\n---\n\n[ShellFix 系统配置]
检测到 OpenCode 当前使用 Windows PowerShell 5.1。
已自动修复：将 opencode.jsonc 中 "shell" 设为 "pwsh"，重启后生效。
如需还原，请执行 /shellfix pwsh off。`;
  s.pwshCheck.pending = false;
  saveState(s);
}
```

#### TUI 新增函数

**`showEnvInject`**（参照 `showGitLineEnding` 模式）：

```typescript
function showEnvInject(api: any): void {
  try {
    const s = loadState() || {} as any;
    const current = s.envInject ? "ON" : "OFF";
    const lines: string[] = [
      `编码环境变量注入 — 让 Python/Node 等工具输出 UTF-8`,
      ``,
      `当前: ${current}`,
      ``,
      `  ON   注入 PYTHONUTF8=1、PYTHONIOENCODING=utf-8、LESSCHARSET=utf-8`,
      `       子进程自动继承，从源头避免中文乱码`,
      `  OFF  不注入`,
      ``,
      `用法（斜杠命令，通过 LLM 执行）：`,
      `  /shellfix env-inject on|off`,
    ];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: "ShellFix env-inject 编码环境变量",
        message: lines.join("\n"),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showEnvInject error:`, e);
  }
}
```

**`showPwshCheck`**（参照 `showGitLineEnding` 模式）：

```typescript
function showPwshCheck(api: any): void {
  try {
    const s = loadState() || {} as any;
    const current = s.autoFixPwsh ? "ON" : "OFF";
    const lines: string[] = [
      `自动切换 PowerShell 7 — 从根本上解决编码问题`,
      ``,
      `当前: ${current}`,
      ``,
      `  ON   自动检测 PS 5.1，修改 opencode.jsonc 切换为 pwsh`,
      `  OFF  不自动修复，保持当前 shell 配置`,
      ``,
      `用法（斜杠命令，通过 LLM 执行）：`,
      `  /shellfix pwsh on|off`,
    ];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: "ShellFix pwsh 自动切换",
        message: lines.join("\n"),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showPwshCheck error:`, e);
  }
}
```

#### 状态面板更新

```typescript
// showShellFixStatus 新增两行
`  env-inject     ${s.envInject ? "ON" : "OFF"}`,
`  pwsh           ${s.autoFixPwsh ? "AUTO" : "OFF"}`,
```

---

## 四、测试验证

### 4.1 环境变量注入测试（3 用例）

| 用例 | 操作 | 预期 | 验证方式 |
|------|------|------|----------|
| `envInject=true` 注入 | 查看 `shell.env` 输出 | `out.env["PYTHONUTF8"]` 为 `"1"` | 代码审查 |
| `envInject=false` 跳过 | 查看 `shell.env` 输出 | `out.env["PYTHONUTF8"]` 不存在 | 代码审查 |
| CI_ENV_VARS 不变 | 查看循环 | 16 个基础变量始终注入 | 代码审查 |

### 4.2 PwshCheck 自动修复测试（5 用例）

| 用例 | 条件 | 预期 | 验证方式 |
|------|------|------|----------|
| 已配置 pwsh | `opencode.jsonc` 含 `"shell":"pwsh"` | 标记 accepted，不做任何修改 | 代码审查 |
| 未配置 + autoFixPwsh=true | PS 5.1，pwsh 已安装 | 自动修改 opencode.jsonc，备份原文件 | 模拟测试 |
| 未配置 + autoFixPwsh=false | PS 5.1，pwsh 已安装 | 设 pending=true，走 system.transform 提示 | 代码审查 |
| pwsh 未安装 | PS 5.1，pwsh 不存在 | 跳过，不做任何事 | 代码审查 |
| dismissed=forever | 用户选择不再提醒 | 跳过全部检测 | 代码审查 |

### 4.3 JSONC 修改正确性测试（3 用例）

| 用例 | 输入内容 | 期望输出 | 验证方式 |
|------|----------|----------|----------|
| 已有 shell 字段 | `"shell": "powershell.exe"` | `"shell": "pwsh"` | 正则替换 |
| 无 shell 字段 | `{"$schema":"...","model":"..."}` | 在 `$schema` 后插入 `"shell":"pwsh"` | 正则插入 |
| 备份文件 | 首次修改 | `opencode.jsonc.shellfix.bak` 存在 | 文件存在检查 |

### 4.4 LSP 诊断

`src/shell-fix.ts`、`src/lib/state.ts`、`src/shell-fix-tui.ts` 均为**零 error**。

---

## 五、交付清单

- [ ] `src/lib/state.ts` — `envInject` + `autoFixPwsh` 字段 + `DEFAULT_STATE` + `PLUGIN_VERSION` 2.2.12
- [ ] `src/shell-fix.ts` — `shell.env` 钩子追加编码环境变量注入（`s.envInject` 门控）
- [ ] `src/shell-fix.ts` — PwshCheck 检测逻辑升级（`autoFixPwsh` 门控自动修复 JSONC）
- [ ] `src/shell-fix.ts` — `system.transform` 中 PwshCheck 协议文本更新
- [ ] `src/shell-fix-tui.ts` — 新增 `shellfix.env-inject` palette 入口 + `showEnvInject` 函数
- [ ] `src/shell-fix-tui.ts` — 新增 `shellfix.pwsh` palette 入口 + `showPwshCheck` 函数
- [ ] `src/shell-fix-tui.ts` — 状态面板新增 env-inject + pwsh 状态行
- [ ] 测试：环境变量 3 用例 + PwshCheck 5 用例 + JSONC 3 用例 = 11 用例全部通过
- [ ] 文档：CHANGELOG + 开发方案 + 审核报告
- [ ] 版本号 bump v2.2.11 → v2.2.12
- [ ] 按 `.sisyphus/rules.md` 流程：提交 → tag → 发布 → 部署

---

## 附：优先级说明

| 优先级 | 项目 | 改动量 | 收益 | 决策 |
|--------|------|--------|------|------|
| **P0** | 编码环境变量注入 | 小（+3 env var + 1 state + TUI） | 高 | **立即实现** |
| **P1** | PwshCheck 自动修复 | 中（升级检测 + JSONC 读写 + TUI） | 高 | **立即实现** |
| P2 | chcp .cmd 包装 | 大（新架构 + 安全评估） | 中 | 推迟，记录 |
| P3 | 前缀 chcp 65001 | 极小 | 低 | 推迟，记录 |

### P2/P3 推迟原因

**P2（.cmd 包装脚本）**：文章方案通过 `shell-utf8.cmd` → `shell-utf8-impl.ps1` 链式包装实现系统层 `chcp 65001`。优势是零命令污染，劣势是：
- `Invoke-Expression` 存在注入风险
- 每次 bash 调用多一层进程链（.cmd → .ps1）
- 与 ShellFix 其他功能解耦（错误检测、cmdRules 在另一层运行）
- 路径硬编码，跨机器需重新配置

**建议**：未来作为 `shellfix.doctor` 的可选建议项，不内建到 ShellFix 核心流程中。

**P3（前缀 chcp 65001）**：在编码前缀中直接加 `chcp 65001>$null;`。之前已验证在非交互模式（OpenCode 的 bash tool 场景）下效果有限，且 `chcp 65001` 在某些 Windows 版本上有 C 运行时兼容性副作用。

**建议**：若用户需要系统层 `chcp 65001`，可通过 PowerShell Profile 或文章方案的 .cmd 包装实现，ShellFix 不做默认集成。

---

## 附：关键行号（V2.2.11 基准）

- `state.ts` PluginState 接口: lines 73-92
- `state.ts` DEFAULT_STATE: lines 184-223
- `state.ts` PLUGIN_VERSION: line 58
- `shell-fix.ts` CI_ENV_VARS: lines 210-227
- `shell-fix.ts` shell.env 钩子: lines 364-378
- `shell-fix.ts` PwshCheck 检测: lines 330-358
- `shell-fix.ts` system.transform PwshCheck: lines 619-631
- `shell-fix-tui.ts` palette 入口区: lines 520-675
- `shell-fix-tui.ts` 状态面板: lines 1167-1188
- `shell-fix-tui.ts` showGitLineEnding: lines 1219-1244