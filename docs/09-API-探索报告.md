# v1.9 平台 API 探索报告

> 日期：2026-07-13
> 目的：验证 OpenCode Plugin API 中除已用钩子外的新钩子存在性与能力边界

---

## 一、已知钩子（已在 ShellFix 中使用）

| 钩子 | 用途 | 状态 |
|------|------|------|
| `shell.env` | 进程级环境变量注入 | ✅ 已用 |
| `tool.execute.before` | 命令拦截 + 编码注入 | ✅ 已用 |
| `command.execute.before` | 斜杠命令入口 | ✅ 已用 |
| `experimental.chat.system.transform` | system prompt 注入 | ✅ 已用 |

---

## 二、新发现钩子

### 2.1 `chat.message` — 消息接收钩子 ✅ 可用

```typescript
"chat.message"?: (input: {
    sessionID: string;
    agent?: string;
    model?: { providerID: string; modelID: string; };
    messageID?: string;
    variant?: string;
}, output: {
    message: UserMessage;
    parts: Part[];
}) => Promise<void>;
```

**能力：** 收到新消息时触发，可修改 `output.parts`。

**潜在用途：**
- 替代 `replace_input`：在用户消息到达 LLM 前修改内容
- 注入动态上下文到用户消息中（而非 system prompt）
- 过滤/屏蔽敏感内容

**限制：** 只读模式？需要实验验证 `output.parts` 的修改是否生效。

### 2.2 `experimental.chat.messages.transform` — 消息列表变换 ✅ 可用

```typescript
"experimental.chat.messages.transform"?: (input: {}, output: {
    messages: { info: Message; parts: Part[]; }[];
}) => Promise<void>;
```

**能力：** 可以修改整个消息列表（包括 system message、user message、assistant message）。

**潜在用途：**
- 在消息列表层面插入/删除/修改任意消息
- 比 `system.transform` 更灵活，可以操作所有消息类型

**限制：** 标记为 `experimental`，可能不稳定。

### 2.3 `chat.params` — LLM 参数修改 ✅ 可用

```typescript
"chat.params"?: (input: {
    sessionID: string; agent: string; model: Model;
    provider: ProviderContext; message: UserMessage;
}, output: {
    temperature: number; topP: number; topK: number;
    options: Record<string, any>;
}) => Promise<void>;
```

**能力：** 修改发送给 LLM 的参数（temperature、topP 等）。

**潜在用途：** 根据上下文动态调整模型参数。

### 2.4 `chat.headers` — 请求头修改 ✅ 可用

```typescript
"chat.headers"?: (input: {...}, output: { headers: Record<string, string> }) => Promise<void>;
```

**能力：** 修改发送给 LLM provider 的 HTTP 请求头。

### 2.5 `tool.execute.after` — 工具执行后 ✅ 可用

```typescript
"tool.execute.after"?: (input: {
    tool: string; sessionID: string; callID: string; args: any;
}, output: {
    title: string; output: string; metadata: any;
}) => Promise<void>;
```

**能力：** 工具执行完成后，可修改输出结果。

### 2.6 `experimental.session.compacting` — 会话压缩 ✅ 可用

```typescript
"experimental.session.compacting"?: (input: { sessionID: string }, output: {
    context: string[]; prompt?: string;
}) => Promise<void>;
```

**能力：** 自定义会话压缩行为，追加上下文或替换压缩提示词。

### 2.7 `experimental.text.complete` — 文本补全 ✅ 可用

```typescript
"experimental.text.complete"?: (input: {
    sessionID: string; messageID: string; partID: string;
}, output: { text: string }) => Promise<void>;
```

**能力：** 修改 LLM 的文本补全输出。

### 2.8 `tool.definition` — 工具定义修改 ✅ 可用

```typescript
"tool.definition"?: (input: { toolID: string }, output: {
    description: string; parameters: any;
}) => Promise<void>;
```

**能力：** 修改工具的描述和参数 schema。

### 2.9 `event` — 通用事件钩子 ✅ 可用

```typescript
event?: (input: { event: Event }) => Promise<void>;
```

**能力：** 接收所有事件的通用钩子。`Event` 类型来自 `@opencode-ai/sdk`。

### 2.10 `permission.ask` — 权限询问 ✅ 可用

```typescript
"permission.ask"?: (input: Permission, output: {
    status: "ask" | "deny" | "allow";
}) => Promise<void>;
```

**能力：** 修改权限询问行为（自动允许/拒绝）。

---

## 三、未找到的 API

| 假设的 API | 是否存在 | 说明 |
|-----------|----------|------|
| `experimental.chat.user.transform` | ❌ 不存在 | 无此钩子名 |
| `api.event.before()` | ❌ 不存在 | 无 middleware 式 before 钩子 |
| `api.client.tui.executeCommand` | ⚠️ 部分存在 | TUI 侧有 `api.client?.tui?.executeCommand` 但非正式 API |

---

## 四、对 v1.9 的影响

### 4.1 动态上下文注入的替代方案

当前方案（已实现）使用 `pendingDynamic` 缓存 + `system.transform` 注入。如果 `chat.message` 的 `output.parts` 可修改，可以更优雅地实现：

```typescript
// 替代方案（v2.0 候选）：
"chat.message": async (_input, output) => {
    const dynamicContext = consumePendingDynamic();
    if (dynamicContext) {
        output.parts.push({ type: "text", text: dynamicContext });
    }
}
```

**优点：** 无需 system prompt 膨胀，直接注入到用户消息中。
**风险：** 需要实验验证 `output.parts` 的修改是否被平台接受。

### 4.2 会话压缩增强

`experimental.session.compacting` 钩子可以用于：
- 在压缩时保留动态上下文的关键信息
- 追加压缩提示词以保护注入内容不被压缩掉

### 4.3 工具执行后处理

`tool.execute.after` 可以用于：
- 自动清理敏感输出
- 格式化工具执行结果

---

## 五、建议

1. **短期（v1.9）：** 保持当前 `pendingDynamic` + `system.transform` 方案，已验证可靠
2. **中期（v2.0）：** 实验 `chat.message` 的 `output.parts` 修改能力，如果可行则迁移到更优雅的方案
3. **长期：** 利用 `experimental.chat.messages.transform` 实现更复杂的消息注入逻辑
