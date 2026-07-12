# v1.6 开发方案 — /in 条件引擎

> 当前版本：v1.5.0 → 目标版本：v1.6.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §9
> 预计工作量：~5h

---

## 一、目标

为 `/in` 注入模块添加条件引擎，让模块根据当前环境（OS、分支、文件、工具等）自动启用/禁用，消除手动开关的繁琐。

**核心场景：**
1. `windows` 模块只在 Windows 上自动注入，macOS/Linux 不注入
2. `review` 模块只在 `feature/*` 分支上自动启用
3. `git` 模块只在有 `.git` 目录的项目中启用
4. 用户通过 `/in conditions` 自定义条件规则

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/state.ts` | **修改** | 新增 `InjectCondition` 接口 + 条件存储 |
| `src/inject-modules.ts` | **修改** | 模块定义增加 `conditions` 字段 |
| `src/shell-fix.ts` | **修改** | 新增 `/in conditions` 子命令 + 条件评估逻辑 |
| `src/template-store.ts` | **不变** | 复用 `resolveGitBranch` 等环境检测函数 |
| `docs/_Draft/Draft-ShellFix-V1.6-开发方案.md` | **新增** | 本文件 |

---

## 三、详细设计

### 3.1 条件模型

```typescript
// state.ts 新增
export interface InjectCondition {
  /** 条件谓词 */
  predicate: ConditionPredicate;
  /** 预期值（支持 glob 通配） */
  expected: string;
  /** 条件启用？false = 跳过此条件 */
  enabled: boolean;
}

export type ConditionPredicate =
  // 环境
  | "os"                // 平台：windows / darwin / linux
  | "arch"              // 架构：x64 / arm64
  // Git
  | "branch"            // Git 分支（glob 通配）
  | "dirty"             // 工作区有未提交改动：true / false
  // 项目
  | "tool_exists"       // 某工具是否存在：dotnet / node / bun / git
  | "file_exists"       // 某文件/目录是否存在：src/*.cs / package.json
  | "is_git_repo"       // 当前目录是否有 .git
  // 内置
  | "always"            // 始终匹配
  | "never";            // 永不匹配

// PluginState 扩展
export interface PluginState {
  // ... 原有字段
  inject: {
    modules: Record<string, boolean>;
    mode: InjectMode;
    require: string;
    /** 模块 → 条件列表（覆盖默认条件） */
    conditions: Record<string, InjectCondition[]>;
  };
}
```

### 3.2 条件评估引擎

```typescript
// shell-fix.ts 新增
function evaluateCondition(cond: InjectCondition): boolean {
  switch (cond.predicate) {
    case "always":
      return true;
    case "never":
      return false;
    case "os":
      return platform() === cond.expected;
    case "arch":
      return arch() === cond.expected;
    case "branch":
      const branch = resolveGitBranch();
      return matchesGlob(branch, cond.expected);
    case "dirty":
      return isGitDirty() === (cond.expected === "true");
    case "tool_exists":
      return toolExists(cond.expected);
    case "file_exists":
      return fileExists(cond.expected);
    case "is_git_repo":
      return isGitRepo();
  }
}

/** 判断模块是否应当启用（综合考虑手动开关 + 条件） */
function shouldInjectModule(modName: string): boolean {
  const s = loadState();
  // 手动开关关闭 → 不注入
  if (!s.inject.modules[modName]) return false;

  // 无条件 → 按手动开关
  const conditions = s.inject.conditions[modName];
  if (!conditions || conditions.length === 0) return true;

  // 所有条件必须为 true（AND 逻辑）
  return conditions.every((c) => {
    if (!c.enabled) return true;
    return evaluateCondition(c);
  });
}
```

### 3.3 默认条件（内置模块）

| 模块 | 默认条件 | 说明 |
|------|----------|------|
| `coding` | `always` | 始终注入 |
| `windows` | `os=windows` | 仅 Windows |
| `tech-stack` | `always` | 始终注入 |
| `review` | `always` | 默认关闭（手动开关优先），无条件 |
| `security` | `always` | 默认关闭，无条件 |
| `git` | `is_git_repo=true` | 仅在 Git 仓库中启用 |

### 3.4 条件配置命令

```
/in conditions                          → 查看所有模块的条件配置
/in conditions <module>                 → 查看某模块的条件
/in conditions <module> add <predicate> <expected>   → 添加条件
/in conditions <module> rm <index>      → 删除第 N 条条件
/in conditions <module> toggle <index>  → 开关某条件
/in conditions <module> clear           → 清除所有条件
/in conditions eval <module>            → 测试评估当前环境是否匹配
```

示例：

```
/in conditions windows add os windows
/in conditions windows add tool_exists pwsh
/in conditions review add branch feature/*
/in conditions git add is_git_repo true
/in conditions eval review
  → 评估结果：✅ 条件匹配（branch=feature/xxx）
```

### 3.5 system.transform 集成

`experimental.chat.system.transform` 钩子中的收集逻辑改为使用 `shouldInjectModule`：

```typescript
// 之前：直接按 modules 开关收集
for (const modName of getEnabledInjectModules()) { ... }

// 之后：经过条件评估
for (const mod of INJECT_MODULES) {
  if (shouldInjectModule(mod.name)) {
    chunks.push(mod.content);
  }
}
```

### 3.6 新增内置检测函数

```typescript
// template-store.ts 或 shell-fix.ts

/** 检测 Git 工作区是否有未提交改动 */
function isGitDirty(): boolean { ... }

/** 检测某工具是否存在 */
function toolExists(name: string): boolean {
  try {
    execSync(`where ${name}`, { stdio: "ignore", timeout: 3000 });
    return true;
  } catch { return false; }
}

/** 检测文件/目录是否存在（支持 glob） */
function fileExists(pattern: string): boolean { ... }

/** 检测当前目录是否为 Git 仓库 */
function isGitRepo(): boolean { ... }

/** 简单的 glob 匹配（支持 * 通配） */
function matchesGlob(value: string, pattern: string): boolean { ... }
```

### 3.7 /in 状态面板更新

```
/in 面板新增行：
║  条件: 5 条已配置 / 2 条生效            ║

/in list 输出新增：
  conditions: windows → os=windows ✅, tool_exists=pwsh ⏸️
  conditions: review  → branch=feature/* ✅
```

---

## 四、与现有功能的交互

### 4.1 条件 vs 手动开关

```
手动开关              条件评估             最终结果
/in coding OFF       任意                 不注入 ❌
/in coding ON        无条件               注入 ✅
/in coding ON        conditions 全部匹配  注入 ✅
/in coding ON        conditions 任一不匹配 不注入 ❌
```

**手动开关优先阻断**：关了的模块不评估条件。条件只在已开启的模块上生效。

### 4.2 条件 vs system.transform 钩子

```
experimental.chat.system.transform
├── 遍历所有模块
│   ├── 手动开关 OFF → 跳过
│   ├── 手动开关 ON + 无条件 → 注入
│   └── 手动开关 ON + 有条件 → 评估条件
│       ├── 全部匹配 → 注入
│       └── 任一不匹配 → 跳过
├── require 文本（无条件）
└── prompt 提示（如有）
```

### 4.3 条件 vs 默认模块配置

内置模块的默认条件存储在 `inject-modules.ts` 中，首次加载时自动写入 `state.conditions`。用户可通过 `/in conditions` 覆盖。

---

## 五、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | 条件评估频繁调用 execSync 影响性能 | 低 | 每次 session 启动只评估一次，结果缓存 |
| 2 | glob 匹配实现复杂 | 低 | 仅支持 `*` 通配，不引入 minimatch 依赖 |
| 3 | 用户配置的条件与模块默认条件冲突 | 低 | 用户配置覆盖默认，clear 恢复默认 |
| 4 | 复杂条件组合（AND/OR） | 低 | 当前仅 AND 逻辑，后续可扩展 OR 组 |

---

## 六、交付清单

- [ ] `state.ts` — 新增 `InjectCondition` / `ConditionPredicate` 类型 + conditions 存储字段
- [ ] `inject-modules.ts` — 为模块定义默认条件
- [ ] 条件评估引擎 — `evaluateCondition` / `shouldInjectModule`
- [ ] 检测函数 — `isGitDirty` / `toolExists` / `fileExists` / `isGitRepo` / `matchesGlob`
- [ ] `/in conditions` — 查看所有模块条件
- [ ] `/in conditions <module>` — 查看某模块条件
- [ ] `/in conditions <module> add <predicate> <expected>` — 添加条件
- [ ] `/in conditions <module> rm <index>` — 删除条件
- [ ] `/in conditions <module> toggle <index>` — 开关条件
- [ ] `/in conditions <module> clear` — 清除条件
- [ ] `/in conditions eval <module>` — 测试评估
- [ ] `system.transform` 集成 — 使用 `shouldInjectModule` 替代 `getEnabledInjectModules`
- [ ] 状态面板更新 — 显示条件计数
- [ ] diagnostics 无错误