# v2.1 开发方案 — Git 环境净化（第四基础支柱）

> 当前版本：v2.0.0 → 目标版本：v2.1.1
> 预计工作量：~2h

---

## 一、目标

新增第四基础功能：**Git 换行符警告静默**，作为 `/shellfix` 管家的子命令，与三大修复并列。

### 解决什么问题

```
warning: in the working copy of 'foo.ts', LF will be replaced by CRLF the next time Git touches it
```

这类 warning 是纯噪声：
- 不改变 Git 行为
- 每次 `git diff`/`git add`/`git commit` 都可能刷一批
- 浪费 token、干扰 Agent、挤占上下文窗口

### 方案对比

| 方案 | 生效范围 | 副作用 | 推荐 |
|------|---------|-------|------|
| `shell.env` 注入 `GIT_CONFIG_*` 环境变量 | **仅 OpenCode 进程** | 无 | ✅ **默认 auto** |
| 写入 `~/.gitconfig` | 系统全局 | 影响所有 Git 操作 | 可选（config 模式） |

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/lib/state.ts` | **修改** | 新增 `gitLineEnding` 字段 |
| `src/shell-fix.ts` | **修改** | `shell.env` 动态注入 + `tool.execute.after` 检测 |
| `src/shell-fix-tui.ts` | **修改** | 子命令 + 面板 + 帮助 |

---

## 三、详细设计

### 3.1 状态模型

```typescript
// state.ts
export interface PluginState {
  // ... 已有字段
  gitLineEnding: "auto" | "config" | "off";
}
```

三个模式：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `auto`（默认） | 环境变量注入，仅 OpenCode 内生效 | 大多数用户 |
| `config` | 追加 prompt 让用户手动执行 `git config --global` | 希望永久生效的用户 |
| `off` | 关闭，不注入任何配置 | 不需要时 |

### 3.2 shell.env 动态注入

将 `shell.env` 改为读取 `PluginState.gitLineEnding`：

```typescript
"shell.env": async (_input, output) => {
  const out = output as { env: Record<string, string> };
  const s = loadState();

  // 基础 Git 免交互
  for (const [key, val] of Object.entries(CI_ENV_VARS)) {
    out.env[key] = val;
  }

  // 换行符配置（条件注入）
  if (s.gitLineEnding !== "off") {
    out.env["GIT_CONFIG_COUNT"] = "2";
    out.env["GIT_CONFIG_KEY_0"] = "core.autocrlf";
    out.env["GIT_CONFIG_VALUE_0"] = "false";
    out.env["GIT_CONFIG_KEY_1"] = "core.safecrlf";
    out.env["GIT_CONFIG_VALUE_1"] = "false";
  }
}
```

### 3.3 首次检测通知

`tool.execute.after` 钩子（新增）：检测 git 命令输出中的换行符警告，仅第一次报告：

```typescript
let _gitLineEndingNotified = false;

"tool.execute.after": async (input) => {
  if (_gitLineEndingNotified) return;
  const { tool } = input as { tool: string };
  if (tool !== "bash" && tool !== "pwsh") return;

  const s = loadState();
  if (s.gitLineEnding === "off") return;

  // 如果用户还没配置过（还是默认 auto），且未通知过
  if (!_gitLineEndingNotified) {
    _gitLineEndingNotified = true;
    console.log(`[ShellFix] 检测到 Git 换行符警告。用 /shellfix git-line-ending 配置处理方式。`);
  }
}
```

### 3.4 TUI 子命令

```
/shellfix git-line-ending               → 查看当前状态
/shellfix git-line-ending auto          → 环境变量注入（默认，推荐）
/shellfix git-line-ending config        → 生成 `git config` 命令填入输入框
/shellfix git-line-ending off           → 关闭
```

`config` 模式使用 `appendPrompt` 填入预编排命令：

```
git config --global core.autocrlf false
git config --global core.safecrlf false
```

### 3.5 状态面板

在 `/shellfix` 面板中新增一行：

```
║  git-line-ending [AUTO]  Git 换行符警告静默    ║
```

---

## 四、交付清单

- [ ] state.ts — 新增 `gitLineEnding` 字段
- [ ] shell-fix.ts — `shell.env` 动态注入 + `tool.execute.after` 检测
- [ ] shell-fix-tui.ts — `/shellfix git-line-ending` 子命令 + 面板 + 帮助 + palette
- [ ] docs — v2.1 开发方案草案 + CHANGELOG
- [ ] 最终验证 + 提交 v2.1