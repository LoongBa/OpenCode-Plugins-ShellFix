# v1.3 开发方案 — 三支柱基础版

> 当前版本：v1.2.0 → 目标版本：v1.3.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §10
> 状态：代码已完成，待审计

---

## 一、目标

在 v1.2 三大修复功能基础上，建立三支柱命令体系的基础框架：

1. **/shellfix 子命令** — cmd/encoding/log/doctor/help，状态持久化
2. **/my 模板系统** — 内置 7 模板 + ? 查询 + 参数渲染 + CRUD
3. **/note 笔记系统** — #tag# 存储/检索/层级树浏览

---

## 二、改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shell-fix.ts` | **重写** | 单体 → 模块化，新增 `command.execute.before` 钩子 |
| `src/state.ts` | **新增** | 状态持久化管理 |
| `src/template-store.ts` | **新增** | 模板/笔记存储引擎 |
| `docs/D0-ShellFix-全功能设计.md` | **更新** | 新 §6 /note，更新版本规划 |
| `README.md` | **待更新** | |

---

## 三、功能详情

### 3.1 /shellfix 子命令

| 子命令 | 功能 |
|--------|------|
| (无参数) | 状态面板 + doctor 摘要 |
| `cmd` | 列出所有命令替换规则 + [ON/OFF] |
| `cmd <name> on/off` | 乒乓开关 |
| `encoding on/off` | 编码注入开关 |
| `log on/off` | 日志开关 |
| `doctor` | 环境诊断报告 |
| `help` | 帮助 |

### 3.2 新增命令替换规则（默认 off）

| 规则 | 匹配 | 替换 |
|------|------|------|
| which | `which <cmd>` | `(Get-Command <cmd>).Source` |
| source | `source <file>` | `. <file>` |
| touch | `touch <file>` | `New-Item -ItemType File` |
| rm | `rm <path>` | `Remove-Item -Recurse -Force` |
| chmod | `chmod <args>` | 忽略 + 注释 |

### 3.3 /my 模板系统

| 命令 | 行为 |
|------|------|
| `/my ?` | 列出所有模板 |
| `/my ? <name>` | 预览模板（不注入） |
| `/my <name> [args…]` | 渲染模板，注入对话 |
| `/my save <name> <内容>` | 保存模板 |
| `/my rm <name>` | 删除模板 |
| `/my show <name>` | 查看原始模板 |

内置模板：ys / review / pr / bug / commit / explain / deploy

### 3.4 /note 笔记系统

| 命令 | 行为 |
|------|------|
| `/note ?` | 列出笔记顶层标签 |
| `/note ? <prefix>` | 浏览标签树 |
| `/note #tag#` | 注入笔记内容 |
| `/note #tag#:<content>` | 保存笔记 |
| `/note rm #tag#` | 删除笔记 |

---

## 四、代码结构

```
src/
├── shell-fix.ts       ← 入口：3 个钩子 + 3 个命令处理器 + UI 渲染
├── state.ts           ← 状态持久化（shellfix-state.json）
└── template-store.ts  ← 模板/笔记存储（templates/index.json）
```

### 4.1 钩子架构

```
Plugin Load
├── shell.env            → 环境变量（不变）
├── tool.execute.before  → 命令拦截 + 编码（加开关判断）
└── command.execute.before → /shellfix /my /note 斜杠命令
```

### 4.2 命令分发

```
command.execute.before
├── command == "shellfix" → handleShellFixCommand(args)
├── command == "my"       → handleMyCommand(args)
├── command == "note"     → handleNoteCommand(args)
└── default               → return（不处理）
```

---

## 五、交付清单

- [x] 状态持久化（加载/保存/便捷函数）
- [x] 模板/笔记存储引擎（CRUD + 渲染 + 标签树）
- [x] `/shellfix` 状态面板（文本版）
- [x] `/shellfix cmd` 规则列表 + 开关
- [x] `/shellfix encoding on/off`
- [x] `/shellfix log on/off`
- [x] `/shellfix doctor`
- [x] `/shellfix help`
- [x] `/my ?` / `/my ? <name>`
- [x] `/my <name> [args…]` 渲染执行
- [x] `/my save / rm / show`
- [x] `/note ?` / `/note ? <prefix>`
- [x] `/note #tag#` 注入 / `/note #tag#:内容` 保存
- [x] `/note rm #tag#`
- [ ] `tool.execute.before` 编码/export 保留兼容
- [ ] 新增 5 条命令规则（带开关判断）
- [ ] diagnostics 无错误
- [ ] 部署验证
