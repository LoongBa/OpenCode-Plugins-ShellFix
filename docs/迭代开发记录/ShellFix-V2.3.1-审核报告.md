# v2.3.1 审核报告 — 通用 Toast 提示 + 计数机制

> 对应开发方案：`docs/迭代开发记录/ShellFix-V2.3.1-开发方案.md`
> 审核日期：2026-11-07
> 版本：2.3.0 → 2.3.1

---

## 一、结论

实现完成，静态检查通过（4 个改动 TS 文件 LSP 零 error）。**v2.3.1 已部署到本地环境**（部署版 `PLUGIN_VERSION=2.3.1`，备份 `.bak\20261107_232416_*`，lib 含 `toast-alerts.ts`，shell-fix.ts 检测调用已确认）。测试矩阵（§四，10 用例）待用户重启后实际验证。审核通过，可提交。

---

## 二、交付清单核对

| 项 | 状态 | 说明 |
|----|------|------|
| `src/lib/state.ts` | ✅ | `alertToasts: true`（默认）+ `alertCounts: {}` + `toggleAlertToasts()` + `bumpAlertCount()`（`??=` 防御旧 state）+ `PLUGIN_VERSION=2.3.1` |
| `src/lib/toast-alerts.ts`（新） | ✅ | `alertToast()` 通用通道（开关判定→计数→节流→toast）；`detectThinkTruncation()`（session.idle 思考截断检测）；`detectCodemapNoIndex()`（codemap 工具错误检测） |
| `src/shell-fix.ts` | ✅ | event 钩子加 `session.idle` 分支（思考截断，置于 created/edited/deleted 之前）；tool.execute.after 加 codemap 工具检测（置于 bash 早退之前，与 build 检测并列） |
| `src/shell-fix-tui.ts` | ✅ | `toggleAlertToasts` import；TOGGLE_META `alerts`；palette `shellfix.alerts`；状态面板 `alerts` 行；help 清单补 codemap/codemap-run/alerts 条目（顺带修复 v2.3.0 遗漏） |
| `deploy.ps1` | ✅ | `$libFiles` 追加 `toast-alerts.ts` |
| `package.json` | ✅ | `2.3.0` → `2.3.1` |
| 文档 | ✅ | CHANGELOG（v2.3.1 条目）、README（版本 + ⑥ 小节 + 命令表）、docs/03 FAQ（调试提示 Q）、开发方案（§四 测试矩阵） |

---

## 三、实现要点与关键决策

1. **计数不受开关影响**：`bumpAlertCount` 在开关判定之前执行——关闭 toast 后计数仍累计，符合「正式期静默但可查」设计。
2. **节流与去重双保险**：`TOAST_THROTTLE_MS = 5min`（同场景进程内节流，防连续工具调用刷屏）+ `alertedMessages` Set（同消息只提示一次，防 session.idle 重复事件）。
3. **判定条件严格防误报**：思考截断需「无正文（text 非空且非 synthetic 的文本不存在）+ 有思考 + 思考尾部非自然结束 + 非 tool-calls + 非 abort + 主会话（无 parentID）」五重条件；codemap 检测用 `/repo_path is required|no repo has been indexed|Run index\.ensure_baseline/i` 精确匹配。
4. **通道形状**：toast 走 `client.tui.showToast({ body: { title, message, variant, duration } })`，文案自动追加「（累计 N 次）」；SDK 形状与 v2.4 实证一致。
5. **非自愈**：思考截断仅提示，不含 autoRetry/session.prompt/appendPrompt——自愈留 v2.4（stash 在 `%TEMP%\opencode\v24-stash\`）。
6. **性能**：计数走内存缓存（loadState 不读盘）+ 低频落盘（<1ms）；两个场景均为低频事件，无感知。
7. **注释规范**：新增 JSDoc 仅公共 API（关键契约「计数不受开关影响」必写）；分区横幅沿用项目既有体系。

---

## 四、测试矩阵核对

| # | 用例 | 状态 | 说明 |
|---|------|------|------|
| 1 | 触发思考截断（空正文+思考断尾） | ⏳ | 待重启实测（需真实截断场景或构造消息） |
| 2 | 同一消息重复 idle 事件 | ⏳ | 去重逻辑已实现（alertedMessages），待实测 |
| 3 | 正常回复（有正文/自然结束） | ⏳ | 判定条件已排除，待实测 |
| 4 | `finish=tool-calls` | ⏳ | 已排除（代码 435 行守卫），待实测 |
| 5 | codemap_* 工具返回未建索引错误 | ⏳ | 检测已接入 tool.execute.after，待实测 |
| 6 | 5 分钟内多次同场景触发 | ⏳ | 节流已实现，待实测 |
| 7 | `alerts` 开关 OFF → toast 不弹 | ⏳ | 逻辑已实现，待实测 |
| 8 | `alerts` 开关默认 ON | ✅ | 代码确认（DEFAULT_STATE.alertToasts=true） |
| 9 | 旧 state 文件无新字段（升级） | ✅ | deepMerge 补默认值（既有机制）+ bumpAlertCount `??=` 防御 |
| 10 | 非 bash/pwsh 工具调用不受影响 | ✅ | codemap 检测置于 bash 早退之前，命令错误检测逻辑未动 |

---

## 五、静态检查

`lsp_diagnostics`（4 个改动文件）：**error 全部 0**（shell-fix.ts / shell-fix-tui.ts / state.ts / toast-alerts.ts）。

---

## 六、遗留项与风险

| 项 | 说明 |
|----|------|
| 测试矩阵 10 用例 | 待用户重启后实测（重点：#1 思考截断、#5 codemap 未建索引、#7 开关） |
| 部署 | 已执行（备份 `.bak\20261107_232416_*`），需重启 OpenCode 生效 |
| v2.4 自愈 | 仍暂存 `%TEMP%\opencode\v24-stash\`，本版本明确不做；`alertToast` 通道可供 v2.4 复用 |
| 未来开关细分 | 现仅总开关；方案注明未来可加「总开关+单独开关」分层 |

---

## 七、待确认

1. 是否重启后执行 §四 测试矩阵验证。
2. 提交信息建议：`feat: v2.3.1 通用调试提示（toast + 计数 + 总开关）`。