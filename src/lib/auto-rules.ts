/**
 * ShellFix — 自动化规则模块定义
 *
 * 每个模块是一段自动注入到 system prompt 的上下文文本。
 * 用户通过 /auto 管理开关和启动行为。v1.6 增加条件引擎。
 *
 * 旧名：inject-modules.ts（v1.6.0 重命名为 auto-rules.ts）
 */

// ====================================================================
// 类型定义
// ====================================================================

import type { InjectCondition, ConditionPredicate } from "./state";

export interface AutoModule {
  /** 模块标识（如 "coding"） */
  name: string;
  /** 显示名称 */
  label: string;
  /** 简短描述 */
  description: string;
  /** 注入到 system prompt 的文本内容 */
  content: string;
  /** 默认是否启用 */
  defaultOn: boolean;
  /** 标签分类 */
  tags: string[];
  /** 默认条件（在什么环境下自动启用） */
  defaultConditions?: InjectCondition[];
}

// ====================================================================
// 内置自动化模块
// ====================================================================

export const AUTO_MODULES: AutoModule[] = [
  {
    name: "coding",
    label: "编码规范",
    description: "TypeScript 严格模式、命名规范、ESLint 规则",
    tags: ["code-quality"],
    defaultOn: true,
    defaultConditions: [{ predicate: "always", expected: "true", enabled: true }],
    content: [
      "## 编码规范",
      "",
      "- TypeScript 严格模式，禁止 `as any` / `@ts-ignore` / `@ts-expect-error`",
      "- 优先使用 `interface` 而非 `type` 定义对象类型",
      "- 函数使用显式返回类型标注",
      "- 异步操作使用 `async/await`，避免裸 `.then()`",
      "- 命名：组件 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE_CASE",
      "- 文件编码统一 UTF-8 without BOM（.ps1 文件例外：UTF-8 with BOM）",
      "- 禁止提交凭据、Token、密码等到 Git",
    ].join("\n"),
  },
  {
    name: "windows",
    label: "平台提醒",
    description: "Windows + PowerShell 环境注意事项",
    tags: ["platform"],
    defaultOn: true,
    defaultConditions: [{ predicate: "os", expected: "win32", enabled: true }],
    content: [
      "## 运行环境",
      "",
      "- 操作系统：Windows",
      "- Shell：PowerShell（非 bash/zsh）",
      "- Agent 输出的 Linux bash 命令不兼容，请使用 PowerShell 语法",
      "- 路径分隔符使用反斜杠 `\\`，但在 PowerShell 中 `/` 通常也可用",
      "- 环境变量用 `$env:NAME` 而非 `$NAME`",
    ].join("\n"),
  },
  {
    name: "tech-stack",
    label: "技术栈",
    description: "自动检测的项目技术栈声明",
    tags: ["project"],
    defaultOn: true,
    defaultConditions: [{ predicate: "always", expected: "true", enabled: true }],
    content: [
      "## 技术栈（自动检测）",
      "",
      "- 语言：TypeScript",
      "- 运行时：Bun（兼容 Node.js API）",
      "- 插件系统：OpenCode Plugin API v1.17.13+",
      "- 项目：OpenCode Plugins ShellFix",
      "- 构建：原生 TypeScript（Bun 直接编译执行）",
    ].join("\n"),
  },
  {
    name: "review",
    label: "Review 清单",
    description: "代码审查检查清单",
    tags: ["workflow"],
    defaultOn: false,
    defaultConditions: [{ predicate: "always", expected: "true", enabled: true }],
    content: [
      "## Review 检查清单",
      "",
      "审查代码时逐项检查：",
      "",
      "1. **逻辑正确性** — 边界条件、空值、异常路径是否覆盖",
      "2. **类型安全** — 有无 `as any`、类型断言是否必要",
      "3. **错误处理** — catch 块是否忽略异常、错误是否向上传递",
      "4. **性能** — 有无不必要的循环、重复计算、内存泄漏",
      "5. **安全** — 输入是否校验、路径遍历、命令注入风险",
      "6. **可维护性** — 命名是否清晰、函数是否过长、职责是否单一",
      "7. **测试** — 关键路径是否有测试覆盖",
    ].join("\n"),
  },
  {
    name: "security",
    label: "安全提醒",
    description: "安全注意事项与常见漏洞预防",
    tags: ["security"],
    defaultOn: false,
    defaultConditions: [{ predicate: "always", expected: "true", enabled: true }],
    content: [
      "## 安全注意事项",
      "",
      "- 禁止硬编码凭据、Token、API Key、连接字符串",
      "- 禁止将敏感信息提交到 Git（使用环境变量或 secrets）",
      "- 文件路径操作需防路径遍历攻击",
      "- 构造 shell 命令时避免拼接用户输入",
      "- SQL 查询使用参数化查询，禁止拼接字符串",
      "- 日志中不要输出密码、Token 等敏感字段",
    ].join("\n"),
  },
  {
    name: "git",
    label: "Git 规范",
    description: "分支命名、commit message 规范",
    tags: ["workflow"],
    defaultOn: false,
    defaultConditions: [{ predicate: "is_git_repo", expected: "true", enabled: true }],
    content: [
      "## Git 规范",
      "",
      "- 分支命名：`feature/<name>` / `fix/<name>` / `chore/<name>`",
      "- Commit Message 格式：`<type>(<scope>): <subject>`",
      "  - type: feat / fix / refactor / chore / docs / test",
      "  - scope: 模块名（可选）",
      "  - subject: 一句话描述（小写开头，无句号）",
      "- 一个 commit 一个逻辑改动，不混搭",
      "- rebase 而非 merge 保持历史线性",
    ].join("\n"),
  },
  {
    name: "requirements",
    label: "当前目标",
    description: "/auto require 临时注入的当前任务目标",
    tags: ["dynamic"],
    defaultOn: false,
    defaultConditions: [{ predicate: "always", expected: "true", enabled: true }],
    content: "",
  },
];

// ====================================================================
// 便捷查找
// ====================================================================

/** 按 name 查找模块 */
export function getAutoModule(name: string): AutoModule | undefined {
  return AUTO_MODULES.find((m) => m.name === name);
}

/** 获取默认启用的模块名列表 */
export function getDefaultEnabledModules(): string[] {
  return AUTO_MODULES.filter((m) => m.defaultOn).map((m) => m.name);
}

/** 获取模块的默认条件列表 */
export function getDefaultConditions(name: string): InjectCondition[] {
  const mod = getAutoModule(name);
  return mod?.defaultConditions ? JSON.parse(JSON.stringify(mod.defaultConditions)) : [];
}