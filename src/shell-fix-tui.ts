/**
 * ShellFix TUI Plugin — 本地调度器
 *
 * 所有命令优先在 TUI 侧本地处理（dispatch → local handler），
 * 零 LLM 成本。未匹配时回退到服务器端 executeCommand。
 *
 * 四个命令：
 *   /shellfix — 平台修复状态/开关
 *   /my       — 模板系统
 *   /note     — 笔记系统
 *   /auto     — 自动化系统
 */

// @ts-nocheck
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

// ====================================================================
// 导入 lib 模块（纯 TypeScript，零 OpenCode 依赖）
// ====================================================================

import {
  loadState,
  saveState,
  setCmdRule,
  setAutoModule,
  setAutoMode,
  setAutoRequire,
  getEnabledAutoModules,
  getModuleConditions,
  addModuleCondition,
  removeModuleCondition,
  toggleModuleCondition,
  clearModuleConditions,
  getSyncConfig,
  getKickmeRules,
  addKickmeRule,
  removeKickmeRule,
  toggleKickmeRule,
  setKickmeSound,
  CMD_RULES_META,
  type CmdRuleName,
  type AutoMode,
  type InjectCondition,
  type KickmeRule,
  getDynamicRules,
  addDynamicRule,
  removeDynamicRule,
  toggleDynamicRule,
  setDynamicCooldown,
  markDynamicTriggered,
  isDynamicOnCooldown,
  type DynamicRule,
  getAutoRules,
  addAutoRule,
  removeAutoRule,
  toggleAutoRule,
  type AutoRuleV2,
} from "./lib/state";

import {
  listTemplates,
  getTemplate,
  saveTemplate,
  renderTemplate,
  getNote,
  saveNote,
  removeNote,
  listNotesByTime,
  queryNotesByTime,
  listTagTree,
  countTemplatesBySource,
} from "./lib/template-store";

import {
  AUTO_MODULES,
  getAutoModule,
  getDefaultEnabledModules,
} from "./lib/auto-rules";

// ====================================================================
// 类型定义
// ====================================================================

type DispatchResult = {
  output?: string;  // → appendPrompt（填入输入框）
  toast?: string;   // → showToast（瞬时通知）
};

type LocalHandler = (args: string) => DispatchResult | null;
// null = 未处理，回退到服务器

// ====================================================================
// 常量
// ====================================================================

const PLUGIN_NAME = "ShellFix";
const PLUGIN_VERSION = "1.6.0";

// ====================================================================
// 进程级缓存（不持久化）
// ====================================================================

/** 上一条消息缓存（用户消息或 LLM 回复） */
let _lastMessage = "";

function setLastMessage(text: string): void {
  if (text) _lastMessage = text;
}

function getLastMessage(): string {
  return _lastMessage;
}

// ====================================================================
// 本地处理器注册表
// ====================================================================

const handlers = new Map<string, LocalHandler>();

// ── /shellfix ──────────────────────────────────────────────────────

handlers.set("shellfix", (args: string): DispatchResult | null => {
  if (!args) return { output: buildShellFixPanel() };

  const tokens = args.split(/\s+/);
  const sub = tokens[0].toLowerCase();

  switch (sub) {
    case "cmd":    return handleShellFixCmd(tokens.slice(1));
    case "encoding": return handleShellFixEncoding(tokens.slice(1));
    case "log":    return handleShellFixLog(tokens.slice(1));
    case "doctor": return { output: collectDoctorReport() };
    case "help":   return { output: buildShellFixHelp() };
    default:       return { output: `未知子命令: ${sub}\n\n${buildShellFixHelp()}` };
  }
});

function handleShellFixCmd(args: string[]): DispatchResult | null {
  const s = loadState();
  if (args.length === 0) {
    const lines = [`ShellFix — 命令替换规则\n`];
    for (const meta of CMD_RULES_META) {
      const state = s.cmdRules[meta.name] ? "ON" : "OFF";
      lines.push(`  ${state}  ${meta.label}`);
      lines.push(`       ${meta.description}\n`);
    }
    lines.push(`/shellfix cmd <规则名> on/off`);
    return { output: lines.join("\n") };
  }

  const ruleName = args[0] as CmdRuleName;
  const meta = CMD_RULES_META.find((m) => m.name === ruleName);
  if (!meta) return { toast: `未知规则: ${ruleName}` };

  if (args.length === 1) {
    return { output: `${meta.label}: ${s.cmdRules[ruleName] ? "ON" : "OFF"}\n${meta.description}` };
  }

  const action = args[1].toLowerCase();
  if (action === "on")  { setCmdRule(ruleName, true);  return { toast: `${meta.label}: ON` }; }
  if (action === "off") { setCmdRule(ruleName, false); return { toast: `${meta.label}: OFF` }; }
  return { toast: `用法: /shellfix cmd ${ruleName} on|off` };
}

function handleShellFixEncoding(args: string[]): DispatchResult | null {
  const s = loadState();
  if (args.length === 0) {
    return { output: `ShellFix — 编码注入\n状态: ${s.encoding ? "ON" : "OFF"}\n\n/shellfix encoding on|off` };
  }
  const action = args[0].toLowerCase();
  if (action === "on")  { const s2 = loadState(); s2.encoding = true;  saveState(s2); return { toast: "编码注入: ON" }; }
  if (action === "off") { const s2 = loadState(); s2.encoding = false; saveState(s2); return { toast: "编码注入: OFF" }; }
  return { toast: "用法: /shellfix encoding on|off" };
}

function handleShellFixLog(args: string[]): DispatchResult | null {
  const s = loadState();
  if (args.length === 0) {
    return { output: `ShellFix — 日志\n状态: ${s.log ? "ON" : "OFF"}\n\n/shellfix log on|off` };
  }
  const action = args[0].toLowerCase();
  if (action === "on")  { const s2 = loadState(); s2.log = true;  saveState(s2); return { toast: "日志: ON" }; }
  if (action === "off") { const s2 = loadState(); s2.log = false; saveState(s2); return { toast: "日志: OFF" }; }
  return { toast: "用法: /shellfix log on|off" };
}

// ── /my ────────────────────────────────────────────────────────────

handlers.set("my", (args: string): DispatchResult | null => {
  if (!args) return { output: "ShellFix 模板系统\n用法: /my ? 浏览 /my <name> [args] 执行" };

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // 查询模式
  if (first === "?") {
    const rest = tokens.slice(1).join(" ");
    if (!rest) {
      const all = listTemplates();
      if (all.length === 0) return { toast: "暂无模板" };
      return { output: "可用模板：\n" + all.map((t) => `  ${t.name}${t.builtin ? "" : " *"}  ${t.description || ""}`).join("\n") + "\n\n* 用户自定义" };
    }
    const tmpl = getTemplate(rest);
    if (!tmpl) return { toast: `模板 "${rest}" 不存在` };
    return { output: `模板: ${tmpl.name}\n描述: ${tmpl.description || ""}\n${tmpl.builtin ? "内置" : "用户"}\n\n${tmpl.template}` };
  }

  // 编辑模式
  if (first === "edit") {
    const name = tokens[1];
    if (!name) return { toast: "用法: /my edit <name> [新内容]" };
    const tmpl = getTemplate(name);
    if (!tmpl) return { toast: `模板 "${name}" 不存在` };
    if (tmpl.builtin) return { toast: `⚠️ "${name}" 是内置模板，编辑将创建用户覆盖` };
    const content = tokens.slice(2).join(" ");
    if (content) {
      saveTemplate({ name, template: content, description: tmpl.description });
      return { toast: `模板 "${name}" 已更新` };
    }
    return { output: `模板: ${name}\n描述: ${tmpl.description || ""}\n\n当前内容:\n${tmpl.template}\n\n---\n用 /my edit ${name} <新内容> 保存` };
  }

  // 执行模板
  const name = first;
  const tmpl = getTemplate(name);
  if (!tmpl) {
    const all = listTemplates();
    const match = all.find((t) => t.name.startsWith(name));
    if (match) {
      const tmplArgs = tokens.slice(1);
      const rendered = renderTemplate(match.template, tmplArgs);
      if (rendered) return { output: rendered };
      return { toast: "模板渲染失败" };
    }
    return { toast: `模板 "${name}" 不存在。用 /my ? 查看所有` };
  }

  const tmplArgs = tokens.slice(1);
  const rendered = renderTemplate(tmpl.template, tmplArgs);
  if (rendered) return { output: rendered };
  return { toast: "模板渲染失败" };
});

// ── /note ──────────────────────────────────────────────────────────

const NOTE_SAVE_RE = /^#([^#]+)#:(.*)$/s;
const NOTE_TAG_RE = /^#([^#]+)#$/;

handlers.set("note", (args: string): DispatchResult | null => {
  if (!args) return { output: "笔记系统\n用法: /note ? 浏览 /note #tag# 注入 /note timeline 查看时间线" };

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // 查询模式
  if (first === "?") {
    const rest = tokens.slice(1).join(" ");
    if (!rest) {
      const tree = listTagTree();
      if (tree.length === 0) return { toast: "暂无笔记" };
      return { output: "笔记标签：\n" + tree.map((t) => `  #${t.endsWith("/") ? t.slice(0, -1) : t}#`).join("\n") };
    }
    const prefix = rest.endsWith("/") ? rest : rest;
    const children = listTagTree(prefix);
    if (children.length === 0) {
      const note = getNote(rest);
      if (note) return { output: `笔记 #${rest}#:\n${note.content}` };
      return { toast: `标签 "${rest}" 下无内容` };
    }
    return { output: `${rest}/ 下的子标签：\n` + children.map((c) => `  #${prefix}${c.endsWith("/") ? c.slice(0, -1) : c}#`).join("\n") };
  }

  // timeline 时间线
  if (first === "timeline") {
    let tagFilter = "";
    let limit = 20;
    let since: string | undefined;
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === "--limit") {
        limit = parseInt(tokens[++i], 10) || 20;
      } else if (t === "--since") {
        const raw = tokens[++i];
        if (raw) {
          // 支持 YYYY-MM-DD 和 YYYY-MM-DDTHH:mm:ss.SSSZ
          since = raw.length === 10 ? raw + "T00:00:00.000Z" : raw;
        }
      } else if (t.startsWith("#") && t.endsWith("#")) {
        tagFilter = t.slice(1, -1);
      }
      i++;
    }
    const notes = tagFilter
      ? queryNotesByTime(tagFilter, limit, since)
      : listNotesByTime(limit, since);
    if (notes.length === 0) return { toast: "暂无笔记" };
    const lines: string[] = [`📅 笔记时间线（显示 ${notes.length} 条）`, "━".repeat(40)];
    for (const n of notes) {
      const date = n.created.slice(0, 19).replace("T", " ");
      lines.push(`#${date}# #${n.tag}#`);
      lines.push(n.content.slice(0, 100));
      lines.push("");
    }
    return { output: lines.join("\n") };
  }

  // rm
  if (first === "rm") {
    const tagMatch = args.match(NOTE_TAG_RE);
    if (!tagMatch) return { toast: '用法: /note rm #tag#' };
    const tag = tagMatch[1];
    if (removeNote(tag)) return { toast: `笔记 #${tag}# 已删除` };
    return { toast: `笔记 #${tag}# 不存在` };
  }

  // 保存: /note #tag#:content
  const saveMatch = args.match(NOTE_SAVE_RE);
  if (saveMatch) {
    const tag = saveMatch[1].trim();
    const content = saveMatch[2].trim();
    if (content === ":last") {
      const last = getLastMessage();
      if (last) {
        saveNote(tag, last);
        return { toast: `笔记 #${tag}# 已保存（来自缓存）` };
      }
      return { toast: '缓存为空。先发送消息或等待 LLM 回复后再试。' };
    }
    saveNote(tag, content);
    return { toast: `笔记 #${tag}# 已保存` };
  }

  // 注入: /note #tag#
  const tagMatch2 = args.match(NOTE_TAG_RE);
  if (tagMatch2) {
    const tag = tagMatch2[1];
    const note = getNote(tag);
    if (!note) {
      const children = listTagTree(tag);
      if (children.length > 0) {
        return { output: `${tag}/ 下的子标签：\n` + children.map((c) => `  #${tag}/${c.endsWith("/") ? c.slice(0, -1) : c}#`).join("\n") };
      }
      return { toast: `笔记 #${tag}# 不存在` };
    }
    return { output: note.content };
  }

  return { toast: '无法解析。格式: /note #tag#:content 或 /note #tag#' };
});

// ── /auto ──────────────────────────────────────────────────────────

const AUTO_MODE_LABEL: Record<AutoMode, string> = { prompt: "引导", auto: "静默", silent: "关闭" };

handlers.set("auto", (args: string): DispatchResult | null => {
  if (!args) return buildAutoPanel();

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // list
  if (first === "list" || first === "ls") {
    const s = loadState();
    const enabled = getEnabledAutoModules();
    const lines = ["当前已启用的自动化模块："];
    for (const mod of AUTO_MODULES) {
      const on = enabled.includes(mod.name) ? "✅" : "  ";
      lines.push(`  ${on} ${mod.label} (${mod.name}) — ${mod.description}`);
    }
    lines.push(`\n模式: ${s.auto.mode} (${AUTO_MODE_LABEL[s.auto.mode]})`);
    if (s.auto.require) lines.push(`require: ${s.auto.require}`);
    return { output: lines.join("\n") };
  }

  // /auto <module> — toggle
  const mod = getAutoModule(first);
  if (mod) {
    const s = loadState();
    const current = s.auto.modules[mod.name] ?? mod.defaultOn;
    setAutoModule(mod.name, !current);
    return { toast: `${mod.label}: ${!current ? "ON ✅" : "OFF"}` };
  }

  // /auto mode
  if (first === "mode") {
    const mode = tokens[1] as AutoMode | undefined;
    if (!mode || !["prompt", "auto", "silent"].includes(mode)) {
      return { output: `用法: /auto mode prompt|auto|silent\n当前: ${loadState().auto.mode}` };
    }
    setAutoMode(mode);
    return { toast: `模式: ${mode}` };
  }

  // /auto require
  if (first === "require" || first === "req") {
    const text = tokens.slice(1).join(" ");
    if (!text) {
      const current = loadState().auto.require;
      return { output: current ? `当前 require:\n${current}` : "require 未设置。用 /auto require <文本> 设置。" };
    }
    setAutoRequire(text);
    return { toast: `require 已设置 (${text.length} chars)` };
  }

  if (first === "require_rm" || first === "req_rm" || first === "reqrm") {
    setAutoRequire("");
    return { toast: "require 已清除" };
  }

  // /auto show <module>
  if (first === "show") {
    const modName = tokens[1];
    if (!modName) return { toast: "用法: /auto show <module>" };
    const mod2 = getAutoModule(modName);
    if (!mod2) return { toast: `未知模块: ${modName}` };
    return { output: `${mod2.label}\n${"-".repeat(mod2.label.length)}\n${mod2.content || "(空)"}` };
  }

  // /auto reset
  if (first === "reset") {
    const defaults = getDefaultEnabledModules();
    for (const m of AUTO_MODULES) {
      setAutoModule(m.name, defaults.includes(m.name));
    }
    setAutoRequire("");
    return { toast: "所有模块已恢复默认" };
  }

  // /auto conditions
  if (first === "conditions" || first === "cond") {
    return handleAutoConditions(tokens.slice(1));
  }

  // /auto rule — AutoRuleV2 管理
  if (first === "rule") {
    return handleAutoRule(tokens.slice(1));
  }

  // /auto help
  if (first === "help") {
    return { output: [
      `/auto                   查看模块开关总览`,
      `/auto list              列出模块启停状态`,
      `/auto <module>          切换开关`,
      `/auto mode <模式>       设置模式`,
      `/auto require <文本>    注入当前任务目标`,
      `/auto req_rm            清除 require`,
      `/auto show <module>     查看模块内容`,
      `/auto reset             恢复默认`,
      `/auto conditions        条件管理`,
      `/auto rule              规则管理`,
    ].join("\n") };
  }

  return { toast: '无法解析。用 /auto help 查看用法' };
});

function handleAutoConditions(args: string[]): DispatchResult | null {
  const s = loadState();
  if (args.length === 0) {
    let total = 0;
    for (const mod of AUTO_MODULES) {
      const conds = s.auto.conditions[mod.name];
      if (conds) total += conds.length;
    }
    if (total === 0) return { output: "未配置条件。使用默认条件。\n/auto conditions <module> 查看。" };
    const lines: string[] = [`条件配置 (共 ${total} 条)：\n`];
    for (const mod of AUTO_MODULES) {
      const conds = s.auto.conditions[mod.name];
      if (conds && conds.length > 0) {
        for (let i = 0; i < conds.length; i++) {
          const c = conds[i];
          const icon = c.enabled ? "✅" : "⏸️";
          lines.push(`  ${mod.name}[${i}] ${icon} ${c.predicate}=${c.expected}`);
        }
      }
    }
    return { output: lines.join("\n") };
  }

  const modName = args[0];
  const mod = getAutoModule(modName);
  const rest = args.slice(1);
  if (!mod) return { toast: `未知模块: ${modName}` };

  if (rest.length === 0) {
    const conds = getModuleConditions(modName);
    if (conds.length === 0) return { output: `${mod.label} 无条件` };
    return { output: `${mod.label} 条件：\n` + conds.map((c, i) => `  [${i}] ${c.predicate}=${c.expected} (${c.enabled ? "ON" : "OFF"})`).join("\n") };
  }

  const sub = rest[0];
  const subArgs = rest.slice(1);

  if (sub === "add") {
    const pred = subArgs[0] as InjectCondition["predicate"];
    const expected = subArgs.slice(1).join(" ");
    if (!pred || !expected) return { toast: `用法: /auto conditions ${modName} add <predicate> <expected>` };
    addModuleCondition(modName, { predicate: pred, expected, enabled: true });
    return { toast: `条件已添加: ${pred}=${expected}` };
  }

  if (sub === "rm") {
    const idx = parseInt(subArgs[0], 10);
    if (Number.isNaN(idx)) return { toast: `用法: /auto conditions ${modName} rm <index>` };
    if (removeModuleCondition(modName, idx)) return { toast: `条件 [${idx}] 已删除` };
    return { toast: `索引无效: ${idx}` };
  }

  if (sub === "toggle") {
    const idx = parseInt(subArgs[0], 10);
    if (Number.isNaN(idx)) return { toast: `用法: /auto conditions ${modName} toggle <index>` };
    const result = toggleModuleCondition(modName, idx);
    if (result === null) return { toast: `索引无效: ${idx}` };
    return { toast: `条件 [${idx}]: ${result ? "ON" : "OFF"}` };
  }

  if (sub === "clear") {
    clearModuleConditions(modName);
    return { toast: `${modName} 条件已清除` };
  }

  return { toast: `用法: /auto conditions ${modName} add|rm|toggle|clear` };
}

function handleAutoRule(args: string[]): DispatchResult | null {
  if (args.length === 0) {
    const rules = getAutoRules();
    if (rules.length === 0) return { output: "暂无 AutoRule。\n用法: /auto rule add <module> <trigger>" };
    const lines: string[] = [`AutoRuleV2 规则 (${rules.length} 条)：\n`];
    for (const rule of rules) {
      const icon = rule.enabled ? "✅" : "⏸️";
      lines.push(`  ${icon} [${rule.trigger}] ${rule.module} (${rule.id})`);
    }
    return { output: lines.join("\n") };
  }

  const first = args[0];

  if (first === "add") {
    const module = args[1];
    const trigger = (args[2] || "session_start") as "session_start" | "user_input";
    if (!module) return { toast: "用法: /auto rule add <module> [trigger]" };
    const id = addAutoRule({ trigger, module, conditions: [], enabled: true, priority: 50 });
    return { toast: `AutoRule 已添加: ${module} (${id})` };
  }

  if (first === "rm") {
    const id = args[1];
    if (!id) return { toast: "用法: /auto rule rm <id>" };
    if (removeAutoRule(id)) return { toast: `规则已删除: ${id}` };
    return { toast: `规则不存在: ${id}` };
  }

  if (first === "on") {
    const id = args[1];
    if (!id) return { toast: "用法: /auto rule on <id>" };
    const rules = getAutoRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) return { toast: `规则不存在: ${id}` };
    if (!rule.enabled) toggleAutoRule(id);
    return { toast: `规则已开启: ${rule.module}` };
  }

  if (first === "off") {
    const id = args[1];
    if (!id) return { toast: "用法: /auto rule off <id>" };
    const rules = getAutoRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) return { toast: `规则不存在: ${id}` };
    if (rule.enabled) toggleAutoRule(id);
    return { toast: `规则已关闭: ${rule.module}` };
  }

  return { toast: "用法: /auto rule add|rm|on|off" };
}

function buildAutoPanel(): DispatchResult | null {
  const s = loadState();
  const enabled = getEnabledAutoModules();
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════╗`);
  lines.push(`║ ShellFix 自动化系统                   ║`);
  lines.push(`╠══════════════════════════════════════╣`);
  lines.push(`║ 模式: ${s.auto.mode} (${AUTO_MODE_LABEL[s.auto.mode]})              ║`);
  lines.push(`║                                      ║`);
  for (const mod of AUTO_MODULES) {
    const on = enabled.includes(mod.name) ? "[ON]" : "    ";
    lines.push(`║  ${on} ${mod.label.padEnd(14)} ${mod.name.padEnd(16)}║`);
  }
  if (s.auto.require) {
    lines.push(`║                                      ║`);
    lines.push(`║  require: ${s.auto.require.slice(0, 34).padEnd(34)}║`);
  }
  lines.push(`║                                      ║`);
  lines.push(`║  /auto help         查看全部子命令     ║`);
  lines.push(`╚══════════════════════════════════════╝`);
  return { output: lines.join("\n") };
}

// ====================================================================

// ── /kickme ────────────────────────────────────────────────────────

handlers.set("kickme", (args: string): DispatchResult | null => {
  if (!args) return listKickmeRules();

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // /kickme add <keyword> <title> <message>
  if (first === "add") {
    const keyword = tokens[1];
    const title = tokens[2] || keyword;
    const message = tokens.slice(3).join(" ") || `触发关键词: ${keyword}`;
    if (!keyword) return { toast: "用法: /kickme add <关键词> <标题> <消息>" };
    const id = addKickmeRule({
      label: keyword,
      enabled: true,
      matchType: "keyword",
      pattern: keyword,
      title,
      message,
      sound: false,
      scope: "both",
    });
    return { toast: `规则已添加: "${keyword}" (${id})` };
  }

  // /kickme rm <id>
  if (first === "rm") {
    const id = tokens[1];
    if (!id) return { toast: "用法: /kickme rm <id>" };
    if (removeKickmeRule(id)) return { toast: `规则已删除: ${id}` };
    return { toast: `规则不存在: ${id}` };
  }

  // /kickme on <id>
  if (first === "on") {
    const id = tokens[1];
    if (!id) return { toast: "用法: /kickme on <id>" };
    const rule = getKickmeRules().find((r) => r.id === id);
    if (!rule) return { toast: `规则不存在: ${id}` };
    if (!rule.enabled) toggleKickmeRule(id);
    return { toast: `规则已开启: ${rule.label}` };
  }

  // /kickme off <id>
  if (first === "off") {
    const id = tokens[1];
    if (!id) return { toast: "用法: /kickme off <id>" };
    const rule = getKickmeRules().find((r) => r.id === id);
    if (!rule) return { toast: `规则不存在: ${id}` };
    if (rule.enabled) toggleKickmeRule(id);
    return { toast: `规则已关闭: ${rule.label}` };
  }

  // /kickme sound <id> on/off
  if (first === "sound") {
    const id = tokens[1];
    const onOff = tokens[2];
    if (!id || !onOff) return { toast: "用法: /kickme sound <id> on|off" };
    const ok = setKickmeSound(id, onOff === "on");
    if (!ok) return { toast: `规则不存在: ${id}` };
    return { toast: `提示音: ${onOff === "on" ? "ON" : "OFF"}` };
  }

  return { output: listKickmeRulesOutput() };
});

function listKickmeRules(): DispatchResult | null {
  return { output: listKickmeRulesOutput() };
}

function listKickmeRulesOutput(): string {
  const rules = getKickmeRules();
  if (rules.length === 0) {
    return "暂无 kickme 规则。\n用法: /kickme add <关键词> <标题> <消息>";
  }
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════╗`);
  lines.push(`║ Kickme 通知规则                       ║`);
  lines.push(`╠══════════════════════════════════════╣`);
  for (const rule of rules) {
    const icon = rule.enabled ? "✅" : "⏸️";
    const sound = rule.sound ? "🔊" : "  ";
    const scope = rule.scope === "user" ? "用户" : rule.scope === "llm" ? "LLM" : "全部";
    lines.push(`║  ${icon}${sound} [${scope}] ${rule.label.padEnd(16)}${rule.id.padEnd(12)}║`);
    lines.push(`║      → ${rule.title.padEnd(36)}║`);
  }
  lines.push(`║                                      ║`);
  lines.push(`║  /kickme add <关键词> <标题> <消息>   ║`);
  lines.push(`║  /kickme rm|on|off <id>              ║`);
  lines.push(`║  /kickme sound <id> on|off           ║`);
  lines.push(`╚══════════════════════════════════════╝`);
  return lines.join("\n");
}

// ── /dynamic ──────────────────────────────────────────────────────

handlers.set("dynamic", (args: string): DispatchResult | null => {
  if (!args) return listDynamicRules();

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // /dynamic add <trigger> <context>
  if (first === "add") {
    const trigger = tokens[1];
    const context = tokens.slice(2).join(" ");
    if (!trigger) return { toast: "用法: /dynamic add <触发词> <注入内容>" };
    const id = addDynamicRule({
      trigger,
      enabled: true,
      matchType: "keyword",
      context: context || `(当前对话涉及 ${trigger})`,
      cooldown: 0,
      lastTriggered: 0,
    });
    return { toast: `动态规则已添加: "${trigger}" (${id})` };
  }

  // /dynamic rm <id>
  if (first === "rm") {
    const id = tokens[1];
    if (!id) return { toast: "用法: /dynamic rm <id>" };
    if (removeDynamicRule(id)) return { toast: `规则已删除: ${id}` };
    return { toast: `规则不存在: ${id}` };
  }

  // /dynamic on <id>
  if (first === "on") {
    const id = tokens[1];
    if (!id) return { toast: "用法: /dynamic on <id>" };
    const rules = getDynamicRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) return { toast: `规则不存在: ${id}` };
    if (!rule.enabled) toggleDynamicRule(id);
    return { toast: `规则已开启: ${rule.trigger}` };
  }

  // /dynamic off <id>
  if (first === "off") {
    const id = tokens[1];
    if (!id) return { toast: "用法: /dynamic off <id>" };
    const rules = getDynamicRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) return { toast: `规则不存在: ${id}` };
    if (rule.enabled) toggleDynamicRule(id);
    return { toast: `规则已关闭: ${rule.trigger}` };
  }

  // /dynamic cooldown <id> <seconds>
  if (first === "cooldown") {
    const id = tokens[1];
    const seconds = parseInt(tokens[2], 10);
    if (!id || Number.isNaN(seconds)) return { toast: "用法: /dynamic cooldown <id> <秒数>" };
    if (setDynamicCooldown(id, seconds)) return { toast: `冷却时间已设置: ${seconds}s` };
    return { toast: `规则不存在: ${id}` };
  }

  return { output: listDynamicRulesOutput() };
});

function listDynamicRules(): DispatchResult | null {
  return { output: listDynamicRulesOutput() };
}

function listDynamicRulesOutput(): string {
  const rules = getDynamicRules();
  if (rules.length === 0) {
    return "暂无动态规则。\n用法: /dynamic add <触发词> <注入内容>";
  }
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════╗`);
  lines.push(`║ Dynamic 动态上下文注入规则             ║`);
  lines.push(`╠══════════════════════════════════════╣`);
  for (const rule of rules) {
    const icon = rule.enabled ? "✅" : "⏸️";
    const cd = rule.cooldown > 0 ? `[CD:${rule.cooldown}s]` : "    ";
    const matchT = rule.matchType === "regex" ? "R" : "K";
    lines.push(`║  ${icon}${cd} [${matchT}] ${rule.trigger.padEnd(16)}${rule.id.padEnd(12)}║`);
    lines.push(`║      → ${(rule.context || "").slice(0, 36).padEnd(36)}║`);
  }
  lines.push(`║                                      ║`);
  lines.push(`║  /dynamic add <触发词> <注入内容>     ║`);
  lines.push(`║  /dynamic rm|on|off <id>             ║`);
  lines.push(`║  /dynamic cooldown <id> <秒数>       ║`);
  lines.push(`╚══════════════════════════════════════╝`);
  return lines.join("\n");
}

// ====================================================================
// /shellfix — 面板 + 帮助 + doctor
// ====================================================================

function buildShellFixPanel(): string {
  const s = loadState();
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════╗`);
  lines.push(`║ ${PLUGIN_NAME} v${PLUGIN_VERSION}              ║`);
  lines.push(`╠══════════════════════════════════════╣`);
  lines.push(`║                                      ║`);
  lines.push(`║  encoding  ${fmtToggle(s.encoding)}  中文不乱码         ║`);
  lines.push(`║                                      ║`);
  for (const meta of CMD_RULES_META) {
    const on = s.cmdRules[meta.name];
    lines.push(`║  ${meta.label.padEnd(22)} ${fmtToggle(on)}  ║`);
  }
  lines.push(`║                                      ║`);
  lines.push(`║  log       ${fmtToggle(s.log)}  日志输出           ║`);
  lines.push(`║                                      ║`);
  lines.push(`║  Git 免交互: 16 env vars              ║`);
  lines.push(`║                                      ║`);
  const syncCfg = getSyncConfig();
  const syncOn = syncCfg.repoUrl ? "ON" : "OFF";
  lines.push(`║  sync     [${syncOn}]  远程模板仓库        ║`);
  if (syncCfg.repoUrl) {
    const counts = countTemplatesBySource();
    lines.push(`║  内置:${String(counts.builtin).padStart(2)} 用户:${String(counts.user).padStart(2)} 远程:${String(counts.remote).padStart(2)}         ║`);
  }
  lines.push(`║                                      ║`);
  lines.push(`║  /shellfix help  查看全部子命令       ║`);
  lines.push(`╚══════════════════════════════════════╝`);
  return lines.join("\n");
}

function fmtToggle(on: boolean): string {
  return on ? "[ON] " : "[OFF]";
}

function buildShellFixHelp(): string {
  return [
    `ShellFix 命令帮助\n`,
    `/shellfix                   状态面板`,
    `/shellfix cmd               列出所有命令替换规则`,
    `/shellfix cmd <name> on/off 开关规则`,
    `/shellfix encoding on/off   开关编码注入`,
    `/shellfix log on/off        开关日志输出`,
    `/shellfix doctor            环境诊断`,
    `/shellfix help              本帮助`,
    ``,
    `/my                         模板系统`,
    `/my ?                       列出所有模板`,
    `/my ? <name>                预览模板内容`,
    `/my <name> [args...]        执行模板`,
    `/my save <name> <content>   保存模板`,
    `/my rm <name>               删除模板`,
    `/my show <name>             查看模板原始内容`,
    `/my sync                    同步远程模板仓库`,
    `/my sync-config             查看同步配置`,
    ``,
    `/note                       笔记系统`,
    `/note ?                     列出所有笔记标签`,
    `/note ? <prefix>            浏览标签树`,
    `/note #tag#                 注入笔记内容`,
    `/note #tag#:<content>       保存笔记`,
    `/note rm #tag#              删除笔记`,
    ``,
    `/auto                       自动化系统`,
    `/auto list                  列出模块启停状态`,
    `/auto <module>              切换模块开关`,
    `/auto mode prompt|auto|silent 设置模式`,
    `/auto require <文本>        注入当前任务目标`,
    `/auto req_rm                清除 require`,
    `/auto show <module>         查看模块内容`,
    `/auto reset                 恢复默认`,
    `/auto conditions            条件管理`,
    ``,
    `/dynamic                    动态上下文注入规则`,
    `/dynamic add <触发词> <内容> 添加规则`,
    `/dynamic rm|on|off <id>     删除/开关规则`,
    `/dynamic cooldown <id> <秒>  设置冷却时间`,
  ].join("\n");
}

function collectDoctorReport(): string {
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════╗`);
  lines.push(`║ ShellFix v${PLUGIN_VERSION} — 环境诊断      ║`);
  lines.push(`╠══════════════════════════════════════╣`);
  try {
    const os = require("os");
    lines.push(`║ OS: ${os.platform()} ${os.release()}`);
    lines.push(`║ Hostname: ${os.hostname()}`);
    lines.push(`║ Arch: ${os.arch()}`);
  } catch { /* */ }
  lines.push(`║ Plugins: ${PLUGIN_NAME} v${PLUGIN_VERSION}`);
  lines.push(`╚══════════════════════════════════════╝`);
  return lines.join("\n");
}

// ====================================================================
// 调度器
// ====================================================================

/**
 * 尝试本地处理命令。如果本地处理器返回 null，回退到服务器。
 * 本地处理结果通过 appendPrompt（填入输入框）或 toast（通知）输出。
 */
async function dispatch(api: any, cmd: string, args: string): Promise<boolean> {
  const handler = handlers.get(cmd);
  if (handler) {
    try {
      const result = handler(args);
      if (result) {
        if (result.output && api.client?.tui?.appendPrompt) {
          await api.client.tui.appendPrompt({ text: result.output });
        }
        if (result.toast) {
          api.ui?.toast?.({ message: result.toast });
        }
        return true;
      }
    } catch (e) {
      console.error(`[ShellFix] Local handler error for ${cmd}:`, e);
    }
  }
  return false;
}

// ====================================================================
// 插件入口
// ====================================================================

const tui: TuiPlugin = async (api, _options, _meta) => {
  api.keymap.registerLayer({
    commands: [
      // ── /shellfix ────────────────────────────────────────────────
      {
        name: "shellfix.status",
        title: "ShellFix 状态面板",
        category: "ShellFix",
        namespace: "palette",
        slashName: "shellfix",
        run() {
          try {
            api.ui.dialog?.clear?.();
            dispatch(api, "shellfix", "").then((handled) => {
              if (!handled) {
                api.client?.tui?.executeCommand?.({ command: "|shellfix" });
              }
            });
          } catch {}
        },
      },

      // ── /my ──────────────────────────────────────────────────────
      {
        name: "shellfix.my",
        title: "ShellFix 模板系统",
        category: "ShellFix",
        namespace: "palette",
        slashName: "my",
        run() {
          try {
            api.ui.dialog?.clear?.();
            const all = listTemplates();
            if (all.length === 0) {
              api.ui.toast({ message: "暂无模板" });
              return;
            }
            api.ui.dialog?.replace?.(() =>
              api.ui.DialogSelect({
                title: "模板系统",
                options: [
                  { label: "✏️ 编辑模板", value: "__edit__", description: "修改已保存的模板内容" },
                  { label: "📋 查看全部", value: "__list__", description: "查看所有模板" },
                  ...all.map((t) => ({
                    label: t.name,
                    value: t.name,
                    description: t.description || "",
                  })),
                ],
                onSelect: (name: string) => {
                  if (name === "__edit__") {
                    // 进入编辑模式：选择要编辑的模板
                    const editable = all.filter((t) => !t.builtin);
                    if (editable.length === 0) {
                      api.ui.toast({ message: "没有可编辑的用户模板" });
                      return;
                    }
                    api.ui.dialog?.replace?.(() =>
                      api.ui.DialogSelect({
                        title: "选择要编辑的模板",
                        options: editable.map((t) => ({
                          label: t.name,
                          value: t.name,
                          description: t.description || "",
                        })),
                        onSelect: (editName: string) => {
                          const tmpl = getTemplate(editName);
                          if (!tmpl) { api.ui.toast({ message: "不存在" }); return; }
                          api.ui.dialog?.replace?.(() =>
                            api.ui.DialogPrompt({
                              title: `编辑模板 "${editName}"`,
                              label: "新内容:",
                              defaultText: tmpl.template,
                              onConfirm: (content: string) => {
                                if (content.trim()) {
                                  saveTemplate({ name: editName, template: content, description: tmpl.description });
                                  api.ui.toast({ message: `模板 "${editName}" 已更新` });
                                  api.ui.dialog?.clear?.();
                                } else {
                                  api.ui.toast({ message: "内容不能为空" });
                                }
                              },
                              onCancel: () => api.ui.dialog?.clear?.(),
                            })
                          );
                        },
                        onCancel: () => api.ui.dialog?.clear?.(),
                      })
                    );
                  } else if (name === "__list__") {
                    dispatch(api, "my", "?").then((handled) => {
                      if (!handled) api.client?.tui?.executeCommand?.({ command: "|my ?" });
                    });
                  } else {
                  const tmpl = getTemplate(name);
                  if (!tmpl || !tmpl.template) {
                    api.ui.toast({ message: `模板 "${name}" 无内容` });
                    return;
                  }
                  const paramCount = (tmpl.template.match(/\{(\d+)\}/g) || [])
                    .map((m) => parseInt(m.slice(1, -1), 10))
                    .filter((n) => !Number.isNaN(n))
                    .reduce((max, n) => Math.max(max, n), -1) + 1;
                  if (paramCount > 0) {
                    api.ui.dialog?.replace?.(() =>
                      api.ui.DialogPrompt({
                        title: `模板 "${name}" — 输入参数 (${paramCount} 个)`,
                        label: `参数 (空格分隔):`,
                        placeholder: "arg1 arg2 ...",
                        onConfirm: (input: string) => {
                          const args = input.trim().split(/\s+/);
                          const rendered = renderTemplate(tmpl.template, args);
                          if (rendered) {
                            api.client?.tui?.appendPrompt?.({ text: rendered });
                            api.ui.dialog?.clear?.();
                          } else {
                            api.ui.toast({ message: "渲染失败" });
                          }
                        },
                        onCancel: () => api.ui.dialog?.clear?.(),
                      })
                    );
} else {
                      const rendered = renderTemplate(tmpl.template, []);
                      if (rendered) {
                        api.client?.tui?.appendPrompt?.({ text: rendered });
                        api.ui.dialog?.clear?.();
                      } else {
                        api.ui.toast({ message: "渲染失败" });
                      }
                    }
                  }
                },
                onCancel: () => api.ui.dialog?.clear?.(),
              })
            );
          } catch {}
        },
      },

      // ── /note ────────────────────────────────────────────────────
      {
        name: "shellfix.note",
        title: "ShellFix 笔记系统",
        category: "ShellFix",
        namespace: "palette",
        slashName: "note",
        run() {
          try {
            api.ui.dialog?.clear?.();
            const tree = listTagTree();
            if (tree.length === 0) {
              api.ui.dialog?.replace?.(() =>
                api.ui.DialogPrompt({
                  title: "新建笔记",
                  label: "#标签#:内容",
                  placeholder: "#arch/db#:数据库连接池最大 10 连接",
                  onConfirm: (input: string) => {
                    dispatch(api, "note", input).then((handled) => {
                      if (!handled) {
                        api.client?.tui?.executeCommand?.({ command: `|note ${input}` });
                      }
                    });
                  },
                  onCancel: () => api.ui.dialog?.clear?.(),
                })
              );
              return;
            }
            api.ui.dialog?.replace?.(() =>
              api.ui.DialogSelect({
                title: "选择笔记标签",
                options: [
                  { label: "📝 新建笔记", value: "__new__", description: "输入新笔记" },
                  ...tree.map((t) => ({
                    label: `#${t.endsWith("/") ? t.slice(0, -1) : t}#`,
                    value: t,
                    description: "",
                  })),
                ],
                onSelect: (value: string) => {
                  if (value === "__new__") {
                    api.ui.dialog?.replace?.(() =>
                      api.ui.DialogPrompt({
                        title: "新建笔记",
                        label: "#标签#:内容",
                        placeholder: "#arch/db#:数据库连接池...",
                        onConfirm: (input: string) => {
                          dispatch(api, "note", input).then((handled) => {
                            if (!handled) api.client?.tui?.executeCommand?.({ command: `|note ${input}` });
                          });
                        },
                        onCancel: () => api.ui.dialog?.clear?.(),
                      })
                    );
                  } else {
                    dispatch(api, "note", `#${value}#`).then((handled) => {
                      if (!handled) api.client?.tui?.executeCommand?.({ command: `|note #${value}#` });
                    });
                  }
                },
                onCancel: () => api.ui.dialog?.clear?.(),
              })
            );
          } catch {}
        },
      },

      // ── /auto ────────────────────────────────────────────────────
      {
        name: "shellfix.auto",
        title: "ShellFix 自动化系统",
        category: "ShellFix",
        namespace: "palette",
        slashName: "auto",
        run() {
          try {
            api.ui.dialog?.clear?.();
            const s = loadState();
            const enabled = getEnabledAutoModules();
            const options = AUTO_MODULES.map((mod) => ({
              label: `${enabled.includes(mod.name) ? "✅" : "  "} ${mod.label}`,
              value: mod.name,
              description: `${mod.description} | ${enabled.includes(mod.name) ? "ON" : "OFF"}`,
            }));
            options.push({
              label: "⚙️  模式设置",
              value: "__mode__",
              description: `当前: ${s.auto.mode}`,
            });
            options.push({
              label: "📋 查看全部",
              value: "__list__",
              description: "",
            });
            api.ui.dialog?.replace?.(() =>
              api.ui.DialogSelect({
                title: "自动化模块 (点击切换)",
                options,
                onSelect: (value: string) => {
                  if (value === "__mode__") {
                    api.ui.dialog?.replace?.(() =>
                      api.ui.DialogSelect({
                        title: "选择模式",
                        options: [
                          { label: "auto 静默", value: "auto", description: "自动注入，不提示" },
                          { label: "prompt 引导", value: "prompt", description: "启动时引导用户选择" },
                          { label: "silent 关闭", value: "silent", description: "不注入" },
                        ],
                        onSelect: (mode: string) => {
                          setAutoMode(mode as AutoMode);
                          api.ui.toast({ message: `模式: ${mode}` });
                          api.ui.dialog?.clear?.();
                        },
                        onCancel: () => api.ui.dialog?.clear?.(),
                      })
                    );
                  } else if (value === "__list__") {
                    dispatch(api, "auto", "list").then((handled) => {
                      if (!handled) api.client?.tui?.executeCommand?.({ command: "|auto list" });
                    });
                  } else {
                    setAutoModule(value, !enabled.includes(value));
                    api.ui.toast({ message: `${getAutoModule(value)?.label || value}: ${enabled.includes(value) ? "OFF" : "ON"}` });
                    api.ui.dialog?.clear?.();
                  }
                },
                onCancel: () => api.ui.dialog?.clear?.(),
              })
            );
          } catch {}
        },
      },

      // ── /kickme ───────────────────────────────────────────────────
      {
        name: "shellfix.kickme",
        title: "ShellFix 通知规则",
        category: "ShellFix",
        namespace: "palette",
        slashName: "kickme",
        run() {
          try {
            api.ui.dialog?.clear?.();
            dispatch(api, "kickme", "").then((handled) => {
              if (!handled) {
                api.client?.tui?.executeCommand?.({ command: "|kickme" });
              }
            });
          } catch {}
        },
      },

      // ── /dynamic ─────────────────────────────────────────────────
      {
        name: "shellfix.dynamic",
        title: "ShellFix 动态上下文注入",
        category: "ShellFix",
        namespace: "palette",
        slashName: "dynamic",
        run() {
          try {
            api.ui.dialog?.clear?.();
            dispatch(api, "dynamic", "").then((handled) => {
              if (!handled) {
                api.client?.tui?.executeCommand?.({ command: "|dynamic" });
              }
            });
          } catch {}
        },
      },
    ],
  });

  // ==================================================================
  // 事件订阅
  // ==================================================================

  /**
   * 辅助：从事件中提取文本内容
   * 兼容不同的 event.data 结构。
   */
  function extractText(data: any): string {
    if (!data) return "";
    if (typeof data.text === "string") return data.text;
    if (data.parts && Array.isArray(data.parts)) {
      return data.parts
        .map((p: any) => (p.type === "text" ? p.text : ""))
        .join("\n");
    }
    if (data.content && typeof data.content === "string") return data.content;
    return "";
  }

  /**
   * 辅助：从文本中提取所有 #标签# 并自动保存笔记
   */
  function autoCollectTags(text: string): void {
    if (!text) return;
    const tagRe = /#([^#\s]+)#/g;
    let match: RegExpExecArray | null;
    while (true) {
      match = tagRe.exec(text);
      if (match === null) break;
      const tag = match[1].trim();
      if (!tag || tag.includes("#") || tag.includes(":")) continue;
      // 提取标签后的一段内容作为笔记正文
      const start = match.index + match[0].length;
      const contextEnd = Math.min(start + 80, text.length);
      const context = text.slice(match.index, contextEnd).replace(/\s+/g, " ").trim();
      try {
        saveNote(tag, context);
        // 不弹 toast —— 批量采集时避免骚扰
      } catch { /* 静默 */ }
    }
  }

  /**
   * 检查 kickme 规则，匹配时弹出 toast 通知
   * @param scope 事件源 — "user" (用户消息) 或 "llm" (LLM 回复)
   */
  function checkKickmeRules(text: string, scope: "user" | "llm"): void {
    if (!text) return;
    const rules = getKickmeRules();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.scope !== "both" && rule.scope !== scope) continue;
      const matched = rule.matchType === "regex"
        ? new RegExp(rule.pattern, "i").test(text)
        : text.toLowerCase().includes(rule.pattern.toLowerCase());
      if (matched) {
        const message = rule.message.replace("{matched}", rule.pattern);
        try {
          api.ui.toast({ message: `${rule.title}: ${message}` });
          if (rule.sound) {
            api.attention?.notify?.({ title: rule.title, message });
          }
        } catch { /* 静默 */ }
        break; // 每条文本只触发第一个匹配规则
      }
    }
  }

  /**
   * 检查动态上下文规则，匹配时将注入内容写入 pendingDynamic 缓存
   * system.transform 钩子会消费此缓存
   */
  function checkDynamicRules(text: string): void {
    if (!text) return;
    const rules = getDynamicRules();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (isDynamicOnCooldown(rule)) continue;
      const matched = rule.matchType === "regex"
        ? new RegExp(rule.trigger, "i").test(text)
        : text.toLowerCase().includes(rule.trigger.toLowerCase());
      if (matched) {
        markDynamicTriggered(rule.id);
        const s = loadState();
        if (!s.pendingDynamic) s.pendingDynamic = [];
        if (!s.pendingDynamic.includes(rule.id)) {
          s.pendingDynamic.push(rule.id);
          saveState(s);
        }
        break; // 每条文本只触发第一个匹配规则
      }
    }
  }

  // ── 订阅：用户消息被提交 ──────────────────────────────────────
  api.event.on("session.next.prompted", (event: any) => {
    try {
      const data = event?.data;
      if (!data) return;

      const text = extractText(data);

      if (text) setLastMessage(text);
      autoCollectTags(text);
      checkKickmeRules(text, "user");
      checkDynamicRules(text);
    } catch { /* 静默 */ }
  });

  // ── 订阅：LLM 回复完成 ─────────────────────────────────────────
  api.event.on("session.next.text.ended", (event: any) => {
    try {
      const text = extractText(event?.data);
      if (!text) return;

      setLastMessage(text);
      autoCollectTags(text);
      checkKickmeRules(text, "llm");
      checkDynamicRules(text);
    } catch { /* 静默 */ }
  });

  // ── 会话级自动注入（mode === "prompt" 时弹窗） ─────────────
  const s0 = loadState();
  if (s0.auto.mode === "prompt") {
    setTimeout(() => {
      try {
        showSessionModuleDialog(api);
      } catch { /* 静默 */ }
    }, 800);
  }
};

/**
 * 会话级模块选择弹窗 — 多轮选择直到用户点「完成」
 * 选择的模块通过 setAutoModule 持久化，system.transform 钩子自动生效
 */
function showSessionModuleDialog(api: any): void {
  const current = getEnabledAutoModules();
  const options = AUTO_MODULES.map((mod) => ({
    label: `${current.includes(mod.name) ? "✅" : "  "} ${mod.label}`,
    value: mod.name,
    description: mod.description,
  }));
  options.unshift({
    label: "✅ 完成选择",
    value: "__done__",
    description: "使用当前选中的模块",
  });
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogSelect({
      title: "本次会话启用哪些模块？（点击切换，选完点「完成选择」）",
      options,
      onSelect: (value: string) => {
        if (value === "__done__") {
          api.ui.dialog?.clear?.();
          return;
        }
        // 读取最新 state 并 toggle
        const fresh = getEnabledAutoModules();
        const newEnabled = fresh.includes(value)
          ? fresh.filter((n) => n !== value)
          : [...fresh, value];
        for (const mod of AUTO_MODULES) {
          setAutoModule(mod.name, newEnabled.includes(mod.name));
        }
        // 刷新弹窗显示新状态
        showSessionModuleDialog(api);
      },
      onCancel: () => api.ui.dialog?.clear?.(),
    })
  );
}

const plugin: TuiPluginModule & { id: string } = {
  id: "shellfix",
  tui,
};

export default plugin;