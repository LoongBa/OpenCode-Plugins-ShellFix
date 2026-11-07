# v2.3.1 开发方案 — 通用 Toast 提示 + 计数机制

> 状态：📝 方案待审
> 版本：v2.3.1（优化细节，patch bump：2.3.0 → 2.3.1）

---

## 一、背景与目标

### 1.1 需求来源（用户 2026-11-07 反馈）

调试期发现两类「静默失败/无感知」场景，agent 与用户都看不到提示：

| 场景 | 现象 | 现状 |
|------|------|------|
| **思考截断** | agent 回复只有思考、正文被截断（无正文 + 思考断尾） | ❌ 无任何提示（v2.4 自愈已剥离待内测） |
| **codemap 未建索引** | 调用 codemap 工具报 `repo_path is required — no repo has been indexed yet` | ❌ 插件无感知（MCP 工具错误只回到 agent） |

### 1.2 用户拍板的原则（原文要点）

1. **通用提示 + 计数**：按需增加统一的 toast + 计数；调试状态自动启用。
2. **开关策略**：现在只要**总开关**（默认开启）；未来再考虑总开关 + 单独开关。
3. **思考截断**：先 toast + 计数，**不做自愈**（自动续写留到 v2.4）。
4. 行为模式参照既有功能：默认开启（大部分）、toast 提示、提示内容含计数。

### 1.3 范围界定

**做：**
- 新增通用 toast + 计数通道（总开关 `alertToasts`，默认 true）
- 场景 A：思考截断检测 → toast + 计数（仅提示，不注入、不写输入框、不自愈）
- 场景 B：codemap 未建索引（工具错误）→ toast + 计数 + 指引
- 计数持久化（state.json，跨会话累计），toast 文案含累计次数

**不做：**
- ❌ 自愈（autoRetry / session.prompt 注入）→ v2.4 内测
- ❌ 空流检测 / 输出上限 / finish=unknown 等 v2.4 判定 → 保持 v2.4 范围
- ❌ 单独开关 → 仅总开关
- ❌ 修改既有静默通道（编码转换、export→$env 等保持静默）

---

## 二、设计

### 2.1 总开关与计数存储（`src/lib/state.ts`）

```typescript
// PluginState 新增：
alertToasts: boolean;                    // 总开关，默认 true（调试期自动启用）
alertCounts: Record<string, number>;     // 计数，key 为场景名

// DEFAULT_STATE 新增：
alertToasts: true,
alertCounts: {},

// 新增切换函数：
export function toggleAlertToasts(): boolean;   // 总开关切换
export function bumpAlertCount(key: string): number;  // 计数 +1，返回新值（持久化）
```

- 旧 state 文件无新字段 → `deepMerge(DEFAULT_STATE, parsed)` 自动补默认值（既有机制，已验证）。
- 计数 key：`"think-cut"`（思考截断）、`"codemap-no-index"`（未建索引）。

### 2.2 通用 toast 通道（新文件 `src/lib/toast-alerts.ts`）

```typescript
type ToastClient = { tui?: { showToast?: (opts: { body: ToastBody }) => Promise<unknown> } };
type ToastBody = { title: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number };

// 通用入口：总开关关闭 → 静默；计数 +1；toast 文案自动带「(累计 N 次)」
export async function alertToast(
  client: ToastClient | undefined,
  key: string,            // 计数 key（如 "think-cut"）
  title: string,          // toast 标题（如 "思考截断"）
  message: string,        // 正文（不含计数部分）
  variant: "warning" | "error" = "warning",
): Promise<void>;
```

- 总开关读取：`loadState().alertToasts === false` → return（含计数不落？**计数照记**——即使 toast 被关，次数仍累计，供 `/shellfix doctor` 或未来排查使用）。
- SDK 形状（已实证）：`showToast({ body: { title, message, variant, duration } })`，variant 仅 `info|success|warning|error`。

### 2.3 场景 A：思考截断检测（`src/shell-fix.ts` event 钩子）

**触发**：`session.idle` 事件（复用 event 钩子，在现有 created/edited/deleted 分支之前）。

**判定**（取最后一条有内容的 assistant 消息）：
```
finish 不是 tool-calls
且 无正文（text 部分为空/无实际内容）
且 有思考内容（reasoning 非空）
且 思考尾部 不是自然结束（NATURAL_END 不匹配）
→ 疑似思考截断
```

**动作**：`alertToast(client, "think-cut", "思考截断", "检测到思考被截断（无正文输出）。若回复不完整可要求继续。", "error")`。

**防重复**：模块级 `Set<messageId>`，同一消息只提示一次（进程内，与 v2.4 alert 同策略）。

**判定常量**：`NATURAL_END = /[。！？!?；;：:\.…·）)\]】》"'`\n|]$/`（与 v2.4 stash 一致）。

**消息获取**：`client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })`。

### 2.4 场景 B：codemap 未建索引检测（`src/shell-fix.ts` tool.execute.after）

**插入点**：既有 B2 钩子顶部、`if (tool !== "bash" && tool !== "pwsh") return;` **之前**（与 codemapOnBuildSuccess 并列）。

**判定**：
```typescript
if (typeof tool0 === "string" && tool0.startsWith("codemap_")) {
  const out = (output as { output?: string }).output || "";
  if (/repo_path is required|no repo has been indexed|Run index\.ensure_baseline/.test(out)) {
    → 未建索引命中
  }
}
```

**动作**：`alertToast(client, "codemap-no-index", "CodeMap 未建索引", "该仓库尚未建立索引。请执行 codemap_index_ensure_baseline(repo_path=<仓库根>)，或 /codemap-index 命令。", "warning")`。

**防重复**：本次会话内同仓库（baseDir）限 1 次？——**不做会话级去重**（用户可能多次调多个仓库），但按「5 分钟内同 key 最多 1 次 toast」节流（进程内 Map 时间戳），避免连续工具调用刷屏。

### 2.5 TUI 开关入口（`src/shell-fix-tui.ts`）

- `TOGGLE_META` 加：`alerts: { label: "调试提示", desc: "思考截断/codemap 未建索引等 toast 提示 + 计数（总开关，默认 ON）", stateKey: "alertToasts" }`
- palette 加：`shellfix.alerts` → `showToggleInfo(api, "alerts", toggleAlertToasts)`
- 状态面板加一行：`alerts ${s.alertToasts ? "ON" : "OFF"}`
- import：`toggleAlertToasts`

### 2.6 部署（`deploy.ps1`）

- `$libFiles` 追加 `toast-alerts.ts`。
- 部署后版本号 `PLUGIN_VERSION` 由 state.ts 改为 `2.3.1`；package.json `2.3.1`。

---

## 三、交付清单

| 项 | 文件 | 说明 |
|----|------|------|
| 1 | `src/lib/state.ts` | `alertToasts`/`alertCounts` 字段 + `toggleAlertToasts()` + `bumpAlertCount()` + `PLUGIN_VERSION=2.3.1` |
| 2 | `src/lib/toast-alerts.ts`（新） | `alertToast()` 通用通道（开关判定 + 计数 + 节流） |
| 3 | `src/shell-fix.ts` | event 钩子加 `session.idle` 分支（思考截断判定 + toast）；tool.execute.after 加 codemap 工具错误检测 + toast |
| 4 | `src/shell-fix-tui.ts` | TOGGLE_META/palette/状态面板加 `alerts` 开关 |
| 5 | `deploy.ps1` | `$libFiles` 加 `toast-alerts.ts` |
| 6 | `package.json` | `2.3.1` |
| 7 | 文档 | CHANGELOG v2.3.1 条目、README（⑥ 或新小节）、docs/03 FAQ |

---

## 四、测试矩阵

| # | 用例 | 预期 |
|---|------|------|
| 1 | 触发思考截断（空正文+思考断尾） | toast「思考截断」，state 计数 `think-cut` +1 |
| 2 | 同一消息重复 idle 事件 | 只提示 1 次（msgId 去重） |
| 3 | 正常回复（有正文/自然结束） | 无 toast |
| 4 | `finish=tool-calls` | 无 toast |
| 5 | 调用 codemap_* 工具返回未建索引错误 | toast「CodeMap 未建索引」+ 指引，计数 +1 |
| 6 | 5 分钟内多次同场景触发 | 节流：最多 1 次 toast，计数继续累计 |
| 7 | `alerts` 总开关 OFF | toast 不弹，计数仍累计 |
| 8 | `alerts` 总开关 ON（默认） | 正常提示 |
| 9 | 旧 state 文件无新字段（升级） | deepMerge 补默认值，不崩 |
| 10 | 非 bash/pwsh 工具调用 | 不影响既有命令错误检测 |

---

## 五、风险与兼容

| 项 | 说明 |
|----|------|
| `client.session.messages` 在 idle 时机可用性 | v2.4 已实证可用（同 API），风险低 |
| `input.client` 类型为 unknown | 沿用既有 `(input as any)` 风格，toast 走 `?.` 链静默失败 |
| 思考截断误报 | 判定条件严格（无正文 + 思考断尾 + 非 tool-calls），误报即 toast 一条，无副作用 |
| v2.4 后续复用 | 本方案的 `alertToast`/计数为 v2.4 自愈 toast 提供公共通道，避免内测再改 |

---

## 六、实施顺序

1. `state.ts`（字段 + 函数 + 版本号）
2. `toast-alerts.ts`（通用通道）
3. `shell-fix.ts`（两个场景接入）
4. `shell-fix-tui.ts`（开关入口）
5. `deploy.ps1` + `package.json`
6. 文档（CHANGELOG / README / FAQ）
7. LSP 校验 → 部署 → 测试矩阵 → 审核报告 → 提交推送