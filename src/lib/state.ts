/**
 * ShellFix — 状态持久化管理
 *
 * 负责读写 ~/.config/opencode/shellfix-state.json
 * 保存所有功能和规则的开关状态，重启后恢复。
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

// ====================================================================
// 类型定义
// ====================================================================

export type CmdRuleName = "export" | "which" | "source" | "touch" | "rm" | "chmod";

export type AutoMode = "prompt" | "auto" | "silent";

export type ConditionPredicate =
  | "os"
  | "arch"
  | "branch"
  | "dirty"
  | "tool_exists"
  | "file_exists"
  | "is_git_repo"
  | "always"
  | "never";

export type AutoModuleName = "coding" | "windows" | "tech-stack" | "review" | "security" | "git" | "requirements";

export interface InjectCondition {
  predicate: ConditionPredicate;
  expected: string;
  enabled: boolean;
}

export interface CmdRules {
  export: boolean;
  which: boolean;
  source: boolean;
  touch: boolean;
  rm: boolean;
  chmod: boolean;
}

export interface AutoState {
  modules: Record<string, boolean>;
  mode: AutoMode;
  require: string;
  conditions: Record<string, InjectCondition[]>;
}

export interface SyncConfig {
  repoUrl: string;
  branch: string;
  autoSyncOnStart: boolean;
  lastSyncCommit: string;
  lastSyncAt: string;
}

export interface PluginState {
  version: string;
  encoding: boolean;
  log: boolean;
  cmdRules: CmdRules;
  auto: AutoState;
  sync: SyncConfig;
  kickme: KickmeRule[];
}

export interface KickmeRule {
  id: string;
  label: string;
  enabled: boolean;
  matchType: "keyword" | "regex";
  pattern: string;
  title: string;
  message: string;
  sound: boolean;
  scope: "user" | "llm" | "both";
}

/** 所有命令规则的元信息，供 ui 渲染 */
export interface CmdRuleMeta {
  name: CmdRuleName;
  label: string;
  description: string;
  defaultOn: boolean;
}

export const CMD_RULES_META: CmdRuleMeta[] = [
  { name: "export", label: "export→$env:", description: "export KEY=VAL → $env:KEY=\"VAL\"", defaultOn: true },
  { name: "which", label: "which→Get-Command", description: "which cmd → (Get-Command cmd).Source", defaultOn: false },
  { name: "source", label: "source→dot-source", description: "source file → . file (PowerShell dot sourcing)", defaultOn: false },
  { name: "touch", label: "touch→New-Item", description: "touch file → New-Item -ItemType File", defaultOn: false },
  { name: "rm", label: "rm→Remove-Item", description: "rm path → Remove-Item -Recurse -Force", defaultOn: false },
  { name: "chmod", label: "chmod→warn", description: "chmod → Write-Warning (安全忽略)", defaultOn: false },
];

// ====================================================================
// 默认值与路径
// ====================================================================

const STATE_DIR = join(homedir(), ".config", "opencode");
const STATE_PATH = join(STATE_DIR, "shellfix-state.json");

const DEFAULT_STATE: PluginState = {
  version: "1.6.0",
  encoding: true,
  log: true,
  cmdRules: {
    export: true,
    which: false,
    source: false,
    touch: false,
    rm: false,
    chmod: false,
  },
  auto: {
    modules: {
      coding: true,
      windows: true,
      "tech-stack": true,
      review: false,
      security: false,
      git: false,
    },
    mode: "prompt",
    require: "",
    conditions: {},
  },
  sync: {
    repoUrl: "",
    branch: "main",
    autoSyncOnStart: false,
    lastSyncCommit: "",
    lastSyncAt: "",
  },
  kickme: [],
};

// ====================================================================
// 内存缓存（避免高频 io）
// ====================================================================

let _cached: PluginState | null = null;

// ====================================================================
// 公开 API
// ====================================================================

/** 加载状态（先读缓存→再读文件→最后回退默认值） */
export function loadState(): PluginState {
  if (_cached) return { ..._cached };
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PluginState>;
      // 与默认值合并，避免新增字段缺失
      _cached = deepMerge(DEFAULT_STATE, parsed);
      return { ..._cached };
    }
  } catch {
    // state 文件损坏 / 不可读 → 回退默认
  }
  _cached = { ...DEFAULT_STATE };
  return { ..._cached };
}

/** 持久化状态到文件 */
export function saveState(state: PluginState): void {
  _cached = { ...state };
  try {
    if (!existsSync(STATE_DIR,)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // 写失败静默忽略（不可写目录）
  }
}

// ====================================================================
// 便捷函数
// ====================================================================

/** 切换某条命令替换规则的开关，返回新状态 */
export function toggleCmdRule(rule: CmdRuleName): boolean {
  const s = loadState();
  s.cmdRules[rule] = !s.cmdRules[rule];
  saveState(s);
  return s.cmdRules[rule];
}

/** 显式设置命令规则 */
export function setCmdRule(rule: CmdRuleName, val: boolean): void {
  const s = loadState();
  s.cmdRules[rule] = val;
  saveState(s);
}

/** 切换编码注入 */
export function toggleEncoding(): boolean {
  const s = loadState();
  s.encoding = !s.encoding;
  saveState(s);
  return s.encoding;
}

/** 切换日志 */
export function toggleLog(): boolean {
  const s = loadState();
  s.log = !s.log;
  saveState(s);
  return s.log;
}

/** 设置自动化模块开关 */
export function setAutoModule(module: string, val: boolean): void {
  const s = loadState();
  s.auto.modules[module] = val;
  saveState(s);
}

/** 设置自动化模式 */
export function setAutoMode(mode: AutoMode): void {
  const s = loadState();
  s.auto.mode = mode;
  saveState(s);
}

/** 设置临时注入文本 */
export function setAutoRequire(text: string): void {
  const s = loadState();
  s.auto.require = text;
  saveState(s);
}

/** 获取模块的条件列表 */
export function getModuleConditions(module: string): InjectCondition[] {
  const s = loadState();
  return s.auto.conditions[module] || [];
}

/** 设置模块的条件列表 */
export function setModuleConditions(module: string, conditions: InjectCondition[]): void {
  const s = loadState();
  s.auto.conditions[module] = conditions;
  saveState(s);
}

/** 为模块添加一条条件 */
export function addModuleCondition(module: string, condition: InjectCondition): void {
  const s = loadState();
  if (!s.auto.conditions[module]) s.auto.conditions[module] = [];
  s.auto.conditions[module].push(condition);
  saveState(s);
}

/** 删除模块的第 N 条条件 */
export function removeModuleCondition(module: string, index: number): boolean {
  const s = loadState();
  if (!s.auto.conditions[module] || index < 0 || index >= s.auto.conditions[module].length) return false;
  s.auto.conditions[module].splice(index, 1);
  saveState(s);
  return true;
}

/** 开关模块的第 N 条条件 */
export function toggleModuleCondition(module: string, index: number): boolean | null {
  const s = loadState();
  if (!s.auto.conditions[module] || index < 0 || index >= s.auto.conditions[module].length) return null;
  const cond = s.auto.conditions[module][index];
  cond.enabled = !cond.enabled;
  saveState(s);
  return cond.enabled;
}

/** 清空模块的所有条件 */
export function clearModuleConditions(module: string): void {
  const s = loadState();
  delete s.auto.conditions[module];
  saveState(s);
}

/** 获取启用的自动化模块列表 */
export function getEnabledAutoModules(): string[] {
  const s = loadState();
  return Object.entries(s.auto.modules)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

/** 获取当前启用的命令规则列表 */
export function getEnabledRules(): CmdRuleName[] {
  const s = loadState();
  return (Object.keys(s.cmdRules) as CmdRuleName[]).filter(
    (k) => s.cmdRules[k],
  );
}

/** 获取同步配置 */
export function getSyncConfig(): SyncConfig {
  return { ...loadState().sync };
}

/** 设置同步配置 */
export function setSyncConfig(cfg: Partial<SyncConfig>): void {
  const s = loadState();
  s.sync = { ...s.sync, ...cfg };
  saveState(s);
}

// ====================================================================
// Kickme 规则管理
// ====================================================================

let _kickmeIdCounter = 0;

function _seedKickmeIdCounter(): void {
  const s = loadState();
  let max = 0;
  for (const r of s.kickme) {
    const m = r.id.match(/^km_(\d+)_/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  _kickmeIdCounter = max;
}

/** 获取所有 kickme 规则 */
export function getKickmeRules(): KickmeRule[] {
  return [...loadState().kickme];
}

/** 添加 kickme 规则 */
export function addKickmeRule(rule: Omit<KickmeRule, "id">): string {
  const s = loadState();
  if (_kickmeIdCounter === 0) _seedKickmeIdCounter();
  const id = `km_${++_kickmeIdCounter}_${Date.now()}`;
  s.kickme.push({ ...rule, id });
  saveState(s);
  return id;
}

/** 删除 kickme 规则 */
export function removeKickmeRule(id: string): boolean {
  const s = loadState();
  const idx = s.kickme.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  s.kickme.splice(idx, 1);
  saveState(s);
  return true;
}

/** 开关 kickme 规则 */
export function toggleKickmeRule(id: string): boolean | null {
  const s = loadState();
  const rule = s.kickme.find((r) => r.id === id);
  if (!rule) return null;
  rule.enabled = !rule.enabled;
  saveState(s);
  return rule.enabled;
}

/** 设置 kickme 规则提示音 */
export function setKickmeSound(id: string, on: boolean): boolean {
  const s = loadState();
  const rule = s.kickme.find((r) => r.id === id);
  if (!rule) return false;
  rule.sound = on;
  saveState(s);
  return true;
}

// ====================================================================
// 内部工具
// ====================================================================

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val !== undefined && val !== null) {
      if (typeof val === "object" && !Array.isArray(val) && typeof base[key] === "object") {
        result[key] = { ...(base[key] as any), ...(val as any) };
      } else {
        result[key] = val as T[keyof T];
      }
    }
  }
  return result;
}
