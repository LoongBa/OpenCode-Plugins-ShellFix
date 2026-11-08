# v2.3.3 审核报告 — 插件日志改文件输出（消除 TUI 输入框红字污染）

> 对应开发方案：`docs/迭代开发记录/ShellFix-V2.3.3-开发方案.md`
> 审核日期：2026-11-08
> 版本：2.3.2 → 2.3.3（hotfix）

---

## 一、结论

实现完成，静态检查通过（新增/改动文件 LSP 零 error，`tsc --noEmit` 无新增错误）。日志通道已用 Node 直跑 `logLine()` 自测成功（文件写入、格式化、Error 序列化均正常）。**已部署到本地环境**（9 个文件哈希全部一致，`PLUGIN_VERSION=2.3.3`，备份 `.bak\20261108_151912_*`）。测试矩阵需重启后实机验证。审核通过，待用户确认后提交。

---

## 二、交付清单核对

| # | 项 | 状态 | 说明 |
|---|----|------|------|
| 1 | `src/lib/log-file.ts`（新） | ✅ | `logLine(tag, ...args)` 写 `~/.local/share/opencode/log/shellfix.log`；`>5MB` 保留最后 1MB；目录不存在自动创建；任何异常静默；支持 string / Error（含 stack）/ 对象（JSON） |
| 2 | `src/lib/codemap-indexer.ts` | ✅ | 3 处 `console.error` → `logLine("CodeMap", ...)`；`built` 行仍受 `state.log` 门控 |
| 3 | `src/shell-fix.ts` | ✅ | 5 处 `console.*`（4 error + 1 log）→ `logLine("core", ...)`；import 追加 |
| 4 | `src/shell-fix-tui.ts` | ✅ | 46 处 `console.error` → `logLine("tui", ...)`；import 路径 `../plugins/lib/log-file`（与部署结构一致） |
| 5 | `src/lib/state.ts` | ✅ | `PLUGIN_VERSION = "2.3.3"` |
| 6 | `package.json` | ✅ | `2.3.3` |
| 7 | `deploy.ps1` | ✅ | `$libFiles` 追加 `log-file.ts` |
| 8 | 文档 | ✅ | CHANGELOG v2.3.3 条目；README 版本号 v2.3.3；docs/03 新增「输入框红字」FAQ + 重写「日志调试」小节（`logLine` 用法与路径） |

---

## 三、实现要点与关键决策

1. **为什么必须换通道**：`@opencode-ai/plugin` 的 `PluginInput` 只有 `client/project/directory/worktree/serverUrl/$`，**无 logger API**；`console.*` 直写进程 stderr，与 TUI 共用终端 → 覆盖渲染区。取证：`opencode.log`（46MB）中 `[ShellFix][CodeMap]` 0 命中，证明插件 console 输出既不进 opencode 日志也不进 toast。
2. **`logLine(tag, ...args)` 保持 console 的变参签名**：机械替换只需把 `console.error(` 换成 `logLine("<tag>", `，54 处零手改、零遗漏（grep 校验残留 0）。
3. **tag 区分来源**：`core`（服务端插件）/ `tui`（TUI 调度器）/ `CodeMap`（索引器），便于在单一文件内按来源过滤。
4. **不引入 state 依赖**：`log-file.ts` 只依赖 `node:fs/os/path`，避免与 `state.ts` 循环引用；「是否记录信息类日志」由调用方既有 `if (state.log)` 门控保留。
5. **失败静默**：写日志失败（目录不可写/磁盘满）绝不影响插件功能——整个函数 try/catch 吞掉。
6. **截断策略**：`>5MB` 时读取文件、保留最后 1MB 后重写，避免无限增长；检查在写入前执行，正常路径只多一次 `statSync`。
7. **toast 不受影响**：B 段的 40 处 `DispatchResult.variant` + 35 处 catch 红 toast 全部保留，本次只改「诊断信息去哪」，不改「用户看到什么」。
8. **部署一致性**：`shell-fix-tui.ts` 用 `../plugins/lib/log-file`（部署后 `tui-plugins/` 与 `plugins/lib/` 同级），与服务端 `./lib/log-file` 各自匹配其部署位置。

---

## 四、测试矩阵核对

| # | 用例 | 状态 | 说明 |
|---|------|------|------|
| 1 | .NET 仓库开新会话 | ⏳ | 待重启实测：输入框无红字 + `shellfix.log` 出现 `mode=built` 行 |
| 2 | `dotnet build` 成功 | ⏳ | 同上 |
| 3 | 非 .NET 仓库开会话 | ✅（静态） | `isDotnetRepo` 守卫未改，零输出零日志 |
| 4 | `log` 开关 OFF | ✅（静态） | `built` 行仍包在 `if (state.log)` 内 |
| 5 | 人为触发异常（模板保存只读目录） | ⏳ | 红色 toast 照旧 + `shellfix.log` 有 `tui` 行 + 输入框无红字 |
| 6 | 日志 >5MB | ✅（静态+逻辑） | 写前 `statSync` 判断，超限保留 1MB |
| 7 | 日志目录不可写 | ✅（自测） | try/catch 静默；`logLine` 自测未抛异常 |
| 8 | 重启后版本号 | ✅ | 部署版 `PLUGIN_VERSION = "2.3.3"` |

---

## 五、静态检查

| 项 | 结果 |
|----|------|
| `lsp_diagnostics`（`log-file.ts` / `codemap-indexer.ts`） | 零 error（仅 biome 既有 warning/info） |
| `tsc --noEmit`（4 文件） | 26 error **全部为既有问题**（`template-store.ts` 8 处类型不匹配、`shell-fix.ts` 18 处隐式 any/`PluginState.auto`），**无一落在本次改动行**（`logLine` 位于 334/385/422/446/638，报错行均不重合） |
| `console.*` 残留 | `src/` 下 **0 命中** |
| `logLine(` 调用数 | `shell-fix-tui` 46 / `shell-fix` 5 / `codemap-indexer` 3（= 原 console 数） |
| 运行时自测 | `node` 直跑 `logLine("selftest", ...)` → 文件创建成功、3 条记录格式正确（含 Error stack） |

---

## 六、遗留项与风险

| 项 | 说明 |
|----|------|
| 实机验证 | 用例 1/2/5 需重启后确认「输入框无红字」 |
| npm 发布（v2.3.2） | 工作流重跑仍失败：**E403 Forbidden — You do not have permission to publish "opencode-shellfix"**。说明 NPM_TOKEN 已通过认证但**缺少该包的发布权限**（需 Classic *Automation* token，或 Granular token 勾选该包 Read and write + 允许绕过 2FA） |
| 历史 tag | `V2.3.0`/`V2.3.1` 从未创建，npm registry 最新仍为 `2.2.12` |
| 日志文件增长 | 5MB 截断；`log` OFF 时信息类日志不写 |
| 排查习惯 | 诊断从「终端可见」改为「看 `shellfix.log`」，docs/03 已写明路径 |

---

## 七、待确认

1. 重启后验证 §四 用例 1/2/5（重点：输入框不再出现红字）。
2. 提交信息建议：`fix: v2.3.3 插件日志改文件输出，消除 TUI 输入框红字污染`
3. 是否同时处理 npm 发布（需重新生成有 publish 权限的 Automation token）。
