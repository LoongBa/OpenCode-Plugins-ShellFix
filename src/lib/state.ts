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

export type CmdRuleName = "export" | "which" | "source" | "touch" | "rm" | "chmod" | "head" | "tail";

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
  head: boolean;
  tail: boolean;
}

/** @deprecated AutoState 已在 PluginState 中移除，由 autoRules/require/autoMode/moduleConditions 替代 */

/** 当前插件版本号（单一事实来源） */
export const PLUGIN_VERSION = "2.2.8";

export interface SyncConfig {
  repoUrl: string;
  branch: string;
  autoSyncOnStart: boolean;
  lastSyncCommit: string;
  lastSyncAt: string;
}

export interface PwshCheckState {
  pending: boolean;
  dismissed: "pending" | "dismissed" | "forever";
}

export interface PluginState {
  version: string;
  encoding: boolean;
  log: boolean;
  showVersion: boolean;
  cmdRules: CmdRules;
  sync: SyncConfig;
  kickme: KickmeRule[];
  dynamic: DynamicRule[];
  autoRules: AutoRuleV2[];
  autoMode: AutoMode;
  require: string;
  moduleConditions: Record<string, InjectCondition[]>;
  pendingDynamic: string[];
  gitLineEnding: "auto" | "config" | "off";
  cmdErrors: CmdErrorEntry[];
  pendingSafetyWarnings: SafetyWarnEntry[];
  safetyCooldowns: Record<string, number>;
  pwshCheck: PwshCheckState;
}

export interface CmdErrorEntry {
  cmd: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  notified: boolean;
}

export interface SafetyWarnEntry {
  pattern: string;  // 安全模式名称（rm-rf / sudo / chmod / curl-bash）
  message: string;  // 提醒文本
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

export interface DynamicRule {
  id: string;
  trigger: string;       // 触发关键词/正则
  enabled: boolean;
  matchType: "keyword" | "regex";
  context: string;       // 注入的上下文文本（上限 500 字符）
  cooldown: number;      // 冷却时间（秒），0 表示无冷却
  lastTriggered: number; // 上次触发时间戳（ms），0 表示从未触发
}

export interface AutoRuleV2 {
  id: string;
  trigger: "session_start" | "user_input";
  module: string;        // 关联的 AutoModule name
  conditions: string[];  // 条件表达式（未来扩展）
  enabled: boolean;
  priority: number;      // 注入顺序
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
  { name: "head", label: "head→Select-Object -First", description: "| head [-n] N → | Select-Object -First N (仅管道后)", defaultOn: true },
  { name: "tail", label: "tail→Select-Object -Last", description: "| tail [-n] N → | Select-Object -Last N (仅管道后，跳过 tail -f)", defaultOn: true },
];

/** 安全提醒模式元信息，供 palette 渲染 */
export interface SafetyPatternMeta {
  name: string;
  risk: string;    // "高" | "中" | "低"
  label: string;
  description: string;
}

export const SAFETY_PATTERNS_META: SafetyPatternMeta[] = [
  { name: "rm-rf",   risk: "高", label: "rm -rf",  description: "检测 rm -rf 命令，提醒确认路径" },
  { name: "sudo",    risk: "中", label: "sudo",     description: "Windows 无 sudo，提醒用管理员身份" },
  { name: "chmod",   risk: "低", label: "chmod",    description: "Windows 不需要 chmod，提醒忽略" },
  { name: "curl-bash", risk: "高", label: "curl|bash", description: "管道安装安全风险，提醒检查内容" },
];

// ====================================================================
// 默认值与路径
// ====================================================================

const STATE_DIR = join(homedir(), ".config", "opencode");
const STATE_PATH = join(STATE_DIR, "shellfix-state.json");

const DEFAULT_STATE: PluginState = {
  version: "2.0.0",
  encoding: true,
  log: true,
  showVersion: true,
  cmdRules: {
    export: true,
    which: false,
    source: false,
    touch: false,
    rm: false,
    chmod: false,
    head: true,
    tail: true,
  },
  autoMode: "prompt",
  require: "",
  moduleConditions: {},
  sync: {
    repoUrl: "",
    branch: "main",
    autoSyncOnStart: false,
    lastSyncCommit: "",
    lastSyncAt: "",
  },
  kickme: [],
  dynamic: [],
  autoRules: [],
  pendingDynamic: [],
  gitLineEnding: "auto",
  cmdErrors: [],
  pendingSafetyWarnings: [],
  safetyCooldowns: {},
  pwshCheck: { pending: false, dismissed: "pending" },
};

// ====================================================================
// 内存缓存（避免高频 io）
// ====================================================================

let _cached: PluginState | null = null;

// ====================================================================
// 公开 API
// ====================================================================

/** 迁移旧版 state 数据：auto → autoRules/require/autoMode/moduleConditions */
function migrateState(raw: Record<string, unknown>): void {
  if (raw.auto && typeof raw.auto === "object" && !raw.autoRules) {
    const old = raw.auto as Record<string, unknown>;
    // 迁移 modules → autoRules
    if (old.modules && typeof old.modules === "object") {
      const rules: AutoRuleV2[] = [];
      for (const [module, enabled] of Object.entries(old.modules as Record<string, boolean>)) {
        rules.push({
          id: `ar_migrate_${Date.now()}_${module}`,
          trigger: "session_start",
          module,
          conditions: [],
          enabled: !!enabled,
          priority: 50,
        });
      }
      raw.autoRules = rules;
    }
    // 迁移 mode
    if (old.mode && typeof old.mode === "string") {
      raw.autoMode = old.mode;
    }
    // 迁移 require
    if (old.require && typeof old.require === "string") {
      raw.require = old.require;
    }
    // 迁移 conditions
    if (old.conditions && typeof old.conditions === "object") {
      raw.moduleConditions = old.conditions;
    }
    // 删除旧字段
    delete raw.auto;
  }
}

/** 加载状态（先读缓存→再读文件→最后回退默认值） */
export function loadState(): PluginState {
  if (_cached) return { ..._cached };
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 自动迁移旧版数据
      migrateState(parsed);
      // 与默认值合并，避免新增字段缺失
      _cached = deepMerge(DEFAULT_STATE, parsed as Partial<PluginState>);
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
    const data = { ...state } as Record<string, unknown>;
    delete (data as any).auto; // 清理旧字段残留
    writeFileSync(STATE_PATH, JSON.stringify(data, null, 2), "utf-8");
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

/** 切换启动版本信息显示 */
export function toggleShowVersion(): boolean {
  const s = loadState();
  s.showVersion = !s.showVersion;
  saveState(s);
  return s.showVersion;
}

/** 设置自动化模块开关（重定向到 AutoRuleV2） */
export function setAutoModule(module: string, val: boolean): void {
  const s = loadState();
  const existing = s.autoRules.find((r) => r.module === module && r.trigger === "session_start");
  if (existing) {
    existing.enabled = val;
  } else {
    s.autoRules.push({
      id: `ar_sync_${Date.now()}`,
      trigger: "session_start",
      module,
      conditions: [],
      enabled: val,
      priority: 50,
    });
  }
  saveState(s);
}

/** 设置自动化模式 */
export function setAutoMode(mode: AutoMode): void {
  const s = loadState();
  s.autoMode = mode;
  saveState(s);
}

/** 设置临时注入文本 */
export function setAutoRequire(text: string): void {
  const s = loadState();
  s.require = text;
  saveState(s);
}

/** 获取模块的条件列表 */
export function getModuleConditions(module: string): InjectCondition[] {
  const s = loadState();
  return s.moduleConditions[module] || [];
}

/** 设置模块的条件列表 */
export function setModuleConditions(module: string, conditions: InjectCondition[]): void {
  const s = loadState();
  s.moduleConditions[module] = conditions;
  saveState(s);
}

/** 为模块添加一条条件 */
export function addModuleCondition(module: string, condition: InjectCondition): void {
  const s = loadState();
  if (!s.moduleConditions[module]) s.moduleConditions[module] = [];
  s.moduleConditions[module].push(condition);
  saveState(s);
}

/** 删除模块的第 N 条条件 */
export function removeModuleCondition(module: string, index: number): boolean {
  const s = loadState();
  if (!s.moduleConditions[module] || index < 0 || index >= s.moduleConditions[module].length) return false;
  s.moduleConditions[module].splice(index, 1);
  saveState(s);
  return true;
}

/** 开关模块的第 N 条条件 */
export function toggleModuleCondition(module: string, index: number): boolean | null {
  const s = loadState();
  if (!s.moduleConditions[module] || index < 0 || index >= s.moduleConditions[module].length) return null;
  const cond = s.moduleConditions[module][index];
  cond.enabled = !cond.enabled;
  saveState(s);
  return cond.enabled;
}

/** 清空模块的所有条件 */
export function clearModuleConditions(module: string): void {
  const s = loadState();
  delete s.moduleConditions[module];
  saveState(s);
}

/** 获取启用的自动化模块列表（基于 AutoRuleV2） */
export function getEnabledAutoModules(): string[] {
  const s = loadState();
  return s.autoRules
    .filter((r) => r.trigger === "session_start" && r.enabled)
    .map((r) => r.module);
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
// DynamicRule 动态上下文注入规则管理
// ====================================================================

let _dynamicIdCounter = 0;

function _seedDynamicIdCounter(): void {
  const s = loadState();
  let max = 0;
  for (const r of s.dynamic) {
    const m = r.id.match(/^dm_(\d+)_/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  _dynamicIdCounter = max;
}

/** 获取所有动态规则 */
export function getDynamicRules(): DynamicRule[] {
  return [...loadState().dynamic];
}

/** 添加动态规则 */
export function addDynamicRule(rule: Omit<DynamicRule, "id">): string {
  const s = loadState();
  if (_dynamicIdCounter === 0) _seedDynamicIdCounter();
  const id = `dm_${++_dynamicIdCounter}_${Date.now()}`;
  s.dynamic.push({ ...rule, id });
  saveState(s);
  return id;
}

/** 删除动态规则 */
export function removeDynamicRule(id: string): boolean {
  const s = loadState();
  const idx = s.dynamic.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  s.dynamic.splice(idx, 1);
  saveState(s);
  return true;
}

/** 开关动态规则 */
export function toggleDynamicRule(id: string): boolean | null {
  const s = loadState();
  const rule = s.dynamic.find((r) => r.id === id);
  if (!rule) return null;
  rule.enabled = !rule.enabled;
  saveState(s);
  return rule.enabled;
}

/** 设置动态规则冷却时间 */
export function setDynamicCooldown(id: string, seconds: number): boolean {
  const s = loadState();
  const rule = s.dynamic.find((r) => r.id === id);
  if (!rule) return false;
  rule.cooldown = Math.max(0, seconds);
  saveState(s);
  return true;
}

/** 标记规则已触发（更新 lastTriggered） */
export function markDynamicTriggered(id: string): void {
  const s = loadState();
  const rule = s.dynamic.find((r) => r.id === id);
  if (!rule) return;
  rule.lastTriggered = Date.now();
  saveState(s);
}

/** 检查规则是否在冷却中 */
export function isDynamicOnCooldown(rule: DynamicRule): boolean {
  if (rule.cooldown <= 0 || rule.lastTriggered <= 0) return false;
  return (Date.now() - rule.lastTriggered) < rule.cooldown * 1000;
}

// ====================================================================
// AutoRuleV2 CRUD
// ====================================================================

let _autoRuleIdCounter = 0;

function _seedAutoRuleIdCounter(): void {
  const s = loadState();
  let max = 0;
  for (const r of s.autoRules) {
    const m = r.id.match(/^ar_(\d+)_/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  _autoRuleIdCounter = max;
}

/** 获取所有 AutoRuleV2 */
export function getAutoRules(): AutoRuleV2[] {
  return [...loadState().autoRules];
}

/** 添加 AutoRuleV2 */
export function addAutoRule(rule: Omit<AutoRuleV2, "id">): string {
  const s = loadState();
  if (_autoRuleIdCounter === 0) _seedAutoRuleIdCounter();
  const id = `ar_${++_autoRuleIdCounter}_${Date.now()}`;
  s.autoRules.push({ ...rule, id });
  saveState(s);
  return id;
}

/** 删除 AutoRuleV2 */
export function removeAutoRule(id: string): boolean {
  const s = loadState();
  const idx = s.autoRules.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  s.autoRules.splice(idx, 1);
  saveState(s);
  return true;
}

/** 开关 AutoRuleV2 */
export function toggleAutoRule(id: string): boolean | null {
  const s = loadState();
  const rule = s.autoRules.find((r) => r.id === id);
  if (!rule) return null;
  rule.enabled = !rule.enabled;
  saveState(s);
  return rule.enabled;
}

/** 向后兼容：旧版 module toggle 同步到 AutoRuleV2 */
export function syncModuleToAutoRule(moduleName: string, enabled: boolean): void {
  const s = loadState();
  // 查找是否已有对应的 AutoRuleV2
  const existing = s.autoRules.find((r) => r.module === moduleName && r.trigger === "session_start");
  if (existing) {
    existing.enabled = enabled;
  } else {
    s.autoRules.push({
      id: `ar_sync_${Date.now()}`,
      trigger: "session_start",
      module: moduleName,
      conditions: [],
      enabled,
      priority: 50,
    });
  }
  saveState(s);
}

// ====================================================================
// CmdError 命令错误追踪
// ====================================================================

/** 记录一条命令执行失败的日志，去重计次 */
export function addCmdError(cmd: string): void {
  const s = loadState();
  const existing = s.cmdErrors.find((e) => e.cmd === cmd);
  const now = new Date().toISOString();
  if (existing) {
    existing.count++;
    existing.lastSeen = now;
  } else {
    s.cmdErrors.push({ cmd, count: 1, firstSeen: now, lastSeen: now, notified: false });
  }
  saveState(s);
}

/** 获取所有命令错误日志 */
export function getCmdErrors(): CmdErrorEntry[] {
  return [...loadState().cmdErrors];
}

/** 标记某条错误已通知用户 */
export function markCmdErrorNotified(cmd: string): void {
  const s = loadState();
  const entry = s.cmdErrors.find((e) => e.cmd === cmd);
  if (entry) { entry.notified = true; saveState(s); }
}

/** 清除所有命令错误日志 */
export function clearCmdErrors(): void {
  const s = loadState();
  s.cmdErrors = [];
  saveState(s);
}

// ====================================================================
// SafetyWarn 安全提醒
// ====================================================================

/** 安全提醒冷却时间（5 分钟） */
export const SAFETY_COOLDOWN_MS = 5 * 60 * 1000;

/** 添加一条待提醒的安全警告 */
export function addSafetyWarning(entry: SafetyWarnEntry): void {
  const s = loadState();
  // 避免重复：同 pattern 未消费时不应再添加
  if (s.pendingSafetyWarnings.some((w) => w.pattern === entry.pattern)) return;
  s.pendingSafetyWarnings.push(entry);
  saveState(s);
}

/** 获取所有待提醒的安全警告 */
export function getPendingSafetyWarnings(): SafetyWarnEntry[] {
  return [...loadState().pendingSafetyWarnings];
}

/** 清除所有待提醒的安全警告（消费后调用） */
export function clearPendingSafetyWarnings(): void {
  const s = loadState();
  s.pendingSafetyWarnings = [];
  saveState(s);
}

/** 检查某安全模式是否在冷却中 */
export function isSafetyOnCooldown(pattern: string): boolean {
  const s = loadState();
  const expiry = s.safetyCooldowns[pattern];
  if (!expiry) return false;
  if (Date.now() >= expiry) {
    // 冷却已过期，清理
    delete s.safetyCooldowns[pattern];
    saveState(s);
    return false;
  }
  return true;
}

/** 标记某安全模式冷却（从当前时间开始计时） */
export function markSafetyCooldown(pattern: string, cooldownMs: number = SAFETY_COOLDOWN_MS): void {
  const s = loadState();
  s.safetyCooldowns[pattern] = Date.now() + cooldownMs;
  saveState(s);
}

/** 清除所有安全提醒冷却 */
export function clearSafetyCooldowns(): void {
  const s = loadState();
  s.safetyCooldowns = {};
  saveState(s);
}

// ====================================================================
// PwshCheck 版本检测引导（v2.2.9）
// ====================================================================

/** 设置 pwsh 检测结果为已处理 */
export function setPwshCheckDismissed(mode: "dismissed" | "forever"): void {
  const s = loadState();
  s.pwshCheck.pending = false;
  s.pwshCheck.dismissed = mode;
  saveState(s);
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
