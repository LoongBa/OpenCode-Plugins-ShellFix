/**
 * ShellFixPlugin v1.6.0
 * ======================
 * OpenCode 原生 TS 插件 — 四支柱体系 + 条件引擎
 *
 * 支柱一：平台修复（shellfix）
 *   - 中文不乱码 → 自动注入 $OutputEncoding / [Console]::OutputEncoding
 *   - export → $env: 转换 + 5 条命令兼容规则（乒乓开关）
 *   - Git 免交互 → shell.env 进程级注入 16 个环境变量
 *   - doctor → 环境诊断
 *
 * 支柱二：模板系统（my）
 *   - 预设文本 + 位置参数 {0} {1} + 环境变量 {branch} {date}
 *   - ? 查询模式预览不执行
 *   - /my sync 远程 Git 仓库同步（团队模板共享）
 *   - /my sync-config 同步配置管理
 *
 * 支柱三：笔记系统（note）
 *   - 对话中截取有价值信息，#标签# 存储与检索
 *   - 层级标签 #架构/存储层#，支持父标签浏览子级
 *
 * 支柱四：自动化系统（auto）
 *   - 自动注入上下文到 system prompt
 *   - 三种模式：auto（静默）/ prompt（引导）/ silent（关闭）
 *   - /auto require 临时注入当前任务目标
 *
 * 四个命令前缀：
 *   /shellfix  — 平台修复管家
 *   /my        — 模板系统
 *   /note      — 笔记系统
 *   /auto      — 自动化系统
 */

// ====================================================================
// 类型定义（零依赖，自包含）
// ====================================================================

type PluginInput = {
  client: unknown;
  project: unknown;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
};

type Plugin = (input: PluginInput) => Promise<Record<string, unknown>>;

// ====================================================================
// 内部模块
// ====================================================================

import {
  loadState,
  saveState,
  toggleCmdRule,
  setCmdRule,
  toggleEncoding,
  toggleLog,
  setAutoModule,
  setAutoMode,
  setAutoRequire,
  getEnabledAutoModules,
  getModuleConditions,
  setModuleConditions,
  addModuleCondition,
  removeModuleCondition,
  toggleModuleCondition,
  clearModuleConditions,
  getSyncConfig,
  setSyncConfig,
  CMD_RULES_META,
  type CmdRuleName,
  type PluginState,
  type AutoMode,
  type InjectCondition,
  type ConditionPredicate,
  type SyncConfig,
} from "./lib/state";

import {
  listTemplates,
  getTemplate,
  saveTemplate,
  removeTemplate,
  renderTemplate,
  listNotes,
  getNote,
  saveNote,
  removeNote,
  listTagTree,
  queryNotes,
  resolveEnvVar,
  cloneRemoteRepo,
  pullRemoteRepo,
  remoteRepoExists,
  countTemplatesBySource,
  type TemplateEntry,
  type SyncResult,
} from "./lib/template-store";

import {
  AUTO_MODULES,
  getAutoModule,
  getDefaultEnabledModules,
  getDefaultConditions,
} from "./lib/auto-rules";

// BUN 兼容：将所有 require() 提升为顶层 import
import { execSync } from "child_process";
import * as os from "os";
import { existsSync, readdirSync } from "fs";

// ====================================================================
// 辅助函数
// ====================================================================

function escapePSDoubleQuoted(val: string): string {
  return val
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '""');
}

function parseExportKV(kvBlock: string): string[] {
  const pairRe = /\w+=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  const assignments: string[] = [];
  let match: RegExpExecArray | null = pairRe.exec(kvBlock);
  while (match !== null) {
    const part = match[0];
    const eqIdx = part.indexOf("=");
    const key = part.slice(0, eqIdx);
    let val = part.slice(eqIdx + 1);
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
      val = val.replace(/\\(["\\])/g, "$1");
    }
    assignments.push(`$env:${key}="${escapePSDoubleQuoted(val)}";`);
    match = pairRe.exec(kvBlock);
  }
  return assignments;
}

function dedupeEnvAssignments(cmd: string): string {
  const seen = new Map<string, { index: number; len: number }>();
  const envRe = /\$env:(\w+)=(?:("(?:[^"\\]|\\.)*"|\S+?));/g;
  for (let m = envRe.exec(cmd); m !== null; m = envRe.exec(cmd)) {
    seen.set(m[1], { index: m.index, len: m[0].length });
  }
  if (seen.size === 0) return cmd;
  const removed = new Set<string>();
  let result = cmd;
  const sorted = [...seen.entries()].sort(
    (a, b) => b[1].index - a[1].index,
  );
  for (const [key, pos] of sorted) {
    if (removed.has(key)) {
      const after = result.slice(pos.index + pos.len);
      result = result.slice(0, pos.index) + after.replace(/^[;\s]*/, "");
    }
    removed.add(key);
  }
  return result;
}

// ====================================================================
// 常量
// ====================================================================

const EXPORT_RE = /^\s*export\s+/;
const EXPORT_LINE_RE =
  /^\s*export\s+((?:\w+=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)\s*)+)(.*)$/s;

const ENCODING_PREFIX =
  "$OutputEncoding=[Text.UTF8Encoding]::new($false);" +
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";

const PLUGIN_NAME = "ShellFix";
const PLUGIN_VERSION = "1.6.0";

const CI_ENV_VARS: Record<string, string> = {
  CI: "true",
  SHELLFIX_VERSION: PLUGIN_VERSION,
  DEBIAN_FRONTEND: "noninteractive",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  HOMEBREW_NO_AUTO_UPDATE: "1",
  GIT_EDITOR: ":",
  EDITOR: ":",
  VISUAL: "",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_PAGER: "cat",
  PAGER: "cat",
  npm_config_yes: "true",
  PIP_NO_INPUT: "1",
  YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
};

// shellfix 特殊指令（tool.execute.before 中保留兼容）
const SPECIAL_CMD_RE = /^\s*[/#]shellfix\b/;
const PIPE_CMD_RE = /^\s*\|(shellfix|my|note|auto)(?:\s|$)/;
const SLASH_CMD_RE = /^\s*\/(shellfix|my|note|auto)(?:\s|$)/;

// ====================================================================
// 新增命令规则正则
// ====================================================================

const WHICH_RE = /^\s*which\s+(\S+)/;
const SOURCE_RE = /^\s*source\s+(\S+(?:\s+\S+)*)/;
const TOUCH_RE = /^\s*touch\s+(.+)$/;
const RM_RE = /^\s*rm\s+(.+)$/;
const CHMOD_RE = /^\s*chmod\s+/;

// ====================================================================
// 插件主入口
// ====================================================================

export const ShellFixPlugin: Plugin = async () => {
  const state = loadState();
  console.log(
    `[${PLUGIN_NAME}] v${PLUGIN_VERSION} loaded — ` +
      `encoding:${state.encoding ? "ON" : "OFF"} ` +
      `rules:${getEnabledRuleNames(state).length} ` +
      `log:${state.log ? "ON" : "OFF"}`
  );

  return {
    // ================================================================
    // 钩子 A: shell.env — Git 免交互环境变量
    // ================================================================
    "shell.env": async (_input, output) => {
      const out = output as { env: Record<string, string> };
      for (const [key, val] of Object.entries(CI_ENV_VARS)) {
        out.env[key] = val;
      }
    },

    // ================================================================
    // 钩子 B: tool.execute.before — 命令拦截 + 编码注入
    // ================================================================
    "tool.execute.before": async (input, output) => {
      const tool = (input as { tool: string }).tool;
      if (tool !== "bash" && tool !== "pwsh") return;

      const out = output as { args: Record<string, unknown> };
      const cmd: string | undefined = out.args?.command as string | undefined;
      if (typeof cmd !== "string") return;

      // 仅保留 /shellfix 兼容（command.execute.before 是首选路径）
      if (SPECIAL_CMD_RE.test(cmd)) {
        out.args.command = buildShellFixPanelCmd();
        return;
      }

      // 管道命令后备方案：|my |note |auto |shellfix
      const pipeMatch = cmd.match(PIPE_CMD_RE);
      if (pipeMatch) {
        const pipeCmd = pipeMatch[1];
        const pipeArgs = cmd.slice(pipeMatch[0].length).trim();
        let text = "";
        switch (pipeCmd) {
          case "shellfix": text = handleShellFixCommand(pipeArgs); break;
          case "my":       text = handleMyCommand(pipeArgs); break;
          case "note":     text = handleNoteCommand(pipeArgs); break;
          case "auto":     text = handleAutoCommand(pipeArgs); break;
        }
        // 转义单引号后用 Write-Host 输出
        const escaped = text.replace(/'/g, "''");
        out.args.command = `${ENCODING_PREFIX}Write-Host '${escaped}'`;
        return;
      }

      // 斜杠命令后备方案：/my /note /auto /shellfix
      const slashMatch = cmd.match(SLASH_CMD_RE);
      if (slashMatch) {
        const slashCmd = slashMatch[1];
        const slashArgs = cmd.slice(slashMatch[0].length).trim();
        let text = "";
        switch (slashCmd) {
          case "shellfix": text = handleShellFixCommand(slashArgs); break;
          case "my":       text = handleMyCommand(slashArgs); break;
          case "note":     text = handleNoteCommand(slashArgs); break;
          case "auto":     text = handleAutoCommand(slashArgs); break;
        }
        const escaped = text.replace(/'/g, "''");
        out.args.command = `${ENCODING_PREFIX}Write-Host '${escaped}'`;
        return;
      }

      const s = loadState();
      let result = cmd;

      // 命令替换（按开关执行）
      if (s.cmdRules.export) {
        result = applyExportRule(result);
      }
      if (s.cmdRules.which) {
        result = applyWhichRule(result);
      }
      if (s.cmdRules.source) {
        result = applySourceRule(result);
      }
      if (s.cmdRules.touch) {
        result = applyTouchRule(result);
      }
      if (s.cmdRules.rm) {
        result = applyRmRule(result);
      }
      if (s.cmdRules.chmod) {
        result = applyChmodRule(result);
      }

      // 编码前缀
      if (s.encoding && !result.startsWith(ENCODING_PREFIX)) {
        result = `${ENCODING_PREFIX}${result}`;
      }

      out.args.command = result;
    },

    // ================================================================
    // 钩子 C: command.execute.before — 斜杠命令入口（SDK 官方支持）
    // ================================================================
    "command.execute.before": async (input, output) => {
      const { command, arguments: args } = input as {
        command: string;
        sessionID: string;
        arguments: string;
      };
      const out = output as { parts: { type: "text"; text: string }[] };

      let text = "";

      switch (command) {
        case "shellfix":
          text = handleShellFixCommand(args.trim());
          break;
        case "my":
          text = handleMyCommand(args.trim());
          break;
        case "note":
          text = handleNoteCommand(args.trim());
          break;
        case "auto":
          text = handleAutoCommand(args.trim());
          break;
        default:
          return; // 不处理未知命令
      }

      out.parts = [{ type: "text", text }];
    },

    // ================================================================
    // 钩子 D: experimental.chat.system.transform — system prompt 注入
    // ================================================================
    "experimental.chat.system.transform": async (_input, output) => {
      const out = output as { content: string };
      const s = loadState();

      // 收集启用的注入模块内容（经过条件评估）
      const chunks: string[] = [];

      // 启用模块的注入
      for (const mod of AUTO_MODULES) {
        if (shouldInjectModule(mod.name) && mod.content) {
          chunks.push(mod.content);
        }
      }

      // require 文本
      if (s.auto.require) {
        chunks.push(s.auto.require);
      }

      if (chunks.length === 0) return;

      const separator = "\n\n---\n";
      out.content = out.content + separator + chunks.join("\n\n");

      // prompt 模式：追加提示引导
      if (s.auto.mode === "prompt") {
        out.content +=
          "\n\n[注] 以上为 ShellFix 自动注入的上下文。用 /auto 查看和管理。";
      }
    },
  };
};

// ====================================================================
// 命令替换规则实现
// ====================================================================

function applyExportRule(cmd: string): string {
  if (!EXPORT_RE.test(cmd)) return cmd;
  const lineMatch = cmd.match(EXPORT_LINE_RE);
  if (!lineMatch) return cmd;
  const kvBlock = lineMatch[1];
  const suffix = (lineMatch[2] || "").trim();
  const envAssignments = parseExportKV(kvBlock);
  const result = `${envAssignments.join("")}${suffix ? ` ${suffix}` : ""}`;
  return dedupeEnvAssignments(result);
}

function applyWhichRule(cmd: string): string {
  return cmd.replace(WHICH_RE, "(Get-Command '$1').Source");
}

function applySourceRule(cmd: string): string {
  return cmd.replace(SOURCE_RE, ". '$1'");
}

function applyTouchRule(cmd: string): string {
  return cmd.replace(TOUCH_RE, "New-Item -ItemType File -Path '$1' -ErrorAction SilentlyContinue");
}

function applyRmRule(cmd: string): string {
  return cmd.replace(RM_RE, "Remove-Item -Recurse -Force $1");
}

function applyChmodRule(cmd: string): string {
  return cmd.replace(CHMOD_RE, "# chmod ignored on Windows; ");
}

// ====================================================================
// 状态面板（PowerShell）
// ====================================================================

function buildShellFixPanelCmd(): string {
  const s = loadState();
  const lines: string[] = [];
  lines.push(`${ENCODING_PREFIX}`);
  lines.push(`Write-Host "";`);
  lines.push(`Write-Host "[${PLUGIN_NAME}] v${PLUGIN_VERSION}" -ForegroundColor Cyan;`);
  lines.push(`Write-Host "  ├ 中文不乱码: ${statusEmoji(s.encoding)} $(${s.encoding ? '' : 'Disabled - '})UTF-8 encoding prefix" -ForegroundColor ${s.encoding ? 'Green' : 'DarkYellow'};`);

  const enabledRules = CMD_RULES_META.filter((r) => s.cmdRules[r.name]);
  if (enabledRules.length > 0) {
    // 第一行带 ├
    const first = enabledRules[0];
    lines.push(`Write-Host "  ├ ${first.label}: ${statusEmoji(true)}" -ForegroundColor Green;`);
    for (let i = 1; i < enabledRules.length; i++) {
      lines.push(`Write-Host "  │ ${enabledRules[i].label}: ${statusEmoji(true)}" -ForegroundColor Green;`);
    }
  }

  lines.push(`Write-Host "  ├ Git 免交互: ${Object.keys(CI_ENV_VARS).length} env vars via shell.env" -ForegroundColor Green;`);

  // doctor 摘要（无额外开销）
  lines.push(`Write-Host "  └ doctor: PowerShell $(\$PSVersionTable.PSVersion.ToString()) / Encoding: $([Console]::OutputEncoding.WebName)" -ForegroundColor DarkGray;`);
  lines.push(`Write-Host "";`);

  return lines.join("");
}

function statusEmoji(on: boolean): string {
  return on ? "ON" : "OFF";
}

// ====================================================================
// /shellfix 命令处理
// ====================================================================

function handleShellFixCommand(args: string): string {
  if (!args) return buildShellFixPanel();

  const tokens = args.split(/\s+/);
  const sub = tokens[0].toLowerCase();

  switch (sub) {
    case "cmd":
      return handleCmdSub(tokens.slice(1));
    case "encoding":
      return handleEncodingSub(tokens.slice(1));
    case "log":
      return handleLogSub(tokens.slice(1));
    case "doctor":
      return collectDoctorReport();
    case "help":
      return buildShellFixHelp();
    default:
      return `未知子命令: ${sub}\n\n${buildShellFixHelp()}`;
  }
}

function handleCmdSub(args: string[]): string {
  const s = loadState();

  if (args.length === 0) {
    // 列出所有规则 + 状态
    const lines: string[] = [`ShellFix — 命令替换规则\n`];
    for (const meta of CMD_RULES_META) {
      const state = s.cmdRules[meta.name] ? "ON" : "OFF";
      lines.push(`  ${state}  ${meta.label}`);
      lines.push(`       ${meta.description}`);
      lines.push("");
    }
    lines.push(`使用：/shellfix cmd <规则名> on/off`);
    return lines.join("\n");
  }

  const ruleName = args[0] as CmdRuleName;
  const meta = CMD_RULES_META.find((m) => m.name === ruleName);
  if (!meta) {
    return `未知规则: ${ruleName}\n可用规则: ${CMD_RULES_META.map((m) => m.name).join(", ")}`;
  }

  if (args.length === 1) {
    // 查看单条规则状态
    return `${meta.label}: ${s.cmdRules[ruleName] ? "ON" : "OFF"}\n${meta.description}`;
  }

  const action = args[1].toLowerCase();
  if (action === "on") {
    setCmdRule(ruleName, true);
    return `${meta.label}: ON`;
  } else if (action === "off") {
    setCmdRule(ruleName, false);
    return `${meta.label}: OFF`;
  } else {
    return `用法: /shellfix cmd ${ruleName} on|off`;
  }
}

function handleEncodingSub(args: string[]): string {
  const s = loadState();

  if (args.length === 0) {
    return [
      `ShellFix — 编码注入\n`,
      `状态: ${s.encoding ? "ON" : "OFF"}`,
      `当前编码: ${s.encoding ? "UTF-8（自动注入）" : "关闭（系统默认编码）"}`,
      ``,
      `用法：`,
      `  /shellfix encoding on    开启编码前缀`,
      `  /shellfix encoding off   关闭编码前缀`,
      `  /shellfix encoding       查看当前状态`,
    ].join("\n");
  }

  const action = args[0].toLowerCase();
  if (action === "on") {
    const s2 = loadState();
    s2.encoding = true;
    saveState(s2);
    return "编码注入: ON";
  } else if (action === "off") {
    const s2 = loadState();
    s2.encoding = false;
    saveState(s2);
    return "编码注入: OFF";
  } else {
    return `用法: /shellfix encoding on|off`;
  }
}

function handleLogSub(args: string[]): string {
  const s = loadState();

  if (args.length === 0) {
    return [
      `ShellFix — 日志输出\n`,
      `状态: ${s.log ? "ON" : "OFF"}`,
      ``,
      `用法：`,
      `  /shellfix log on    开启日志`,
      `  /shellfix log off   关闭日志`,
      `  /shellfix log       查看当前状态`,
    ].join("\n");
  }

  const action = args[0].toLowerCase();
  if (action === "on") {
    const s2 = loadState();
    s2.log = true;
    saveState(s2);
    return "日志: ON";
  } else if (action === "off") {
    const s2 = loadState();
    s2.log = false;
    saveState(s2);
    return "日志: OFF";
  } else {
    return `用法: /shellfix log on|off`;
  }
}

// ====================================================================
// 状态面板（文本版，用于 command.execute.before）
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
  lines.push(`║  注入系统: ${fmtToggle(s.auto.mode !== "silent")} auto上下文        ║`);
  const activeCount = getActiveInjectModules().length;
  const enabledCount = getEnabledAutoModules().length;
  lines.push(`║  已启用: ${activeCount}/${AUTO_MODULES.length} 模块 (条件:${enabledCount}开)  ║`);
  lines.push(`║                                      ║`);
  lines.push(`║  Git 免交互: ${Object.keys(CI_ENV_VARS).length} env vars    ║`);
  lines.push(`║                                      ║`);
  const syncCfg = getSyncConfig();
  const syncOn = syncCfg.repoUrl ? "ON" : "OFF";
  lines.push(`║  sync     [${syncOn}]  远程模板仓库        ║`);
  if (syncCfg.repoUrl) {
    const counts = countTemplatesBySource();
    lines.push(`║  内置:${String(counts.builtin).padStart(2)} 用户:${String(counts.user).padStart(2)} 远程:${String(counts.remote).padStart(2)}         ║`);
  }
  lines.push(`║                                      ║`);
  lines.push(`╟─ doctor ──────────────────────────────╢`);

  try {
    lines.push(`║  OS: ${os.platform()} ${os.release()}               ║`);
  } catch { /* */ }

  lines.push(`║                                      ║`);
  lines.push(`║  /shellfix help  查看全部子命令        ║`);
  lines.push(`╚══════════════════════════════════════╝`);

  return lines.join("\n");
}

function fmtToggle(on: boolean): string {
  return on ? "[ON] " : "[OFF]";
}

// ====================================================================
// doctor — 环境诊断
// ====================================================================

function collectDoctorReport(): string {
  const s = loadState();
  const lines: string[] = [];

  lines.push(`╔══════════════════════════════════════╗`);
  lines.push(`║ ShellFix v${PLUGIN_VERSION} — 环境诊断      ║`);
  lines.push(`╠══════════════════════════════════════╣`);

  // 基础信息
  try {
    lines.push(`║ OS: ${os.platform()} ${os.release()}`);
    lines.push(`║ Hostname: ${os.hostname()}`);
    lines.push(`║ Arch: ${os.arch()}`);
  } catch { /* */ }

  // PowerShell 信息（仅 tool.execute.before 才能获取，这里简单展示）
  lines.push(`║ Plugins: ${PLUGIN_NAME} v${PLUGIN_VERSION}`);
  lines.push(`╚══════════════════════════════════════╝`);

  return lines.join("\n");
}

// ====================================================================
// 帮助
// ====================================================================

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
    `/my <name> [args...]        执行模板（注入对话）`,
    `/my save <name> <content>   保存模板`,
    `/my rm <name>               删除模板`,
    `/my show <name>             查看模板原始内容`,
    `/my sync                    同步远程模板仓库`,
    `/my sync --force            强制重新克隆`,
    `/my sync --dry-run          预览同步`,
    `/my sync status             查看同步状态`,
    `/my sync-config             查看同步配置`,
    `/my sync-config set <key> <val>  设置配置项`,
    ``,
    `/note                       笔记系统`,
    `/note ?                     列出所有笔记标签`,
    `/note ? <prefix>            浏览标签树`,
    `/note #tag/key#             注入笔记内容`,
    `/note #tag/key#:<content>   保存笔记`,
    `/note #tag/key#:last        保存上一条（暂不支持，仅存显式）`,
    `/note rm #tag/key#          删除笔记`,
    ``,
    `/auto                         注入系统`,
    `/auto list                    列出模块启停状态`,
    `/auto <module>                切换模块开关`,
    `/auto mode prompt|auto|silent 设置自注入模式`,
    `/auto require <文本>          注入当前任务目标`,
    `/auto req_rm                  清除 require`,
    `/auto show <module>           查看模块内容`,
    `/auto reset                   恢复默认`,
    `/auto conditions              查看所有模块的条件`,
    `/auto conditions <module>     查看模块条件`,
    `/auto conditions <module> add <pred> <expected>  添加条件`,
    `/auto conditions <module> rm <index>    删除条件`,
    `/auto conditions <module> toggle <index> 开关条件`,
    `/auto conditions <module> clear         清除条件`,
    `/auto conditions eval <module>          测试评估`,
  ].join("\n");
}

// ====================================================================
// 工具
// ====================================================================

function getEnabledRuleNames(state: PluginState): CmdRuleName[] {
  return (Object.keys(state.cmdRules) as CmdRuleName[]).filter(
    (k) => state.cmdRules[k],
  );
}

// ====================================================================
// 条件引擎 — 检测函数
// ====================================================================

/** 简单的 glob 匹配（仅支持 * 通配） */
function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "*/*") return true;
  const regexStr = "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  try {
    return new RegExp(regexStr).test(value);
  } catch {
    return value === pattern;
  }
}

/** 检测当前目录是否为 Git 仓库 */
function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 检测 Git 工作区是否有未提交改动 */
function isGitDirty(): boolean {
  try {
    const out = execSync("git status --porcelain", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** 检测某工具是否存在 */
function toolExists(name: string): boolean {
  try {
    execSync(`where ${name}`, { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** 检测文件/目录是否存在（支持简单 * 通配） */
function fileExists(pattern: string): boolean {
  try {
    if (!pattern.includes("*")) return existsSync(pattern);
    // glob 模式：尝试 readdir 匹配
    const parts = pattern.split(/[\\/]/);
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    const filePat = parts[parts.length - 1];
    const files = readdirSync(dir);
    const regexStr = "^" + filePat.replace(/\*/g, ".*") + "$";
    return files.some((f: string) => new RegExp(regexStr).test(f));
  } catch {
    return false;
  }
}

// ====================================================================
// 条件引擎 — 评估
// ====================================================================

/** 评估单条条件是否匹配当前环境 */
function evaluateCondition(cond: InjectCondition): boolean {
  if (!cond.enabled) return true; // 跳过已禁用的条件

  switch (cond.predicate) {
    case "always":
      return true;
    case "never":
      return false;
    case "os":
      return matchesGlob(os.platform(), cond.expected);
    case "arch":
      return matchesGlob(os.arch(), cond.expected);
    case "branch":
      return matchesGlob(resolveGitBranchCached(), cond.expected);
    case "dirty":
      return isGitDirty() === (cond.expected === "true");
    case "tool_exists":
      return toolExists(cond.expected);
    case "file_exists":
      return fileExists(cond.expected);
    case "is_git_repo":
      return isGitRepo() === (cond.expected === "true");
    default:
      return true;
  }
}

/** 缓存分支名（避免重复 execSync） */
let _cachedBranch: string | null = null;
function resolveGitBranchCached(): string {
  if (_cachedBranch !== null) return _cachedBranch;
  try {
    _cachedBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    _cachedBranch = "unknown";
  }
  return _cachedBranch;
}

/** 判断模块是否应当注入（手动开关 + 条件评估） */
function shouldInjectModule(modName: string): boolean {
  const s = loadState();
  // 手动开关关闭 → 不注入
  if (!s.auto.modules[modName]) return false;

  // 读取用户配置的条件（优先）或默认条件
  const conditions = s.auto.conditions[modName];
  if (!conditions || conditions.length === 0) return true; // 无条件 → 按手动开关

  // 所有条件必须匹配（AND 逻辑）
  return conditions.every((c) => evaluateCondition(c));
}

/** 获取当前实际活跃的注入模块名（经过条件过滤） */
function getActiveInjectModules(): string[] {
  return AUTO_MODULES
    .filter((m) => shouldInjectModule(m.name))
    .map((m) => m.name);
}

/** 统计条件生效数量 */
function countActiveConditions(): number {
  const s = loadState();
  let total = 0, active = 0;
  for (const mod of AUTO_MODULES) {
    const conds = s.auto.conditions[mod.name];
    if (conds) {
      for (const c of conds) {
        total++;
        if (c.enabled && evaluateCondition(c)) active++;
      }
    }
  }
  return active;
}

// ====================================================================
// /my 命令处理
// ====================================================================

function handleMyCommand(args: string): string {
  if (!args) {
    return `ShellFix 模板系统\n用法: /my ? 浏览 /my <name> [args] 执行\n/my help 查看帮助`;
  }

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // 查询模式
  if (first === "?") {
    const rest = tokens.slice(1).join(" ");
    if (!rest) {
      // 列出所有模板
      const all = listTemplates();
      if (all.length === 0) return "暂无模板。";
      return (
        "可用模板：\n" +
        all.map((t) => `  ${t.name}${t.builtin ? "" : " *"}  ${t.description || ""}`).join("\n") +
        "\n\n* 用户自定义"
      );
    }
    // 预览具体模板
    const tmpl = getTemplate(rest);
    if (!tmpl) return `模板 "${rest}" 不存在。`;
    return [
      `模板: ${tmpl.name}`,
      `描述: ${tmpl.description || ""}`,
      `${tmpl.builtin ? "内置" : "用户自定义"}\n`,
      tmpl.template,
    ].join("\n");
  }

  // 子命令
  switch (first) {
    case "list": {
      const all = listTemplates();
      return "模板列表：\n" + all.map((t) => `  ${t.name}  ${t.description || ""}`).join("\n");
    }
    case "save": {
      // /my save <name> <template text...>
      const name = tokens[1];
      if (!name) return "用法: /my save <name> <模板内容>";
      const content = tokens.slice(2).join(" ");
      if (!content) return "用法: /my save <name> <模板内容>";
      saveTemplate({ name, template: content, description: "用户自定义" });
      return `模板 "${name}" 已保存。`;
    }
    case "rm": {
      const name = tokens[1];
      if (!name) return "用法: /my rm <name>";
      if (removeTemplate(name)) return `模板 "${name}" 已删除。`;
      return `无法删除 "${name}"（不存在或是内置模板）。`;
    }
    case "show": {
      const name = tokens[1];
      if (!name) return "用法: /my show <name>";
      const tmpl = getTemplate(name);
      if (!tmpl) return `模板 "${name}" 不存在。`;
      return `模板: ${tmpl.name}\n描述: ${tmpl.description || ""}\n类型: ${tmpl.builtin ? "内置" : "用户"}\n\n${tmpl.template}`;
    }
    case "sync":
      return handleMySync(tokens.slice(1));
    case "sync-config":
      return handleMySyncConfig(tokens.slice(1));
    case "help":
      return [
        `模板系统帮助\n`,
        `/my ?               列出所有模板`,
        `/my ? <name>        预览模板`,
        `/my <name> [args..] 执行模板`,
        `/my save <n> <内容>  保存模板`,
        `/my rm <n>          删除模板`,
        `/my show <n>        查看模板内容`,
      ].join("\n");
    default: {
      // 执行模板：/my <name> [args...]
      const name = first;
      const tmpl = getTemplate(name);
      if (!tmpl) {
        // 尝试模糊匹配
        const all = listTemplates();
        const match = all.find((t) => t.name.startsWith(name));
        if (match) {
          const tmplArgs = tokens.slice(1);
          return renderTemplate(match.template, tmplArgs);
        }
        return `模板 "${name}" 不存在。用 /my ? 查看所有模板。`;
      }
      const tmplArgs = tokens.slice(1);
      return renderTemplate(tmpl.template, tmplArgs);
    }
  }
}

// ====================================================================
// /my sync — 远程模板同步
// ====================================================================

function handleMySync(args: string[]): string {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const sub = args.find((a) => !a.startsWith("--")) || "";

  // /my sync status
  if (sub === "status") {
    const syncCfg = getSyncConfig();
    if (!syncCfg.repoUrl) return "未配置远程仓库。用 /my sync-config set repo_url <url> 配置。";
    const exists = remoteRepoExists();
    const counts = countTemplatesBySource();
    const lines: string[] = [];
    lines.push(`╔══════════════════════════════════════╗`);
    lines.push(`║ 远程模板同步状态                      ║`);
    lines.push(`╠══════════════════════════════════════╣`);
    lines.push(`║ 仓库: ${syncCfg.repoUrl.padEnd(37)}║`);
    lines.push(`║ 分支: ${syncCfg.branch.padEnd(37)}║`);
    lines.push(`║ 状态: ${(exists ? "已同步" : "未克隆").padEnd(37)}║`);
    if (syncCfg.lastSyncAt) {
      lines.push(`║ 上次同步: ${syncCfg.lastSyncAt.padEnd(34)}║`);
      lines.push(`║ 最新 commit: ${syncCfg.lastSyncCommit.padEnd(31)}║`);
    }
    lines.push(`║                                      ║`);
    lines.push(`║  内置: ${String(counts.builtin).padStart(2)}  用户: ${String(counts.user).padStart(2)}  远程: ${String(counts.remote).padStart(2)} ║`);
    lines.push(`╚══════════════════════════════════════╝`);
    return lines.join("\n");
  }

  // /my sync
  const cfg = getSyncConfig();
  if (!cfg.repoUrl) return "未配置远程仓库地址。\n用法: /my sync-config set repo_url <url>";

  // --dry-run 预览
  if (flags.has("--dry-run")) {
    return `[dry-run] 将从 ${cfg.repoUrl} (${cfg.branch}) 同步模板到本地。\n使用 /my sync（不加 --dry-run）执行。`;
  }

  let result: SyncResult;
  if (flags.has("--force") || !remoteRepoExists()) {
    result = cloneRemoteRepo(cfg.repoUrl, cfg.branch);
  } else {
    result = pullRemoteRepo();
  }

  // 更新同步元数据
  if (result.success && result.commit) {
    setSyncConfig({
      lastSyncCommit: result.commit,
      lastSyncAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
  }

  // 报告
  const counts = countTemplatesBySource();
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════╗`);
  lines.push(`║ 远程模板同步                          ║`);
  lines.push(`╠══════════════════════════════════════╣`);
  lines.push(`║ ${result.message.padEnd(38)}║`);
  if (result.success) {
    lines.push(`║                                      ║`);
    lines.push(`║  新增: ${String(result.added).padStart(2)}    更新: ${String(result.updated).padStart(2)}    跳过: ${String(result.skipped).padStart(2)} ║`);
    lines.push(`║                                      ║`);
    lines.push(`║  内置: ${String(counts.builtin).padStart(2)}    用户: ${String(counts.user).padStart(2)}    远程: ${String(counts.remote).padStart(2)} ║`);
  }
  lines.push(`╚══════════════════════════════════════╝`);
  return lines.join("\n");
}

// ====================================================================
// /my sync-config — 同步配置管理
// ====================================================================

const SYNC_CONFIG_KEYS: Record<string, keyof SyncConfig> = {
  repo_url: "repoUrl",
  branch: "branch",
  auto_sync_on_start: "autoSyncOnStart",
};

function handleMySyncConfig(args: string[]): string {
  if (args.length === 0) {
    const cfg = getSyncConfig();
    const lines: string[] = [];
    lines.push(`╔══════════════════════════════════════╗`);
    lines.push(`║ 远程模板同步配置                      ║`);
    lines.push(`╠══════════════════════════════════════╣`);
    lines.push(`║ repo_url  ${cfg.repoUrl.padEnd(32)}║`);
    lines.push(`║ branch    ${cfg.branch.padEnd(32)}║`);
    lines.push(`║ auto_sync ${cfg.autoSyncOnStart ? "true" : "false".padEnd(31)}║`);
    if (cfg.lastSyncAt) {
      lines.push(`║ 上次同步: ${cfg.lastSyncAt.padEnd(33)}║`);
    }
    lines.push(`╚══════════════════════════════════════╝`);
    return lines.join("\n");
  }

  const sub = args[0];

  if (sub === "set") {
    const key = args[1];
    const val = args.slice(2).join(" ");
    if (!key || !val) return "用法: /my sync-config set <key> <value>";

    const mapped = SYNC_CONFIG_KEYS[key];
    if (!mapped) return `未知配置项: ${key}\n可用: ${Object.keys(SYNC_CONFIG_KEYS).join(", ")}`;

    const update: Partial<SyncConfig> = {};
    if (mapped === "autoSyncOnStart") {
      (update as any)[mapped] = val === "true" || val === "1";
    } else {
      (update as any)[mapped] = val;
    }
    setSyncConfig(update);
    return `${key} → ${val}`;
  }

  if (sub === "help") {
    return [
      `/my sync-config              查看当前配置`,
      `/my sync-config set <key> <val>  设置配置项`,
      ``,
      `配置项：`,
      `  repo_url          远程仓库 URL（如 https://github.com/team/templates.git）`,
      `  branch            分支名（默认 main）`,
      `  auto_sync_on_start 启动时自动同步（true/false，默认 false）`,
      ``,
      `配置后执行 /my sync 拉取模板。`,
    ].join("\n");
  }

  return "用法: /my sync-config 或 /my sync-config help";
}

// ====================================================================
// /note 命令处理
// ====================================================================

/** 解析 #tag/content# 格式 */
const NOTE_SAVE_RE = /^#([^#]+)#:(.*)$/s;
/** 解析纯标签 #tag# */
const NOTE_TAG_RE = /^#([^#]+)#$/;

function handleNoteCommand(args: string): string {
  if (!args) {
    return "笔记系统\n用法: /note ? 浏览 /note #tag# 注入";
  }

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // 查询模式
  if (first === "?") {
    const rest = tokens.slice(1).join(" ");
    if (!rest) {
      // 列出所有顶层标签
      const tree = listTagTree();
      if (tree.length === 0) return "暂无笔记。";
      return "笔记标签：\n" + tree.map((t) => `  #${t.endsWith("/") ? t.slice(0, -1) : t}#`).join("\n");
    }
    // 列出子标签
    const prefix = rest.endsWith("/") ? rest : rest;
    const children = listTagTree(prefix);
    if (children.length === 0) {
      // 没有子标签，看看是不是直接匹配
      const note = getNote(rest);
      if (note) {
        return `笔记 #${rest}#:\n${note.content}`;
      }
      return `标签 "${rest}" 下无内容。`;
    }
    return `${rest}/ 下的子标签：\n` +
      children.map((c) => `  #${prefix}${c.endsWith("/") ? c.slice(0, -1) : c}#`).join("\n");
  }

  // rm 子命令
  if (first === "rm") {
    const tagMatch = args.match(NOTE_TAG_RE);
    if (!tagMatch) return '用法: /note rm #tag#';
    const tag = tagMatch[1];
    if (removeNote(tag)) return `笔记 #${tag}# 已删除。`;
    return `笔记 #${tag}# 不存在。`;
  }

  // 保存模式: /note #tag#:content
  const saveMatch = args.match(NOTE_SAVE_RE);
  if (saveMatch) {
    const tag = saveMatch[1].trim();
    let content = saveMatch[2].trim();
    // 处理 :last 标记（暂存标识，实际内容为当前）
    if (content === ":last") content = "(上一条消息内容)"; // 占位
    saveNote(tag, content);
    return `笔记 #${tag}# 已保存。`;
  }

  // 注入模式: /note #tag#
  const tagMatch2 = args.match(NOTE_TAG_RE);
  if (tagMatch2) {
    const tag = tagMatch2[1];
    const note = getNote(tag);
    if (!note) {
      // 尝试作为父标签浏览
      const children = listTagTree(tag);
      if (children.length > 0) {
        return `${tag}/ 下的子标签：\n` +
          children.map((c) => `  #${tag}/${c.endsWith("/") ? c.slice(0, -1) : c}#`).join("\n");
      }
      return `笔记 #${tag}# 不存在。用 /note ? 列出所有。`;
    }
    return note.content;
  }

  // 帮助
  if (first === "help") {
    return [
      `笔记系统帮助\n`,
      `/note ?             列出所有标签`,
      `/note ? <prefix>    浏览标签树`,
      `/note #tag#:content  保存笔记`,
      `/note #tag#          注入笔记`,
      `/note rm #tag#       删除笔记`,
    ].join("\n");
  }

  return '无法解析。格式: /note #tag#:content 或 /note #tag#';
}

// ====================================================================
// 支柱四：注入系统（in）
// ====================================================================

function handleAutoCommand(args: string): string {
  if (!args) {
    const s = loadState();
    const enabled = getEnabledAutoModules();
    const modeLabel = { prompt: "引导", auto: "静默", silent: "关闭" };
    const lines: string[] = [];
    lines.push(`╔══════════════════════════════════════╗`);
    lines.push(`║ ShellFix 注入系统                    ║`);
    lines.push(`╠══════════════════════════════════════╣`);
    lines.push(`║ 模式: ${s.auto.mode} (${modeLabel[s.auto.mode]})              ║`);
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
    lines.push(`║  /auto help         查看全部子命令       ║`);
    lines.push(`╚══════════════════════════════════════╝`);
    return lines.join("\n");
  }

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // /auto list
  if (first === "list" || first === "ls") {
    const s = loadState();
    const enabled = getEnabledAutoModules();
    const active = getActiveInjectModules();
    const lines = ["当前已启用的注入模块："];
    for (const mod of AUTO_MODULES) {
      const on = enabled.includes(mod.name) ? "✅" : "  ";
      const actually = active.includes(mod.name) ? "" : " ⚠️条件阻断";
      lines.push(`  ${on} ${mod.label} (${mod.name}) — ${mod.description}${actually}`);
    }
    lines.push(`\n模式: ${s.auto.mode}`);
    if (s.auto.require) {
      lines.push(`require: ${s.auto.require}`);
    }
    const totalConds = Object.values(s.auto.conditions).reduce((s2, arr) => s2 + arr.length, 0);
    if (totalConds > 0) {
      const activeConds = countActiveConditions();
      lines.push(`条件: ${totalConds} 条配置, ${activeConds} 条活跃`);
    }
    return lines.join("\n");
  }

  // /auto <module>
  const mod = getAutoModule(first);
  if (mod) {
    const s = loadState();
    const current = s.auto.modules[mod.name] ?? mod.defaultOn;
    const newVal = !current;
    setAutoModule(mod.name, newVal);
    return `${mod.label}: ${newVal ? "ON ✅" : "OFF"}`;
  }

  // /auto mode
  if (first === "mode") {
    const mode = tokens[1] as AutoMode | undefined;
    if (!mode || !["prompt", "auto", "silent"].includes(mode)) {
      return `用法: /auto mode prompt|auto|silent\n当前: ${loadState().auto.mode}`;
    }
    setAutoMode(mode);
    return `模式: ${mode}`;
  }

  // /auto require [text]
  if (first === "require" || first === "req") {
    const text = tokens.slice(1).join(" ");
    if (!text) {
      const current = loadState().auto.require;
      return current ? `当前 require:\n${current}` : "require 未设置。用 /auto require <文本> 设置。";
    }
    setAutoRequire(text);
    return `require 已设置 (${text.length} chars)。`;
  }

  // /auto require_rm
  if (first === "require_rm" || first === "req_rm" || first === "reqrm") {
    setAutoRequire("");
    return "require 已清除。";
  }

  // /auto show <module> — 查看模块内容
  if (first === "show") {
    const modName = tokens[1];
    if (!modName) return "用法: /auto show <module>";
    const mod2 = getAutoModule(modName);
    if (!mod2) return `未知模块: ${modName}`;
    return `${mod2.label}\n${"-".repeat(mod2.label.length)}\n${mod2.content || "(动态内容，当前为空)"}`;
  }

  // /auto reset — 恢复所有模块默认开关 + 条件
  if (first === "reset") {
    const defaults = getDefaultEnabledModules();
    for (const mod of AUTO_MODULES) {
      setAutoModule(mod.name, defaults.includes(mod.name));
      // 重置为默认条件
      const defaultConds = getDefaultConditions(mod.name);
      if (defaultConds.length > 0) {
        setModuleConditions(mod.name, defaultConds);
      } else {
        clearModuleConditions(mod.name);
      }
    }
    setAutoRequire("");
    return "所有注入模块已恢复默认设置，条件已重置，require 已清除。";
  }

  // /auto conditions — 条件管理
  if (first === "conditions" || first === "cond") {
    return handleInjectConditions(tokens.slice(1));
  }

  // /auto help
  if (first === "help") {
    return [
      `注入系统帮助\n`,
      `/auto                   查看模块开关总览`,
      `/auto list              列出模块启停状态`,
      `/auto <module>          切换开关（coding / windows / tech-stack / review / security / git）`,
      `/auto mode <模式>       设置注入模式：prompt（对话引导）、auto（静默）、silent（关闭）`,
      `/auto require <文本>    注入当前任务目标（仅在本次生效）`,
      `/auto req_rm            清除 require`,
      `/auto show <module>     查看模块内容`,
      `/auto reset             恢复默认`,
    ].join("\n");
  }

  return '无法解析。用 /auto help 查看用法。';
}

// ====================================================================
// /auto conditions — 条件管理
// ====================================================================

const CONDITION_PREDICATES: { pred: ConditionPredicate; label: string; example: string }[] = [
  { pred: "os", label: "操作系统", example: "win32 / darwin / linux" },
  { pred: "arch", label: "CPU 架构", example: "x64 / arm64" },
  { pred: "branch", label: "Git 分支", example: "feature/* / main" },
  { pred: "dirty", label: "有未提交改动", example: "true / false" },
  { pred: "tool_exists", label: "工具存在", example: "dotnet / bun / node" },
  { pred: "file_exists", label: "文件/目录存在", example: "package.json / src/*.cs" },
  { pred: "is_git_repo", label: "是 Git 仓库", example: "true / false" },
  { pred: "always", label: "始终", example: "true" },
  { pred: "never", label: "永不", example: "true" },
];

function handleInjectConditions(args: string[]): string {
  // /auto conditions
  if (args.length === 0) {
    const s = loadState();
    const totalConds = Object.values(s.auto.conditions).reduce((sum, arr) => sum + arr.length, 0);
    if (totalConds === 0) {
      return "未配置条件。使用默认条件（模块定义内置）。\n/auto conditions <module> 查看具体模块。";
    }
    const lines: string[] = [];
    lines.push(`条件配置 (共 ${totalConds} 条)：\n`);
    for (const mod of AUTO_MODULES) {
      const conds = s.auto.conditions[mod.name];
      if (conds && conds.length > 0) {
        for (let i = 0; i < conds.length; i++) {
          const c = conds[i];
          const icon = c.enabled ? "✅" : "⏸️";
          const match = c.enabled && evaluateCondition(c) ? "✓" : "✗";
          lines.push(`  ${mod.name}[${i}] ${icon} ${c.predicate}=${c.expected} (${match})`);
        }
      }
    }
    return lines.join("\n");
  }

  const modName = args[0];
  const mod = getAutoModule(modName);
  const rest = args.slice(1);

  // /auto conditions <module>
  if (rest.length === 0) {
    if (!mod) return `未知模块: ${modName}`;
    const conds = getModuleConditions(modName);
    if (conds.length === 0) {
      // 显示默认条件
      const defaults = getDefaultConditions(modName);
      if (defaults.length > 0) {
        return `${mod.label} 默认条件：\n` +
          defaults.map((c, i) => `  [${i}] ${c.predicate}=${c.expected} (${c.enabled ? "ON" : "OFF"})`).join("\n") +
          "\n（未自定义，默认条件生效）";
      }
      return `${mod.label} 无条件。`;
    }
    const s = loadState();
    const lines: string[] = [`${mod.label} 条件：`];
    for (let i = 0; i < conds.length; i++) {
      const c = conds[i];
      const match = c.enabled && evaluateCondition(c) ? "✓" : "✗";
      lines.push(`  [${i}] ${c.enabled ? "✅" : "⏸️"} ${c.predicate}=${c.expected} (${match})`);
    }
    return lines.join("\n");
  }

  if (!mod) return `未知模块: ${modName}`;
  const sub = rest[0];

  // /auto conditions <module> add <predicate> <expected>
  if (sub === "add") {
    const predicate = rest[1] as ConditionPredicate | undefined;
    const expected = rest.slice(2).join(" ");
    if (!predicate || !expected) {
      return `用法: /auto conditions ${modName} add <predicate> <expected>\n可用谓词:\n` +
        CONDITION_PREDICATES.map((p) => `  ${p.pred} — ${p.label} (例: ${p.example})`).join("\n");
    }
    if (!CONDITION_PREDICATES.find((p) => p.pred === predicate)) {
      return `未知谓词: ${predicate}\n可用: ${CONDITION_PREDICATES.map((p) => p.pred).join(", ")}`;
    }
    addModuleCondition(modName, { predicate, expected, enabled: true });
    return `${modName}: 已添加条件 ${predicate}=${expected}`;
  }

  // /auto conditions <module> rm <index>
  if (sub === "rm") {
    const idx = parseInt(rest[1], 10);
    if (isNaN(idx)) return `用法: /auto conditions ${modName} rm <index>`;
    if (removeModuleCondition(modName, idx)) {
      return `${modName}: 已删除条件 [${idx}]`;
    }
    return `删除失败: 索引 ${idx} 无效`;
  }

  // /auto conditions <module> toggle <index>
  if (sub === "toggle" || sub === "tog") {
    const idx = parseInt(rest[1], 10);
    if (isNaN(idx)) return `用法: /auto conditions ${modName} toggle <index>`;
    const result = toggleModuleCondition(modName, idx);
    if (result === null) return `操作失败: 索引 ${idx} 无效`;
    return `${modName}[${idx}]: ${result ? "ON ✅" : "OFF ⏸️"}`;
  }

  // /auto conditions <module> clear
  if (sub === "clear") {
    clearModuleConditions(modName);
    return `${modName}: 条件已清除（将使用默认条件）`;
  }

  // /auto conditions eval <module>
  if (sub === "eval") {
    const conds = getModuleConditions(modName);
    if (conds.length === 0) {
      const defaults = getDefaultConditions(modName);
      if (defaults.length === 0) return `${modName}: 无条件，始终匹配 ✅`;
      const allMatch = defaults.every((c) => evaluateCondition(c));
      const lines = [`${modName} 默认条件评估：`];
      for (const c of defaults) {
        const match = evaluateCondition(c);
        lines.push(`  ${match ? "✅" : "❌"} ${c.predicate}=${c.expected}`);
      }
      lines.push(allMatch ? "\n结果: ✅ 全部匹配，模块将注入" : "\n结果: ❌ 条件未满足，模块不会注入");
      return lines.join("\n");
    }
    const allMatch = conds.every((c) => evaluateCondition(c));
    const lines = [`${modName} 条件评估：`];
    for (const c of conds) {
      const match = evaluateCondition(c);
      lines.push(`  ${match ? "✅" : "❌"} ${c.predicate}=${c.expected} (${c.enabled ? "ON" : "⏸️"})`);
    }
    lines.push(allMatch ? "\n结果: ✅ 全部匹配" : "\n结果: ❌ 条件未完全匹配");
    return lines.join("\n");
  }

  return     `用法:\n` +
    `/auto conditions                   查看所有条件\n` +
    `/auto conditions <module>          查看模块条件\n` +
    `/auto conditions ${modName} add <pred> <val>  添加条件\n` +
    `/auto conditions ${modName} rm <index>       删除条件\n` +
    `/auto conditions ${modName} toggle <index>   开关条件\n` +
    `/auto conditions ${modName} clear            清除条件\n` +
    `/auto conditions ${modName} eval             测试评估`;
}
