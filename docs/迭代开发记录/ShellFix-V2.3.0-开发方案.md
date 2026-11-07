# v2.3.0 开发方案 — CodeMap 索引自动化注入

> 状态：📝 方案待审（**v2 修订版**：已按 oracle-pro 评审意见修订）
> 版本：v2.3.0（新功能，minor bump）

---

## 〇、v2 修订说明（评审驱动）

oracle-pro 评审结论「Approve with conditions」，指出 5 项必改。本版已全部吸收：

| 评审项 | 问题 | 本版处理 |
|--------|------|----------|
| C1 | `event` 钩子无 `worktree/directory` 字段，repo 路径应取 `event.properties.info.directory` | §2.4 已改；闭包捕获兜底 |
| C2 | `.cs` 编辑用 `tool.execute.after` 是错的（早退拦截），应用 `event → file.edited` | §2.4 已改 |
| C3 | build 成功分支放在现有 `failedCmd` return 之后 → 不可达 | §2.4 明确置于守卫之前 |
| C4 | `config` 钩子自注册命令是否被 opencode 拾取未验证 | §2.6 改为「先 spike 验证 + 手动配置兜底」 |
| B1 | 一次性进程在高频 `.cs` 编辑下代价被低估（实际 ~270ms/次） | §2.2 改为**常驻客户端**（按 repo 懒启动、空闲 5min 回收） |
| B2 | 「CodeMap 支持多客户端并发写」未验证 | §7 增加**破坏性测试前置项** |
| F1 | 「失败全静默」会掩盖持久故障 | §2.7 增加连续失败 ≥3 一次性提醒 |
| A1/A2/A3/A4 | MCP 客户端 exit 残留 buffer / 超时树杀 / 握手时序 | §2.2 逐条修复 |
| B3 | `workspace_id="session"` 多窗口冲突 | 保持需求默认值 + 环境变量覆盖 + 文档标注 |
| D1/D2/E1/E2/E3/F2/F3/G1 | 持久化冷却、repo 根归一化、多 csproj、大小写、排除目录、失败记录、cleanup 保守化、deepMerge null 守卫 | 均已并入 §2.3 / §2.7 / §3.1 |

---

## 一、背景与问题

### 1.1 现状：靠 Agent 自觉，非硬保证

CodeMap 是本地 MCP 语义索引服务（`codemap-mcp.exe`，Roslyn/.NET）。当前只在全局 instructions / agent prompt 里写"优先用 codemap"，是否真的建索引、刷新 overlay 完全取决于 Agent 自觉：

- 新仓库第一次会话：Agent 往往直接 `grep`，索引根本没建
- `dotnet build` 成功后：语义最完整的时刻，却没人触发 `ensure_baseline`
- 编辑 `.cs` 后：overlay 不刷新，`workspace_id` 查询看不到未提交修改
- 数据目录 `~/.codemap` 持续膨胀，没有清理时机

### 1.2 为什么不能"直接调 opencode 的 MCP 工具"

已查证 OpenCode 插件 SDK（`@opencode-ai/plugin` 的 `Hooks`）**没有**调用 MCP 工具的 API：`client.session` / `client.tui` 均无 `mcp.callTool`。插件能拿到的只有 `client`（HTTP SDK）、`$`（BunShell）、`directory` / `worktree`。

### 1.3 可行性实测（本机已跑通）

插件进程是 Bun/Node 环境，可**自带 MCP 客户端**，以 stdio 直接拉起 `codemap-mcp.exe`，不经过 opencode 的 MCP 管理器：

| 实测项 | 结果 |
|--------|------|
| `codemap-mcp.exe` | `C:\Users\coffe\.dotnet\tools\codemap-mcp.exe`（v2.6.2） |
| `initialize` 握手 | **159 ms** |
| `tools/list` | 28 个工具（`index.ensure_baseline` / `workspace.create/list` / `index.refresh_overlay` / `index.cleanup` / `repo.status` / `index.list_baselines`） |
| `repo.status` | **222 ms**（含进程启动），返回 `repo_id` / `current_commit_sha` / `is_clean` / `baseline_index_exists` / `workspaces` |
| 协议 | JSON-RPC 2.0，stdio 按行分隔 |
| 符号数来源 | `store/<repo_id>/baselines/<sha>/manifest.json` → `symbol_count`（实测 10962） |
| 当前 `~/.codemap` | 809 MB（阈值 1 GB） |

### 1.4 已核实的 SDK 事件结构（关键）

```typescript
// session.created —— repo 路径来源
type EventSessionCreated = { type: "session.created"; properties: { info: Session } };
type Session = { id: string; projectID: string; directory: string; ... };

// file.edited —— .cs 编辑的正确触发源
type EventFileEdited = { type: "file.edited"; properties: { file: string } };

// session.deleted —— 回收常驻客户端
type EventSessionDeleted = { type: "session.deleted"; properties: { info: Session } };
```

> `event` 钩子签名是 `(input: { event: Event })`，**没有** `directory`/`worktree` 字段。

---

## 二、方案设计

### 2.1 总体架构

```
opencode 进程
├─ shell-fix.ts（核心插件，已有）
│   ├─ event 钩子
│   │   ├─ session.created → ensure + workspace + cleanup
│   │   ├─ file.edited     → *.cs → refresh_overlay（防抖）
│   │   └─ session.deleted → 回收常驻客户端
│   ├─ tool.execute.after  → dotnet build 成功（置于现有守卫之前）
│   ├─ command.execute.before → /codemap-index
│   └─ config 钩子         → 尝试自注册 /codemap-index（spike 验证）
│
├─ lib/codemap-mcp.ts      ← 新增：MCP stdio 客户端（常驻会话 + 一次性兜底）
└─ lib/codemap-indexer.ts  ← 新增：编排（检测/归一化/去重/ensure/workspace/refresh/cleanup/日志/失败计数）
        │ spawn(stdio, JSON-RPC)
        ▼
   codemap-mcp.exe  →  ~/.codemap/store/<repo_id>/...
```

**不做的事**：不向 system prompt 注入 CodeMap 使用提示（硬保证替代软引导，零 token；仅连续失败 ≥3 时注入一次故障提醒）。

### 2.2 MCP 客户端（`src/lib/codemap-mcp.ts`）

```typescript
export function resolveCodemapExe(): string | null;   // env → ~/.dotnet/tools → PATH 探测

export class CodemapSession {                          // 常驻（按 repo 懒启动）
  constructor(repoPath: string);
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Result>;
  close(): void;                                       // 主动回收
}

export async function callToolOnce(name, args, timeoutMs?): Promise<Result>; // 兜底/诊断用
```

**关键实现要点（逐条对应评审）**

| 项 | 设计 |
|----|------|
| 进程模型 | **常驻会话**：首次 `call` 时 spawn，之后复用；空闲 5 min 自动 `close`；`session.deleted` 时 `close`；`call` 失败自动重启一次，二次失败降级为一次性模式 |
| 传输 | `spawn(exe, [], { stdio: ["pipe","pipe","pipe"], windowsHide: true })` |
| 编解码 | 按 `\n` 切行 + 行内 `JSON.parse`；**exit 前 flush 残留 buffer**（A1） |
| 请求路由 | `id → {resolve, timer}` Map；响应按 id 匹配，避免并发串包 |
| 握手 | `initialize` → 收到响应后发 `notifications/initialized` → `setImmediate` 后再发首个 `tools/call`（A4，不依赖时序巧合） |
| 超时 | initialize 15s；普通工具 20s；`index.ensure_baseline` 180s |
| 终止 | Windows 用 `taskkill /PID <pid> /T /F`（杀进程树，A3）；其他平台 `SIGKILL`；先尝试 `stdin.end()` 优雅关闭 |
| 残留 | `stderr` 丢弃（CodeMap 打 info 日志）；进程 `exit` 时把未决请求全部 reject |
| 失败 | 全部 `try/catch`，返回 `{ ok:false, error }`，绝不向钩子外层抛出 |
| 并发 | 同一 repo 单会话串行化调用（内部 promise 队列），避免同进程并发写同一 workspace |

> 为什么从一次性改为常驻：`refresh_overlay` 服务端 63ms，但一次性进程实际 ≈ 270ms/次（spawn+init+call），高频 `.cs` 编辑下 spawn 抖动明显，且反复打开 baseline 增加与 opencode 自带 codemap MCP 争用 store 的概率。常驻后 refresh 真实成本 ≈ 63ms。若实测常驻不稳定，降级为一次性 + 60s 冷却（接口不变）。

### 2.3 编排层（`src/lib/codemap-indexer.ts`）

| 函数 | 职责 |
|------|------|
| `normalizeRepoRoot(dir)` | `git rev-parse --show-toplevel`（cwd=dir）→ 失败回退 `dir`；Windows 下 Map key 统一小写 |
| `detectDotnetRepo(root)` | 根目录或**唯一一层子目录**存在 `.slnx/.sln/.csproj`（正则 `/i`，排除 `node_modules/.git/bin/obj/artifacts/packages/.nuget/TestResults`）→ 返回 `{ root, solutionPath? }`；否则 `null`。多 `.csproj` 无 `.sln` **也算** .NET 仓库，`solutionPath` 留空交给 codemap 自动发现 |
| `runEnsure(repoRoot, {force})` | 去重 → `repo.status` → `index.ensure_baseline`（180s）→ 读 `manifest.json` 取 `symbol_count` → 写 `codemapLast` |
| `ensureWorkspace(repoRoot, wsId)` | `workspace.list` 有则跳过，无则 `workspace.create`（`wsId` 默认 `"session"`，可被 `SHELLFIX_CODEMAP_WORKSPACE` 覆盖） |
| `refreshOverlay(repoRoot, wsId, files?)` | **5s 防抖** + 仅当 workspace 存在；一次批量传 `file_paths` |
| `cleanupIfNeeded(repoRoot)` | 总目录 > 1GB 且距上次 ≥24h：先 `dry_run:true` 估算；预计释放 >100MB 才 `dry_run:false`（`keep_count:3, older_than_days:14`，只传当前 repo） |
| `getStatus(repoRoot)` | `repo.status` + `index.list_baselines` 摘要（显式命令用） |
| `recordRun(info)` | 更新 `state.codemapLast`（含 `consecutiveFailures`） |

**去重（重启安全）**

```
内存 Map<repoKey, { inFlight, lastSha, lastAt }>
   ↓ 冷启动/插件重载后回退读
state.codemapLast = { repo, sha, at, mode, consecutiveFailures, ... }
```

- 自动触发：`inFlight` 存在 → 复用；`sha === lastSha && now-lastAt < 60s` → 跳过
- 持久化兜底：内存无记录但 `codemapLast` 同 repo 且 60s 内同 sha → 视为 cached，不 spawn
- 显式命令：`force=true`（忽略冷却，仍复用 inFlight）

### 2.4 触发时机（已按评审修正）

| # | 时机 | 钩子 | 动作 | 阻塞性 |
|---|------|------|------|--------|
| 1 | 会话开始 | `event` → `session.created` | repo = `event.properties.info.directory`（兜底：插件入口闭包捕获的 `directory`/`worktree`）→ `runEnsure` + `ensureWorkspace` + `cleanupIfNeeded` | 后台 fire-and-forget |
| 2 | 编译通过 | `tool.execute.after`（bash/pwsh） | **置于现有守卫之前**：命令匹配 `dotnet (build\|msbuild)` 且成功 → `runEnsure` + `refreshOverlay`；随后**继续**走原有错误检测流程（不 return） | 后台 |
| 3 | 编辑 .cs | `event` → `file.edited` | `event.properties.file` 以 `.cs` 结尾（`/\.cs$/i`）→ 归一化 repo 根 → `refreshOverlay`（5s 防抖，批量 file_paths） | 后台 |
| 4 | 会话删除 | `event` → `session.deleted` | 回收该 repo 的常驻客户端 | 同步轻量 |
| 5 | 显式命令 | `command.execute.before` → `codemap-index` | `runEnsure(force)` + `ensureWorkspace` + `refreshOverlay`，返回一行结果；`status` 子命令返回状态摘要 | 同步（用户主动等） |

**编译成功判定**（文本正则为主，metadata 为快捷路径）：

```typescript
const isBuild = /\bdotnet\s+(build|msbuild)\b/i.test(cmd);
const text = output.output || "";
const textOk = /Build succeeded|生成成功|0 (Error|个错误)/i.test(text)
            && !/Build FAILED|生成失败|error (CS|MSB|NETSDK)\d+/i.test(text);
const exitOk = output.metadata?.exitCode === 0;   // 有则优先（未验证字段，作 shortcut）
const success = exitOk || textOk;
```

**明确不触发**：`git commit` / `git push`；非 .NET 仓库；开关关闭；同仓库冷却期内；`ensure_baseline` 进行中（inFlight 复用）。

### 2.5 开关（默认开）

```typescript
codemapIndex: boolean;              // 默认 true —— 总开关
codemapLast: CodemapRunInfo | null; // 最近运行摘要（持久化，参与冷却 + 状态展示）
```

```typescript
interface CodemapRunInfo {
  at: string;                 // ISO 时间
  repo: string;
  mode: "built" | "cached" | "failed" | "skipped";
  elapsedMs: number;
  symbols: number;
  sha: string;
  workspaceId: string;
  error?: string;
  consecutiveFailures: number;
  lastCleanupAt?: string;
}
```

- 关闭时：所有钩子**零动作**（连 `repo.status` 都不调，不 spawn）
- 命令面：`/shellfix codemap on|off`（TUI palette `shellfix.codemap`）
- 手动执行：palette `shellfix.codemap-run` → 桥接 `executeCommand("/codemap-index")`；或直接 `/codemap-index`

### 2.6 `/codemap-index` 命令注册（spike 优先）

仓库既有约定：`/my`、`/auto` 在 `opencode.jsonc` 的 `command` 段静态注册，由 `command.execute.before` 拦截替换 parts。

本版策略：

1. **Step 0 spike（实现前必做）**：`config` 钩子注册 `/test-cmd` → 重启 opencode 验证是否出现在命令列表且被拦截。
2. spike 通过 → 保留插件自注册（用户零配置）。
3. spike 失败 → 降级为**文档引导手动注册**：
   ```jsonc
   "command": {
     "codemap-index": { "template": "|codemap-index $ARGUMENTS", "description": "CodeMap 索引维护（.NET 仓库）" }
   }
   ```
4. 无论哪种，TUI palette `shellfix.codemap-run` 走 `api.client.tui.executeCommand` 桥接；桥接失败时 toast 提示先注册命令。

`command.execute.before` 分支：

| 参数 | 行为 | 返回 |
|------|------|------|
| 无 | ensure(force) + workspace + refresh | `CodeMap: built, 13.2s, 10962 symbols` |
| `status` | repo.status + list_baselines 摘要 | 多行状态 |
| 非 .NET 仓库 | 跳过 | `CodeMap: 非 .NET 仓库，已跳过` |
| 失败 | 用户主动触发，不静默 | `CodeMap: failed — <error>` |

### 2.7 日志、静默与故障可见性

- **成功**：一行（`s.log` 开启时 `console.error`，进 opencode 日志）+ 写 `state.codemapLast`
  ```
  [ShellFix][CodeMap] 2026-11-07T16:30:00+08:00 repo=F:\...\_TKWF mode=built elapsed=13240ms symbols=10962 sha=117eee48
  ```
- **失败**：默认静默（不弹 toast、不注入、不污染工具输出）
- **连续失败保护（F1）**：`consecutiveFailures ≥ 3` 时，经 `experimental.chat.system.transform` 注入**一次**提醒（注入后清零，不重复打扰）：
  ```
  [ShellFix][CodeMap] 索引已连续 3 次失败（最近错误：...）。执行 /codemap-index status 诊断。
  ```
- **状态面板**：`codemap  ON  OK (10962 symbols, 12.3s)` / `FAILED x3` / `N/A (codemap-mcp not found)` / `OFF`
- **显式命令**：始终返回结果（唯一对用户可见的失败路径）

---

## 三、实现细节

### 3.1 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/lib/codemap-mcp.ts` | **新增**：常驻 MCP 会话 + 一次性调用兜底（~230 行，零依赖） |
| `src/lib/codemap-indexer.ts` | **新增**：repo 归一化 / .NET 检测 / 去重 / ensure / workspace / refresh / cleanup / 失败计数 / 日志（~280 行） |
| `src/lib/state.ts` | `codemapIndex`(默认 true) + `codemapLast` + `CodemapRunInfo` + `toggleCodemapIndex()` + `setCodemapLast()`；`deepMerge` 增加 null 守卫（G1）；`PLUGIN_VERSION → "2.3.0"` |
| `src/shell-fix.ts` | 新增 `event`（session.created / file.edited / session.deleted）、`config` 钩子；`tool.execute.after` 开头插入 build 检测（守卫之前）；`command.execute.before` 增加 `codemap-index`；`system.transform` 增加连续失败一次性提醒；插件入口闭包捕获 `directory`/`worktree` |
| `src/shell-fix-tui.ts` | palette `shellfix.codemap`（开关）+ `shellfix.codemap-run`（executeCommand 桥接）；状态面板 codemap 行 |
| `deploy.ps1` | `$libFiles` += `codemap-mcp.ts`、`codemap-indexer.ts` |
| `CHANGELOG.md` / `README.md` | v2.3.0 功能、开关、命令、手动注册兜底说明 |

### 3.2 核心代码骨架

**`codemap-mcp.ts`（关键片段）**

```typescript
import { spawn, execFileSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function resolveCodemapExe(): string | null {
  const env = process.env.SHELLFIX_CODEMAP_MCP;
  if (env && existsSync(env)) return env;
  if (process.platform === "win32") {
    const p = join(homedir(), ".dotnet", "tools", "codemap-mcp.exe");
    if (existsSync(p)) return p;
    try {
      const out = execFileSync("where", ["codemap-mcp"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
      if (out && existsSync(out)) return out;
    } catch { /* not found */ }
    return null;
  }
  try {
    return execFileSync("which", ["codemap-mcp"], { encoding: "utf8" }).trim() || null;
  } catch { return null; }
}

export class CodemapSession {
  private child: any = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, { resolve: (r: Result) => void; timer: any }>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: any = null;

  constructor(private repoPath: string) {}

  call(name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<Result> {
    const run = () => this.invoke(name, args, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private async invoke(name: string, args: any, timeoutMs: number): Promise<Result> {
    const exe = resolveCodemapExe();
    if (!exe) return { ok: false, error: "codemap-mcp not found" };
    if (!this.child) {
      const started = await this.start(exe);
      if (!started.ok) return started;
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.hardKill();                       // 树杀
        resolve({ ok: false, error: `timeout ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    });
  }

  private async start(exe: string): Promise<Result> { /* spawn + initialize + initialized */ }
  private send(o: any) { try { this.child.stdin.write(JSON.stringify(o) + "\n"); } catch {} }
  private onLine(line: string) {
    let msg: any; try { msg = JSON.parse(line); } catch { return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) return p.resolve({ ok: false, error: msg.error.message ?? "rpc error" });
    const text = msg.result?.content?.[0]?.text ?? "";
    let data: any = text;
    try { data = JSON.parse(text); } catch {}
    p.resolve({ ok: true, data });
  }
  private onExit() {
    // A1: flush 残留行
    if (this.buf.trim()) { this.onLine(this.buf); this.buf = ""; }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: "exited" }); }
    this.pending.clear();
    this.child = null;
  }
  private hardKill() {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    } catch { try { this.child?.kill(); } catch {} }
    this.child = null;
  }
  close() { this.hardKill(); }
}
```

**`codemap-indexer.ts`（关键片段）**

```typescript
const sessions = new Map<string, CodemapSession>();
const runState = new Map<string, { inFlight: Promise<RunResult> | null; lastSha: string; lastAt: number }>();
const COOLDOWN_MS = 60_000;
const REFRESH_DEBOUNCE_MS = 5_000;
const CLEANUP_THRESHOLD = 1024 ** 3;
const CLEANUP_INTERVAL_MS = 24 * 3600_000;

export function normalizeRepoRoot(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim() || dir;
  } catch { return dir; }
}

export async function runEnsure(repoRoot: string, opts: { force?: boolean } = {}): Promise<RunResult> {
  const key = repoKey(repoRoot);                    // Windows 小写
  const s = loadState();
  const ent = runState.get(key) ?? { inFlight: null, lastSha: "", lastAt: 0 };
  runState.set(key, ent);

  if (ent.inFlight) return ent.inFlight;
  const last = s.codemapLast;
  const persistedFresh = last && last.repo === repoRoot && last.sha &&
    Date.now() - Date.parse(last.at) < COOLDOWN_MS;
  if (!opts.force && (persistedFresh || (ent.lastSha && Date.now() - ent.lastAt < COOLDOWN_MS))) {
    return { mode: "cached", elapsedMs: 0, symbols: last?.symbols ?? 0, sha: last?.sha ?? ent.lastSha };
  }

  ent.inFlight = (async () => {
    const t0 = Date.now();
    const session = getSession(repoRoot);
    const r = await session.call("index.ensure_baseline", { repo_path: repoRoot }, 180_000);
    const elapsedMs = Date.now() - t0;
    if (!r.ok) return { mode: "failed" as const, elapsedMs, symbols: 0, sha: "", error: r.error };
    const st = await session.call("repo.status", { repo_path: repoRoot });
    const sha = st.ok ? (st.data?.current_commit_sha ?? "") : "";
    const symbols = st.ok ? readSymbolCount(st.data?.repo_id, sha) : 0;
    return { mode: "built" as const, elapsedMs, symbols, sha };
  })();

  const res = await ent.inFlight;
  ent.inFlight = null;
  if (res.mode === "built") { ent.lastSha = res.sha; ent.lastAt = Date.now(); }
  recordRun(repoRoot, res);      // 全 mode 记录 + consecutiveFailures
  return res;
}
```

**`shell-fix.ts` 钩子挂载**

```typescript
const capturedDir = input.directory;
const capturedWorktree = input.worktree;

event: async ({ event }) => {
  const s = loadState();
  if (!s.codemapIndex) return;
  try {
    if (event.type === "session.created") {
      const dir = (event as any).properties?.info?.directory || capturedWorktree || capturedDir;
      void codemapOnSessionStart(dir);
    } else if (event.type === "file.edited") {
      const file = (event as any).properties?.file || "";
      if (/\.cs$/i.test(file)) codemapOnCsEdited(file, capturedWorktree || capturedDir);
    } else if (event.type === "session.deleted") {
      const dir = (event as any).properties?.info?.directory;
      if (dir) closeSession(normalizeRepoRoot(dir));
    }
  } catch (e) { console.error("[ShellFix] codemap event error:", e); }
},

"tool.execute.after": async (input, output) => {
  try {
    // ── CodeMap build 检测（必须在现有守卫之前）──
    codemapOnToolAfter(input, output);
    // ── 现有命令错误检测逻辑（保持不变）──
    ...
  } catch ...
},
```

### 3.3 与现有代码的兼容性

- `event` / `config` 是新增钩子，不影响既有钩子
- `tool.execute.after` 的 build 检测插在 `try` 之后、`tool` 守卫之前，且不 return，现有错误检测流程完全不变
- `deepMerge` 增加 null 守卫属安全修复，不影响既有 state 迁移
- 零新增 npm 依赖

---

## 四、实现顺序（含前置 spike）

| 步骤 | 内容 | 通过标准 | 状态 |
|------|------|----------|------|
| **Step 0a** | `config` 钩子注册 `/test-cmd` spike | 重启后命令列表出现且被 `command.execute.before` 拦截 | ⏳ 待用户重启验证 |
| **Step 0b** | 并发破坏性测试：两个 codemap-mcp 进程对同一 repo 同时 `ensure_baseline` | 不产生半写/损坏 | ✅ 通过（见 §4.1） |
| **Step 0c** | 中途 kill 测试：`ensure_baseline` 中途树杀 | baseline 可恢复、无残留 | ✅ 通过（见 §4.1） |
| Step 1 | `codemap-mcp.ts` + `codemap-indexer.ts` | 单元级手动验证（Node 脚本直调） | ⏳ |
| Step 2 | `state.ts` + `shell-fix.ts` 钩子 | 会话/build/编辑触发均生效 | ⏳ |
| Step 3 | `shell-fix-tui.ts` + `deploy.ps1` | palette/开关/状态面板正常 | ⏳ |
| Step 4 | 测试矩阵 + 文档 | 14 用例通过、CHANGELOG/README 更新 | ⏳ |

### 4.1 Spike 实测结论（2026-11-07 已执行）

**0b 并发写 —— `F:\LoongBa_Git\_Tests\Wps2Markdown`（未索引仓库，404 symbols）**

- 两个独立进程同时 `ensure_baseline`：wall 4468 ms / 4365 ms，**双方均返回 `already_existed:false`**
  → 证实 **无跨进程互斥**，两个进程各自完整构建了一次（重复计算，非损坏）
- 终态检查：baselines 目录仅 1 个 sha 目录；`manifest.json` 1560 B、`symbol_count=404`、可正常解析；`repo.status.baseline_index_exists=true`；`symbols.search` 命中
- **结论**：并发**不产生损坏**（暂存构建 + 原子落位），但会重复消耗 CPU/IO
  → 插件进程内去重（inFlight + 冷却）必要且充分；多窗口场景仅浪费算力，不伤数据
  → 原「检测到 opencode 自带 codemap MCP 就禁用自动触发」的降级**不需要**，风险从「损坏」降为「重复计算」

**0c 中途树杀 —— `F:\LoongBa_Git\_TKWF`（HEAD 未索引，10962 symbols）**

- 12 s 时 `taskkill /PID <pid> /T /F`：子进程 exit code=1，MCP 调用立即返回 `exited code=1`（无挂死、无 pending 泄漏）
- 杀后立即检查 store：HEAD sha 目录**完全不存在** → 构建在暂存区完成后才落位，**无半写残留**
- 重跑：40.8 s 完成，`already_existed:false`，产出 12 个索引文件 + `manifest.json`（9614 B），`symbol_count=10962`、`reference_count=24482`、`file_count=1248`；`baseline_index_exists=true`；`symbols.search` 命中 18 条
- **结论**：kill 安全、重跑可完全恢复；`ensure_baseline` 超时设 **180 s 合理**（实测最大仓库 40.8 s，≈4x 余量）
  → 无需额外「baseline 完整性校验 + 手动重建」兜底；仅保留 `baseline_index_exists` 状态展示

**0a（待办）**：`config` 钩子注册命令需重启 opencode 才能验证，用户重启后确认；失败则走 §2.6 手动注册兜底。

---

## 五、测试验证

### 5.1 功能测试矩阵

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 非 .NET 仓库跳过 | 本仓库（TS）启动会话 | 不 spawn，无日志 |
| 2 | 会话开始（已索引） | 已索引 .NET 仓库新建会话 | `mode=cached`，<2s，日志一行 |
| 3 | 会话开始（未索引） | 未索引 .NET 仓库新建会话 | `mode=built`，含 symbols/sha |
| 4 | 编译成功触发 | `dotnet build` 成功 | 后台一次 ensure；60s 内再 build 不重复 |
| 5 | 编译失败不触发 | `dotnet build` 失败 | 无 ensure |
| 6 | .cs 编辑刷新 | 编辑保存 `.cs` | 5s 防抖后 refresh_overlay；CodeMap 查询可见改动 |
| 7 | 开关关闭 | `/shellfix codemap off` | 零 spawn |
| 8 | 显式命令 | `/codemap-index` / `status` | 返回结果/状态摘要 |
| 9 | exe 缺失 | `SHELLFIX_CODEMAP_MCP` 指向不存在 | 静默，状态面板 N/A |
| 10 | 并发去重 | session.created + build 同时 | 只 spawn 一次 |
| 11 | 重启冷却 | 索引后重启 opencode 再开会话 | 60s 内 `cached`，不重建 |
| 12 | 连续失败提醒 | 连续 3 次失败 | system.transform 注入一次提醒，状态面板 FAILED x3 |
| 13 | cleanup | 模拟 >1GB | dry_run 估算 → 超 100MB 才真删；24h 一次 |
| 14 | 多 csproj 无 sln | `src/A.csproj` + `tests/B.csproj` | 判定为 .NET 仓库，正常建索引 |

### 5.2 实测基线（本机已获得）

- `initialize` 159 ms；`repo.status` 222 ms；符号数来自 `manifest.json.symbol_count`（10962）；`~/.codemap` 809 MB

### 5.3 静态检查

`src/lib/codemap-mcp.ts`、`src/lib/codemap-indexer.ts`、`src/lib/state.ts`、`src/shell-fix.ts`、`src/shell-fix-tui.ts` 全部 LSP diagnostics **零 error**。

---

## 六、交付清单

- [x] Step 0a/0b/0c spike 结论记录（写入审核报告）
- [x] `src/lib/codemap-mcp.ts` — 常驻会话 + 一次性兜底 + 树杀 + buffer flush
- [x] `src/lib/codemap-indexer.ts` — 归一化/检测/去重/ensure/workspace/refresh/cleanup/失败计数
- [x] `src/lib/state.ts` — `codemapIndex` + `codemapLast` + `toggleCodemapIndex()` + deepMerge null 守卫 + 版本 2.3.0
- [x] `src/shell-fix.ts` — `event`（created/edited/deleted）+ `config` 钩子
- [x] `src/shell-fix.ts` — `tool.execute.after` build 检测（守卫之前、不 return）
- [x] `src/shell-fix.ts` — `command.execute.before` 的 `codemap-index` 分支
- [x] `src/shell-fix.ts` — `system.transform` 连续失败一次性提醒
- [x] `src/shell-fix-tui.ts` — palette 开关 + 手动执行桥接 + 状态面板
- [x] `deploy.ps1` — `$libFiles` 追加两个新 lib
- [ ] 测试：5.1 矩阵 14 用例（需重启 opencode 后按矩阵逐项执行；Step 0a 同批验证）
- [x] 文档：CHANGELOG + README + 开发方案 + 审核报告
- [x] 版本 bump 2.2.12 → 2.3.0

---

## 七、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 自建客户端与 opencode 自带 codemap MCP 并发写 store | 仅重复计算（已实测无损坏） | Step 0b 已验证：无半写/损坏；靠进程内 inFlight + 60s 冷却去重 |
| `config` 钩子注册命令不生效 | `/codemap-index` 不可用 | Step 0a spike；失败则文档手动注册 + palette 桥接兜底 |
| `ensure_baseline` 超时被树杀 | 已实测无残留 | Step 0c 已验证：暂存+原子落位，重跑完全恢复；超时 180s（实测 40.8s 上限） |
| codemap-mcp 未安装/版本旧 | 功能静默失效 | exe 探测 + 状态面板 N/A + 连续失败 3 次提醒 |
| 多窗口 workspace 冲突 | overlay 数据混乱 | 默认 `session`（需求）+ `SHELLFIX_CODEMAP_WORKSPACE` 覆盖 + 文档标注 |
| 频繁 .cs 编辑 | spawn 抖动 | 常驻会话 + 5s 防抖；开关可一键关闭 |
| `worktree`/`directory` 不一致 | 去重失效 | `normalizeRepoRoot`（git toplevel）统一 key |
| Bun 子进程兼容性 | spawn 异常 | 实测 Node 24 / Bun 1.4.4 同 API；失败静默不影响插件其余功能 |

---

## 附：与需求描述的对应关系

| 需求 | 落点 |
|------|------|
| 1a `ensure_baseline` 幂等/超时后台完成 | §2.2 超时 180s + §2.3 去重 + 实测 159/222ms |
| 1b `workspace.create(session)` | §2.3 `ensureWorkspace`（list 后 create） |
| 1c `.cs` 编辑后 `refresh_overlay` | §2.4 触发 #3（`file.edited` + 5s 防抖） |
| 1d 查询带 `workspace_id:"session"` | Agent 侧沿用；插件负责建/刷新，`status` 输出 workspaceId |
| 1e `cleanup` >1GB | §2.3 `cleanupIfNeeded`（dry_run 估算 → 保守实删） |
| 2 触发时机 | §2.4（build 成功 / 会话开始 / 显式命令） |
| 3 仅 .NET 仓库 | §2.3 `detectDotnetRepo`（含多 csproj 无 sln） |
| 4 不在 commit 后触发 / 并行去重 | §2.4 排除清单 + §2.3 内存 + 持久化双层去重 |
| 5 成功 log 一行 / 失败静默 | §2.7（含连续失败保护） |
| 提供开关，默认开 | §2.5 `codemapIndex: true` |
