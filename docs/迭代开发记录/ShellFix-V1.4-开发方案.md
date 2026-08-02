# v1.4 开发方案 — /in 注入系统

> 当前版本：v1.3.0 → 目标版本：v1.4.0 ✅ 已实现
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §7
> 实际工作量：~2h

---

## 一、目标

建立上下文注入系统 `/in`，解决每次都要手动输入规则的痛点。
Session 启动时自动注入你关心的上下文，省去重复输入。

三种模式：
- **auto** — 静默全自动注入启用的模块
- **prompt** — 弹引导消息询问当次要注入什么
- **silent** — 什么都不做（默认行为，不影响现有体验）

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shell-fix.ts` | **修改** | 新增 `/in` 命令处理器 |
| `src/shell-fix.ts` | **修改** | 新增 `experimental.chat.system.transform` 钩子 |
| `src/inject-modules.ts` | **新增** | 注入模块定义 + 内容 |
| `src/state.ts` | **修改** | 新增 inject 状态字段 |
| `docs/D0-ShellFix-全功能设计.md` | **后续更新** | |

---

## 三、详细设计

### 3.1 状态扩展

```typescript
// state.ts 新增
export interface InjectState {
  modules: Record<string, boolean>;  // 模块名 → 启用?
  mode: "prompt" | "auto" | "silent";
  require: string;  // 临时注入文本
}
```

默认配置：
```
coding ✅         编码规范
windows ✅        平台提醒
tech-stack ✅     技术栈声明
review ❌         Review 清单
security ❌       安全提醒
git ❌            Git 规范
mode: prompt      启动行为
```

### 3.2 注入模块内容

```typescript
// inject-modules.ts
const INJECT_MODULES: Record<string, {
  label: string;
  content: string;
}> = {
  coding: {
    label: "编码规范",
    content: `## 编码规范\n- TypeScript 严格模式，禁止 as any / @ts-ignore\n- ...`
  },
  windows: {
    label: "平台提醒",
    content: `## 平台信息\n- 本项目运行在 Windows + PowerShell 上\n- ...`
  },
  tech-stack: {
    label: "技术栈",
    content: `## 技术栈\n- ...（自动从项目检测）`
  },
  review: { label: "Review 清单", content: "..." },
  security: { label: "安全提醒", content: "..." },
  git: { label: "Git 规范", content: "..." },
};
```

### 3.3 三种启动模式

```
auto:
  插件加载 → 所有启用模块注入 system prompt → 用户直接开始对话
  好处：零操作，但 context 固定

prompt（默认）:
  LLM 首条消息：
  "需要配置今天的注入吗？当前已启用：coding✅ windows✅ tech-stack✅
  可用：review security git
  用 /in on <模块> 开启，或 /in mode auto 跳过确认"

silent:
  完全不注入，行为同 v1.3。

更改模式：
  /in mode auto     → 下次 session 生效
  /in mode prompt   → 下次 session 生效
  /in mode silent   → 关闭注入
```

### 3.4 /in 命令语法

```
/in                     → 显示当前状态
/in list                → 列出所有模块 + 开关状态 + mode
/in on <module>         → 启用模块
/in off <module>        → 禁用模块
/in mode                → 查看当前 mode
/in mode auto|prompt|silent  → 设置 mode
/in require <text>      → 临时注入一句话（当前 session 生效）
/in require             → 查看当前临时注入
/in require ""          → 清除临时注入
/in help                → 帮助
```

### 3.5 注入时机

```
experimental.chat.system.transform
├── mode === "silent" → 直接返回
├── mode === "auto"   → 所有已启用模块的 content 追加到 output.system
├── mode === "prompt" → 追加引导消息到 system（提示用户配置）
└── 所有模式都检查 /in require → 追加临时文本
```

> `experimental.chat.system.transform` 是实验性 API。
> 如果不可用，降级为在第一条消息中插入系统级指令。

---

## 四、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `experimental.chat.system.transform` API 不稳定 | 中 | 加 try-catch，不可用时静默降级 |
| 2 | 注入内容过多撑爆 system prompt | 低 | 模块内容控制在 200 字以内 |
| 3 | 用户不想要注入，忘记改 mode | 低 | 默认 `prompt` 模式不打扰 |

---

## 五、交付清单 ✅ 全部完成

- [x] `inject-modules.ts` — 定义注入模块 + 内容（7 个模块：coding/windows/tech-stack/review/security/git/requirements）
- [x] `state.ts` — 新增 inject 状态（modules/mode/require）
- [x] `/in list` — 列出所有模块 + [ON/OFF] + mode
- [x] `/in <module>` — 切换模块开关（而非 on/off 两个子命令）
- [x] `/in mode` / `/in mode prompt|auto|silent`
- [x] `/in require <text>` — 临时注入
- [x] `/in req_rm` — 清除 require
- [x] `/in show <module>` — 查看模块内容
- [x] `/in reset` — 恢复默认
- [x] `experimental.chat.system.transform` 钩子 — 自动注入启用的模块
- [x] auto 模式 — 静默自动注入启用的模块
- [x] prompt 模式 — 追加引导提示
- [x] silent 模式 — 不做任何事
- [x] 状态面板集成 — `/shellfix` 面板显示注入状态 + 模块计数
- [x] `/shellfix help` 整合 /in 帮助
- [x] bun build 编译通过，zero diagnostics
