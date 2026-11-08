# ShellFix V2.3.3 开发方案 — 插件日志改为文件输出（消除 TUI 输入框红字污染）

> 版本：2.3.2 → 2.3.3（hotfix）
> 日期：2026-11-08
> 状态：待用户确认

---

## 一、问题现象

v2.3.2 部署后，用户仍看到输入框区域出现红字：

```
Git\FlowCenter mode=built
elapsed=295mssymbols=0sha=f4e0f26e
ShellFix][codeMap]ngBa2026-11-08T07:02:34.347Zrepo=F:\Loo
```

（同一行被窄区域折行 + 渲染错位后的样子）

还原后实际是这一行：

```
[ShellFix][CodeMap] 2026-11-08T07:02:34.347Z repo=F:\LoongBa_Git\FlowCenter mode=built elapsed=295ms symbols=0 sha=f4e0f26e
```

## 二、根因（已取证，非推测）

1. 该行来自 `src/lib/codemap-indexer.ts:174` 的 `recordRun()`：
   ```ts
   if (res.mode === "built" && state.log) {
     console.error(`[ShellFix][CodeMap] ${info.at} repo=${res.repo} mode=built ...`);
   }
   ```
2. 插件运行在 opencode 的服务进程里，**没有日志 API**（`@opencode-ai/plugin` 的 `PluginInput` 只有 `client/project/directory/worktree/serverUrl/$`，无 logger）。因此 `console.error` 直接写进程 **stderr**，与 TUI 共用同一终端 → 原始文本覆盖 TUI 渲染区，表现为输入框附近的红字乱码。
3. 取证：`%USERPROFILE%\.local\share\opencode\log\opencode.log`（46MB）中 `[ShellFix][CodeMap]` **0 命中** —— 插件 console 输出既没进 opencode 日志文件，也没走 toast，而是直写终端。
4. 触发频率：任何 .NET 仓库每次会话开始 / `dotnet build` 成功都会打一行（`state.log` 默认 ON），因此反复出现。

> 结论：v2.3.2 的 B 段只统一了「toast 通知」通道，**没有处理 `console.*` 这条第三条输出通道**。这是本次遗漏。

## 三、方案

### 3.1 新增 `src/lib/log-file.ts`（插件日志文件）

```ts
// 目标：插件所有诊断输出写文件，绝不写 stdout/stderr
export function logLine(tag: string, message: string): void
```

- 路径：`%USERPROFILE%\.local\share\opencode\log\shellfix.log`（与 opencode 自身日志同目录，便于一起排查；目录不存在则创建）
- 格式：`2026-11-08T07:02:34.347Z [tag] message`
- 截断：文件 > 5MB 时重写为最后 1MB（防无限增长）
- 永不抛异常：整个函数包 try/catch，失败静默（不得因日志把插件搞崩）
- 不做 `state.log` 判定，由调用方决定是否调用（保留既有「日志开关」语义）

### 3.2 替换全部 `console.*`（54 处）

| 文件 | 处数 | 处理 |
|------|------|------|
| `src/lib/codemap-indexer.ts` | 3 | `console.error` → `logLine("CodeMap", ...)`；`built` 行仍受 `state.log` 门控 |
| `src/shell-fix.ts` | 5 | → `logLine("core", ...)` |
| `src/shell-fix-tui.ts` | 46 | → `logLine("tui", ...)`（catch 里的红色 toast 保持不变，只是不再打终端） |

> 替换后插件运行期**零 stdout/stderr 输出**，TUI 输入框不再出现任何插件红字。

### 3.3 版本与部署

- `src/lib/state.ts`：`PLUGIN_VERSION = "2.3.3"`
- `package.json`：`2.3.3`
- `deploy.ps1`：`$libFiles` 追加 `"log-file.ts"`（**新增 lib 文件，必须同步**）
- 部署后校验：8 → 9 个文件哈希一致

### 3.4 文档

- `README.md`：⑥ 或新增小节说明「插件日志位置 `~/.local/share/opencode/log/shellfix.log`；TUI 不再显示插件红字」
- `docs/03-安装与使用.md`：FAQ 新增「输入框出现红字怎么办」→ 说明 v2.3.3 已修复 + 日志文件路径
- `CHANGELOG.md`：v2.3.3 条目（修复：插件 console 输出污染 TUI）

---

## 四、测试矩阵

| # | 用例 | 预期 |
|---|------|------|
| 1 | .NET 仓库（FlowCenter）开新会话 | 输入框区域**无任何红字**；`shellfix.log` 出现一行 `mode=built` |
| 2 | `dotnet build` 成功 | 同上，无终端输出 |
| 3 | 非 .NET 仓库开会话 | 无输出、无日志行（零开销） |
| 4 | `log` 开关 OFF 后开会话 | 无日志行（`built` 行受门控） |
| 5 | 人为触发异常（如模板保存只读目录） | 红色 toast 正常弹出；`shellfix.log` 有 `tui` 行；输入框无红字 |
| 6 | 日志文件 > 5MB | 自动截断为 ~1MB，不报错 |
| 7 | 日志目录不可写 | 静默跳过，插件功能不受影响 |
| 8 | 重启后 `PLUGIN_VERSION` | `2.3.3` |

---

## 五、风险

| 项 | 说明 |
|----|------|
| 排查习惯变化 | 原来 `console.error` 直接可见（虽然污染 TUI），现在需看 `shellfix.log`；文档写明路径 |
| 遗漏 console 调用 | 替换后用 grep 校验 `console\.` 在 `src/` 下 0 命中（`log-file.ts` 内部除外，且其内部也不用 console） |
| 日志文件增长 | 5MB 截断 + 只在 `state.log` ON 时写 info 行 |
| 部署遗漏 | `deploy.ps1` 必须加 `log-file.ts`，否则 TUI 插件 import 失败（已列入清单） |

---

## 六、实施顺序

1. 新增 `src/lib/log-file.ts`
2. 替换 54 处 console.*（3 文件）
3. 版本号 2.3.3 + `deploy.ps1` 追加 lib
4. 文档（README / docs03 / CHANGELOG）
5. LSP 零 error + `tsc --noEmit` + grep 校验 0 残留
6. 部署 + 实机验证测试矩阵
7. 写审核报告 → 用户确认 → commit / tag `V2.3.3` / push

---

## 七、待确认

1. 日志路径用 `~/.local/share/opencode/log/shellfix.log`（与 opencode 日志同目录）是否合适？也可改为 `~/.config/opencode/logs/shellfix.log`。
2. 5MB 截断阈值是否合适？
3. 是否同意按本方案实施 v2.3.3。
