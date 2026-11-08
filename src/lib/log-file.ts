/**
 * ShellFix 插件日志文件通道。
 *
 * 背景：opencode 插件 API 没有 logger，`console.*` 会直写进程 stderr，
 * 与 TUI 共用终端时污染输入框区域（红字乱码）。因此插件运行期一律不写
 * stdout/stderr，诊断信息统一落到本文件。
 *
 * 位置：`~/.local/share/opencode/log/shellfix.log`（与 opencode 自身日志同目录）
 * 策略：>5MB 时保留最后 1MB；任何异常静默（日志不得影响插件功能）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;

function logPath(): string {
  return join(homedir(), ".local", "share", "opencode", "log", "shellfix.log");
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 追加一行日志；失败静默。tag 用于区分来源（core / tui / CodeMap）。 */
export function logLine(tag: string, ...args: unknown[]): void {
  try {
    const file = logPath();
    const dir = join(homedir(), ".local", "share", "opencode", "log");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      const buf = readFileSync(file);
      writeFileSync(file, buf.subarray(Math.max(0, buf.length - KEEP_BYTES)));
    }

    const message = args.map(stringify).join(" ");
    appendFileSync(file, `${new Date().toISOString()} [${tag}] ${message}\n`, "utf8");
  } catch {
    /* 静默：日志失败不影响插件 */
  }
}
