# v2.3.2 开发方案 — CodeMap overlay 冲突修复 + 输出通道统一（toast 四色）

> 状态：📝 方案待审
> 版本：v2.3.2（缺陷修复，patch bump：2.3.1 → 2.3.2）
> 范围：A 段 = CodeMap overlay 冲突（一~七）；B 段 = 输出通道统一为 toast（八）

---

## 一、背景

### 1.1 用户反馈（2026-11-08）

编辑 `.cs` 后 TUI 出现一行：

```
[ShellFix][CodeMap] refresh_overlay failed: {"code":"NOT FOUND","message":"Workspace 'session' not found","retryable":false}
```

### 1.2 取证结果（已完成，非推测）

| 证据 | 来源 |
|------|------|
| 该行由 `src/lib/codemap-indexer.ts:270`（`flushOverlayRefresh`）输出，条件 `!r.ok && loadState().log` | 源码 |
| `workspace.create failed for F:\LoongBa_Git\_TKWF.Extensions` — `System.IO.IOException: The process cannot access the file 'C:\Users\coffe\.codemap\store\overlays\session\overlay.wal' because it is being used by another process` | `~/.codemap/logs/codemap-2026-11-07.log` 19:03~19:45 多次 |
| 同一 workspace id `session` 被至少 3 个不同仓库复用：`90d2b5753e563eb7` / `d15d0ed8fc1a5f97`（_TKWF.Extensions）/ 尝试 `F:\LoongBa_Git\_TKWF`、`F:\LoongBa_Git\FlowCenter` | 同上 `WorkspaceManager` 日志 |
| 同一仓库的 `Workspace session created ...` 反复出现（20:03 / 20:13 / 20:23 / 20:30 / 20:45 / 次日 00:41 / 01:10） | 同上，说明 workspace 是**进程内状态**，进程重建即丢失 |
| 当前同时运行 **5 个** `codemap-mcp.exe` | `Get-Process codemap-mcp` |
| opencode 自身在 `opencode.jsonc` 配了 `mcp.codemap`（`command: ["codemap-mcp"]`），与 ShellFix 自 spawn 的进程并存 | 配置文件 1490 行 |

### 1.3 根因（三层）

1. **workspace id 是全局常量 `"session"`**（`DEFAULT_WORKSPACE_ID`），而 codemap 的 overlay 存储路径是 `~/.codemap/store/overlays/<workspaceId>`，**不带仓库维度**。于是不同仓库、不同进程共用同一个 `overlay.wal`。
2. **双写者**：opencode 自己的 `mcp.codemap` 进程（Agent 查询走它）与 ShellFix 为每个仓库 spawn 的进程，同时打开同一个 WAL。`EngineOverlay..ctor → WalReader.Replay → File.ReadAllBytes` 撞上写入方 → `IOException` → `workspace.create` 失败。
3. **失败被静默且无法自愈**：
   - `ensureWorkspace()` 返回值被所有调用方丢弃（`codemapOnSessionStart` / `codemapOnBuildSuccess` / `runCodemapCommand`）；
   - 刷新路径（`file.edited` → `flushOverlayRefresh`）**从不重新 ensure**，进程重启/空闲 5 分钟回收后必然 `NOT FOUND`；
   - `CodemapSession.invoke()` 的可恢复正则 `/timeout|exited|spawn failed|EPIPE|not found/i` 把 `Workspace 'session' not found` 也判为可恢复 → 白杀进程重启再试一次，必然再失败，还加剧文件竞争。

### 1.4 影响面

- baseline 索引仍在，`codemap_symbols_*` 不会整体失效；
- 但**未提交改动的增量 overlay 刷不上**，查询可能看到旧符号；
- 每次编辑 `.cs` 都失败一次，日志刷屏；进程被杀重启放大开销。

---

## 二、方案选型

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A（推荐）** | ShellFix **退出自动 overlay 写路径**：只做 `index.ensure_baseline` + `index.cleanup`；workspace/overlay 交给 Agent 侧 codemap MCP（规则已要求 `refresh_overlay`）；`/codemap-index` 显式命令仍可创建 workspace + 刷新，但加锁冲突重试与友好报错 | 单一写者，根治 WAL 竞争；与"谁查询谁维护"的架构一致；改动小、可回退 | 失去"编辑即自动刷新"的保险（由 Agent 侧规则兜底） |
| B | 保留自动刷新，workspace id 改为按仓库派生 `session-<hash8>` + 重试 + 惰性 ensure | 保留自动刷新 | ShellFix 的 overlay 与 Agent 的 `session` 分离，刷新对查询无效（除非同步改规则，脆弱）；同仓库双写者竞争仍在 |
| C | 最小改动：保留 `session`，只加重试 + 惰性 ensure + 正则收窄 + 日志节流 | 改动最小 | 跨仓库语义冲突未解（同一 overlay 被多仓库反复重建），问题会复发 |

**结论：选 A。** 理由：Agent 的查询只走 opencode 自己的 `mcp.codemap` 进程，ShellFix 那份 overlay 只是"另一个写者"；两写者共用一个 WAL 在机制上就不安全（已被 IOException 证实）。

---

## 三、详细设计（方案 A）

### 3.1 `src/lib/codemap-indexer.ts`

| 改动 | 说明 |
|------|------|
| 删除自动 overlay 路径 | 移除 `scheduleOverlayRefresh` / `flushOverlayRefresh` 及 `pendingRefresh`、`refreshTimer`、`REFRESH_DEBOUNCE_MS` |
| `codemapOnCsEdited()` | 整函数删除（不再订阅 `.cs` 编辑） |
| `refreshOverlayNow()` | 保留，仅供 `/codemap-index` 显式命令；新增"锁冲突重试"（见 3.2）与友好错误文本 |
| `runEnsure` / `ensureWorkspace` / `cleanupIfNeeded` | 保留；`ensureWorkspace` 返回值改为**被检查** |
| `codemapOnSessionStart` / `codemapOnBuildSuccess` | 保留 `runEnsure` + `cleanupIfNeeded`；删除 `ensureWorkspace` 调用（不再为 Agent 代建 workspace） |
| 失败可观测 | `runEnsure` 失败已有 `consecutiveFailures` 计数与连续 3 次注入提醒（既有），保持；新增 5 分钟同错节流日志 |

> `codemapLast.workspaceId` 字段保留，值固定为 `workspaceId()`（默认 `"session"`），语义改为"Agent 侧工作区名（仅供状态面板展示）"。

### 3.2 `src/lib/codemap-mcp.ts`

| 改动 | 说明 |
|------|------|
| 收窄可恢复正则 | `/timeout|exited|spawn failed|EPIPE|not found/i` → `/codemap-mcp not found\|spawn failed\|exited code=\|EPIPE\|timeout/i`；workspace not found 不再触发杀进程重试 |
| 新增锁冲突重试 | 新增 `callWithRetry(name, args, { attempts, backoffMs })`：命中 `overlay.wal` / `IOException` / `being used by another process` 时按 300ms / 1200ms / 3000ms 退避重试；仅 `refreshOverlayNow` 使用 |
| 错误文本规范化 | `NOT FOUND: Workspace '...' not found` → `工作区未创建（可能被其他 CodeMap 进程占用），稍后重试或执行 /codemap-index status` |

### 3.3 `src/shell-fix.ts`

| 改动 | 说明 |
|------|------|
| event 钩子 | `file.edited` 分支删除（连同 `codemapOnCsEdited` import）；保留 `session.created`（ensure + cleanup）与 `session.deleted`（关闭本进程，方案 A 下无副作用） |
| `tool.execute.after` | `codemapOnBuildSuccess` 保留（ensure + cleanup，不再刷新 overlay） |
| 导入清理 | 移除 `codemapOnCsEdited` |

### 3.4 `src/lib/state.ts`

- `PLUGIN_VERSION` → `"2.3.2"`。
- 无新增字段（不引入新 state，降低迁移风险）。

### 3.5 文档

| 文件 | 改动 |
|------|------|
| `README.md` ⑤ CodeMap 表 | "编辑 `.cs` 文件 → 5s 防抖 refresh_overlay" 改为"overlay 由 Agent 侧 codemap MCP 维护（规则已要求编辑后 refresh_overlay）"；补充"ShellFix 只维护 baseline 与磁盘清理" |
| `docs/03-*` FAQ | 新增坑记录：workspace id 全局 + overlay.wal 跨进程锁；`NOT FOUND: Workspace` 的成因与处置 |
| `CHANGELOG.md` | v2.3.2 条目（Fixed：overlay 竞争、静默失败、无意义进程重启） |
| `package.json` | `2.3.2` |

---

## 四、交付清单

| 项 | 文件 | 说明 |
|----|------|------|
| 1 | `src/lib/codemap-indexer.ts` | 移除自动 overlay 刷新路径；`ensureWorkspace` 结果检查；失败节流日志 |
| 2 | `src/lib/codemap-mcp.ts` | 正则收窄 + `callWithRetry` + 错误文本规范化 |
| 3 | `src/shell-fix.ts` | 删除 `file.edited` 分支与 `codemapOnCsEdited` import |
| 4 | `src/lib/state.ts` | `PLUGIN_VERSION = "2.3.2"` |
| 5 | `package.json` | `2.3.2` |
| 6 | 文档 | README ⑤、docs/03 FAQ、CHANGELOG |
| 7 | 部署 | `deploy.ps1` 无新增 lib 文件（不需改）；部署后校验哈希 |

---

## 五、测试矩阵

| # | 用例 | 预期 |
|---|------|------|
| 1 | 在 .NET 仓库开新会话 | `ensure_baseline` 幂等返回；无 `Workspace ... created` 由 ShellFix 触发 |
| 2 | 连续编辑 3 个 `.cs` 文件 | 无 `refresh_overlay failed` 日志；无 codemap-mcp 被额外 spawn |
| 3 | 运行 `/codemap-index`（显式） | 重建 baseline + 创建 workspace + 刷新成功；状态行显示 ws=session |
| 4 | 同时用 Agent 的 `codemap_*` 查询 + 跑 `/codemap-index` | 若撞锁：退避重试成功，或给出友好提示，不打印原始 JSON 错误 |
| 5 | `dotnet build` 成功 | 触发 ensure（幂等）+ cleanup 检查，不刷新 overlay |
| 6 | 关闭 codemap-mcp 可执行文件（模拟缺失） | 静默跳过，不抛异常 |
| 7 | 非 .NET 仓库（本插件仓库） | 零开销，无日志 |
| 8 | 旧 state 文件（v2.3.1）升级 | 正常加载，无字段缺失 |
| 9 | `session.deleted` | 关闭本进程，不影响其他会话 |
| 10 | 日志开关 `log` OFF | 失败时不输出 console 日志（计数/状态仍更新） |

---

## 六、风险与兼容

| 项 | 说明 |
|----|------|
| 失去自动 overlay 刷新 | Agent 侧规则已要求编辑后 `codemap_index_refresh_overlay(workspace_id="session")`；若 Agent 漏调，overlay 滞后，baseline 查询不受影响 |
| 显式命令仍可能撞锁 | 已加退避重试 + 友好错误；最坏情况提示"稍后重试" |
| 与全局 rules 的一致性 | 方案 A 不改 rules（Agent 继续用 `session`），避免跨文件改动 |
| 回退 | 若需恢复自动刷新，回退本次提交即可（改动集中在 3 个源文件） |

---

## 七、实施顺序

1. `codemap-mcp.ts`（正则收窄 + `callWithRetry` + 错误文本）
2. `codemap-indexer.ts`（移除自动 overlay 路径 + 结果检查 + 节流日志）
3. `shell-fix.ts`（删除 `file.edited` 分支与 import）
4. `state.ts` + `package.json`（版本号）
5. 文档（README / FAQ / CHANGELOG）
6. LSP 零 error → 部署 → 测试矩阵 → 审核报告 → 提交推送（等用户确认）

---

## 八、追加范围（B 段）：输出通道统一为 toast（四色）

### 8.1 需求与用户决策（2026-11-08）

> 原文：「不要再用输入框输出的方式，已经改用 toast —— 包括历史功能也检查一遍，统一走 toast（两侧颜色区分：橙色、绿色、蓝色、红色）」

决策（question 已确认）：

| 议题 | 决策 |
|------|------|
| 模板/笔记这类「要发给 LLM 的文本」 | **直接发送消息 + toast 提示**（不再停留在输入框） |
| 约 20 处多行面板（`/my ?` 列表、`/auto` 状态、`/shellfix doctor` 等，走 DialogAlert） | **保留面板**，仅通知类走 toast |

### 8.2 API 实证（opencode 1.19.5 二进制反查，非推测）

| 侧 | API | 形状 | 支持 variant |
|----|-----|------|--------------|
| TUI 侧 | `api.ui.toast` | `{ title?, message, variant?, duration? }` | ✅ 源码为 `variant: t.variant ?? "info"` |
| 服务端侧 | `client.tui.showToast` | `{ body: { title?, message, variant, duration? } }` | ✅（`toast-alerts.ts` 已在用） |
| 发送消息 | `client.tui.appendPrompt` + `client.tui.submitPrompt` | `{ text }` / 无参 | —（`/tui/submit-prompt` 端点） |
| 面板 | `api.ui.dialog.replace(fn)` + `DialogAlert` | 多行可滚动 | 保留不动 |

**四色映射**（opencode TUI 主题枚举）：

| variant | 颜色 | 语义 |
|---------|------|------|
| `info` | 蓝 | 信息、用法、列表为空 |
| `success` | 绿 | 操作成功、开关切换、已保存/已删除 |
| `warning` | 橙 | 不存在、参数无效、内容为空、被占用稍后重试 |
| `error` | 红 | 渲染失败、保存失败、异常（catch） |

### 8.3 TUI 侧改造（`src/shell-fix-tui.ts`）

**① 新增统一入口**（替换全部 `api.ui.toast({ message })`）：

```ts
type ToastVariant = "info" | "success" | "warning" | "error";

/** 统一 toast：TUI 侧原生支持 variant；缺失时回退服务端 showToast */
function toast(api: any, message: string, variant: ToastVariant = "info", title?: string): void {
  try {
    if (api?.ui?.toast) { api.ui.toast({ title, message, variant }); return; }
    api?.client?.tui?.showToast?.({ body: { title, message, variant } });
  } catch (e) {
    console.error("[ShellFix] toast error:", e);
  }
}
```

**② `DispatchResult` 扩展**（不破坏现有 `output`/`dialog`）：

```ts
type DispatchResult = {
  output?: string;                 // 面板（DialogAlert），保留
  toast?: string;                  // 瞬时通知文案
  variant?: ToastVariant;          // 通知颜色，缺省 info（蓝）
  dialog?: string;
};
```

`dispatch()` 改为 `toast(api, result.toast, result.variant ?? "info")`。

**③ 逐条语义标注**（约 45 处 `return { toast: ... }` + 约 20 处直接 `api.ui.toast`）：

| 场景（举例） | variant |
|--------------|---------|
| `暂无模板`、`模板 "x" 不存在`、`用法: ...`、`索引无效`、`内容不能为空`、`require 未设置`、`内置模板，编辑将创建用户覆盖` | `warning` |
| `模板 "x" 已更新`、`已保存`、`已删除`、`已添加`、`已清除`、`模式: xxx`、`ON/OFF 切换`、`条件已添加/已删除` | `success` |
| `渲染失败`、`保存失败`、`编辑异常`、`编辑界面异常`、`模板渲染异常`、所有 `catch` 分支 | `error` |
| 纯信息（`暂无命令错误记录`、`安全提醒冷却已清除` 等无副作用提示） | `info` |

> 原则：**失败=红、风险/缺失=橙、成功=绿、中性=蓝**。逐处对照，不靠关键词猜测。

**④ 模板执行改为「直接发送」**（消除唯一剩余 `appendPrompt`）：

```ts
/** 直接发送文本到当前会话（append → submit），不再停留在输入框 */
function sendPrompt(api: any, text: string, label: string): void {
  const tui = api?.client?.tui;
  if (!tui?.appendPrompt) { toast(api, "发送失败：TUI API 不可用", "error"); return; }
  Promise.resolve(tui.appendPrompt({ text }))
    .then(() => tui.submitPrompt?.())
    .then(() => toast(api, `已发送 ${label}`, "success"))
    .catch((e) => { console.error("[ShellFix] sendPrompt error:", e); toast(api, "发送失败", "error"); });
}
```

- `showTemplateRender` 两处 `appendPrompt({ text: rendered })` → `sendPrompt(api, rendered, \`模板 "${name}"\`)`
- 删除 `TuiApi.client.tui.appendPrompt` 注释中的「填入输入框」语义说明，改为「直接发送」

### 8.4 服务端侧核查（`src/shell-fix.ts`、`src/lib/*`）

| 位置 | 现状 | 结论 |
|------|------|------|
| `lib/toast-alerts.ts` 思考截断 | `variant="error"`（红） | ✅ 已符合 |
| `lib/toast-alerts.ts` codemap 未建索引 | 缺省 `warning`（橙） | ✅ 已符合 |
| `command.execute.before`（`/my`、`/auto`、`/codemap-index`） | 结果替换 `output.parts` → 作为用户消息发送 | **保持**：这是「命令执行结果」，属直接发送；但需在文档标注「信息类子命令（`/my ?`、`/auto list`）会进入对话」为已知行为 |
| v2.3.2 A 段新增的 codemap 失败提示 | 原为 `console.error` | 改为 `alertToast(..., "warning")`（橙），与 8.2 映射一致 |

### 8.5 测试矩阵（B 段）

| # | 用例 | 预期 |
|---|------|------|
| B1 | palette `ShellFix encoding` 切换 | 绿色 toast「编码: ON」 |
| B2 | `/my edit 不存在名` | 橙色 toast「模板不存在」 |
| B3 | `/my save` 写入失败（模拟只读） | 红色 toast「保存失败」 |
| B4 | palette `模板 → 执行 ys` | 消息直接发出（不停留输入框）+ 绿色 toast「已发送 模板 "ys"」 |
| B5 | palette `模板 → 执行` 带 `{0}` 参数模板 | DialogPrompt 收参 → 直接发出 + 绿色 toast |
| B6 | `/my ?` 列表 | 仍为 DialogAlert 面板（可滚动），无 toast |
| B7 | 思考截断 | 红色 toast（既有） |
| B8 | codemap 未建索引 | 橙色 toast（既有） |
| B9 | codemap overlay 冲突（A 段） | 橙色 toast + 日志节流，不再 `console.error` 刷屏 |
| B10 | 全部 `catch` 分支 | 红色 toast，不再静默 |

### 8.6 B 段交付清单

| 项 | 文件 | 说明 |
|----|------|------|
| B1 | `src/shell-fix-tui.ts` | 新增 `toast()` / `sendPrompt()`；`DispatchResult.variant`；约 65 处调用点标注颜色；删除 2 处 `appendPrompt` |
| B2 | `src/lib/toast-alerts.ts` | 无需改动（已支持 variant） |
| B3 | `src/lib/codemap-indexer.ts` | overlay 失败改 `alertToast(..., "warning")`（与 A 段合并实现） |
| B4 | `docs/03-安装与使用.md` | 新增「toast 四色说明」小节 |
| B5 | `README.md` | `/my <name>` 说明由「填入输入框」改为「直接发送」 |
| B6 | `docs/D0-ShellFix-全功能设计.md` | 输出通道表格更新（输入框输出 → 直接发送 / toast） |

### 8.7 B 段风险

| 项 | 说明 |
|----|------|
| `submitPrompt` 时序 | `appendPrompt` 是异步 POST，若 `submitPrompt` 先到会提交空内容 → 用 `await`/Promise 链串行（已按此实现） |
| 用户误发 | 模板执行不再给「先看一眼再改」的机会 → 由 toast「已发送 xxx」+ 可编辑后重发兜底；如需保留预览可后续加开关 |
| 面板保留 | 多行内容仍走 DialogAlert，不受影响 |

