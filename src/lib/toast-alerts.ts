import { loadState, bumpAlertCount } from "./state";

/**
 * 调试提示（v2.3.1）：统一 toast + 计数通道。
 * 总开关 alertToasts 只控制 toast 是否弹出，计数始终累计（供排查）。
 */

const TOAST_THROTTLE_MS = 5 * 60 * 1000;

/** 进程内节流：同场景 5 分钟内最多弹 1 条 toast */
const lastToastAt = new Map<string, number>();

type ToastVariant = "info" | "success" | "warning" | "error";

/** 识别 captured 并返回解析结果（兼容 SDK 包装结构） */
function unwrap(res: unknown): any {
  return (res as any)?.data ?? res;
}

/** 通用提示入口：开关关闭 → 静默；计数始终 +1；同场景 5 分钟节流 */
export async function alertToast(
  client: unknown,
  key: string,
  title: string,
  message: string,
  variant: ToastVariant = "warning",
): Promise<void> {
  const count = bumpAlertCount(key);
  if (!loadState().alertToasts) return;

  const now = Date.now();
  const last = lastToastAt.get(key) ?? 0;
  if (now - last < TOAST_THROTTLE_MS) return;
  lastToastAt.set(key, now);

  try {
    const tui = (client as any)?.tui;
    await tui?.showToast?.({
      body: { title, message: `${message}（累计 ${count} 次）`, variant, duration: 10000 },
    });
  } catch {
    /* toast 失败静默 */
  }
}

// ====================================================================
// 场景 A：思考截断检测（仅提示 + 计数，不自愈——自愈在 v2.4）
// ====================================================================

const NATURAL_END = /[。！？!?；;：:\.…·）)\]】》"'`\n|]$/;
const REASONING_BROKEN_MIN = 1;

/** 进程内去重：同一消息只提示一次 */
const alertedMessages = new Set<string>();

function hasRealText(parts: any[]): boolean {
  return parts.some((p: any) => p?.type === "text" && p.text && !p.synthetic);
}

function hasReasoning(parts: any[]): string {
  const reasons = parts.filter((p: any) => p?.type === "reasoning" && p.text);
  return reasons.length ? String(reasons[reasons.length - 1].text).trimEnd() : "";
}

function hasContent(m: any): boolean {
  const ps = Array.isArray(m?.parts) ? m.parts : [];
  return ps.some(
    (p: any) => p && ((p.type === "reasoning" && p.text) || (p.type === "text" && p.text && !p.synthetic) || p.type === "tool"),
  );
}

function isMainSession(sess: any): boolean {
  return !sess?.parentID && !!sess?.id;
}

/** 会话空闲时检测末条 assistant 消息是否为「思考被截断」（无正文 + 思考断尾） */
export async function detectThinkTruncation(sessionID: string, client: unknown): Promise<void> {
  let list: any[] | null = null;
  try {
    const res = await (client as any)?.session?.messages?.({ path: { id: sessionID }, query: { limit: 20 } });
    const data = unwrap(res);
    list = Array.isArray(data) ? data : null;
  } catch {
    return;
  }
  if (!list || list.length === 0) return;

  const sess: any = await (async () => {
    try {
      return unwrap(await (client as any)?.session?.get?.({ path: { id: sessionID } }));
    } catch {
      return null;
    }
  })();
  if (sess && !isMainSession(sess)) return;

  let last: any = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.info?.role !== "assistant") continue;
    if (hasContent(m)) {
      last = m;
      break;
    }
  }
  if (!last) return;

  const id = last.info?.id;
  if (!id || alertedMessages.has(id)) return;
  const info = last.info;
  if (info.finish === "tool-calls") return;
  if (info.error?.name === "MessageAbortedError") return;

  const parts = Array.isArray(last.parts) ? last.parts : [];
  const reasoning = hasReasoning(parts);
  if (!reasoning || hasRealText(parts)) return;
  if (reasoning.length < REASONING_BROKEN_MIN) return;
  if (NATURAL_END.test(reasoning.slice(-1))) return;

  alertedMessages.add(id);
  const model = String(info.modelID || "?");
  await alertToast(client, "think-cut", "思考截断", `模型 ${model} 仅产出思考、正文被截断。若回复不完整可要求继续。`, "error");
}

// ====================================================================
// 场景 B：codemap 未建索引（工具错误检测）
// ====================================================================

const CODEMAP_NO_INDEX_RE = /repo_path is required|no repo has been indexed|Run index\.ensure_baseline/i;

/** tool.execute.after 中检测 codemap 系列工具输出是否命中「未建索引」 */
export function detectCodemapNoIndex(tool: string, output: string, client: unknown): void {
  if (!tool.startsWith("codemap_")) return;
  if (!output || typeof output !== "string") return;
  if (!CODEMAP_NO_INDEX_RE.test(output)) return;
  void alertToast(
    client,
    "codemap-no-index",
    "CodeMap 未建索引",
    "该仓库尚未建立索引。请执行 codemap_index_ensure_baseline(repo_path=<仓库根>)，或使用 /codemap-index 命令。",
  );
}