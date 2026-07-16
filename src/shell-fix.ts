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
  PLUGIN_VERSION,
  type CmdRuleName,
  type PluginState,
  type AutoMode,
  type InjectCondition,
  type ConditionPredicate,
  type SyncConfig,
  type KickmeRule,
  getDynamicRules,
  markDynamicTriggered,
  isDynamicOnCooldown,
  type DynamicRule,
  getAutoRules,
  addAutoRule,
  removeAutoRule,
  toggleAutoRule,
  type AutoRuleV2,
  addCmdError,
  getCmdErrors,
  type CmdErrorEntry,
  addSafetyWarning,
  getPendingSafetyWarnings,
  clearPendingSafetyWarnings,
  isSafetyOnCooldown,
  markSafetyCooldown,
  SAFETY_COOLDOWN_MS,
  type PwshCheckState,
  setPwshCheckDismissed,
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
  listNotesByTime,
  queryNotesByTime,
  resolveEnvVar,
  cloneRemoteRepo,
  pullRemoteRepo,
  remoteRepoExists,
  pushTemplatesToRemote,
  countTemplatesBySource,
  type TemplateEntry,
  type SyncResult,
  type PushResult,
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
import { existsSync, readFileSync } from "fs";
import { join } from "path";

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

const ENCODING_PREFIX_PS =
  "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
/** PowerShell 7+ (pwsh) — $OutputEncoding 默认为 UTF8，只需设 Console */
const ENCODING_PREFIX_PWSH =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;";

const PLUGIN_NAME = "ShellFix";

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

const PIPE_CMD_RE = /^\s*\|(my|auto)(?:\s|$)/;
const SLASH_CMD_RE = /^\s*\/(my|auto)(?:\s|$)/;

// ====================================================================
// 新增命令规则正则
// ====================================================================

const WHICH_RE = /^\s*which\s+(\S+)/;
const SOURCE_RE = /^\s*source\s+(\S+(?:\s+\S+)*)/;
const TOUCH_RE = /^\s*touch\s+(.+)$/;
const RM_RE = /^\s*rm\s+(.+)$/;
const CHMOD_RE = /^\s*chmod\s+/;

/** 仅匹配管道后的 head/tail，避免误伤文件路径或变量名 */
const HEAD_RE = /(\|\s*)head(?:\s+(?:-n\s*)?(\d+))?/;
const TAIL_RE = /(\|\s*)tail(?:\s+(?!-f\b)(?:-n\s*)?(\d+))?/;

// ====================================================================
// 安全检测模式（v2.2.8）
// ====================================================================

interface SafetyPattern {
  name: string;
  risk: string;
  re: RegExp;
  message: string;
}

const SAFETY_PATTERNS: SafetyPattern[] = [
  {
    name: "rm-rf",
    risk: "高危",
    re: /rm\s+-rf\s+(?:\/|\.\/|[a-zA-Z]:\\|\$HOME)/,
    message: "注意：你使用了 `rm -rf` 命令。请改用 Remove-Item -Recurse -Force，并确认路径正确后再执行。",
  },
  {
    name: "sudo",
    risk: "中危",
    re: /sudo\s+/,
    message: "注意：你使用了 `sudo` 命令。Windows 环境下没有 sudo，如果确实需要管理员权限，请以管理员身份运行 OpenCode。",
  },
  {
    name: "chmod",
    risk: "低危",
    re: /chmod\s+/,
    message: "注意：`chmod` 是 Linux 命令，Windows 环境下不需要。ShellFix 已内置 chmod 替换规则，可确保命令不报错。",
  },
  {
    name: "curl-bash",
    risk: "高危",
    re: /curl\s+.*\|\s*(?:sh|bash)\b/,
    message: "注意：`curl | bash` 存在安全风险（可能执行未经检查的远程脚本）。建议先下载查看内容，确认安全后再手动执行。",
  },
];

// ====================================================================
// 插件主入口
// ====================================================================

export const ShellFixPlugin: Plugin = async () => {
  const state = loadState();
  if (state.showVersion !== false) {
    console.log(
      `[${PLUGIN_NAME}] v${PLUGIN_VERSION} loaded — ` +
        `encoding:${state.encoding ? "ON" : "OFF"} ` +
        `rules:${getEnabledRuleNames(state).length} ` +
        `log:${state.log ? "ON" : "OFF"}`
    );
  }

  // ── PwshCheck：检测 OpenCode 是否使用 PowerShell 5.1（v2.2.9）────
  if (process.platform === "win32" && state.pwshCheck.dismissed !== "forever") {
    try {
      const configPath = join(os.homedir(), ".config", "opencode", "opencode.jsonc");
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        const hasPwshShell = /"shell"\s*:\s*"[^"]*pwsh[^"]*"/i.test(content);
        if (hasPwshShell) {
          // 已配置 pwsh，标记为已采纳
          state.pwshCheck.pending = false;
          state.pwshCheck.dismissed = "accepted" as any;
          saveState(state);
        } else if (state.pwshCheck.dismissed !== "accepted") {
          // 未配置 pwsh → 先确认 pwsh 是否已安装
          let pwshFound = false;
          try {
            execSync("where pwsh", { stdio: "ignore" });
            pwshFound = true;
          } catch { /* pwsh 未安装 */ }
          if (pwshFound) {
            state.pwshCheck.pending = true;
            saveState(state);
          }
        }
      }
    } catch {
      // 无法读取配置文件，静默跳过
    }
  }

  return {
    // ================================================================
    // 钩子 A: shell.env — Git 免交互环境变量
    // ================================================================
    "shell.env": async (_input, output) => {
      const out = output as { env: Record<string, string> };
      const s = loadState();
      // 基础 Git 免交互环境变量
      for (const [key, val] of Object.entries(CI_ENV_VARS)) {
        out.env[key] = val;
      }
      // git-line-ending: 条件注入 Git 配置环境变量（抑制换行符警告）
      if (s.gitLineEnding !== "off") {
        out.env["GIT_CONFIG_COUNT"] = "2";
        out.env["GIT_CONFIG_KEY_0"] = "core.autocrlf";
        out.env["GIT_CONFIG_VALUE_0"] = "false";
        out.env["GIT_CONFIG_KEY_1"] = "core.safecrlf";
        out.env["GIT_CONFIG_VALUE_1"] = "false";
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

      // 管道命令后备方案：|my |auto
      const pipeMatch = cmd.match(PIPE_CMD_RE);
      if (pipeMatch) {
        const pipeCmd = pipeMatch[1];
        const pipeArgs = cmd.slice(pipeMatch[0].length).trim();
        let text = "";
        switch (pipeCmd) {
          case "my":   text = handleMyCommand(pipeArgs); break;
          case "auto": text = handleAutoCommand(pipeArgs); break;
        }
        const escaped = text.replace(/'/g, "''");
        out.args.command = `${tool === "pwsh" ? ENCODING_PREFIX_PWSH : ENCODING_PREFIX_PS}Write-Host '${escaped}'`;
        return;
      }

      // 斜杠命令后备方案：/my /auto
      const slashMatch = cmd.match(SLASH_CMD_RE);
      if (slashMatch) {
        const slashCmd = slashMatch[1];
        const slashArgs = cmd.slice(slashMatch[0].length).trim();
        let text = "";
        switch (slashCmd) {
          case "my":   text = handleMyCommand(slashArgs); break;
          case "auto": text = handleAutoCommand(slashArgs); break;
        }
        const escaped = text.replace(/'/g, "''");
        out.args.command = `${tool === "pwsh" ? ENCODING_PREFIX_PWSH : ENCODING_PREFIX_PS}Write-Host '${escaped}'`;
        return;
      }

      const s = loadState();
      let result = cmd;

      // ── 安全检测（v2.2.8）：检测危险命令，标记待提醒 ────────
      for (const sp of SAFETY_PATTERNS) {
        if (sp.re.test(cmd) && !isSafetyOnCooldown(sp.name)) {
          addSafetyWarning({ pattern: sp.name, message: sp.message });
          markSafetyCooldown(sp.name, SAFETY_COOLDOWN_MS);
        }
      }

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
      if (s.cmdRules.head) {
        result = applyHeadRule(result);
      }
      if (s.cmdRules.tail) {
        result = applyTailRule(result);
      }

      // 编码前缀 — 检测是否已有编码设置（ShellFix 格式或其他格式），避免重复注入
      if (s.encoding &&
          !result.startsWith(ENCODING_PREFIX_PS) &&
          !result.startsWith(ENCODING_PREFIX_PWSH) &&
          !/^\s*(?:\$z=\[Text\.Encoding\]|\[Console\]::OutputEncoding\s*=|\[System\.Text\.UTF8Encoding\]|\$OutputEncoding\s*=)/i.test(result)) {
        result = `${tool === "pwsh" ? ENCODING_PREFIX_PWSH : ENCODING_PREFIX_PS}${result}`;
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
        case "my":
          text = handleMyCommand(args.trim());
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
        if (getCachedShouldInject(mod.name) && mod.content) {
          chunks.push(mod.content);
        }
      }

      // require 文本
      if (s.require) {
        chunks.push(s.require);
      }

      // ── 动态上下文注入（消费 pendingDynamic 缓存） ──────────
      if (s.pendingDynamic && s.pendingDynamic.length > 0) {
        const dynamicRules = getDynamicRules();
        const consumed: string[] = [];
        for (const id of s.pendingDynamic) {
          const rule = dynamicRules.find((r) => r.id === id);
          if (rule && rule.enabled && rule.context) {
            chunks.push(`[动态上下文 - ${rule.trigger}]\n${rule.context}`);
          }
          consumed.push(id);
        }
        // 清空已消费的 pendingDynamic
        s.pendingDynamic = s.pendingDynamic.filter((id) => !consumed.includes(id));
        saveState(s);
      }

      if (chunks.length > 0) {
        const separator = "\n\n---\n";
        out.content = out.content + separator + chunks.join("\n\n");
      }

      // 命令错误提醒：Agent 多次执行了不存在的命令时，提示改用 PowerShell 等效命令
      const cmdErrors = getCmdErrors();
      const frequentErrors = cmdErrors.filter((e) => e.count >= 2);
      if (frequentErrors.length > 0) {
        const hints = frequentErrors.map((e) => `\`${e.cmd}\` (${e.count} 次)`).join("、");
        out.content += `\n\n[ShellFix] 注意：以下命令在 PowerShell 中不存在，请使用等效命令：${hints}。`;
      }

      // 安全提醒（v2.2.8）：将待提醒的安全警告注入 system prompt
      const pendingSafety = getPendingSafetyWarnings();
      if (pendingSafety.length > 0) {
        const warnings = pendingSafety
          .map((w) => `[ShellFix 安全提醒] ${w.message}`)
          .join("\n\n");
        out.content += `\n\n---\n${warnings}`;
        clearPendingSafetyWarnings();
      }

      // PwshCheck（v2.2.9）：检测到 PS 5.1 且未配置 pwsh，引导 Agent 询问用户
      const pwshPending = s.pwshCheck.pending && s.pwshCheck.dismissed === "pending";
      if (pwshPending) {
        out.content += `\n\n---\n\n[ShellFix 系统配置]
检测到 OpenCode 当前使用 Windows PowerShell 5.1。
建议切换为 pwsh（PowerShell 7）以获得完整 PS7 API 支持、UTF-8 编码和 Profile 加载。

请询问用户是否要处理：
1. "改" → 编辑 ~/.config/opencode/opencode.jsonc，在 "$schema" 下方添加 "shell": "pwsh",，然后告知用户需重启生效
2. "以后再说" → 将 ~/.config/opencode/shellfix-state.json 中 pwshCheck.dismissed 改为 "dismissed"
3. "不再提醒" → 将 shellfix-state.json 中 pwshCheck.dismissed 改为 "forever"`;
        s.pwshCheck.pending = false;
        saveState(s);
      }

      // 没有可注入的内容 + 没有待提醒 → 无需修改系统提示
      if (chunks.length === 0 && frequentErrors.length === 0 && pendingSafety.length === 0 && !pwshPending) {
        // 仅 prompt 模式且已注入 chunks 才追加引导语（否则 return）
        return;
      }

      // prompt 模式：追加提示引导
      if (s.autoMode === "prompt" && chunks.length > 0) {
        out.content +=
          "\n\n[注] 以上为 ShellFix 自动注入的上下文。用 /auto 查看和管理。";
      }
    },

    // ================================================================
    // 钩子 E: chat.message — 动态上下文直接注入用户消息
    // ================================================================
    "chat.message": async (_input, output) => {
      const s = loadState();
      if (!s.pendingDynamic || s.pendingDynamic.length === 0) return;

      const parts = (output as any).parts as { type: string; text?: string }[] | undefined;
      if (!parts) return;

      const dynamicRules = getDynamicRules();
      const injected: string[] = [];

      for (const id of s.pendingDynamic) {
        const rule = dynamicRules.find((r) => r.id === id);
        if (!rule || !rule.enabled || !rule.context) continue;
        if (isDynamicOnCooldown(rule)) continue;

        parts.push({
          type: "text",
          text: `\n[动态上下文 - ${rule.trigger}]\n${rule.context}`,
        });
        markDynamicTriggered(rule.id);
        injected.push(id);
      }

      if (injected.length > 0) {
        s.pendingDynamic = s.pendingDynamic.filter((id) => !injected.includes(id));
        saveState(s);
      }
    },

    // ================================================================
    // 钩子 F: experimental.session.compacting — 保护注入上下文不丢失
    // ================================================================
    "experimental.session.compacting": async (_input, output) => {
      const s = loadState();
      const out = output as { context?: string[]; prompt?: string };
      const chunks: string[] = [];

      // 保留活跃的注入模块内容（含条件检查）
      for (const mod of AUTO_MODULES) {
        if (getCachedShouldInject(mod.name) && mod.content) {
          chunks.push(`[模块: ${mod.name}]\n${mod.content}`);
        }
      }

      // 保留 require
      if (s.require) {
        chunks.push(`[当前任务]\n${s.require}`);
      }

      if (chunks.length > 0) {
        out.context = [
          ...(out.context || []),
          "--- ShellFix 活跃注入上下文 ---",
          ...chunks,
        ];
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

function applyHeadRule(cmd: string): string {
  return cmd.replace(HEAD_RE, (_m, pipePrefix, num) => {
    const n = num ? parseInt(num, 10) : 10;
    return `${pipePrefix}Select-Object -First ${n}`;
  });
}

function applyTailRule(cmd: string): string {
  return cmd.replace(TAIL_RE, (_m, pipePrefix, num) => {
    const n = num ? parseInt(num, 10) : 10;
    return `${pipePrefix}Select-Object -Last ${n}`;
  });
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

// ====================================================================
// 条件评估缓存
// ====================================================================

let _conditionCache: Record<string, boolean> | null = null;

function getCachedShouldInject(modName: string): boolean {
  if (_conditionCache === null) {
    _conditionCache = {};
    for (const mod of AUTO_MODULES) {
      _conditionCache[mod.name] = shouldInjectModule(mod.name);
    }
  }
  return _conditionCache[modName] ?? false;
}

function clearConditionCache(): void {
  _conditionCache = null;
}

// ====================================================================
// 条件评估引擎
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

/** 评估单条条件是否匹配当前环境 */
function evaluateCondition(cond: InjectCondition): boolean {
  if (!cond.enabled) return true;

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
  if (!s.autoRules.some((r) => r.module === modName && r.trigger === "session_start" && r.enabled)) return false;

  const conditions = s.moduleConditions[modName];
  if (!conditions || conditions.length === 0) return true;

  return conditions.every((c) => evaluateCondition(c));
}

/** 获取当前实际活跃的注入模块名（经过条件过滤） */
function getActiveInjectModules(): string[] {
  return AUTO_MODULES
    .filter((m) => getCachedShouldInject(m.name))
    .map((m) => m.name);
}

/** 统计条件生效数量 */
function countActiveConditions(): number {
  const s = loadState();
  let total = 0, active = 0;
  for (const mod of AUTO_MODULES) {
    const conds = s.moduleConditions[mod.name];
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
    case "edit": {
      const name = tokens[1];
      if (!name) return "用法: /my edit <name> [新内容]";
      const tmpl = getTemplate(name);
      if (!tmpl) return `模板 "${name}" 不存在。`;
      const content = tokens.slice(2).join(" ");
      if (content) {
        saveTemplate({ name, template: content, description: tmpl.description });
        return `模板 "${name}" 已更新。`;
      }
      return `模板: ${name}\n描述: ${tmpl.description || ""}\n\n当前内容:\n${tmpl.template}\n\n---\n用 /my edit ${name} <新内容> 保存`;
    }
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

  // /my sync --push
  if (flags.has("--push")) {
    const config = getSyncConfig();
    if (!config.repoUrl) return "未配置远程仓库。先用 /my sync-config set repo_url <url> 配置。";
    const templateNames = args.filter((a) => !a.startsWith("--") && a !== sub);
    const result: PushResult = pushTemplatesToRemote(templateNames);
    const lines: string[] = [];
    lines.push(`╔══════════════════════════════════════╗`);
    lines.push(`║ 远程模板推送                          ║`);
    lines.push(`╠══════════════════════════════════════╣`);
    lines.push(`║ ${result.message.padEnd(38)}║`);
    if (result.success) {
      lines.push(`║                                      ║`);
      lines.push(`║  已推送: ${String(result.pushed).padStart(2)} 个模板                ║`);
    }
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
// 支柱四：注入系统（in）
// ====================================================================

function handleAutoCommand(args: string): string {
  // 清除条件缓存，确保下次 system.transform 使用最新状态
  clearConditionCache();
  if (!args) {
    const s = loadState();
    const enabled = getEnabledAutoModules();
    const modeLabel = { prompt: "引导", auto: "静默", silent: "关闭" };
    const lines: string[] = [];
    lines.push(`╔══════════════════════════════════════╗`);
    lines.push(`║ ShellFix 注入系统                    ║`);
    lines.push(`╠══════════════════════════════════════╣`);
    lines.push(`║ 模式: ${s.autoMode} (${modeLabel[s.autoMode]})              ║`);
    lines.push(`║                                      ║`);
    for (const mod of AUTO_MODULES) {
      const on = enabled.includes(mod.name) ? "[ON]" : "    ";
      lines.push(`║  ${on} ${mod.label.padEnd(14)} ${mod.name.padEnd(16)}║`);
    }
    if (s.require) {
      lines.push(`║                                      ║`);
      lines.push(`║  require: ${s.require.slice(0, 34).padEnd(34)}║`);
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
    lines.push(`\n模式: ${s.autoMode}`);
    if (s.require) {
      lines.push(`require: ${s.require}`);
    }
    const totalConds = Object.values(s.moduleConditions).reduce((s2, arr) => s2 + arr.length, 0);
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
    const autoRule = s.autoRules.find((r) => r.module === mod.name && r.trigger === "session_start");
    const current = autoRule ? autoRule.enabled : mod.defaultOn;
    const newVal = !current;
    setAutoModule(mod.name, newVal);
    clearConditionCache();
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

  // /auto rule — AutoRuleV2 管理
  if (first === "rule") {
    return handleAutoRuleServer(tokens.slice(1));
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
    const totalConds = Object.values(s.moduleConditions).reduce((sum, arr) => sum + arr.length, 0);
    if (totalConds === 0) {
      return "未配置条件。使用默认条件（模块定义内置）。\n/auto conditions <module> 查看具体模块。";
    }
    const lines: string[] = [];
    lines.push(`条件配置 (共 ${totalConds} 条)：\n`);
    for (const mod of AUTO_MODULES) {
      const conds = s.moduleConditions[mod.name];
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
    if (Number.isNaN(idx)) return `用法: /auto conditions ${modName} rm <index>`;
    if (removeModuleCondition(modName, idx)) {
      return `${modName}: 已删除条件 [${idx}]`;
    }
    return `删除失败: 索引 ${idx} 无效`;
  }

  // /auto conditions <module> toggle <index>
  if (sub === "toggle" || sub === "tog") {
    const idx = parseInt(rest[1], 10);
    if (Number.isNaN(idx)) return `用法: /auto conditions ${modName} toggle <index>`;
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





function handleAutoRuleServer(args: string[]): string {
  if (args.length === 0) {
    const rules = getAutoRules();
    if (rules.length === 0) return "暂无 AutoRule。\n用法: /auto rule add <module> [trigger]";
    const lines: string[] = [`AutoRuleV2 规则 (${rules.length} 条)：`];
    for (const rule of rules) {
      const icon = rule.enabled ? "✅" : "⏸️";
      lines.push(`  ${icon} [${rule.trigger}] ${rule.module} (${rule.id})`);
    }
    return lines.join("\n");
  }

  const first = args[0];

  if (first === "add") {
    const module = args[1];
    const trigger = (args[2] || "session_start") as "session_start" | "user_input";
    if (!module) return "用法: /auto rule add <module> [trigger]";
    const id = addAutoRule({ trigger, module, conditions: [], enabled: true, priority: 50 });
    return `AutoRule 已添加: ${module} (${id})`;
  }

  if (first === "rm") {
    const id = args[1];
    if (!id) return "用法: /auto rule rm <id>";
    if (removeAutoRule(id)) return `规则已删除: ${id}`;
    return `规则不存在: ${id}`;
  }

  if (first === "on") {
    const id = args[1];
    if (!id) return "用法: /auto rule on <id>";
    const rules = getAutoRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) return `规则不存在: ${id}`;
    if (!rule.enabled) toggleAutoRule(id);
    return `规则已开启: ${rule.module}`;
  }

  if (first === "off") {
    const id = args[1];
    if (!id) return "用法: /auto rule off <id>";
    const rules = getAutoRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) return `规则不存在: ${id}`;
    if (rule.enabled) toggleAutoRule(id);
    return `规则已关闭: ${rule.module}`;
  }

  return "用法: /auto rule add|rm|on|off";
}
