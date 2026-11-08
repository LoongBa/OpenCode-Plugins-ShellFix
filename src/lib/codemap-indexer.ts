/**
 * CodeMap 索引编排 — .NET 仓库检测、去重、ensure/cleanup
 *
 * 自动路径只维护 baseline 与磁盘清理；overlay/workspace 归 Agent 侧 codemap MCP
 * （避免两个进程同写 ~/.codemap/store/overlays/<ws>/overlay.wal）。
 * 失败静默 + 5 分钟节流日志，显式命令与状态面板负责可见性。
 */

import { execFileSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
  CodemapSession,
  ENSURE_TIMEOUT_MS,
  resolveCodemapExe,
  type McpResult,
} from "./codemap-mcp";
import { loadState, setCodemapLast, type CodemapRunInfo, type CodemapRunMode } from "./state";
import { logLine } from "./log-file";

const COOLDOWN_MS = 60_000;
const FAIL_LOG_THROTTLE_MS = 5 * 60_000;
const CLEANUP_THRESHOLD_BYTES = 1024 ** 3;
const CLEANUP_INTERVAL_MS = 24 * 3600_000;
const CLEANUP_MIN_FREED_BYTES = 100 * 1024 * 1024;
const DEFAULT_WORKSPACE_ID = "session";
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "bin",
  "obj",
  "artifacts",
  "packages",
  ".nuget",
  "testresults",
  ".vs",
]);

export interface RunResult {
  repo: string;
  mode: CodemapRunMode;
  elapsedMs: number;
  symbols: number;
  sha: string;
  workspaceId: string;
  error?: string;
}

export interface DotnetRepo {
  root: string;
  solutionPath?: string;
}

const sessions = new Map<string, CodemapSession>();
const runs = new Map<string, { inFlight: Promise<RunResult> | null; lastSha: string; lastAt: number }>();
const lastFailLogAt = new Map<string, number>();

export function repoKey(path: string): string {
  const abs = resolve(path);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function normalizeRepoRoot(dir: string): string {
  if (!dir) return dir;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out ? resolve(out) : resolve(dir);
  } catch {
    return resolve(dir);
  }
}

function findSolutionFile(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const slnx = names.filter((n) => /\.slnx$/i.test(n));
  if (slnx.length) return join(dir, slnx[0]);
  const sln = names.filter((n) => /\.sln$/i.test(n));
  if (sln.length) return join(dir, sln[0]);
  return undefined;
}

function hasProjectFile(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => /\.(csproj|vbproj|fsproj)$/i.test(n));
  } catch {
    return false;
  }
}

export function detectDotnetRepo(dir: string): DotnetRepo | null {
  const root = resolve(dir);
  const rootSolution = findSolutionFile(root);
  if (rootSolution) return { root, solutionPath: rootSolution };
  if (hasProjectFile(root)) return { root };

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (EXCLUDE_DIRS.has(name.toLowerCase())) continue;
    const sub = join(root, name);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const solution = findSolutionFile(sub);
    if (solution) return { root, solutionPath: solution };
    if (hasProjectFile(sub)) return { root };
  }
  return null;
}

function workspaceId(): string {
  const override = process.env.SHELLFIX_CODEMAP_WORKSPACE?.trim();
  return override || DEFAULT_WORKSPACE_ID;
}

function getSession(repo: string): CodemapSession {
  const key = repoKey(repo);
  let session = sessions.get(key);
  if (!session) {
    session = new CodemapSession(repo);
    sessions.set(key, session);
  }
  return session;
}

export function closeCodemapSession(repo: string): void {
  const key = repoKey(normalizeRepoRoot(repo));
  const session = sessions.get(key);
  if (session) {
    session.close();
    sessions.delete(key);
  }
}

export function closeAllCodemapSessions(): void {
  for (const [, session] of sessions) session.close();
  sessions.clear();
}

function recordRun(res: RunResult): void {
  const state = loadState();
  const prev = state.codemapLast;
  const failures = res.mode === "failed" ? (prev?.consecutiveFailures ?? 0) + 1 : 0;
  const info: CodemapRunInfo = {
    at: new Date().toISOString(),
    repo: res.repo,
    mode: res.mode,
    elapsedMs: res.elapsedMs,
    symbols: res.symbols,
    sha: res.sha,
    workspaceId: res.workspaceId,
    error: res.error,
    consecutiveFailures: failures,
    lastCleanupAt: prev?.lastCleanupAt,
  };
  setCodemapLast(info);
  if (res.mode === "built" && state.log) {
    logLine("CodeMap", 
      `[ShellFix][CodeMap] ${info.at} repo=${res.repo} mode=built elapsed=${res.elapsedMs}ms symbols=${res.symbols} sha=${res.sha.slice(0, 8)}`,
    );
  }
  if (res.mode === "failed" && state.log) {
    const key = repoKey(res.repo);
    const now = Date.now();
    if (now - (lastFailLogAt.get(key) ?? 0) >= FAIL_LOG_THROTTLE_MS) {
      lastFailLogAt.set(key, now);
      logLine("CodeMap", 
        `[ShellFix][CodeMap] ${info.at} repo=${res.repo} mode=failed failures=${failures} error=${res.error ?? "unknown"}`,
      );
    }
  }
}

export async function runEnsure(repoRoot: string, opts: { force?: boolean } = {}): Promise<RunResult> {
  const repo = resolve(repoRoot);
  const key = repoKey(repo);
  const wsId = workspaceId();
  const entry = runs.get(key) ?? { inFlight: null, lastSha: "", lastAt: 0 };
  runs.set(key, entry);

  if (entry.inFlight) return entry.inFlight;

  if (!opts.force) {
    const last = loadState().codemapLast;
    if (
      last &&
      last.mode === "built" &&
      last.sha &&
      repoKey(last.repo) === key &&
      Date.now() - Date.parse(last.at) < COOLDOWN_MS
    ) {
      return { repo, mode: "cached", elapsedMs: 0, symbols: last.symbols, sha: last.sha, workspaceId: wsId };
    }
    if (entry.lastSha && Date.now() - entry.lastAt < COOLDOWN_MS) {
      return { repo, mode: "cached", elapsedMs: 0, symbols: 0, sha: entry.lastSha, workspaceId: wsId };
    }
  }

  const task = (async (): Promise<RunResult> => {
    const started = Date.now();
    const session = getSession(repo);
    const r = await session.call("index.ensure_baseline", { repo_path: repo }, ENSURE_TIMEOUT_MS);
    const elapsedMs = Date.now() - started;
    if (!r.ok) {
      return { repo, mode: "failed", elapsedMs, symbols: 0, sha: "", workspaceId: wsId, error: r.error };
    }
    const data = r.data ?? {};
    const sha = typeof data.commit_sha === "string" ? data.commit_sha : "";
    const symbols = Number(data.stats?.symbol_count ?? 0) || 0;
    return { repo, mode: "built", elapsedMs, symbols, sha, workspaceId: wsId };
  })();

  entry.inFlight = task;
  const res = await task;
  entry.inFlight = null;
  if (res.mode === "built") {
    entry.lastSha = res.sha;
    entry.lastAt = Date.now();
  }
  recordRun(res);
  return res;
}

export async function ensureWorkspace(repoRoot: string, wsId = workspaceId()): Promise<boolean> {
  const repo = resolve(repoRoot);
  const session = getSession(repo);
  const list = await session.call("workspace.list", { repo_path: repo });
  if (list.ok) {
    const workspaces = (list.data as any)?.workspaces;
    if (Array.isArray(workspaces)) {
      const found = workspaces.some((w: any) => (w?.workspace_id ?? w?.id) === wsId);
      if (found) return true;
    }
  }
  const created = await session.callWithRetry(
    "workspace.create",
    { repo_path: repo, workspace_id: wsId },
    { attempts: 2 },
  );
  return created.ok;
}

export async function refreshOverlayNow(repoRoot: string, files?: string[]): Promise<McpResult> {
  const repo = resolve(repoRoot);
  const session = getSession(repo);
  const args: Record<string, unknown> = { repo_path: repo, workspace_id: workspaceId() };
  if (files && files.length) args.file_paths = files.map((f) => f.replace(/\\/g, "/"));
  return session.callWithRetry("index.refresh_overlay", args, { attempts: 3 });
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(current, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else total += st.size;
      } catch {
        /* 跳过不可读项 */
      }
    }
  }
  return total;
}

function markCleanupChecked(repo: string): void {
  const state = loadState();
  const last = state.codemapLast;
  const info: CodemapRunInfo = last
    ? { ...last, lastCleanupAt: new Date().toISOString() }
    : {
        at: new Date().toISOString(),
        repo,
        mode: "skipped",
        elapsedMs: 0,
        symbols: 0,
        sha: "",
        workspaceId: workspaceId(),
        consecutiveFailures: 0,
        lastCleanupAt: new Date().toISOString(),
      };
  setCodemapLast(info);
}

export async function cleanupIfNeeded(repoRoot: string): Promise<void> {
  const state = loadState();
  const lastAt = state.codemapLast?.lastCleanupAt ? Date.parse(state.codemapLast.lastCleanupAt) : 0;
  if (lastAt && Date.now() - lastAt < CLEANUP_INTERVAL_MS) return;

  const repo = resolve(repoRoot);
  const total = dirSize(join(homedir(), ".codemap"));
  if (total < CLEANUP_THRESHOLD_BYTES) {
    markCleanupChecked(repo);
    return;
  }

  try {
    const session = getSession(repo);
    const baseArgs = { repo_path: repo, keep_count: 3, older_than_days: 14 };
    const dry = await session.call("index.cleanup", { ...baseArgs, dry_run: true }, 60_000);
    const freed = Number((dry.data as any)?.total_freed_bytes ?? (dry.data as any)?.freed_bytes ?? 0);
    if (dry.ok && freed >= CLEANUP_MIN_FREED_BYTES) {
      const real = await session.call("index.cleanup", { ...baseArgs, dry_run: false }, 120_000);
      if (loadState().log) {
        logLine("CodeMap", 
          `[ShellFix][CodeMap] cleanup ${real.ok ? "ok" : "failed"} freed≈${freed}B ${real.error ?? ""}`.trim(),
        );
      }
    }
  } catch {
    /* 静默 */
  }
  markCleanupChecked(repo);
}

export async function codemapStatusText(dir: string): Promise<string> {
  const root = normalizeRepoRoot(dir);
  const repo = detectDotnetRepo(root);
  if (!repo) return "CodeMap: 非 .NET 仓库，已跳过";
  if (!resolveCodemapExe()) return "CodeMap: codemap-mcp not found";

  const session = getSession(repo.root);
  const status = await session.call("repo.status", { repo_path: repo.root });
  if (!status.ok) return `CodeMap: status failed — ${status.error}`;

  const data = status.data ?? {};
  const baselines = await session.call("index.list_baselines", { repo_path: repo.root });
  const lines: string[] = [
    `repo      ${repo.root}`,
    `repo_id   ${data.repo_id ?? "?"}`,
    `sha       ${String(data.current_commit_sha ?? "").slice(0, 12)}`,
    `baseline  ${data.baseline_index_exists ? "yes" : "no"}`,
    `clean     ${data.is_clean ? "yes" : "no"}`,
    `workspace ${workspaceId()}`,
  ];
  const list = (baselines.data as any)?.baselines;
  if (baselines.ok && Array.isArray(list)) {
    lines.push(`baselines ${list.length}`);
    for (const b of list.slice(0, 3)) {
      lines.push(`  ${String(b.commit_sha ?? "").slice(0, 12)} ${Math.round(Number(b.size_bytes ?? 0) / 1024 / 1024)}MB`);
    }
  }
  const last = loadState().codemapLast;
  if (last) {
    lines.push(`last      ${last.mode} ${last.elapsedMs}ms ${last.symbols} symbols @ ${last.at}`);
  }
  return lines.join("\n");
}

export async function runCodemapCommand(args: string, dir: string): Promise<string> {
  const sub = args.trim().toLowerCase();
  const root = normalizeRepoRoot(dir);
  const repo = detectDotnetRepo(root);
  if (!repo) return "CodeMap: 非 .NET 仓库，已跳过";
  if (!resolveCodemapExe()) return "CodeMap: codemap-mcp not found";

  if (sub === "status") return codemapStatusText(dir);
  if (sub === "cleanup") {
    await cleanupIfNeeded(repo.root);
    return "CodeMap: cleanup 检查完成（详见日志）";
  }

  const res = await runEnsure(repo.root, { force: true });
  if (res.mode === "failed") return `CodeMap: failed — ${res.error ?? "unknown"}`;

  const wsOk = await ensureWorkspace(repo.root);
  const refresh = await refreshOverlayNow(repo.root);

  const seconds = Math.round(res.elapsedMs / 100) / 10;
  const lines = [
    `CodeMap: ${res.mode}, ${seconds}s, ${res.symbols} symbols, sha=${res.sha.slice(0, 8)}, ws=${res.workspaceId}`,
  ];
  if (!wsOk) lines.push("workspace: 创建失败（可能被其他 CodeMap 进程占用），可稍后重试");
  if (!refresh.ok) lines.push(`overlay: 刷新失败 — ${refresh.error ?? "unknown"}`);
  return lines.join("\n");
}

export function codemapOnSessionStart(dir: string): void {
  void (async () => {
    try {
      if (!loadState().codemapIndex) return;
      if (!resolveCodemapExe()) return;
      const root = normalizeRepoRoot(dir);
      const repo = detectDotnetRepo(root);
      if (!repo) return;
      const res = await runEnsure(repo.root);
      if (res.mode === "failed") return;
      await cleanupIfNeeded(repo.root);
    } catch {
      /* 静默 */
    }
  })();
}

export function codemapOnBuildSuccess(cmd: string, outputText: string, exitCode: number | undefined, fallbackDir: string): void {
  try {
    if (!loadState().codemapIndex) return;
    if (!/\bdotnet\s+(build|msbuild)\b/i.test(cmd)) return;
    if (!resolveCodemapExe()) return;

    const textOk =
      /Build succeeded|生成成功|0 (?:Error|个错误)/i.test(outputText) &&
      !/Build FAILED|生成失败|error (?:CS|MSB|NETSDK)\d+/i.test(outputText);
    if (!(exitCode === 0 || textOk)) return;

    const root = normalizeRepoRoot(fallbackDir);
    const repo = detectDotnetRepo(root);
    if (!repo) return;

    void (async () => {
      try {
        const res = await runEnsure(repo.root);
        if (res.mode === "failed") return;
        await cleanupIfNeeded(repo.root);
      } catch {
        /* 静默 */
      }
    })();
  } catch {
    /* 静默 */
  }
}

export function consumeCodemapFailureNotice(): string | null {
  const state = loadState();
  const last = state.codemapLast;
  if (!last || last.mode !== "failed" || last.consecutiveFailures < 3) return null;
  setCodemapLast({ ...last, consecutiveFailures: 0 });
  return `[ShellFix][CodeMap] 索引已连续 ${last.consecutiveFailures} 次失败（最近错误：${last.error ?? "unknown"}）。执行 /codemap-index status 诊断。`;
}
