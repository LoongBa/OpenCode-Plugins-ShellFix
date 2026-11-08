/**
 * CodeMap MCP 客户端 — 常驻 stdio 会话（零依赖）
 *
 * 插件侧硬保证：不经过 opencode 的 MCP 管理器，直接 spawn codemap-mcp.exe。
 * 同一 repo 复用一个进程；空闲 5 分钟回收；超时按进程树杀。
 */

import { execFileSync, spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface McpResult {
  ok: boolean;
  data?: any;
  error?: string;
}

export const INIT_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;
export const ENSURE_TIMEOUT_MS = 180_000;

const IDLE_CLOSE_MS = 5 * 60_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

/** 进程级故障才重启（workspace not found 等业务错误不重启） */
const RECOVERABLE_RE = /spawn failed|exited code=|codemap-mcp exited|EPIPE|timeout \d+ms/i;
/** overlay.wal 被其他 CodeMap 进程占用（跨进程锁冲突） */
const LOCK_CONFLICT_RE = /overlay\.wal|being used by another process|EBUSY|IOException/i;
/** codemap 的 workspace 未创建错误 */
const WORKSPACE_NOT_FOUND_RE = /NOT FOUND[\s\S]*?Workspace '([^']+)' not found/i;

type Pending = {
  resolve: (r: McpResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function resolveCodemapExe(): string | null {
  const fromEnv = process.env.SHELLFIX_CODEMAP_MCP;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  if (process.platform === "win32") {
    const local = join(homedir(), ".dotnet", "tools", "codemap-mcp.exe");
    if (existsSync(local)) return local;
    try {
      const out = execFileSync("where", ["codemap-mcp"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return first && existsSync(first) ? first : null;
    } catch {
      return null;
    }
  }

  try {
    const out = execFileSync("which", ["codemap-mcp"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

const liveSessions = new Set<CodemapSession>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const s of liveSessions) s.close();
  });
}

function textOf(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** 规范化 codemap 错误文本：workspace 未创建给出可操作提示 */
function normalizeError(raw: string): string {
  const m = WORKSPACE_NOT_FOUND_RE.exec(raw);
  if (m) {
    return `工作区 "${m[1]}" 未创建（可能被其他 CodeMap 进程占用），稍后重试或执行 /codemap-index status`;
  }
  return raw;
}

export class CodemapSession {
  private child: ReturnType<typeof spawn> | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartUsed = false;
  private disposed = false;

  constructor(readonly repoPath: string) {
    liveSessions.add(this);
    installExitHook();
  }

  call(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<McpResult> {
    const run = () => this.invoke(name, args, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  /**
   * 带锁冲突退避重试的调用（仅供显式刷新等一次性路径使用）。
   * overlay.wal 被其他 CodeMap 进程占用时退避重试，避免一次性失败。
   */
  async callWithRetry(
    name: string,
    args: Record<string, unknown>,
    opts: { attempts?: number; backoffMs?: number[]; timeoutMs?: number } = {},
  ): Promise<McpResult> {
    const attempts = opts.attempts ?? 3;
    const backoff = opts.backoffMs ?? [300, 1200, 3000];
    let res: McpResult = { ok: false, error: "not attempted" };
    for (let i = 0; i < attempts; i++) {
      res = await this.call(name, args, opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
      if (res.ok) return res;
      if (!LOCK_CONFLICT_RE.test(res.error ?? "")) return res;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, backoff[Math.min(i, backoff.length - 1)]));
      }
    }
    return res;
  }

  close(): void {
    this.disposed = true;
    liveSessions.delete(this);
    this.hardKill();
  }

  private async invoke(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpResult> {
    if (this.disposed) return { ok: false, error: "session disposed" };

    const exe = resolveCodemapExe();
    if (!exe) return { ok: false, error: "codemap-mcp not found" };

    if (!this.child) {
      const started = await this.start(exe);
      if (!started.ok) return started;
    }

    this.touchIdle();
    const res = await this.sendCall(name, args, timeoutMs);
    if (res.ok) {
      this.restartUsed = false;
      return res;
    }

    const recoverable = RECOVERABLE_RE.test(res.error ?? "");
    if (!recoverable || this.restartUsed) return res;

    this.restartUsed = true;
    this.hardKill();
    const restarted = await this.start(exe);
    if (!restarted.ok) return res;
    this.touchIdle();
    const retry = await this.sendCall(name, args, timeoutMs);
    if (retry.ok) this.restartUsed = false;
    return retry;
  }

  private start(exe: string): Promise<McpResult> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: McpResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      try {
        const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.child = child;
        this.buf = "";

        child.stdout?.setEncoding?.("utf-8");
        child.stdout?.on("data", (chunk: string) => this.onData(chunk));
        child.stderr?.on("data", () => {});
        child.on("error", (e: Error) => {
          this.onExit();
          done({ ok: false, error: `spawn failed: ${e.message}` });
        });
        child.on("exit", (code: number | null, signal: string | null) => {
          this.onExit();
          done({ ok: false, error: `exited code=${code} signal=${signal}` });
        });

        this.request(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "shellfix", version: "2.3.0" },
          },
          INIT_TIMEOUT_MS,
        ).then((r) => {
          if (!r.ok) {
            this.hardKill();
            done(r);
            return;
          }
          this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
          setImmediate(() => done({ ok: true }));
        });
      } catch (e: any) {
        done({ ok: false, error: e?.message ?? String(e) });
      }
    });
  }

  private sendCall(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpResult> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs).then((r) => {
      if (!r.ok) return r;
      const result = r.data;
      if (result?.isError === true) {
        return { ok: false, error: normalizeError(textOf(result) || "tool error") };
      }
      const text = textOf(result);
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* 非 JSON 文本原样返回 */
      }
      return { ok: true, data };
    });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<McpResult> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.hardKill();
        resolve({ ok: false, error: `timeout ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(payload: unknown): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* 进程已退出，由 pending/exit 处理 */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.buf.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.id == null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.resolve({ ok: false, error: msg.error?.message ?? JSON.stringify(msg.error) });
      return;
    }
    p.resolve({ ok: true, data: msg.result });
  }

  private onExit(): void {
    if (this.buf.trim()) {
      const rest = this.buf.trim();
      this.buf = "";
      this.onLine(rest);
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: "codemap-mcp exited" });
    }
    this.pending.clear();
    this.child = null;
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.hardKill(), IDLE_CLOSE_MS);
    (this.idleTimer as any)?.unref?.();
  }

  private hardKill(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    const pid = child?.pid;
    this.child = null;
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 5000,
        });
      } else {
        child?.kill("SIGKILL");
      }
    } catch {
      try {
        child?.kill();
      } catch {
        /* 进程已不存在 */
      }
    }
  }
}

export async function callToolOnce(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<McpResult> {
  const session = new CodemapSession("");
  try {
    return await session.call(name, args, timeoutMs);
  } finally {
    session.close();
  }
}
