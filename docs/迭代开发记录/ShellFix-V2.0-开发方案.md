# v2.0 开发方案 — 架构升级 + 质量稳定 + 新钩子落地

> 当前版本：v1.9.0 → 目标版本：v2.0.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §10
> 预计工作量：~8h
>
> 本版本聚焦三个方向：**新钩子落地**（chat.message 替代 pendingDynamic）、**架构精简**（废弃旧 auto.modules，全面迁移 AutoRuleV2）、**质量稳定**（错误处理、版本号、CHANGELOG）
>
> ⚠️ **核心约束：三大基本功能永不倒退** — 编码注入（中文不乱码）、export→$env: 转换、Git 免交互环境变量。任何改动必须保证这三条正常工作，修改后必须通过功能测试。

---

## 一、目标

v2.0 是 ShellFix 的第一个正式版，核心目标：

1. **消除已知技术债务** — pendingDynamic 双阶段方案 → chat.message 直接注入
2. **保护注入上下文不丢失** — session.compacting 钩子防止压缩裁剪
3. **架构精简** — 废弃旧 `auto.modules`，全面迁移到 AutoRuleV2
4. **质量基线** — 统一错误处理、版本号同步、代码清理
5. **文档体系** — CHANGELOG、README 更新、架构图

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shell-fix.ts` | **修改** | 新增 chat.message 钩子、session.compacting 钩子、版本号更新 |
| `src/shell-fix-tui.ts` | **修改** | 错误处理规范化、版本号同步 |
| `src/lib/state.ts` | **修改** | 版本号 → 1.9.0、pendingDynamic 清理（可选） |
| `CHANGELOG.md` | **新增** | 版本历史 |
| `README.md` | **修改** | 更新文档 |
| `docs/D0-ShellFix-全功能设计.md` | **修改** | 同步最新设计 |
| `docs/Audit-ShellFix-V1.9-审核报告.md` | **新增** | v1.9 审核报告 |

---

## 三、详细设计

### 3.1 新钩子落地

#### 3.1.1 `chat.message` — 替代 pendingDynamic 缓存

**当前问题：** v1.9 的 DynamicRule 使用两阶段方案：
1. TUI 事件监听 → 匹配关键词 → 写入 `pendingDynamic[]` 缓存
2. system.transform → 消费缓存 → 注入上下文

**问题：**
- 缓存可能被多次 system.transform 消费（已用消费逻辑解决）
- 如果 system.transform 未触发（如缓存命中），动态上下文丢失
- 上下文注入到 system prompt，而非用户消息，可能被压缩

**v2.0 方案：**

```typescript
"chat.message": async (_input, output) => {
  const userText = extractText(output.parts);
  if (!userText) return;

  const rules = getDynamicRules();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (isDynamicOnCooldown(rule)) continue;

    const matched = rule.matchType === "regex"
      ? new RegExp(rule.pattern, "i").test(userText)
      : userText.toLowerCase().includes(rule.trigger.toLowerCase());

    if (matched) {
      markDynamicTriggered(rule.id);
      output.parts.push({ type: "text", text: `\n[动态上下文 - ${rule.trigger}]\n${rule.context}` });
    }
  }
}
```

**优点：**
- 单阶段，无需缓存中介
- 直接注入到用户消息，而非 system prompt
- 每次用户消息都触发，不会丢失
- 与 system.transform 解耦

**风险：**
- `output.parts` 的修改是否被平台接受 → 需要实验验证
- 如果 `chat.message` 是只读的 → 回退保留 v1.9 方案

**实验步骤：**
1. 在开发环境中注册 `chat.message` 钩子
2. 发送一条测试消息，检查 `output.parts` 修改后 LLM 是否能看到
3. 如果有效 → 正式迁移；如果无效 → 记录结论，保留 v1.9 方案

#### 3.1.2 `experimental.session.compacting` — 保护注入上下文

**问题：** 长会话中，LLM 的上下文窗口会压缩历史消息，早期注入的 system prompt 内容可能被裁剪。

**v2.0 方案：**

```typescript
"experimental.session.compacting": async (_input, output) => {
  const s = loadState();
  const chunks: string[] = [];

  // 保留活跃的注入模块内容
  for (const mod of AUTO_MODULES) {
    if (getCachedShouldInject(mod.name) && mod.content) {
      chunks.push(`[模块: ${mod.name}]\n${mod.content}`);
    }
  }

  // 保留 require
  if (s.auto.require) {
    chunks.push(`[当前任务]\n${s.auto.require}`);
  }

  if (chunks.length > 0) {
    output.context = [
      ...(output.context || []),
      "--- ShellFix 活跃注入上下文 ---",
      ...chunks,
    ];
  }
}
```

**优点：**
- 确保注入内容在会话压缩后仍然保留
- 与 `system.transform` 互补（一个注入，一个保护）

**风险：**
- `experimental` 标记 → 可能不稳定或变更
- 需要验证 `output.context` 的修改是否生效

#### 3.1.3 `tool.execute.after` — 命令输出处理（可选）

**用途：** 在工具执行后修改输出结果。

```typescript
"tool.execute.after": async (input, output) => {
  // 例如：自动清理敏感信息
  // 或：格式化 PowerShell 输出
}
```

**优先级：低** — 作为实验性功能，不阻塞 v2.0 发布。

### 3.2 质量稳定

#### 3.2.1 版本号统一

**当前问题：** 多处版本号硬编码为 "1.6.0"：

| 位置 | 当前值 | 目标值 |
|------|--------|--------|
| `shell-fix.ts` PLUGIN_VERSION | "1.6.0" | "2.0.0" |
| `shell-fix-tui.ts` PLUGIN_VERSION | "1.6.0" | "2.0.0" |
| `state.ts` DEFAULT_STATE.version | "1.6.0" | "2.0.0" |

**v2.0 方案：** 统一改为 `"2.0.0"`，并在 `state.ts` 中导出 `PLUGIN_VERSION` 常量，两插件引用同一来源。

```typescript
// state.ts
export const PLUGIN_VERSION = "2.0.0";

// shell-fix.ts
import { PLUGIN_VERSION } from "./lib/state";
// 删除本地 PLUGIN_VERSION

// shell-fix-tui.ts
import { PLUGIN_VERSION } from "./lib/state";
// 删除本地 PLUGIN_VERSION
```

#### 3.2.2 错误处理规范化

**当前问题：** TUI 调度器中的 palette 命令使用了大量空 `try/catch {}`：

```typescript
run() {
  try {
    // ... 逻辑 ...
  } catch {}  // ← 静默吞掉所有错误
}
```

**v2.0 方案：** 统一错误处理模式：

```typescript
run() {
  try {
    // ... 逻辑 ...
  } catch (e) {
    console.error(`[ShellFix] palette error:`, e);
    api.ui.toast?.({ message: `ShellFix 错误: ${e instanceof Error ? e.message : String(e)}` });
  }
}
```

#### 3.2.3 未使用导入清理

**当前问题：** Biome 报告多项未使用导入警告：
- `shell-fix.ts`: 部分 state 和 template-store 导入未使用
- `shell-fix-tui.ts`: 部分 state 导入未使用

**v2.0 方案：** 逐文件清理，保留合法导入，移除冗余。

#### 3.2.4 AutoRuleV2 全面迁移（废弃旧路径）

**当前问题：** v1.9 实现了 AutoRuleV2 类型 + CRUD + `/auto rule` 子命令，但旧的 `auto.modules` / `auto.require` / `auto.mode` / `auto.conditions` 仍然并行存在，增加维护复杂度。

**v2.0 方案：全面废弃旧路径 `PluginState.auto`，唯一使用 `PluginState.autoRules` + `PluginState.require`**

**旧路径移除：**

```diff
// state.ts — PluginState
-  auto: AutoState;         // 全部移除：modules / mode / require / conditions
+  autoRules: AutoRuleV2[];  // 唯一规则源
+  require: string;           // 临时注入文本（独立字段，摆脱旧 AutoState）
```

同时移除 `AutoState` 接口（仅保留 `DEFAULT_STATE` 中用于向后兼容合并，最终发布时清理）。

**迁移逻辑：**

- 启动时 `loadState()` 检测旧 `state.auto` 是否存在 → 自动转换所有启用的 module 到 AutoRuleV2 条目
- 所有旧函数内部重定向：
  - `setAutoModule()` → 操作 AutoRuleV2（查找 module 名匹配的规则，toggle enabled）
  - `getEnabledAutoModules()` → 基于 `getAutoRules()` 过滤
  - `setAutoMode()` → 控制 AutoRuleV2 中 `session_start` trigger 的批量 enabled
  - `setAutoRequire()` → 写入独立 `PluginState.require`
  - `getModuleConditions()` → 读 AutoRuleV2 的 `conditions[]`
- 移除 `AutoState` 接口类型

**用户接口不变（命令不改变，内部实现替换）：**

| 用户命令 | 旧读路径 | v2.0 读路径 |
|---------|---------|-------------|
| `/auto list` | `auto.modules` | `getAutoRules()` |
| `/auto <module>` toggle | `setAutoModule()` | `toggleAutoRule()` 按 module 匹配 |
| `/auto mode` | `auto.mode` | 全部 AutoRuleV2 的 enabled 批量操作 |
| `/auto require` | `auto.require` | `PluginState.require`（独立） |
| `/auto conditions` | `auto.conditions[module]` | AutoRuleV2 的 `conditions[]` |
| `/auto rule` | AutoRuleV2 | AutoRuleV2（不变）|

### 3.3 文档体系

#### 3.3.1 CHANGELOG.md

```markdown
# Changelog

## v2.0.0 (2026-07-13)

### Features
- chat.message 钩子：动态上下文直接注入用户消息（替代 pendingDynamic 缓存）
- session.compacting 钩子：保护注入上下文不被会话压缩裁剪
- tool.execute.after 钩子：命令输出后处理（实验性）

### Improvements
- 版本号统一为 2.0.0，集中管理
- 错误处理规范化：空 catch → 有日志的 toast 通知
- 未使用导入清理
- AutoRuleV2 同步改为自动调用

### Documentation
- 新增 CHANGELOG.md
- README.md 全面更新
- D0 设计文档同步 v2.0 版本

## v1.9.0
- DynamicRule 动态上下文注入系统
- AutoRuleV2 统一配置
- 平台 API 探索报告

## v1.8.0
- /kickme 通知系统
- 标签 timeline 浏览
- 会话级自动注入
... (后续补全)
```

#### 3.3.2 README.md 更新

- 添加 `/dynamic` 命令文档
- 添加 `/auto rule` 子命令文档
- 更新架构图反映 v2.0 钩子
- 更新版本号

#### 3.3.3 v1.9 审核报告

- 总结 v1.9 实现审计
- 记录 DynamicRule CRUD 正确性
- 记录 AutoRuleV2 向后兼容验证
- 记录 API 探索结论

### 3.4 平台实验记录

#### 3.4.1 实验钩子

| 钩子 | 实验目的 | 优先级 | 预期 |
|------|---------|--------|------|
| `chat.message` | 验证 output.parts 修改生效 | **高** | 可修改用户消息 |
| `session.compacting` | 验证 output.context 修改生效 | **高** | 可追加保护上下文 |
| `tool.execute.after` | 验证输出修改能力 | 低 | 可修改工具输出 |
| `chat.params` | 动态调整模型参数 | 低 | 根据上下文调温度 |
| `permission.ask` | 自动允许 ShellFix 相关权限 | 低 | 减少弹窗 |

#### 3.4.2 实验流程

1. 在开发环境注册钩子
2. 用 `console.log` 记录钩子触发
3. 验证修改是否生效
4. 记录结论到 API 探索报告

---

## 四、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `chat.message` 的 `output.parts` 修改不生效 | **高** | 实验验证优先；失败则回退保留 v1.9 方案 |
| 2 | `session.compacting` 标记为 experimental，可能不稳定 | 中 | 降级为可选功能，不阻塞 v2.0 |
| 3 | 版本号统一后旧 state 文件兼容问题 | 低 | deepMerge 自动合并缺失字段 |
| 4 | 错误处理规范化可能引入新 bug | 低 | 每处修改后验证 LSP diagnostics |
| 5 | 多个钩子同时修改 message → 互相冲突 | 中 | chat.message 和 system.transform 不会同时修改同一内容 |

---

## 五、交付清单

### 新钩子落地（3h）
- [ ] 实验验证 `chat.message` 的 output.parts 修改能力
- [ ] 如果有效：迁移 DynamicRule 注入到 chat.message（清理 pendingDynamic）
- [ ] 如果无效：记录结论，保留 v1.9 方案
- [ ] 实现 `session.compacting` 钩子保护注入上下文
- [ ] 实验验证 `tool.execute.after`（可选）

### 质量稳定（3h）
- [ ] 版本号统一：state.ts 导出 PLUGIN_VERSION，两插件引用
- [ ] DEFAULT_STATE.version → "2.0.0"
- [ ] 错误处理规范化：所有 palette `catch {}` → 有日志的 toast
- [ ] 未使用导入清理
- [ ] **废弃旧 auto.modules 路径**：
  - [ ] 从 PluginState 移除 `auto: AutoState`
  - [ ] 添加独立 `require: string` 字段
  - [ ] 所有旧函数重定向到 AutoRuleV2
  - [ ] 启动时自动迁移旧数据
  - [ ] 移除 `AutoState` 接口
  - [ ] 测试：`/auto list` / `/auto <module>` toggle / `/auto mode` / `/auto require` / `/auto conditions` 全部正常

### 文档体系（2h）
- [ ] 新增 CHANGELOG.md（补全 v1.3–v1.9 历史）
- [ ] README.md 更新（/dynamic、/auto rule、架构精简说明）
- [ ] D0 设计文档同步 v2.0
- [ ] v1.9 审核报告

### 最终验证（1h）
- [ ] **三大基本功能测试**：编码不乱码 / export→$env: / Git 免交互
- [ ] Diagnostics 0 错误
- [ ] 全功能测试：/dynamic / /auto rule / /auto list / /kickme / /my / /note / /shellfix
- [ ] 提交 v2.0

---

## 附录 A：三大基本功能回归测试

每次修改 `shell-fix.ts` 后必须验证：

### ① 中文不乱码（编码注入）

```bash
# 在 Agent 中执行
Write-Output "你好，世界！测试中文不乱码"
```

**预期：** 正常显示中文，无乱码。
**检查：** `tool.execute.before` 钩子中 `ENCODING_PREFIX` 正确注入。

### ② export→$env: 自动转换

```bash
export MY_TEST_VAR="HelloWorld"
echo $env:MY_TEST_VAR
```

**预期：** 输出 `HelloWorld`。
**检查：** `applyExportRule()` 函数正常工作。

### ③ Git 免交互

```bash
git status
```

**预期：** 正常执行，无弹窗阻塞。
**检查：** `shell.env` 钩子注入了 16 个环境变量。

---

## 附录 B：设计决策记录

### 决策 1：chat.message 替代 pendingDynamic

**背景：** v1.9 的 pendingDynamic 缓存方案是权宜之计，因为当时不知道 chat.message 钩子的存在。

**v2.0 立场：** 优先实验 chat.message 修改能力。如果可行，这是更优雅的方案。如果不可行，v1.9 方案作为稳定基线。

### 决策 2：废弃旧 auto.modules，不兼容

**背景：** 旧 `auto` 路径（`AutoState` + `modules`/`mode`/`require`/`conditions`）与 AutoRuleV2 并行存在，增加维护复杂度。用户要求直接废弃，不考虑兼容。

**v2.0 立场：** 从 `PluginState` 移除 `auto: AutoState`，所有旧接口重定向到 AutoRuleV2。启动时自动迁移旧数据。`AutoState` 接口移除。

### 决策 3：版本号统一管理

**背景：** 三处版本号硬编码，多次忘记更新。

**v2.0 立场：** state.ts 作为单一事实来源，导出 `PLUGIN_VERSION` 常量。