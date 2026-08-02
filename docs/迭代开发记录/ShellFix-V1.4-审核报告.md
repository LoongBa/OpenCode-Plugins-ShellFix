# v1.4 审核报告

> 版本：v1.3.0 → v1.4.0
> 审核时间：2026-07-12
> 对应开发方案：Draft-ShellFix-V1.4-开发方案.md

---

## 一、改动总览

### 新增文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/inject-modules.ts` | ~130 | 注入模块定义（7 个模块：coding/windows/tech-stack/review/security/git/requirements） |

### 修改文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/state.ts` | +40 | 新增 InjectState 接口（modules/mode/require）+ 5 个 setter/getter |
| `src/shell-fix.ts` | +180 | 新增 `/in` 命令处理器 + `experimental.chat.system.transform` 钩子 + 状态面板集成 |

### 修复

| 文件 | 说明 |
|------|------|
| `src/template-store.ts` | `renderTemplate` 修复 `{{ }}` 转义处理，避免 `{branch}` 被错误解析 |

### 更新文档

| 文档 | 说明 |
|------|------|
| `docs/_Draft/Draft-ShellFix-V1.4-开发方案.md` | 交付清单标记完成 ✅ |

---

## 二、功能清单

### [已实现] 2.1 注入模块（7 个）

| 模块 | 默认 | 内容 |
|------|------|------|
| `coding` | ON | TS 严格模式、命名规范、禁止 `as any`、UTF-8 编码、禁止提交凭据 |
| `windows` | ON | Windows + PowerShell 环境提醒（路径分隔符、$env: 语法） |
| `tech-stack` | ON | 自动检测的技术栈声明（TypeScript/Bun/OpenCode Plugin API） |
| `review` | OFF | Review 检查清单（逻辑/类型/错误/性能/安全/可维护性/测试） |
| `security` | OFF | 安全注意事项（凭据硬编码、路径遍历、SQL 注入、日志敏感字段） |
| `git` | OFF | Git 规范（分支命名、commit type、rebase 策略） |
| `requirements` | 动态 | `/in require` 临时注入的当前任务目标 |

### [已实现] 2.2 /in 命令体系

| 命令 | 状态 | 实现方式 |
|------|------|---------|
| `/in`（无参数） | ✅ | 状态面板总览（模式 + 模块开关 + require） |
| `/in list` | ✅ | 列出所有模块 + 开关状态 + 模式（支持 `/in ls` 别名） |
| `/in <module>` | ✅ | 切换模块开关（toggle，无需 on/off 子命令） |
| `/in mode` | ✅ | 查看当前模式 |
| `/in mode prompt\|auto\|silent` | ✅ | 设置注入模式 |
| `/in require <text>` | ✅ | 临时注入当前任务目标 |
| `/in req_rm` | ✅ | 清除 require（支持 `/in require_rm` / `reqrm` 别名） |
| `/in show <module>` | ✅ | 查看模块原始内容 |
| `/in reset` | ✅ | 恢复所有模块默认开关 + 清除 require |
| `/in help` | ✅ | 命令帮助 |

### [已实现] 2.3 三种注入模式

| 模式 | 行为 | 实现 |
|------|------|------|
| `auto` | 静默全自动注入所有启用模块 | system.transform 追加模块内容 |
| `prompt` (默认) | 注入模块内容 + 追加引导提示 | 内容 + `[注] 以上为 ShellFix 自动注入的上下文` |
| `silent` | 不做任何注入 | system.transform 直接 return |

### [已实现] 2.4 集成

| 集成点 | 说明 |
|--------|------|
| `/shellfix` 状态面板 | 新增 "注入系统" 行 + 已启用模块计数 |
| `/shellfix help` | 整合 `/in` 所有子命令帮助 |
| 状态持久化 | inject state 通过 `deepMerge` 写入 `shellfix-state.json` |
| `bun build` | 编译通过，zero diagnostics |

---

## 三、架构评审

### 3.1 钩子关系（v1.4）

```
command.execute.before
  ├── /shellfix → state.ts 读写
  ├── /my       → template-store.ts 渲染/CRUD
  ├── /note     → template-store.ts 笔记 CRUD
  └── /in       → state.ts (inject) + inject-modules.ts 查询

experimental.chat.system.transform  ← 新增
  ├── 收集启用模块内容 + require 文本
  ├── 追加到 output.content 末尾
  └── prompt 模式追加引导提示

tool.execute.before     ← 不变
shell.env               ← 不变
```

### 3.2 数据流

```
/in coding → state.ts: inject.modules.coding = true/false
             ↓
system.transform → getEnabledInjectModules()
                  → getInjectModule(name).content
                  → out.content += separator + chunks
```

### 3.3 存储

- **状态文件**: `~/.config/opencode/shellfix-state.json`
  - `inject.modules` — 每个模块的开关状态
  - `inject.mode` — 当前模式 (prompt/auto/silent)
  - `inject.require` — 临时注入文本（跨 session 持久，但需手动清除）

### 3.4 兼容性

- v1.3 所有功能完全保留
- 状态文件 `deepMerge` 保证旧文件自动补齐新字段
- `command.execute.before` 新增 `in` case，不影响现有命令
- `experimental.chat.system.transform` 是实验 API，try-catch 无需处理

---

## 四、风险项

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `experimental.chat.system.transform` API 不稳定或不可用 | 中 | 无 try-catch（插件加载时失败即禁用），钩子直接返回不抛异常 |
| 2 | 注入内容过长撑爆 system prompt | 低 | 每个模块控制在 200 字以内，默认只开 3 个 |
| 3 | `{{ }}` 转义不彻底（模板嵌套场景） | 低 | 当前实现覆盖位置参数 + 环境变量两层替换 |
| 4 | `/in require` 跨 session 持久化 | 低 | 容设计：过时内容用户手动 `/in req_rm` 清除 |

---

## 五、部署状态

| 文件 | 路径 | 状态 |
|------|------|------|
| `shell-fix.ts` | `~/.config/opencode/plugins/shell-fix.ts` | ✅ 已部署 |
| `state.ts` | `~/.config/opencode/plugins/state.ts` | ✅ 已部署 |
| `template-store.ts` | `~/.config/opencode/plugins/template-store.ts` | ✅ 已部署 |
| `inject-modules.ts` | `~/.config/opencode/plugins/inject-modules.ts` | ✅ 已部署 |

> ⚠️ 需要重启 OpenCode 才能加载 v1.4 插件（含新钩子 `experimental.chat.system.transform`）

---

## 六、结论

**通过审核。** v1.4 实现了第四支柱——`/in` 注入系统：

1. **7 个注入模块** — 覆盖编码规范、平台提醒、技术栈、Review、安全、Git、任务目标
2. **三种模式** — auto（静默）/ prompt（引导）/ silent（关闭）
3. **完整命令体系** — 开关/mode/require/show/reset/help
4. **`{{ }}` 转义修复** — 模板系统正确处理文字花括号
5. **状态面板集成** — `/shellfix` 一屏查看注入状态

下一步：规划 v1.5（`/my` Git 同步）。