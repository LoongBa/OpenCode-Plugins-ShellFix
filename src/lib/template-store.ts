/**
 * ShellFix — 模板/笔记存储引擎
 *
 * 管理 ~/.config/opencode/templates/ 下的：
 *   index.json       — 用户模板 + 笔记索引
 *   remote/          — 远程 Git 仓库同步的模板
 *
 * 优先级顺序（高 → 低）：
 *   1. 用户自定义（/my save）
 *   2. 远程同步（remote/）
 *   3. 内置模板（BUILTIN_TEMPLATES）
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "fs";
import { execSync } from "child_process";

// ====================================================================
// 类型定义
// ====================================================================

/** 内置变量替换函数 */
export type EnvVarResolver = (name: string) => string;

export interface TemplateEntry {
  /** 模板名（如 "ys"） */
  name: string;
  /** 模板文本，支持 {0} {1} {branch} {date} 等变量 */
  template: string;
  /** 简短描述 */
  description?: string;
  /** 是否为内置（只读） */
  builtin?: boolean;
}

export interface NoteEntry {
  /** 标签路径（如 "架构/存储层"） */
  tag: string;
  /** 笔记内容 */
  content: string;
  /** 创建时间 ISO */
  created: string;
}

interface TemplateIndex {
  templates: Record<string, TemplateEntry>;
  notes: Record<string, NoteEntry>;
}

// ====================================================================
// 内置模板（开箱即用）
// ====================================================================

const BUILTIN_TEMPLATES: Record<string, TemplateEntry> = {
  ys: {
    name: "ys",
    template: "请验收版本 {0}，检查：\n1. 功能完整性\n2. 回归测试\n3. 文档是否同步更新",
    description: "验收版本",
    builtin: true,
  },
  review: {
    name: "review",
    template: "请 review {branch} 分支的 {0} 模块改动，重点关注：\n1. 逻辑正确性\n2. 边界条件\n3. 性能影响\n4. 安全风险",
    description: "代码审查",
    builtin: true,
  },
  pr: {
    name: "pr",
    template: "## PR: {0}\n\n### 改动说明\n\n### 影响范围\n\n### 测试情况\n\n### 需注意",
    description: "创建 PR",
    builtin: true,
  },
  bug: {
    name: "bug",
    template: "## Bug 报告\n\n**复现步骤：**\n1. {0}\n\n**预期行为：**\n\n**实际行为：**\n\n**环境：**\n- OS: Windows\n- 版本: {1}",
    description: "报告 Bug",
    builtin: true,
  },
  commit: {
    name: "commit",
    template: "{0}({1}): {2}",
    description: "Commit Message (type(scope): subject)",
    builtin: true,
  },
  explain: {
    name: "explain",
    template: "请用通俗语言解释以下 {0} 代码的工作原理：\n\n```\n{1}\n```",
    description: "解释代码",
    builtin: true,
  },
  deploy: {
    name: "deploy",
    template: "请部署版本 {0} 到 {1} 环境，执行：\n1. 拉取最新代码\n2. 构建\n3. 运行迁移\n4. 重启服务",
    description: "部署流程",
    builtin: true,
  },
};

// ====================================================================
// 路径
// ====================================================================

const TEMPLATE_DIR = join(homedir(), ".config", "opencode", "templates");
const INDEX_PATH = join(TEMPLATE_DIR, "index.json");

// ====================================================================
// 内部缓存
// ====================================================================

let _cache: TemplateIndex | null = null;

// ====================================================================
// 文件 IO
// ====================================================================

function ensureDir(): void {
  if (!existsSync(TEMPLATE_DIR)) {
    mkdirSync(TEMPLATE_DIR, { recursive: true });
  }
}

function loadIndex(): TemplateIndex {
  if (_cache) return _cache;
  const userData: Partial<TemplateIndex> = {};
  try {
    if (existsSync(INDEX_PATH)) {
      const raw = readFileSync(INDEX_PATH, "utf-8");
      Object.assign(userData, JSON.parse(raw));
    }
  } catch { /* ignore */ }
  _cache = {
    templates: { ...BUILTIN_TEMPLATES, ...(userData.templates || {}) },
    notes: userData.notes || {},
  };
  return _cache;
}

function saveIndex(idx: TemplateIndex): void {
  _cache = idx;
  ensureDir();
  // 只写用户数据（不含 builtin）
  const userPart: TemplateIndex = {
    templates: {},
    notes: idx.notes,
  };
  for (const [k, v] of Object.entries(idx.templates)) {
    if (!v.builtin) userPart.templates[k] = v;
  }
  try {
    writeFileSync(INDEX_PATH, JSON.stringify(userPart, null, 2), "utf-8");
  } catch { /* ignore */ }
}

// ====================================================================
// 模板变量解析
// ====================================================================

/** 获取常见环境变量值 */
export function resolveEnvVar(name: string, cwd?: string): string {
  switch (name) {
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "time":
      return new Date().toTimeString().slice(0, 5);
    case "datetime":
      return new Date().toISOString().slice(0, 16).replace("T", " ");
    case "user":
      return homedir().split(/[\\/]/).pop() || "user";
    case "branch":
      return resolveGitBranch(cwd);
    case "cwd":
      return cwd || process.cwd();
    case "project":
      return (cwd || process.cwd()).split(/[\\/]/).pop() || "project";
    default:
      return `{${name}}`; // 原样返回
  }
}

function resolveGitBranch(cwd?: string): string {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return branch || "unknown";
  } catch {
    return "unknown";
  }
}

/** 渲染模板：替换 {0} {1} 位置参数 + {branch} {date} 等环境变量 */
export function renderTemplate(
  template: string,
  args: string[],
  cwd?: string,
): string {
  // 第一步：转义 {{ → \x00LB 和 }} → \x00RB 保护原始花括号
  let result = template
    .replace(/\{\{/g, "\x00LB")
    .replace(/\}\}/g, "\x00RB");

  // 第二步：位置参数 {0} {1} ...
  for (let i = 0; i < args.length; i++) {
    result = result.replace(new RegExp(`\\{${i}\\}`, "g"), args[i]);
  }

  // 第三步：环境变量 {branch} {date} {project} ...
  result = result.replace(/\{(\w+)\}/g, (_m, name) => resolveEnvVar(name, cwd));

  // 第四步：恢复转义的花括号 {{ → {, }} → }
  result = result.replace(/\x00LB/g, "{").replace(/\x00RB/g, "}");

  return result;
}

// ====================================================================
// 模板 CRUD
// ====================================================================

/** 获取所有模板（含内置） */
export function listTemplates(): TemplateEntry[] {
  const idx = loadIndex();
  return Object.values(idx.templates);
}

/** 按名查找模板（精确匹配） */
export function getTemplate(name: string): TemplateEntry | undefined {
  const idx = loadIndex();
  return idx.templates[name];
}

/** 保存/覆盖用户模板 */
export function saveTemplate(entry: TemplateEntry): void {
  const idx = loadIndex();
  idx.templates[entry.name] = { ...entry, builtin: false };
  saveIndex(idx);
}

/** 删除用户模板（内置无法删除） */
export function removeTemplate(name: string): boolean {
  const idx = loadIndex();
  const existing = idx.templates[name];
  if (!existing) return false;
  if (existing.builtin) return false; // 内置只读
  delete idx.templates[name];
  saveIndex(idx);
  return true;
}

// ====================================================================
// 笔记 CRUD
// ====================================================================

/** 获取所有笔记 */
export function listNotes(): NoteEntry[] {
  const idx = loadIndex();
  return Object.values(idx.notes);
}

/** 按标签前缀查找笔记 */
export function queryNotes(prefix: string): NoteEntry[] {
  const idx = loadIndex();
  return Object.values(idx.notes).filter((n) => n.tag.startsWith(prefix));
}

/** 按精确标签获取笔记 */
export function getNote(tag: string): NoteEntry | undefined {
  const idx = loadIndex();
  return idx.notes[tag];
}

/** 保存笔记（同名覆盖） */
export function saveNote(tag: string, content: string): void {
  const idx = loadIndex();
  idx.notes[tag] = {
    tag,
    content,
    created: new Date().toISOString(),
  };
  saveIndex(idx);
}

/** 删除笔记 */
export function removeNote(tag: string): boolean {
  const idx = loadIndex();
  if (!idx.notes[tag]) return false;
  delete idx.notes[tag];
  saveIndex(idx);
  return true;
}

/** 列出所有标签树（顶层标签或子标签） */
export function listTagTree(parent?: string): string[] {
  const idx = loadIndex();
  const prefix = parent ? `${parent}/` : "";
  const tags = Object.keys(idx.notes).filter((t) => t.startsWith(prefix));

  // 去重返回下一级
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const rest = tag.slice(prefix.length);
    const slash = rest.indexOf("/");
    const child = slash >= 0 ? rest.slice(0, slash + 1) : rest;
    if (!seen.has(child)) {
      seen.add(child);
      result.push(child);
    }
  }
  return result.sort();
}

// ====================================================================
// 远程仓库同步
// ====================================================================

const REMOTE_DIR = join(TEMPLATE_DIR, "remote");

/** 远程模板加载结果 */
export interface SyncResult {
  success: boolean;
  message: string;
  added: number;
  updated: number;
  skipped: number;
  commit?: string;
}

/** 检查 remote/ 目录是否存在 */
export function remoteRepoExists(): boolean {
  return existsSync(REMOTE_DIR);
}

/** 获取远程模板数量（已合并到索引中的） */
export function getRemoteTemplates(): TemplateEntry[] {
  const idx = loadIndex();
  return Object.values(idx.templates).filter((t) => (t as any).remote);
}

/** 克隆远程仓库 */
export function cloneRemoteRepo(url: string, branch: string): SyncResult {
  try {
    ensureDir();
    if (existsSync(REMOTE_DIR)) {
      rmSync(REMOTE_DIR, { recursive: true, force: true });
    }
    execSync(
      `git clone --depth 1 --branch ${branch} "${url}" "${REMOTE_DIR}"`,
      { stdio: "pipe", timeout: 60000 },
    );
    const commit = execSync(
      `git -C "${REMOTE_DIR}" rev-parse --short HEAD`,
      { encoding: "utf-8", stdio: "pipe", timeout: 5000 },
    ).trim();
    const result = mergeRemoteTemplates();
    result.commit = commit;
    result.success = true;
    result.message = `远程仓库已克隆 (${commit})`;
    return result;
  } catch (e: any) {
    return {
      success: false,
      message: `克隆失败: ${e.message || e}`,
      added: 0, updated: 0, skipped: 0,
    };
  }
}

/** 拉取远程仓库更新 */
export function pullRemoteRepo(): SyncResult {
  try {
    if (!existsSync(REMOTE_DIR)) {
      return {
        success: false,
        message: "远程仓库目录不存在。请先 /my sync-config set repo_url <url> 然后 /my sync",
        added: 0, updated: 0, skipped: 0,
      };
    }
    execSync(
      `git -C "${REMOTE_DIR}" fetch origin --depth 1`,
      { stdio: "pipe", timeout: 60000 },
    );
    execSync(
      `git -C "${REMOTE_DIR}" reset --hard origin/HEAD`,
      { stdio: "pipe", timeout: 30000 },
    );
    const commit = execSync(
      `git -C "${REMOTE_DIR}" rev-parse --short HEAD`,
      { encoding: "utf-8", stdio: "pipe", timeout: 5000 },
    ).trim();
    const result = mergeRemoteTemplates();
    result.commit = commit;
    result.success = true;
    result.message = `远程仓库已更新 (${commit})`;
    return result;
  } catch (e: any) {
    return {
      success: false,
      message: `拉取失败: ${e.message || e}`,
      added: 0, updated: 0, skipped: 0,
    };
  }
}

/** 加载 remote/ 目录下的模板文件 */
function loadRemoteTemplateFiles(): TemplateEntry[] {
  if (!existsSync(REMOTE_DIR)) return [];

  try {
    const files = readdirSync(REMOTE_DIR).filter(
      (f: string) => f.endsWith(".json") && f !== "index.json",
    );
    const templates: TemplateEntry[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(REMOTE_DIR, file), "utf-8");
        const data = JSON.parse(raw);
        if (data.name && data.template) {
          templates.push({
            name: data.name,
            template: data.template,
            description: data.description || `远程模板 (${file})`,
            builtin: false,
            ...{ remote: true },
          } as TemplateEntry & { remote: boolean });
        }
      } catch {
        // 跳过格式错误的文件
      }
    }

    // 尝试读取 index.json 按列表顺序加载
    try {
      const indexRaw = readFileSync(join(REMOTE_DIR, "index.json"), "utf-8");
      const index = JSON.parse(indexRaw);
      if (Array.isArray(index)) {
        for (const entry of index) {
          if (!entry.name || !entry.file) continue;
          try {
            const fileRaw = readFileSync(join(REMOTE_DIR, entry.file), "utf-8");
            const data = JSON.parse(fileRaw);
            if (data.name && data.template) {
              // 避免重复
              const existing = templates.findIndex((t) => t.name === data.name);
              if (existing >= 0) templates.splice(existing, 1);
              templates.push({
                name: data.name,
                template: data.template,
                description: data.description || entry.description || `远程模板 (${entry.file})`,
                builtin: false,
                ...{ remote: true },
              } as TemplateEntry & { remote: boolean });
            }
          } catch { /* skip bad file */ }
        }
      }
    } catch { /* no index.json, use scanned files */ }

    return templates;
  } catch {
    return [];
  }
}

/** 合并远程模板到索引（优先级：用户 > 远程 > 内置） */
function mergeRemoteTemplates(): { added: number; updated: number; skipped: number } {
  const idx = loadIndex();
  const remoteTemplates = loadRemoteTemplateFiles();
  let added = 0, updated = 0, skipped = 0;

  for (const rt of remoteTemplates) {
    const existing = idx.templates[rt.name];
    if (!existing) {
      // 新增
      idx.templates[rt.name] = rt;
      added++;
    } else if (existing.builtin) {
      // 远程覆盖内置
      idx.templates[rt.name] = rt;
      updated++;
    } else {
      // 用户自定义 → 保留用户版本
      skipped++;
    }
  }

  saveIndex(idx);
  return { added, updated, skipped };
}

/** 统计各层级的模板数量 */
export function countTemplatesBySource(): { builtin: number; user: number; remote: number } {
  const idx = loadIndex();
  let builtin = 0, user = 0, remote = 0;
  for (const t of Object.values(idx.templates)) {
    if ((t as any).remote) remote++;
    else if (t.builtin) builtin++;
    else user++;
  }
  return { builtin, user, remote };
}

// ====================================================================
// 推送模板到远程仓库
// ====================================================================

export interface PushResult {
  success: boolean;
  message: string;
  pushed: number;
}

/**
 * 将用户模板推送到远程仓库
 * @param templateNames 要推送的模板名列表（空数组=全部）
 * @returns 推送结果
 */
export function pushTemplatesToRemote(templateNames: string[]): PushResult {
  try {
    // 1. 检查 remote/ 存在且为 Git 仓库
    if (!existsSync(REMOTE_DIR)) {
      return { success: false, message: "远程仓库目录不存在。请先 /my sync 克隆仓库。", pushed: 0 };
    }
    if (!existsSync(join(REMOTE_DIR, ".git"))) {
      return { success: false, message: "remote/ 不是 Git 仓库。请重新 /my sync。", pushed: 0 };
    }

    // 2. 先拉取最新
    try {
      execSync(
        `git -C "${REMOTE_DIR}" pull --rebase origin`,
        { stdio: "pipe", timeout: 30000 },
      );
    } catch {
      // pull 失败不阻塞推送
    }

    // 3. 收集要推送的模板
    const idx = loadIndex();
    const toPush = templateNames.length === 0
      ? Object.entries(idx.templates).filter(([, t]) => !t.builtin)
      : templateNames.map((name) => [name, idx.templates[name]] as const)
          .filter(([, t]) => t && !t.builtin);

    if (toPush.length === 0) {
      return { success: false, message: "没有用户自定义模板可推送。", pushed: 0 };
    }

    // 4. 写入远程目录
    let pushed = 0;
    for (const [name, entry] of toPush) {
      const filePath = join(REMOTE_DIR, `${name}.json`);
      const content = JSON.stringify({
        name,
        template: entry.template,
        description: entry.description || "",
        builtin: false,
        remote: true,
      }, null, 2);
      writeFileSync(filePath, content, "utf-8");
      pushed++;
    }

    // 5. git add + commit + push
    execSync(
      `git -C "${REMOTE_DIR}" add -A`,
      { stdio: "pipe", timeout: 10000 },
    );
    execSync(
      `git -C "${REMOTE_DIR}" commit -m "shellfix: sync ${pushed} template(s)"`,
      { stdio: "pipe", timeout: 10000 },
    );
    execSync(
      `git -C "${REMOTE_DIR}" push origin HEAD`,
      { stdio: "pipe", timeout: 60000 },
    );

    return {
      success: true,
      message: `成功推送 ${pushed} 个模板到远程仓库。`,
      pushed,
    };
  } catch (e: any) {
    const msg = e.message || String(e);
    // 区分常见错误
    if (msg.includes("Authentication failed") || msg.includes("auth")) {
      return { success: false, message: "⚠️ 推送失败: 认证失败 — 请检查 Git 凭据", pushed: 0 };
    }
    if (msg.includes("timeout") || msg.includes("Could not read")) {
      return { success: false, message: "⚠️ 推送失败: 网络超时 — 请检查网络连接", pushed: 0 };
    }
    return { success: false, message: `⚠️ 推送失败: ${msg}`, pushed: 0 };
  }
}
