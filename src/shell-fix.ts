/**
 * ShellFixPlugin
 * ==============
 * OpenCode 原生 TS 插件 —— Windows PowerShell 三大修复功能：
 *
 * 1. 中文不乱码 → 自动注入 $OutputEncoding + [Console]::OutputEncoding（tool.execute.before）
 * 2. export → $env:KEY="VAL" 转换（tool.execute.before）
 * 3. Git 免交互 → shell.env 进程级注入 CI 环境变量，无需写进命令字符串
 *
 * 依赖两个原生钩子，解耦三个需求：
 *   - shell.env         → 进程初始化时注入全局环境变量（只能设 env，不能拼命令）
 *   - tool.execute.before → 每条命令执行前拦截并转换 export 语法、注入编码前缀
 *
 * 注意：如果你的配置中启用了 oh-my-openagent 的 non-interactive-env 插件，
 * 建议禁用该插件，因为 ShellFix 的 shell.env 已覆盖同样功能，
 * 且不会将 $env: 变量写进命令字符串，避免命令前缀膨大。
 *
 * 安装方式：
 *   项目级： 复制到 .opencode/plugins/shell-fix.ts（自动发现）
 *   全局级： 复制到 ~/.config/opencode/plugins/shell-fix.ts（自动发现）
 *   npm：    引入 package 后在 opencode.json 的 plugin 数组注册路径
 *
 * 依赖：@opencode-ai/plugin（类型定义，仅开发时用，可选装）
 *   npm install --save-dev @opencode-ai/plugin
 */

// ====================================================================
// 类型定义（不依赖 @opencode-ai/plugin 也能工作，保留作为自文档）
// 生产环境推荐安装类型包获得 IDE 提示：
//   npm install --save-dev @opencode-ai/plugin
// ====================================================================
// import type { Plugin } from "@opencode-ai/plugin";

// 内联类型（零依赖方案，与 @opencode-ai/plugin v1.17.13 签名一致）
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
// 辅助函数
// ====================================================================

/**
 * 将值转义为 PowerShell 双引号字符串安全形式。
 *
 * PowerShell 双引号中需要转义三个字符：
 *   `  → ``  （反引号本身）
 *   $  → `$  （避免变量展开）
 *   "  → ""  （双引号自身）
 */
function escapePSDoubleQuoted(val: string): string {
  return val
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '""');
}

/**
 * 从 bash export 的 KEY=VAL 块中提取所有键值对，生成 PowerShell 赋值语句。
 *
 * 支持的 value 格式：
 *   KEY=bare_value
 *   KEY="double quoted value"
 *   KEY='single quoted value'
 *
 * @param kvBlock - export 语句中的键值对部分，如 `FOO=bar BAZ="hello world"`
 * @returns $env:KEY="VAL"; 拼接的字符串
 */
function parseExportKV(kvBlock: string): string[] {
  // 逐对解析，正则匹配完整的 KEY=VAL 单元
  // 支持引号包裹的值，不包括空格分隔
  const pairRe = /\w+=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  const assignments: string[] = [];

  let match: RegExpExecArray | null = pairRe.exec(kvBlock);
  while (match !== null) {
    const part = match[0];
    const eqIdx = part.indexOf("=");
    const key = part.slice(0, eqIdx);
    let val = part.slice(eqIdx + 1);

    // 去除外层引号
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
      // 解转义：\" → ", \\ → \
      val = val.replace(/\\(["\\])/g, "$1");
    }

    assignments.push(`$env:${key}="${escapePSDoubleQuoted(val)}";`);

    match = pairRe.exec(kvBlock);
  }

  return assignments;
}

/**
 * 对命令字符串中的 $env:KEY="VALUE" 赋值去重。
 *
 * bash 工具和 shell.env 可能各自注入同一批环境变量，
 * 导致命令前缀出现两套重复的变量块。
 * 此函数移除重复的赋值，只保留最后一次出现的值。
 *
 * 注意：仅匹配 $env: 后接单词字符的简单赋值模式，
 * 不影响命令体中的 $env: 引用（如 echo $env:PATH）。
 */
function dedupeEnvAssignments(cmd: string): string {
  // 匹配完整的 $env:KEY="VALUE"; 或 $env:KEY=VALUE; 赋值
  const seen = new Map<string, { index: number; len: number }>();
  const envRe = /\$env:(\w+)=(?:("(?:[^"\\]|\\.)*"|\S+?));/g;

  // 第一遍：记录每个 KEY 的最后一个出现位置
  for (let m = envRe.exec(cmd); m !== null; m = envRe.exec(cmd)) {
    seen.set(m[1], { index: m.index, len: m[0].length });
  }

  if (seen.size === 0) return cmd;

  // 第二遍：从右向左删除重复（保留最后出现的）
  const removed = new Set<string>();
  let result = cmd;
  // 从后往前处理，这样删除前面的不会影响后面位置的准确性
  const sorted = [...seen.entries()].sort(
    (a, b) => b[1].index - a[1].index,
  );
  for (const [key, pos] of sorted) {
    if (removed.has(key)) {
      // 删掉前面的重复项（包括后面的 ; 或空格）
      const after = result.slice(pos.index + pos.len);
      result = result.slice(0, pos.index) + after.replace(/^[;\s]*/, "");
    }
    removed.add(key);
  }

  return result;
}

/**
 * 判断 shell 命令是否以 export 开头（忽略前导空白）。
 */
const EXPORT_RE = /^\s*export\s+/;

/**
 * 完整的 export 行解析正则。
 *
 * 分组：
 *   [1] KEY=VAL 块（一个或多个键值对，空格分隔）
 *   [2] export 后的剩余命令（可选）
 *
 * 注意：仅匹配行首的 export，不会转换命令中间或注释中的 export。
 */
const EXPORT_LINE_RE =
  /^\s*export\s+((?:\w+=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)\s*)+)(.*)$/s;

// ====================================================================
// 编码前置脚本
//
// PowerShell 非交互子进程默认输出编码为当前系统代码页（Windows 常见 GBK），
// 导致中文乱码。每次命令前强制设置 $OutputEncoding 和 [Console]::OutputEncoding
// 为 UTF-8 确保管道和控制台输出正确。
//
// 注意：bash 工具不负责这个，必须由插件注入。
// 为了防止与 bash 工具叠加重复，注入前检测 startsWith。
// ====================================================================
const ENCODING_PREFIX =
  "$OutputEncoding=[Text.UTF8Encoding]::new($false);" +
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";

// ====================================================================
// 插件元信息
// ====================================================================
const PLUGIN_NAME = "ShellFix";
const PLUGIN_VERSION = "1.2.0";

// 特殊指令匹配：输入 #shellfix 或 /shellfix 触发状态显示
const SPECIAL_CMD_RE = /^\s*[/#]shellfix\b/;

// ====================================================================
// 非交互环境变量（shell.env 进程级注入）
//
// 通过 shell.env 钩子注入到进程环境，子进程自动继承。
// 不需要写进命令字符串，不会产生 $env:CI="true" 等前缀。
//
// 这些变量覆盖 oh-my-openagent 的 non-interactive-env 插件功能，
// 但用 shell.env 而非 tool.execute.before，避免命令字符串膨大。
// ====================================================================
const CI_ENV_VARS: Record<string, string> = {
  CI: "true",
  SHELLFIX_VERSION: PLUGIN_VERSION,    // 唯一标识，用于确认插件生效
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

// ====================================================================
// 插件主入口
// ====================================================================

export const ShellFixPlugin: Plugin = async () => {
  console.log(
    `[${PLUGIN_NAME}] v${PLUGIN_VERSION} loaded — ` +
      `encoding fix | export conversion | ${Object.keys(CI_ENV_VARS).length} non-interactive env vars`
  );

  return {
  // ================================================================
  // 钩子 A: shell.env
  //
  // 时机：每次 shell 进程初始化时触发（AI 工具 + 用户终端）。
  // 能力：仅注入环境变量到 output.env，不能拼接命令。
  // 注意：output 类型为 { env: Record<string, string> }，
  //       不存在 preCommand/vars 等字段（常见设计错误）。
  //
  // 真实 API 签名（@opencode-ai/plugin v1.17.13）：
  //   "shell.env"?:
  //     (input: { cwd: string; sessionID?: string; callID?: string },
  //      output: { env: Record<string, string> })
  //     => Promise<void>
  // ================================================================
  "shell.env": async (_input, output) => {
    const out = output as { env: Record<string, string> };
    for (const [key, val] of Object.entries(CI_ENV_VARS)) {
      out.env[key] = val;
    }
  },

  // ================================================================
  // 钩子 B: tool.execute.before
  //
  // 时机：每次工具调用前触发。
  // 能力：修改 output.args 来改写工具的参数。
  //
  //  三个职责：
  //   1. 注入 ENCODING_PREFIX → 中文不乱码
  //   2. 将行首 export 语法自动转换为 $env:KEY="VAL"
  //   3. /shellfix 指令显示状态
  //
  // 真实 API 签名（@opencode-ai/plugin v1.17.13）：
  //   "tool.execute.before"?:
  //     (input: { tool: string; sessionID: string; callID: string },
  //      output: { args: any })
  //     => Promise<void>
  // ================================================================
  "tool.execute.before": async (input, output) => {
    // 仅处理 bash/pwsh 工具，不影响其他工具
    const tool = (input as { tool: string }).tool;
    if (tool !== "bash" && tool !== "pwsh") return;

    const out = output as { args: Record<string, unknown> };
    const cmd: string | undefined = out.args?.command as string | undefined;
    if (typeof cmd !== "string") return;

    // ── 情况 A：命令以 export 开头 ──
    if (EXPORT_RE.test(cmd)) {
      const lineMatch = cmd.match(EXPORT_LINE_RE);
      if (lineMatch) {
        const kvBlock = lineMatch[1]; // KEY=VAL 块
        const suffix = (lineMatch[2] || "").trim(); // export 后的剩余内容

        const envAssignments = parseExportKV(kvBlock);

        // 仅做 export → $env: 转换并去重，bash 工具不负责编码
        let result = `${ENCODING_PREFIX}${envAssignments.join("")}${
          suffix ? ` ${suffix}` : ""
        }`;
        result = dedupeEnvAssignments(result);
        out.args.command = result;
      }
      // else: export 行格式异常无法解析 — 保持原样，bash 工具会加编码前缀
      return;
    }

    // ── 情况 Z：特殊指令 #shellfix / /shellfix —— 显示版本状态 ──
    if (SPECIAL_CMD_RE.test(cmd)) {
      out.args.command =
        `Write-Host "";` +
        `Write-Host "[${PLUGIN_NAME}] v${PLUGIN_VERSION}" -ForegroundColor Cyan;` +
        `Write-Host "  ├ 中文不乱码: UTF-8 encoding prefix" -ForegroundColor Green;` +
        `Write-Host "  ├ export->` + "`$env: auto-convert" + `" -ForegroundColor Green;` +
        `Write-Host "  └ Git 免交互: ${Object.keys(CI_ENV_VARS).length} env vars via shell.env" -ForegroundColor Green;`;
      return;
    }

    // ── 情况 B：普通命令 —— 注入编码前缀 ──
    // bash 工具不负责编码，需要插件注入 $OutputEncoding + [Console]::OutputEncoding。
    // 用 startsWith 检测避免已存在时重复嵌套（bash 工具可能在极少数场景下也加）。
    if (cmd.startsWith(ENCODING_PREFIX)) {
      return;
    }
    out.args.command = `${ENCODING_PREFIX}${cmd}`;
  },
  };
};
