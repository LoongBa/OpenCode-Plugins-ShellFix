# v2.3.2 审核报告 — CodeMap overlay 跨进程冲突修复 + 输出通道四色 toast 统一

> 对应开发方案：`docs/迭代开发记录/ShellFix-V2.3.2-开发方案.md`
> 审核日期：2026-11-08
> 版本：2.3.1 → 2.3.2

---

## 一、结论

实现完成，静态检查通过（4 个改动 TS 文件 LSP 零 error）。A 段（CodeMap overlay 冲突）与 B 段（四色 toast 统一）均按方案落地，无偏离。测试矩阵（A 段 10 用例 + B 段 B1–B10）需实机重启后验证。**审核通过，待用户确认后提交**（未部署、未提交、未打 tag）。

审核方式：主代理逐行复核 `git diff` 全量改动（10 文件 +266/−166）+ `lsp_diagnostics` 四文件 + 全局 grep 残留引用/覆盖度检查。委派的 code-reviewer 子代理 12 分钟无产出（最后动作卡在 bash），已取消，改为主代理自查；如需要独立第三方复审可另行发起。

---

## 二、交付清单核对

### A 段（CodeMap）

| # | 项 | 状态 | 说明 |
|---|----|------|------|
| 1 | `src/lib/codemap-indexer.ts` | ✅ | 删除 `REFRESH_DEBOUNCE_MS`/`pendingRefresh`/`refreshTimer`/`scheduleOverlayRefresh`/`flushOverlayRefresh`/`codemapOnCsEdited`；`refreshOverlayNow` 返回 `Promise<McpResult>` 且走 `callWithRetry(attempts:3)`；`ensureWorkspace` 的 `workspace.create` 走 `callWithRetry(attempts:2)`；`codemapOnSessionStart`/`codemapOnBuildSuccess` 改为 ensure + cleanup（不再 ensure workspace、不再刷 overlay）；新增 `FAIL_LOG_THROTTLE_MS=5min` + `lastFailLogAt` |
| 2 | `src/lib/codemap-mcp.ts` | ✅ | `RECOVERABLE_RE` 收窄为 `/spawn failed\|exited code=\|codemap-mcp exited\|EPIPE\|timeout \d+ms/i`；新增 `LOCK_CONFLICT_RE`（`overlay.wal\|being used by another process\|EBUSY\|IOException`）；新增 `WORKSPACE_NOT_FOUND_RE` + `normalizeError()`（转中文可操作提示）；新增 `callWithRetry(name,args,{attempts,backoffMs,timeoutMs})` |
| 3 | `src/shell-fix.ts` | ✅ | `event` 钩子删除 `file.edited` 分支与 `codemapOnCsEdited` import；仅保留 `session.created` → `codemapOnSessionStart`、`session.deleted` → `closeCodemapSession` |
| 4 | `src/lib/state.ts` | ✅ | `PLUGIN_VERSION = "2.3.2"` |
| 5 | `package.json` | ✅ | `"version": "2.3.2"` |
| 6 | 文档 | ✅ | README ⑤ 时机表（编辑 `.cs` 不再自动刷新 overlay）+ `/my`、`/note` 改「直接发送」+ ⑥ 四色表；docs/03 FAQ（`refresh_overlay failed` / `Workspace not found` 重写 + toast 四色 FAQ）；docs/D0 调度流程图与 `/my <name>` 说明 |
| 7 | 部署 | ⏳ | `deploy.ps1` 无需改（无新增 lib 文件）；部署待用户授权后执行 |

### B 段（toast 统一）

| # | 项 | 状态 | 说明 |
|---|----|------|------|
| B1 | `src/shell-fix-tui.ts` | ✅ | 新增 `type ToastVariant`、`toast(api,message,variant,title?)`、`sendPrompt(api,text,label)`；`DispatchResult.variant`；`dispatch()` 透传 variant；**40 处** `return { toast }` 全部带 variant（grep 校验 0 遗漏）；全部 `api.ui.toast({message})` 直调已替换（仅剩 helper 内部 1 处与 1 处文案字符串）；2 处 `appendPrompt` 改 `sendPrompt`；**追加 35 处 catch 红色 toast** |
| B2 | `src/lib/toast-alerts.ts` | ✅ | 无需改动（`alertToast` 已支持 variant，5min 节流既有） |
| B3 | `src/lib/codemap-indexer.ts` | ✅（实现方式调整） | A 段后**自动路径已不写 overlay**，故无后台 overlay 失败可提示；唯一 overlay 写入在显式 `/codemap-index`，失败在命令结果面板逐条呈现（符合「面板保留」决策）。失败日志 5min 节流；连续失败 ≥3 次经 `consumeCodemapFailureNotice()` 注入 system prompt |
| B4 | `docs/03-安装与使用.md` | ✅ | 新增 toast 四色说明小节 |
| B5 | `README.md` | ✅ | `/my <name>`、`/note #tag#` 由「填入输入框」改为「直接发送」 |
| B6 | `docs/D0-ShellFix-全功能设计.md` | ✅ | 输出通道表 + `/my <name>` 行改为「渲染模板，直接发送 + 绿色 toast」 |

---

## 三、实现要点与关键决策

1. **A 段治本而非治标**：`Workspace 'session' not found` 的根因是 ShellFix 与 opencode 自带 `mcp.codemap` 两个进程同写 `~/.codemap/store/overlays/session/overlay.wal`。方案选择**彻底退出 overlay 维护**（overlay 归 Agent 侧 CodeMap），而非加锁重试到底——从根上消除双写。
2. **重试只用于显式路径**：`callWithRetry` 仅 `refreshOverlayNow`（`/codemap-index` 显式命令）与 `workspace.create` 使用；自动路径（session 开始 / build 成功）只做幂等 `ensure_baseline`，零 overlay 写入、零重试风暴。
3. **可恢复正则收窄**：原 `/timeout|exited|spawn failed|EPIPE|not found/i` 中的 `not found` 会误匹配 workspace 错误 → 白杀进程重启。现 `RECOVERABLE_RE` 去掉宽泛 `not found`，`timeout` 收紧为 `timeout \d+ms`（真实超时文案），`not found` 类错误交 `normalizeError` 转可读中文。
4. **重试退避**：`backoffMs=[300,1200,3000]`，仅 `LOCK_CONFLICT_RE` 命中才重试（`overlay.wal`/`being used by another process`/`EBUSY`/`IOException`），其他错误立即返回，避免无意义等待。
5. **队列安全性**：`callWithRetry` 每次重试走 `this.call()`（复用 `queue` 串行 + `disposed` 守卫），重试期间不会与并发调用交错；`close()` 后 `invoke` 直接返回 `session disposed`。
6. **四色语义统一**（TUI 侧与服务端侧同色）：`info`=蓝（中性/空列表/进行中）、`success`=绿（保存/删除/开关/已发送）、`warning`=橙（不存在/参数无效/内容为空/稍后重试）、`error`=红（渲染/保存/发送失败/全部 catch）。
7. **「填入输入框」彻底移除**：`sendPrompt` = `appendPrompt({text})` → `submitPrompt()` → 绿色「已发送 …」；失败红色 toast。用户已决策模板/笔记这类「发给 LLM 的文本」直接发送。
8. **面板保留**：`/my ?`、`/auto` 状态、`/shellfix doctor` 等多行内容仍走 `DialogAlert`（用户决策），只有通知类走 toast。
9. **API 形状来自二进制实证**：TUI 侧 `api.ui.toast({title?,message,variant?,duration?})`；服务端 `client.tui.showToast({body:{...}})`；发送 `client.tui.appendPrompt({text})` + `submitPrompt()`。`toast()` helper 优先 `api.ui.toast`，缺失时回退 `api.client.tui.showToast`。
10. **注释规范**：新增 JSDoc 仅公共 API/关键契约（`toast`/`sendPrompt`/`callWithRetry`/`normalizeError`），分区横幅沿用项目既有体系。

---

## 四、测试矩阵核对

### A 段（10 用例）

| # | 用例 | 状态 | 说明 |
|---|------|------|------|
| 1 | .NET 仓库开新会话 | ⏳ | 代码确认：仅 `ensure_baseline` 幂等调用，不 ensure workspace、不刷 overlay |
| 2 | 连续编辑 3 个 `.cs` | ✅（静态） | `file.edited` 分支已删、`codemapOnCsEdited` 全仓 0 引用（grep 验证） |
| 3 | `/codemap-index`（显式） | ⏳ | 代码确认：ensure → workspace（重试 2）→ overlay（重试 3），逐条报错 |
| 4 | Agent `codemap_*` + `/codemap-index` 并发 | ⏳ | 撞锁走退避重试；失败文案经 `normalizeError` 转中文 |
| 5 | `dotnet build` 成功 | ✅（静态） | `codemapOnBuildSuccess` 已无 `ensureWorkspace`/`refreshOverlayNow` |
| 6 | codemap-mcp 缺失 | ✅（静态） | `resolveCodemapExe()` 返回 null → `{ok:false,error:"codemap-mcp not found"}`，静默 |
| 7 | 非 .NET 仓库 | ✅（静态） | `isDotnetRepo` 守卫未改，零开销 |
| 8 | 旧 state（v2.3.1）升级 | ✅（静态） | 本版未新增 state 字段，无迁移问题 |
| 9 | `session.deleted` | ✅（静态） | `closeCodemapSession` 仅关本进程 session |
| 10 | `log` 开关 OFF | ✅（静态） | 失败日志走既有 `log()` 门控 + 5min 节流 |

### B 段（B1–B10）

| # | 用例 | 状态 | 说明 |
|---|------|------|------|
| B1 | palette 切换 `encoding` | ⏳ | 代码确认：`success`（绿） |
| B2 | `/my edit 不存在名` | ⏳ | 代码确认：`warning`（橙） |
| B3 | `/my save` 写入失败 | ⏳ | 代码确认：catch → `error`（红） |
| B4 | palette 模板执行 `ys` | ⏳ | 代码确认：`sendPrompt` → 直接发出 + `success` |
| B5 | 带 `{0}` 参数模板 | ⏳ | 代码确认：DialogPrompt → `sendPrompt` + `success` |
| B6 | `/my ?` 列表 | ✅（静态） | 仍返回 `output` → DialogAlert，无 toast |
| B7 | 思考截断 | ✅（静态） | `toast-alerts.ts` 未改，红色既有 |
| B8 | codemap 未建索引 | ✅（静态） | 同上，橙色既有 |
| B9 | overlay 冲突（A 段） | ⏳ | `warning` + 5min 日志节流 |
| B10 | 全部 catch 分支 | ✅（静态） | 追加 35 处 `toast(api, "ShellFix 内部异常，详见日志", "error")`（含 20 处 palette 包装器、14 处 `show*` 外层 catch、1 处 dispatch 本地 handler）；刻意跳过 2 处：`toast()` helper 自身（递归风险）与 TUI 初始化失败（api 可能不可用）；Promise `.catch` 已在 B 段改造中覆盖 |

---

## 五、静态检查

`lsp_diagnostics`（4 个改动 TS 文件）：**error 全部 0**；追加 35 处 catch toast 后再跑 `tsc --noEmit`（`--skipLibCheck --target esnext --module esnext --moduleResolution bundler`）**exit 0**，`lsp_diagnostics` 返回 `No diagnostics found`。

| 文件 | error | 备注 |
|------|-------|------|
| `src/lib/codemap-mcp.ts` | 0 | 仅 biome 既有 warning/info（`any`、import 顺序） |
| `src/lib/codemap-indexer.ts` | 0 | 同上（`noNonNullAssertion` 等既有项） |
| `src/shell-fix.ts` | 0 | 同上 |
| `src/shell-fix-tui.ts` | 0 | 同上；`noUnusedVariables` 告警均为 **HEAD 已存在的死代码**（`showTemplateRender`/`showTemplateList`/`toggleAndToast` 等在 v2.3.1 即无引用，非本次引入） |

残留引用检查（grep）：
- `codemapOnCsEdited` / `scheduleOverlayRefresh` / `flushOverlayRefresh` / `pendingRefresh` / `refreshTimer`：**0 命中**
- `appendPrompt`：仅 `sendPrompt` 内部 + `api` 类型声明
- `api.ui.toast({ message })` 旧式直调：**0 命中**（仅 helper 内 `api.ui.toast({title,message,variant})`）
- `return { toast: ... }` 共 40 处，**全部带 `variant`**（过滤验证 0 遗漏）

---

## 六、遗留项与风险

| 项 | 说明 |
|----|------|
| 测试矩阵 | A 段 4 项 + B 段 6 项需实机重启验证（重点：A3/A4 撞锁重试、B4/B5 直接发送时序） |
| `sendPrompt` 时序 | `appendPrompt` 的 Promise 完成后立即 `submitPrompt()`；若 TUI 端 append 有渲染延迟，极小概率提交空文本。实测若出现，可加 50–100ms 延时兜底 |
| 服务端侧命令 | `/my ?`、`/auto list`、`/codemap-index status` 仍走 `command.execute.before` 把结果作为用户消息发给 LLM（方案标注「保持不动」，用户已确认） |
| 死代码 | `shell-fix-tui.ts` 中 `showTemplateRender` 等 10 个函数自 v2.3.1 起无引用（biome 告警），本版未清理，避免扩大改动面 |
| 部署 | 未执行；`deploy.ps1` 无新增 lib 文件，无需修改 |
| tag | `V2.3.2` 未打，等待用户授权 |

---

## 七、待确认

1. 是否重启后执行 §四 测试矩阵（A 段 1/3/4、B 段 B1–B5、B9）。
2. 提交信息建议：`fix: v2.3.2 CodeMap overlay 跨进程冲突 + 输出通道四色 toast 统一`
3. 提交后是否立即 `deploy.ps1` 部署本地环境。
