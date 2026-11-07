# v2.3.0 审核报告 — CodeMap 索引自动化注入

> 对应开发方案：`docs/迭代开发记录/ShellFix-V2.3.0-开发方案.md`（v2 修订版）
> 审核日期：2026-11-07
> 版本：2.2.12 → 2.3.0

---

## 一、结论

实现完成，静态检查通过（7 个 TS 文件 LSP 零 error）。**v2.3.0 已部署到本地环境**（部署版 `PLUGIN_VERSION=2.3.0`，备份 `.bak\20261107_221320_*`，无 truncation 残留）。Step 0a 已由用户重启确认**通过**（斜杠菜单无重复条目 = `config` 钩子自注册生效）。v2.4.0 截断自愈（内测中）已从本次提交剥离暂存（`%TEMP%\opencode\v24-stash\`），待内测稳定后另行发布。测试矩阵（§5.1，14 用例）待用户实际使用中验证。

---

## 二、交付清单核对

| 项 | 状态 | 说明 |
|----|------|------|
| `src/lib/codemap-mcp.ts` | ✅ | 常驻会话、串行队列、id 路由、分层超时、空闲回收、树杀、buffer flush |
| `src/lib/codemap-indexer.ts` | ✅ | 归一化、检测、去重、ensure、workspace、refresh、cleanup、失败计数、命令分发；**含正斜杠修复**（`file_paths` 统一 `replace(/\\/g, "/")`，修 `FilePath must use forward slashes only`） |
| `src/lib/state.ts` | ✅ | `codemapIndex`（默认 true）+ `codemapLast` + `toggleCodemapIndex()` + deepMerge null 守卫 + `PLUGIN_VERSION=2.3.0`；**不含** v2.4 truncation 字段 |
| `src/shell-fix.ts` event/config | ✅ | `session.created` / `file.edited` / `session.deleted`；`config` 钩子自注册 `codemap-index` / `my` / `auto`（含 `if (!c.command ...) c.command = {}` 守卫） |
| `src/shell-fix.ts` build 检测 | ✅ | `tool.execute.after` 最前、`tool0`/`cmd0` 命名避重、不 return |
| `src/shell-fix.ts` 命令分支 | ✅ | `command.execute.before` → `case "codemap-index"` / `"my"` / `"auto"` |
| `src/shell-fix.ts` 失败提醒 | ✅ | `system.transform` 注入 `consumeCodemapFailureNotice()` 并并入早退条件 |
| `src/shell-fix-tui.ts` | ✅ | `TOGGLE_META.codemap`、palette `shellfix.codemap` / `shellfix.codemap-run`、状态面板 codemap 行；**移除 `slashName`**（`/my` `/auto` 菜单去重，palette 项保留 `Ctrl+P` 可用） |
| `deploy.ps1` | ✅ | `$libFiles` 追加 `codemap-mcp.ts`、`codemap-indexer.ts`；不含 truncation-alert.ts |
| `package.json` | ✅ | `2.2.12` → `2.3.0` |
| 文档 | ✅ | CHANGELOG（v2.3.0 条目）、README（⑤ 小节 + 命令表 + 版本）、开发方案（§4.1 spike + 交付清单）、docs/03 FAQ（命令注册坑 + 正斜杠）、docs/09 §六（命令路径语义） |
| 测试矩阵 14 用例 | ⏳ | 待实际使用中验证 |

---

## 三、Spike 结论记录

### Step 0a（`config` 钩子注册命令）— 通过
用户重启后确认斜杠菜单 `/my` `/auto` **无重复条目**，即插件 `config` 钩子自注册生效（`codemap-index` / `my` / `auto` 均由插件注册，用户 `opencode.jsonc` 已删除手写 `command.my/auto`，TUI palette 不再带 `slashName`）。兜底路径（`opencode.jsonc` 手动注册 / palette `shellfix.codemap-run`）保留可用。

### Step 0b（并发 ensure 安全性）— 通过
仓库 `_Tests\Wps2Markdown`（404 symbols）。两进程并发 `ensure_baseline`：均返回 `already_existed:false`，wall 4468 ms / 4365 ms；终态仅 1 个 baseline 目录，manifest 1560 B / `symbol_count=404` 可解析，`symbols.search` 正常命中。
**结论**：无跨进程锁、无半写损坏，重复执行仅浪费 CPU → 依赖进程内 inFlight + 60s 持久化冷却即可。

### Step 0c（超时树杀安全性）— 通过
仓库 `_TKWF`（10962 symbols）。12 s 处 `taskkill /T /F`：子进程 exit code=1，调用立即返回；杀后目标 HEAD sha 目录**完全不存在**（暂存 + 原子落位），无半写残留；重跑 40.8 s 成功（10962 symbols / 24482 refs / 1248 files，manifest 9614 B）。
**结论**：树杀安全，180 s 超时 ≈ 4× 实测上限，合理。

---

## 四、实现要点与关键决策

1. **零运行时依赖**：`codemap-mcp.ts` 直接 spawn `codemap-mcp.exe`，JSON-RPC 2.0 按行分隔，不引入 zod / `@opencode-ai/plugin`。
2. **返回结构简化**：实测 `index.ensure_baseline` 直接返回 `stats.symbol_count`，**无需读 manifest.json**（相对方案 v1 的简化）。
3. **去重双层**：进程内 `inFlight`（同仓库并发请求合并）+ 持久化 60 s 冷却（跨 `session.created` 幂等请求快速返回）。
4. **失败可见性**：单次失败静默（仅 `codemapLast` 记录）；连续失败 ≥3 次由 `system.transform` 一次性提醒（`consumeCodemapFailureNotice()` 消费即清）。
5. **非 .NET 零开销**：`detectDotnetRepo` 前置判定，非 .NET 仓库不 spawn 任何进程。
6. **回收路径修正**：`closeCodemapSession` 先 `normalizeRepoRoot` 再 `repoKey`，避免 `session.deleted` 的 directory 与 key 不一致导致回收失效。
7. **注释规范**：新增代码仅保留钩子分区横幅（沿用文件既有 `// 钩子 X:` 命名体系）与公共 API 文档，无自解释注释。

---

## 五、静态检查

`lsp_diagnostics`（src 目录，7 个 TS 文件）：

- **error：0**（本次改动的 5 个文件全部零 error）
- 说明：`src/lib/template-store.ts` 存在 2 条既有 biome 告警（`noControlCharactersInRegex`），该文件本次未改动，非本迭代引入。

---

## 六、需求对照

| 需求 | 实现 |
|------|------|
| a. `ensure_baseline` 幂等 | `runEnsure` + inFlight + 60s 冷却；`already_existed` 快速返回 |
| b. `workspace.create(workspace_id="session")` | `ensureWorkspace`，默认 `session`，`SHELLFIX_CODEMAP_WORKSPACE` 可覆盖 |
| c. 编辑 `.cs` 后 `refresh_overlay` | `event: file.edited` → `codemapOnCsEdited` → 5s 防抖 → `refreshOverlayNow` |
| d. 查询统一带 `workspace_id:"session"` | 客户端所有工具调用注入默认参数（`DEFAULT_ARGS`） |
| e. `~/.codemap` >1GB 清理 | `cleanupIfNeeded`：24h 间隔、dry_run 预估 freed ≥100MB 才实删、keep_count=3 / older_than_days=14 |
| 开关默认开 | `DEFAULT_STATE.codemapIndex = true`；`/shellfix codemap` + palette 切换 |
| 触发优先级 | build 成功 > 会话开始 > `/codemap-index` |
| 日志/静默 | 成功 1 行 log；失败静默；连续 3 次失败一次性提醒 |
| 仅 .NET 仓库 | `detectDotnetRepo`（`.slnx/.sln/.csproj`，排除 `node_modules/.git/bin/obj/...`） |
| 同仓库同窗口只跑一次 | `repoKey` 归一化 + inFlight + 冷却 |
| 不在每个 commit 后触发 | 未接入 git 相关钩子 |

---

## 七、遗留项与风险

| 项 | 说明 |
|----|------|
| 测试矩阵待执行 | §5.1 共 14 用例（含非 .NET 零开销、失败静默、连续 3 次提醒、超时树杀），待实际使用中验证 |
| 部署 | 已执行 `deploy.ps1` 部署到 `~/.config/opencode/plugins/`（含 `lib/`），备份 `.bak\20261107_221320_*` |
| v2.4.0 剥离 | 截断自愈（`truncation-alert.ts` + `state.ts`/`shell-fix.ts`/`shell-fix-tui.ts` truncation 段 + 相关文档）已剥离暂存至 `%TEMP%\opencode\v24-stash\`，内测稳定后另行发布 |

---

## 八、待确认

1. 是否按 §5.1 执行完测试矩阵后再提交（建议：重启 → 跑矩阵 → 再提交）。
2. 提交信息建议：`feat(codemap): 索引自动化注入 v2.3.0（插件侧硬保证）`
