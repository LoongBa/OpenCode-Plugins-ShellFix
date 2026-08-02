# v1.3 审核报告

> 版本：v1.2.0 → v1.3.0
> 审核时间：2026-07-12
> 对应开发方案：Draft-ShellFix-V1.3-开发方案.md

---

## 一、改动总览

### 新增文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/state.ts` | ~130 | 状态持久化（读/写/缓存 shellfix-state.json） |
| `src/template-store.ts` | ~230 | 模板/笔记存储引擎（CRUD + 渲染 + 标签树） |

### 重写文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/shell-fix.ts` | ~450 | 从 v1.2 的 315 行扩展，新增命令处理器 |

### 更新文档

| 文档 | 说明 |
|------|------|
| `docs/D0-ShellFix-全功能设计.md` | 新增 §6 /note, 更新 §2/§5/§10 |
| `docs/_Draft/Draft-ShellFix-V1.3-开发方案.md` | 扩展范围到三支柱 |

---

## 二、功能清单

### [已实现] 2.1 /shellfix 子命令体系

| 命令 | 状态 |
|------|------|
| `/shellfix`（无参数） | ✅ 状态面板 + doctor 摘要 |
| `/shellfix cmd` | ✅ 6 条规则列表 + [ON/OFF] |
| `/shellfix cmd export on/off` | ✅ 乒乓开关 |
| `/shellfix cmd which on/off` | ✅ 新增规则（默认 off） |
| `/shellfix cmd source on/off` | ✅ 新增规则（默认 off） |
| `/shellfix cmd touch on/off` | ✅ 新增规则（默认 off） |
| `/shellfix cmd rm on/off` | ✅ 新增规则（默认 off） |
| `/shellfix cmd chmod on/off` | ✅ 新增规则（默认 off） |
| `/shellfix encoding on/off` | ✅ |
| `/shellfix log on/off` | ✅ |
| `/shellfix doctor` | ✅ 环境诊断 |
| `/shellfix help` | ✅ |

### [已实现] 2.2 /my 模板系统

| 命令 | 状态 |
|------|------|
| `/my ?` | ✅ 列出所有模板 |
| `/my ? <name>` | ✅ 预览模板内容（不注入） |
| `/my <name> [args…]` | ✅ 渲染执行，支持 {0} {branch} {date} |
| `/my save <name> <content>` | ✅ 保存到 index.json |
| `/my rm <name>` | ✅ 删除（内置只读） |
| `/my show <name>` | ✅ 查看原始模板 |

内置模板（7个）：ys / review / pr / bug / commit / explain / deploy

### [已实现] 2.3 /note 笔记系统

| 命令 | 状态 |
|------|------|
| `/note ?` | ✅ 列出笔记顶层标签 |
| `/note ? <prefix>` | ✅ 浏览标签树（层级导航） |
| `/note #tag#` | ✅ 注入笔记内容 |
| `/note #tag#:<content>` | ✅ 保存笔记 |
| `/note rm #tag#` | ✅ 删除 |

### [保留] 2.4 原有三大修复功能

| 功能 | 状态 |
|------|------|
| 编码前缀注入 | ✅ 保持，加 state.encoding 开关 |
| export→$env: 转换 | ✅ 保持，加 state.cmdRules.export 开关 |
| Git 免交互 16 变量 | ✅ shell.env 不变 |

---

## 三、架构评审

### 3.1 钩子关系

```
command.execute.before  ← 新入口，处理三个斜杠命令
  ├── /shellfix → state.ts 读写开关
  ├── /my       → template-store.ts 读写
  └── /note     → template-store.ts 读写

tool.execute.before     ← 保留，加上开关判断
  ├── 命令替换（state.cmdRules 控制）
  └── 编码前缀（state.encoding 控制）

shell.env               ← 不变
```

### 3.2 存储

- **状态文件**: `~/.config/opencode/shellfix-state.json` — 开关持久化
- **模板/笔记**: `~/.config/opencode/templates/index.json` — templates + notes 双分区

### 3.3 兼容性

- v1.2 的 `/shellfix` 无参数行为保留
- `shell.env` 钩子不变
- 新增规则全部默认 off，不改变现有行为
- 内置模板只读，不会因用户操作丢失

---

## 四、风险项

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `require("child_process")` 在 Bun 中可能有限制 | 低 | 仅用于 git branch 检测，execSync 超时 3s |
| 2 | 状态文件并发写入 | 低 | 单进程访问，写后即刻可读 |
| 3 | `command.execute.before` 是标准 API，但需验证 OpenCode 版本 | 低 | 参照 @opencode-ai/plugin v1.17.13 类型定义 |

---

## 五、部署状态

| 文件 | 路径 | 状态 |
|------|------|------|
| `shell-fix.ts` | `~/.config/opencode/plugins/shell-fix.ts` | ✅ 已部署 |
| `state.ts` | `~/.config/opencode/plugins/state.ts` | ✅ 已部署 |
| `template-store.ts` | `~/.config/opencode/plugins/template-store.ts` | ✅ 已部署 |

> ⚠️ 需要重启 OpenCode 才能加载 v1.3 插件

---

## 六、结论

**通过审核。** v1.3 实现了三支柱基础框架：

1. **`/shellfix`** — 子命令体系 + 状态持久化 + 6 条规则管理
2. **`/my`** — 模板系统（内置 7 模板 + 参数渲染 + CRUD）
3. **`/note`** — 笔记系统（#tag# 存储/检索/层级树）

下一步：规划 v1.4（`/in` 注入系统）。
