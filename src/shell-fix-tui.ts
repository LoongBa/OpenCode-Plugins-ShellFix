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

// ====================================================================
// TUI 插件类型（自包含，避免依赖 @opencode-ai/plugin/tui）
// ====================================================================

type TuiApi = {
  keymap: {
    registerLayer(layer: {
      commands: TuiCommand[];
    }): void;
  };
  client?: {
    tui?: {
      appendPrompt?(opts: { text: string }): Promise<void>;
      executeCommand?(opts: { command: string }): Promise<void>;
    };
  };
  ui?: {
    toast?(opts: { message: string }): void;
    dialog?: {
      clear?(): void;
      replace?(fn: () => any): void;
      DialogSelect?(opts: any): any;
      DialogPrompt?(opts: any): any;
    };
  };
};

type TuiCommand = {
  name: string;
  title: string;
  category: string;
  namespace: string;
  slashName?: string;
  run(): void;
};

type TuiPlugin = (api: TuiApi, options?: any, meta?: any) => Promise<void>;

type TuiPluginModule = {
  id?: string;
  tui: TuiPlugin;
};

// ====================================================================
// 导入 lib 模块（纯 TypeScript，零 OpenCode 依赖）
// ====================================================================

import {
  loadState,
  saveState,
  toggleCmdRule,
  setCmdRule,
  toggleEncoding,
  toggleLog,
  CMD_RULES_META,
  setAutoModule,
  setAutoMode,
  setAutoRequire,
  getEnabledAutoModules,
  getModuleConditions,
  addModuleCondition,
  removeModuleCondition,
  toggleModuleCondition,
  clearModuleConditions,
  PLUGIN_VERSION,
  toggleShowVersion,
  getKickmeRules,
  type CmdRuleName,
  type AutoMode,
  type InjectCondition,
  getAutoRules,
  addAutoRule,
  removeAutoRule,
  toggleAutoRule,
  type AutoRuleV2,
  getCmdErrors,
  clearCmdErrors,
  markCmdErrorNotified,
  type CmdErrorEntry,
} from "./lib/state";

import {
  listTemplates,
  getTemplate,
  saveTemplate,
  renderTemplate,
  listNotes,
  getNote,
  saveNote,
} from "./lib/template-store";

import {
  AUTO_MODULES,
  getAutoModule,
  getDefaultEnabledModules,
} from "./lib/auto-rules";

/** ShellFix palette 分组标题（唯一显示版本号的地方） */
const SHELLFIX_CATEGORY = `ShellFix v${PLUGIN_VERSION}`;

// ====================================================================
// 类型定义
// ====================================================================

type DispatchResult = {
  output?: string;  // → appendPrompt（填入输入框）
  toast?: string;   // → showToast（瞬时通知）
  dialog?: string;  // → 弹窗显示状态面板 / 信息
};

type LocalHandler = (args: string) => DispatchResult | null;
// null = 未处理，回退到服务器

// ====================================================================
// 常量
// ====================================================================

const PLUGIN_NAME = "ShellFix";

// ====================================================================
// 进程级缓存（不持久化）
// ====================================================================

/** 缓存已移除，仅保留 my 和 auto 本地处理器 */

// ====================================================================
// 本地处理器注册表
// ====================================================================

const handlers = new Map<string, LocalHandler>();

// ── /shellfix ──────────────────────────────────────────────────────

// ── /my ────────────────────────────────────────────────────────────

handlers.set("my", (args: string): DispatchResult | null => {
  if (!args) return { output: "ShellFix 模板系统\n用法: /my ? 浏览 /my <name> [args] 执行" };

  const tokens = args.split(/\s+/);
  const first = tokens[0];

  // 查询模式
  if (first === "?") {
    const rest = tokens.slice(1).join(" ");
    if (!rest) {
      const all = listTemplates() || [];
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
    const all = listTemplates() || [];
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
    lines.push(`\n模式: ${s.autoMode} (${AUTO_MODE_LABEL[s.autoMode]})`);
    if (s.require) lines.push(`require: ${s.require}`);
    return { output: lines.join("\n") };
  }

  // /auto <module> — toggle
  const mod = getAutoModule(first);
  if (mod) {
    const s = loadState();
    const autoRule = s.autoRules.find((r) => r.module === mod.name && r.trigger === "session_start");
    const current = autoRule ? autoRule.enabled : mod.defaultOn;
    setAutoModule(mod.name, !current);
    return { toast: `${mod.label}: ${!current ? "ON ✅" : "OFF"}` };
  }

  // /auto mode
  if (first === "mode") {
    const mode = tokens[1] as AutoMode | undefined;
    if (!mode || !["prompt", "auto", "silent"].includes(mode)) {
      return { output: `用法: /auto mode prompt|auto|silent\n当前: ${loadState().autoMode}` };
    }
    setAutoMode(mode);
    return { toast: `模式: ${mode}` };
  }

  // /auto require
  if (first === "require" || first === "req") {
    const text = tokens.slice(1).join(" ");
    if (!text) {
      const current = loadState().require;
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
      const conds = s.moduleConditions[mod.name];
      if (conds) total += conds.length;
    }
    if (total === 0) return { output: "未配置条件。使用默认条件。\n/auto conditions <module> 查看。" };
    const lines: string[] = [`条件配置 (共 ${total} 条)：\n`];
    for (const mod of AUTO_MODULES) {
      const conds = s.moduleConditions[mod.name];
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
  lines.push(`║ 模式: ${s.autoMode} (${AUTO_MODE_LABEL[s.autoMode]})              ║`);
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
  lines.push(`║  /auto help         查看全部子命令     ║`);
  lines.push(`╚══════════════════════════════════════╝`);
  return { output: lines.join("\n") };
}

// ====================================================================

// dynamic/kickme/shellfix handlers removed — only my and auto remain

// ====================================================================
// 调度器
// ====================================================================

/** 移除面板的 Unicode 框线字符（对话框比例字体下对齐错乱） */
function stripBoxChars(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^[╔╗║╚╝╠╣╩╦═╧\s]+/, "").replace(/[╔╗║╚╝╠╣╩╦═╧\s]+$/, ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * 尝试本地处理命令（仅 palette 路径调用）。
 * 输出结果通过 dialog 或 toast 展示，不再 appendPrompt 填入输入框。
 */
async function dispatch(api: any, cmd: string, args: string): Promise<boolean> {
  const handler = handlers.get(cmd);
  if (handler) {
    try {
      const result = handler(args);
      if (result) {
        if (result.output && api.ui?.dialog?.replace) {
          api.ui.dialog.replace(() =>
            api.ui.DialogAlert({
              title: `${PLUGIN_NAME} v${PLUGIN_VERSION} — ${cmd}`,
              message: stripBoxChars(result.output),
            })
          );
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
  try {
    if (!api?.keymap?.registerLayer) {
      console.error(`[ShellFix] TUI keymap API missing — plugin disabled`);
      return;
    }
    api.keymap.registerLayer({
    commands: [
      // ── ShellFix 各子命令（独立 palette 入口） ────────────────
      {
        name: "shellfix",
        title: `ShellFix status 状态总览`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showShellFixStatus(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.status):`, e); }
        },
      },
      {
        name: "shellfix.encoding",
        title: `ShellFix encoding 中文不乱码`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showToggleInfo(api, "encoding", toggleEncoding); } catch (e) { console.error(`[ShellFix] palette error (shellfix.encoding):`, e); }
        },
      },
      {
        name: "shellfix.bash",
        title: `ShellFix bash 适配 Powershell 避免出错`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showCmdRules(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.bash):`, e); }
        },
      },
      {
        name: "shellfix.log",
        title: `ShellFix log 记录操作信息`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showToggleInfo(api, "log", toggleLog); } catch (e) { console.error(`[ShellFix] palette error (shellfix.log):`, e); }
        },
      },
      {
        name: "shellfix.git-env",
        title: `ShellFix git-env 避免等待交互`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showGitEnv(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.git-env):`, e); }
        },
      },
      {
        name: "shellfix.git-eol",
        title: `ShellFix git-eol 避免换行警告`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showGitLineEnding(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.git-eol):`, e); }
        },
      },
      {
        name: "shellfix.kickme",
        title: `ShellFix kickme 关键词通知`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showKickme(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.kickme):`, e); }
        },
      },
      {
        name: "shellfix.banner",
        title: `ShellFix banner 启动版本信息`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showToggleInfo(api, "banner", toggleShowVersion); } catch (e) { console.error(`[ShellFix] palette error (shellfix.banner):`, e); }
        },
      },
      {
        name: "shellfix.sysinfo",
        title: `ShellFix sysinfo 查看系统信息`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showDoctor(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.sysinfo):`, e); }
        },
      },
      {
        name: "shellfix.about",
        title: `ShellFix about 版本与更新`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showAbout(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.about):`, e); }
        },
      },
      {
        name: "shellfix.help",
        title: `ShellFix help 命令参考`,
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showShellFixHelp(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.help):`, e); }
        },
      },
      {
        name: "shellfix.cmd-errors",
        title: "ShellFix cmd-errors 命令错误日志",
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showCmdErrors(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.cmd-errors):`, e); }
        },
      },

      // ── /my ──────────────────────────────────────────────────────
      {
        name: "shellfix.my",
        title: "ShellFix my 预设文本模板",
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        slashName: "my",
        run() {
          try { showTemplateSystem(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.my):`, e); }
        },
      },

      // ── /auto ────────────────────────────────────────────────────
      {
        name: "shellfix.note",
        title: "ShellFix note 笔记标签",
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        run() {
          try { showNoteSystem(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.note):`, e); }
        },
      },
      {
        name: "shellfix.auto",
        title: "ShellFix auto 自动注入上下文",
        category: SHELLFIX_CATEGORY,
        namespace: "palette",
        slashName: "auto",
        run() {
          try { showAutoSystem(api); } catch (e) { console.error(`[ShellFix] palette error (shellfix.auto):`, e); }
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
  // 事件钩子已简化 —— note/kickme/dynamic 订阅已移除

  // ── 会话级自动注入（mode === "prompt" 时弹窗） ─────────────
  // 暂时禁用：OpenCode DialogSelect 在 init 阶段渲染会崩溃
  // V3 改为手动 palette 管理
  // const s0 = loadState();
  // if (s0.autoMode === "prompt") {
  //   setTimeout(() => {
  //     try { showSessionModuleDialog(api); } catch {}
  //   }, 800);
  // }
  } catch (e) {
    console.error(`[ShellFix] TUI plugin initialization failed:`, e);
  }
};

/**
 * 会话级模块选择弹窗 — 多轮选择直到用户点「完成」
 * 选择的模块通过 setAutoModule 持久化，system.transform 钩子自动生效
 */
function showSessionModuleDialog(api: any): void {
  try {
    const current = getEnabledAutoModules();
    const modules = AUTO_MODULES || [];
    const options = modules.map((mod) => ({
      label: `${current.includes(mod.name) ? "ON " : "OFF"} ${mod.label}`,
      value: mod.name,
      description: mod.description || "",
    }));
    options.unshift({
      label: "完成选择",
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
          const fresh = getEnabledAutoModules();
          const newEnabled = fresh.includes(value)
            ? fresh.filter((n) => n !== value)
            : [...fresh, value];
          for (const mod of AUTO_MODULES) {
            setAutoModule(mod.name, newEnabled.includes(mod.name));
          }
          showSessionModuleDialog(api);
        },
        onCancel: () => api.ui.dialog?.clear?.(),
      })
    );
  } catch { /* TUI 渲染保护 */ }
}

/**
 * 模板系统 — palette 交互
 * 展示帮助/示例 + 当前状态，然后提供模板操作。
 */
function showTemplateSystem(api: any): void {
  try {
    api.ui.dialog?.clear?.();
    const all = (listTemplates() || []) as TemplateEntry[];
    const builtinCount = all.filter((t) => t.builtin).length;
    const userCount = all.length - builtinCount;
    const lines: string[] = [
      `模板系统 — 保存和执行预设文本模板`,
      ``,
      `内置: ${builtinCount} 个 | 用户: ${userCount} 个`,
      ``,
      ...all.slice(0, 20).map((t) => `  ${t.name}${t.builtin ? "" : " *"}  ${(t.description || "").slice(0, 40)}`),
      userCount > 0 ? `` : ``,
      userCount > 0 ? `  * 用户自定义` : ``,
      ``,
      `用法（斜杠命令，通过 LLM 执行）：`,
      `  /my ?              浏览所有模板`,
      `  /my <模板名> [参数]  执行模板`,
      `  /my edit <模板名>   编辑模板`,
      `  /my save <模板名>   保存新模板`,
      `  /my rm <模板名>     删除模板`,
    ];
    if (all.length > 0) {
      api.ui.dialog?.replace?.(() =>
        api.ui.DialogAlert({
          title: `ShellFix my 模板系统`,
          message: lines.join("\n"),
        })
      );
    } else {
      api.ui.toast({ message: "暂无模板" });
    }
  } catch (e) {
    console.error(`[ShellFix] showTemplateSystem error:`, e);
  }
}

/** 模板使用帮助 + 示例 */
function showTemplateHelp(api: any, all: any[]): void {
  const lines = [
    `模板系统 — 保存和执行预设文本模板`,
    ``,
    `用法：/my <模板名> [参数...]`,
    `      Ctrl+P → 选择 ShellFix my 模板`,
    ``,
    `示例：`,
    `  /my review          → 填入 Code Review Checklist`,
    `  /my commit          → 填入 Commit Message 模板`,
    `  /my explain         → 填入"解释这段代码"`,
    `  /my save mynote ... → 保存新模板`,
    `  /my rm mynote       → 删除模板`,
    ``,
    `内置模板数: ${all.filter((t: any) => t.builtin).length}`,
    `用户模板:   ${all.filter((t: any) => !t.builtin).length}`,
  ];
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "模板系统 — 使用帮助",
      message: lines.join("\n"),
      onConfirm: () => { try { showTemplateSystem(api); } catch (e) { console.error(`[ShellFix] templateHelp onConfirm error:`, e); } },
    })
  );
}

/** 模板编辑子流程：选择模板 → 修改内容 → 保存 */
function showTemplateEditor(api: any, all: any[]): void {
  try {
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
          try {
            const tmpl = getTemplate(editName);
            if (!tmpl) { api.ui.toast({ message: "不存在" }); return; }
            api.ui.dialog?.replace?.(() =>
              api.ui.DialogPrompt({
                title: `编辑模板 "${editName}"`,
                label: "新内容:",
                defaultText: tmpl.template,
                onConfirm: (content: string) => {
                  try {
                    if (content.trim()) {
                      saveTemplate({ name: editName, template: content, description: tmpl.description });
                      api.ui.toast({ message: `模板 "${editName}" 已更新` });
                    } else {
                      api.ui.toast({ message: "内容不能为空" });
                    }
                  } catch (e) {
                    console.error(`[ShellFix] save template error:`, e);
                    api.ui.toast({ message: "保存失败" });
                  }
                  api.ui.dialog?.clear?.();
                },
                onCancel: () => api.ui.dialog?.clear?.(),
              })
            );
          } catch (e) {
            console.error(`[ShellFix] template editor select error:`, e);
            api.ui.toast({ message: "编辑异常" });
            api.ui.dialog?.clear?.();
          }
        },
        onCancel: () => api.ui.dialog?.clear?.(),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showTemplateEditor error:`, e);
    api.ui.toast({ message: "编辑界面异常" });
  }
}

/** 查看全部模板 → 发 /my ? 到服务器 */
function showTemplateList(api: any): void {
  dispatch(api, "my", "?").then((handled) => {
    if (!handled) api.client?.tui?.executeCommand?.({ command: "|my ?" });
  });
}

/** 渲染并填入输入框：有参数则弹窗输入，无参数直接渲染 */
function showTemplateRender(api: any, name: string): void {
  try {
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
            try {
              const args = input.trim().split(/\s+/);
              const rendered = renderTemplate(tmpl.template, args);
              if (rendered) {
                api.client?.tui?.appendPrompt?.({ text: rendered });
              } else {
                api.ui.toast({ message: "渲染失败" });
              }
            } catch (e) {
              console.error(`[ShellFix] templateRender onConfirm error:`, e);
              api.ui.toast({ message: "模板渲染异常" });
            }
            api.ui.dialog?.clear?.();
          },
          onCancel: () => api.ui.dialog?.clear?.(),
        })
      );
    } else {
      const rendered = renderTemplate(tmpl.template, []);
      if (rendered) {
        api.client?.tui?.appendPrompt?.({ text: rendered });
      } else {
        api.ui.toast({ message: "渲染失败" });
      }
      api.ui.dialog?.clear?.();
    }
  } catch (e) {
    console.error(`[ShellFix] showTemplateRender error:`, e);
    api.ui.toast({ message: "模板渲染异常" });
  }
}

/**
 * 自动化系统 — palette 交互
 * 显示帮助/状态总览 + 模块管理入口。
 */
function showAutoSystem(api: any): void {
  try {
    api.ui.dialog?.clear?.();
    const s = loadState() || {} as any;
    const enabled = getEnabledAutoModules();
    const lines: string[] = [
      `自动化系统 — 自动注入上下文到 System Prompt`,
      ``,
      `模式: ${s.autoMode}`,
      `已开启 ${enabled.length}/${AUTO_MODULES.length} 个模块`,
      ``,
      ...AUTO_MODULES.map((mod) => {
        const on = enabled.includes(mod.name) ? "✅" : "  ";
        return `  ${on} ${mod.label.padEnd(10)} ${mod.description}`;
      }),
      ``,
      `用法（斜杠命令，通过 LLM 执行）：`,
      `  /auto list             列出模块状态`,
      `  /auto <模块名>          开关模块`,
      `  /auto mode prompt|auto|silent  设置模式`,
      `  /auto require <文本>    注入任务目标`,
      `  /auto conditions        条件管理`,
    ];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: `ShellFix auto 自动注入上下文`,
        message: lines.join("\n"),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showAutoSystem error:`, e);
  }
}

/** 笔记标签系统 — palette 交互，显示用法 + 当前标签 */
function showNoteSystem(api: any): void {
  api.ui.dialog?.clear?.();
  const all = listNotes();
  const lines = [
    `笔记标签系统 — 用 #标签# 记录关键信息`,
    ``,
    `当前: ${all.length} 条笔记`,
    all.length > 0
      ? all.slice(0, 10).map((n: any) => `  ${n.tag} → ${(n.content || "").slice(0, 40)}`).join("\n")
      : `  (暂无笔记)`,
    ``,
    `用法：/note ?              列出所有标签`,
    `      /note #标签#           取出笔记到输入框`,
    `      /note #标签#:内容      保存笔记`,
    `      /note #标签#:last      保存上一条消息`,
    `      /note rm #标签#        删除笔记`,
  ];
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "ShellFix note 笔记标签",
      message: lines.join("\n"),
    })
  );
}

/** 自动化系统使用帮助 + 示例 */
function showAutoHelp(api: any): void {
  try {
    const s = loadState() || {} as any;
    const enabled = getEnabledAutoModules();
    const lines = [
      `自动化系统 — 自动注入上下文到 System Prompt`,
      ``,
      `模式：${s.autoMode}`,
      `  auto    自动注入，不提示`,
      `  prompt  启动时引导选择模块`,
      `  silent  不注入`,
      ``,
      `已开启 ${enabled.length}/${AUTO_MODULES.length} 个模块：`,
      ...AUTO_MODULES.filter((m) => enabled.includes(m.name)).map((m) => `  ${m.label} — ${m.description}`),
      ``,
      `用法：/auto list  查看完整列表`,
      `      /auto <模块名>  开关模块`,
      `      /auto mode prompt|auto|silent`,
    ];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: "自动化系统 — 使用帮助",
        message: lines.join("\n"),
        onConfirm: () => { try { showAutoSystem(api); } catch (e) { console.error(`[ShellFix] autoHelp onConfirm error:`, e); } },
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showAutoHelp error:`, e);
  }
}

/** 自动化模式选择子流程 */
function showAutoModeSelector(api: any): void {
  try {
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogSelect({
        title: "选择模式",
        options: [
          { label: "auto 静默", value: "auto", description: "自动注入，不提示" },
          { label: "prompt 引导", value: "prompt", description: "启动时引导用户选择" },
          { label: "silent 关闭", value: "silent", description: "不注入" },
        ],
        onSelect: (mode: string) => {
          try {
            setAutoMode(mode as AutoMode);
            api.ui.toast({ message: `模式: ${mode}` });
          } catch (e) {
            console.error(`[ShellFix] autoModeSelector onSelect error:`, e);
          }
          api.ui.dialog?.clear?.();
        },
        onCancel: () => api.ui.dialog?.clear?.(),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showAutoModeSelector error:`, e);
  }
}

/** 查看全部自动化模块 → 发 /auto list 到服务器 */
function showAutoModuleList(api: any): void {
  dispatch(api, "auto", "list").then((handled) => {
    if (!handled) api.client?.tui?.executeCommand?.({ command: "|auto list" });
  });
}

// ====================================================================
// ShellFix 设置面板 — palette 辅助函数
// ====================================================================

function getEnabledRuleCount(s: any): number {
  return Object.values(s.cmdRules || {}).filter(Boolean).length;
}

function toggleAndToast(api: any, label: string, newState: boolean): void {
  api.ui.toast({ message: `${label}: ${newState ? "ON" : "OFF"}` });
  api.ui.dialog?.clear?.();
}

/** 显示当前状态 + 描述，确认后切换 */
const TOGGLE_META: Record<string, { label: string; desc: string; stateKey?: string }> = {
  encoding: { label: "编码注入", desc: "每条命令前自动注入 UTF-8 编码设置，解决中文乱码" },
  log: { label: "日志", desc: "开关控制台日志输出，用于调试" },
  banner: { label: "启动版本信息", desc: "OpenCode 启动时显示 ShellFix vX.X.X loaded", stateKey: "showVersion" },
};

function showToggleInfo(api: any, key: string, toggleFn: () => boolean): void {
  try {
    const s = loadState() || {} as any;
    const meta = TOGGLE_META[key];
    const label = meta?.label || key;
    const desc = meta?.desc || "";
    const stateKey = meta?.stateKey || key;
    const current = s[stateKey];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: `ShellFix ${key} ${label}`,
        message: `${desc}\n\n当前: ${current ? "ON" : "OFF"}\n\n点击确认切换`,
        onConfirm: () => {
          try {
            const next = toggleFn();
            api.ui.toast({ message: `${label}: ${next ? "ON" : "OFF"}` });
          } catch (e) {
            console.error(`[ShellFix] toggle onConfirm error:`, e);
          }
          api.ui.dialog?.clear?.();
        },
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showToggleInfo error:`, e);
  }
}

/** Git 非交互变量 — 展示已注入的 16 个环境变量 */
function showGitEnv(api: any): void {
  const vars = [
    "CI=true",
    "GIT_TERMINAL_PROMPT=0",
    "GCM_INTERACTIVE=never",
    "GIT_EDITOR=:",
    "EDITOR=:",
    "VISUAL=",
    "GIT_SEQUENCE_EDITOR=:",
    "GIT_MERGE_AUTOEDIT=no",
    "GIT_PAGER=cat",
    "PAGER=cat",
    "DEBIAN_FRONTEND=noninteractive",
    "HOMEBREW_NO_AUTO_UPDATE=1",
    "npm_config_yes=true",
    "PIP_NO_INPUT=1",
    "YARN_ENABLE_IMMUTABLE_INSTALLS=false",
    "SHELLFIX_VERSION=" + PLUGIN_VERSION,
  ];
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "ShellFix git-env 非交互变量",
      message:
        `已注入 ${vars.length} 个环境变量，子进程自动继承。` +
        `相比官方 non-interactive-env 插件：不污染命令字符串，` +
        `每条命令省 ~150 tokens。\n\n` +
        vars.map((v) => `  ${v}`).join("\n") +
        `\n\n建议在 oh-my-openagent.jsonc 中禁用内置插件以避免重复注入：` +
        `\n"disabled_hooks": ["non-interactive-env"]` +
        `\n详见 README.md。`,
    })
  );
}

/** 关键词通知系统 — kickme 使用帮助 + 当前规则 */
function showKickme(api: any): void {
  const rules = getKickmeRules();
  const enabledCount = rules.filter((r) => r.enabled).length;
  const lines = [
    `关键词通知系统 kickme — 匹配关键词时弹气泡`,
    ``,
    `当前: ${rules.length} 条规则 (${enabledCount} 条启用)`,
    ``,
    `用法 (斜杠命令, 通过 LLM 执行):`,
    `  /kickme                   列出所有规则`,
    `  /kickme add <关键词> <标题> <消息> 添加规则`,
    `  /kickme rm <id>           删除规则`,
    `  /kickme on|off <id>       开关规则`,
    `  /kickme sound <id> on|off 开关提示音`,
    ``,
    `通知会在消息匹配时通过 api.ui.toast() 弹出。`,
    `V3 计划：Windows 系统弹窗 + MCP 集成。`,
  ];
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "ShellFix kickme 关键词通知",
      message: lines.join("\n"),
    })
  );
}

function showShellFixStatus(api: any): void {
  const s = loadState() || {} as any;
  const kickmeRules = getKickmeRules();
  const enabledKickme = kickmeRules.filter((r) => r.enabled).length;
  const lines: string[] = [
    `ShellFix v${PLUGIN_VERSION}`,
    ``,
    `  encoding       ${s.encoding ? "ON" : "OFF"}`,
    `  bash           ${getEnabledRuleCount(s)}/6`,
    `  log            ${s.log ? "ON" : "OFF"}`,
    `  git-env        16 env vars`,
    `  git-eol        ${s.gitLineEnding === "auto" ? "AUTO" : s.gitLineEnding === "config" ? "CONFIG" : "OFF"}`,
    `  kickme         ${kickmeRules.length} rules (${enabledKickme} on)`,
    `  banner         ${s.showVersion !== false ? "ON" : "OFF"}`,
  ];
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "ShellFix 状态总览",
      message: lines.join("\n"),
    })
  );
}

function showCmdRules(api: any): void {
  try {
    const s = loadState() || {} as any;
    const options = CMD_RULES_META.map((meta) => ({
      label: `${s.cmdRules[meta.name] ? "ON " : "OFF"} ${meta.label}`,
      value: meta.name,
      description: `${meta.description}`,
    }));
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogSelect({
        title: "命令替换规则 (点击切换)",
        options,
        onSelect: (value: string) => {
          try {
            setCmdRule(value as CmdRuleName, !s.cmdRules[value as CmdRuleName]);
            api.ui.toast({ message: `${CMD_RULES_META.find((m) => m.name === value)?.label || value}: ${!s.cmdRules[value as CmdRuleName] ? "ON" : "OFF"}` });
          } catch (e) {
            console.error(`[ShellFix] cmdRules onSelect error:`, e);
          }
          api.ui.dialog?.clear?.();
        },
        onCancel: () => api.ui.dialog?.clear?.(),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showCmdRules error:`, e);
  }
}

function showGitLineEnding(api: any): void {
  try {
    const s = loadState() || {} as any;
    const currentMode = s.gitLineEnding === "auto" ? "AUTO" : s.gitLineEnding === "config" ? "CONFIG" : "OFF";
    const lines: string[] = [
      `Git 换行符警告处理 — 静默 git diff/add 的换行符噪音`,
      ``,
      `当前: ${currentMode}`,
      ``,
      `  auto    环境变量注入，仅 OpenCode 进程内生效（推荐）`,
      `  config  生成 git config 命令供全局执行`,
      `  off     关闭，不处理换行符警告`,
      ``,
      `用法（斜杠命令，通过 LLM 执行）：`,
      `  /shellfix git-line-ending auto|config|off`,
    ];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: "ShellFix git-eol 换行符警告处理",
        message: lines.join("\n"),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showGitLineEnding error:`, e);
  }
}

function showDoctor(api: any): void {
  const os = require("os");
  const lines: string[] = [
    `ShellFix v${PLUGIN_VERSION} — 环境诊断`,
    ``,
    `OS:        ${os.platform()} ${os.release()}`,
    `Hostname:  ${os.hostname()}`,
    `Arch:      ${os.arch()}`,
    `Home:      ${os.homedir()}`,
  ];
  // 检测 shell 版本
  try {
    const { execSync } = require("child_process");
    if (os.platform() === "win32") {
      const psVer = execSync(
        'powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"',
        { encoding: "utf8", timeout: 5000 }
      ).trim();
      lines.push(`Shell:     PowerShell ${psVer}`);
    } else {
      const bashVer = execSync("bash --version | head -1", {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      lines.push(`Shell:     ${bashVer}`);
    }
  } catch {
    lines.push(`Shell:     (detection failed)`);
  }
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "环境诊断",
      message: lines.join("\n"),
    })
  );
}

/**
 * ShellFix 关于 — 显示版本信息并检测更新
 * 通过 GitHub API 查询最新版本号，与当前版本对比。
 */
async function showAbout(api: any): Promise<void> {
  try {
    const lines: string[] = [
      `ShellFix v${PLUGIN_VERSION}`,
      `OpenCode Windows PowerShell 插件`,
      ``,
      `功能：`,
      `  编码注入 — 中文不乱码`,
      `  命令规则 — export/which/touch 等自动转换`,
      `  日志开关`,
      `  Git 免交互 + 换行符静默`,
      `  模板系统`,
      `  自动化系统`,
      `  笔记标签`,
      `  通知系统 (kickme)`,
      ``,
      `项目: https://github.com/LoongBa/OpenCode-Plugins-ShellFix`,
      `作者：爱学习的龙爸`,
      `主页：https://loongba.cn`,
      ``,
      `正在检测更新...`,
    ];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: `ShellFix 关于 v${PLUGIN_VERSION}`,
        message: lines.join("\n"),
      })
    );
    // 异步检测更新
    try {
      const res = await fetch("https://api.github.com/repos/LoongBa/OpenCode-Plugins-ShellFix/releases/latest", {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      const latestTag: string = (data.tag_name || "").replace(/^v/, "");
      if (latestTag && latestTag !== PLUGIN_VERSION) {
        lines.pop();
        lines.push(``);
        lines.push(`📢 新版本可用: v${latestTag}`);
        lines.push(`   当前版本: v${PLUGIN_VERSION}`);
        lines.push(`   ${data.html_url || "https://github.com/LoongBa/OpenCode-Plugins-ShellFix/releases"}`);
      } else if (latestTag) {
        lines.pop();
        lines.push(``);
        lines.push(`✅ 已是最新版本 (v${PLUGIN_VERSION})`);
      } else {
        lines.pop();
        lines.push(``);
        lines.push(`⚠️ 无法获取版本信息`);
      }
    } catch {
      lines.pop();
      lines.push(``);
      lines.push(`⚠️ 检测更新失败（网络或 API 限制）`);
      lines.push(`   当前版本: v${PLUGIN_VERSION}`);
    }
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: `ShellFix 关于 v${PLUGIN_VERSION}`,
        message: lines.join("\n"),
      })
    );
  } catch (e) {
    console.error(`[ShellFix] showAbout error:`, e);
  }
}

function showShellFixHelp(api: any): void {
  const lines = [
    `ShellFix v${PLUGIN_VERSION} — palette 命令`,
    ``,
    `shellfix           status 状态总览`,
    `shellfix.encoding  encoding 中文不乱码`,
    `shellfix.bash      bash 适配 Powershell 避免出错`,
    `shellfix.log       log 记录操作信息`,
    `shellfix.git-env     git-env 避免等待交互`,
    `shellfix.git-eol    git-eol 避免换行警告`,
    `shellfix.sysinfo    sysinfo 查看系统信息`,
    `shellfix.about     about 版本与更新`,
    `shellfix.help      help 命令参考`,
    `shellfix.kickme    kickme 关键词通知`,
    `shellfix.banner    banner 启动版本信息`,
    `shellfix.my        my 预设文本模板`,
    `shellfix.note      note 笔记标签`,
    `shellfix.auto      auto 自动注入上下文`,
    `shellfix.cmd-errors cmd-errors 命令错误日志`,
    ``,
    `所有命令通过 Ctrl+P 访问。`,
  ];
  api.ui.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "ShellFix 帮助",
      message: lines.join("\n"),
    })
  );
}

/** 命令错误日志 — 查看 Agent 误用的非 PowerShell 命令 */
function showCmdErrors(api: any): void {
  try {
    const errors = getCmdErrors();
    if (errors.length === 0) {
      api.ui.toast({ message: "暂无命令错误记录" });
      return;
    }
    const lines: string[] = [
      `命令错误日志 — Agent 使用了不存在的 PowerShell 命令`,
      `共 ${errors.length} 个不同命令`,
      ``,
      ...errors.map((e) => {
        const icon = e.notified ? " " : "●";
        return `  ${icon} ${e.cmd.padEnd(16)} ${e.count} 次  ${e.lastSeen.slice(0, 10)}`;
      }),
      ``,
      `标记 ● = 尚未添加规则/提醒`,
      `ShellFix 会自动在 system prompt 中提醒 Agent 避免重复错误。`,
      `用 /shellfix bash 面板可开启对应命令替换规则。`,
    ];
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: "ShellFix cmd-errors 命令错误",
        message: lines.join("\n"),
        onConfirm: () => { clearCmdErrors(); api.ui.toast({ message: "日志已清除" }); },
      })
    );
    // 标记所有已查看
    for (const e of errors) {
      if (!e.notified) markCmdErrorNotified(e.cmd);
    }
  } catch (e) {
    console.error(`[ShellFix] showCmdErrors error:`, e);
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "shellfix",
  tui,
};

export default plugin;