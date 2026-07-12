# v1.9 开发方案 — /auto 管线重构 + 上下文感知注入 + 平台 API 深入

> 当前版本：v1.8.0 → 目标版本：v1.9.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §10
> 预计工作量：~5h
>
> 前置依赖：v1.8 Oracle 评审结论，/auto 管线扩展因 `replace_input`/`replace_output` 缺乏 payload mutation API 支持 + `notify`/`collect` 与现有功能重复，整体从 v1.8 推迟至此。

---

## 一、目标

v1.9 重新设计 /auto 管线，聚焦三个方向：

1. **动态上下文注入** — 新增 `trigger: "user_input"`，在用户消息中检测关键词后追加上下文
2. **AutoRule 统一配置** — 用 kickme 的 CRUD 模式重构 /auto 规则管理
3. **平台 API 深入** — 探索 `tool.execute.before`、`experimental.chat.system.transform` 以外的新钩子

---

## 二、设计背景

### 2.1 v1.8 的教训

v1.8 原计划在 `/auto` 中新增四种 action 类型：

| Action | 问题 | 结论 |
|--------|------|------|
| `replace_input` | 无法修改 event payload | ❌ 死路 |
| `replace_output` | 同上 | ❌ 死路 |
| `notify` | 与 kickme 完全重复 | ❌ 不要 |
| `collect` | 与 autoCollectTags 重复 | ❌ 不要 |

实质可行的方向不是新增 action 类型，而是**扩展 trigger 维度**：当前 `inject_system` 只支持 `session_start`，应该增加 `user_input` 触发，实现**动态上下文注入**。

### 2.2 价值

- 当用户提问涉及特定领域时，动态注入相关上下文
- 无需用户手动 `/auto` toggle 模块
- 不依赖 payload mutation，利用已有 system prompt 修改机制

---

## 三、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/lib/state.ts` | **修改** | 新增 `DynamicRule` 类型 + 存储 |
| `src/shell-fix-tui.ts` | **修改** | 新增动态规则 UI + `/auto` 扩展 |
| `src/shell-fix.ts` | **修改** | 新增 `experimental.chat.system.transform` 动态注入逻辑 |
| `docs/*` | **修改** | 更新设计文档 |

---

## 三、详细设计

### 3.1 动态上下文注入

#### 3.1.1 概念

用户定义一个规则：当用户消息包含特定关键词时，在下一次 system prompt transform 中追加一段上下文文本。

```
用户: 帮我看看这个数据库连接池配置
                         ↓
system prompt 自动追加:
--- 
## 动态上下文
用户关注数据库连接池。参考配置：
- HikariCP maxPoolSize=20
- connectionTimeout=30000ms
- idleTimeout=600000ms
```

#### 3.1.2 规则模型

```typescript
// state.ts 新增
export interface DynamicRule {
  id: string;
  label: string;           // 显示名称
  enabled: boolean;
  matchType: "keyword" | "regex";
  pattern: string;         // 触发模式
  context: string;         // 注入的上下文文本
  cooldown: number;        // 冷却时间（秒），防止重复触发
  lastTriggered: number;   // 上次触发时间戳
}

export interface PluginState {
  // ... 已有字段
  dynamic: DynamicRule[];  // v1.9 新增
}
```

#### 3.1.3 实现机制

**监听层（shell-fix-tui.ts）：** 在 `session.next.prompted` 中检测动态规则匹配，匹配时设置一个标志位（状态缓存）。

```
session.next.prompted → checkDynamicRules(text)
  → 匹配 → 记录 "[module:xxx]" 到动态注入缓存
```

**注入层（shell-fix.ts）：** 在 `experimental.chat.system.transform` 钩子中，检查动态注入缓存，追加上下文。

```typescript
"experimental.chat.system.transform": async (_input, output) => {
  // ... 已有模块注入逻辑 ...

  // v1.9: 动态上下文注入
  const pendingDynamics = getPendingDynamicContexts();
  for (const ctx of pendingDynamics) {
    if (ctx.cooldownOk) {
      chunks.push(ctx.context);
      markTriggered(ctx.id); // 更新时间戳
    }
  }

  // ... 追加到 system prompt ...
}
```

#### 3.1.4 命令语法

```
/dynamic                          → 列出所有动态规则
/dynamic add <keyword> <context>   → 添加规则
  → 示例: /dynamic add "连接池" "数据库连接池配置建议：HikariCP maxPoolSize=20"
/dynamic add --regex <pattern> <context>
/dynamic rm <id>                  → 删除规则
/dynamic on|off <id>              → 开关规则
/dynamic cooldown <id> <seconds>  → 设置冷却时间
```

### 3.2 AutoRule 统一配置

#### 3.2.1 现有问题

当前 `/auto` 的命令接口分散：

| 功能 | 命令 |
|------|------|
| 开关模块 | `/auto <module>` |
| 切换模式 | `/auto mode prompt\|auto\|silent` |
| 注入需求 | `/auto require <text>` |
| 条件管理 | `/auto conditions ...` |
| 会话注入 | `/auto module` + palette 弹窗 |

缺乏统一的规则管理接口（类似 kickme 的 `list/add/rm/on/off` 循环）。

#### 3.2.2 改造方案

**保持现有命令兼容，新增 `/auto rule` 子命令：**

```
/auto rule                        → 列出所有规则
/auto rule add <trigger> <module> [conditions...]
/auto rule rm <id>
/auto rule on|off <id>
```

**规则模型：**

```typescript
export interface AutoRuleV2 {
  id: string;
  trigger: "session_start" | "user_input"; // 未来: "llm_output"
  module: string;       // 关联的 AutoModule name
  conditions: InjectCondition[];
  enabled: boolean;
  priority: number;     // 注入顺序
}
```

#### 3.2.3 向后兼容

- 现有 `/auto <module>` toggle 仍然有效
- 现有 `mode` / `require` / `conditions` / `reset` 不变
- 新增 `/auto rule` 子命令与 `AutoRuleV2` 存储并行存在
- 迁移策略：旧版 `auto.modules` 读写自动同步到 AutoRuleV2

### 3.3 平台 API 探索

#### 3.3.1 动机

v1.8 暴露了两个平台 API 限制：
1. `session.next.prompted` / `text.ended` 是只读事件，无法修改 payload
2. `experimental.chat.system.transform` 是追加模式，无法做条件替换

#### 3.3.2 探索方向

| API 领域 | 假设 | 验证方式 | 预期价值 |
|----------|------|----------|----------|
| `tool.execute.before` 修改命令 | 返回修改后的命令字符串 | 实验编码 | 可用于 `replace_input` 的替代 |
| `api.event.before()` 拦截 | 是否存在类似 middleware 的 before 钩子 | 编码探索 | 真正的 payload 修改能力 |
| `api.client.tui` 指令 | TUI 侧能否触发终端命令 | 编码探索 | 更多交互能力 |
| `experimental.chat.user.transform` | 用户消息能否被修改 | 编码探索 | 替换用户输入 |

#### 3.3.3 输出

探索结果将作为 v1.9 的附件输出：
- `docs/09-API-探索报告.md` — 记录各 API 的实际行为与边界

---

## 四、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `DynamicRule` 与 kickme 功能有重叠 | 中 | kickme 仅通知，dynamic 注入上下文，语义不同 |
| 2 | 动态注入可能导致 system prompt 膨胀过大 | 中 | 设 context 长度上限（500 chars）+ cooldown 冷却 |
| 3 | 平台 API 探索无结果（before 钩子不存在） | 高 | 降低优先级，不做核心功能依赖 |
| 4 | AutoRuleV2 迁移增加状态复杂度 | 中 | 并行运行，不强制迁移 |
| 5 | 冷却机制在单例模式下失效（只一个 session） | 低 | 简单记录 lastTriggered 时间戳足够 |

---

## 五、交付清单

### 动态上下文注入（2h）
- [ ] state.ts — 新增 `DynamicRule` 类型 + 存储 + CRUD
- [ ] shell-fix-tui.ts — `checkDynamicRules()` 在 `session.next.prompted` 中调用
- [ ] shell-fix.ts — system.transform 中读取动态缓存并注入
- [ ] 命令: `/dynamic add|rm|on|off|cooldown`
- [ ] 冷却机制（cooldown 防重复）
- [ ] context 长度限制（500 chars）

### AutoRule 统一配置（1.5h）
- [ ] state.ts — 新增 `AutoRuleV2` 类型 + 存储
- [ ] TUI: `/auto rule` 子命令处理
- [ ] 服务器降级
- [ ] 向后兼容层（旧 module toggle 同步到新规则）

### 平台 API 探索（1h）
- [ ] 探索 `tool.execute.before` 返回值是否可修改命令
- [ ] 探索 `api.event.before()` 是否存在
- [ ] 探索 `experimental.chat.user.transform` 是否存在
- [ ] 输出 API 探索报告

### 最终验证
- [ ] diagnostics 0 错误
- [ ] 提交 v1.9
