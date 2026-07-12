# v1.8 开发方案 — /kickme 通知系统 + 标签 timeline 浏览 + 会话级自动注入

> 当前版本：v1.7.0 → 目标版本：v1.8.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §10
> 预计工作量：~6h（/kickme ✅ 3h 已完成，剩余 ~2.5h）
>
> Oracle 评审结论（2026-07-13）：/auto 管线扩展因缺乏 payload mutation API + `notify`/`collect` 与 kickme/autoCollectTags 重复，**已推迟到 v1.9**

---

## 一、目标

v1.8 聚焦自动化升级，三个方向：

1. **`/kickme` 通知系统** ✅ — 条件匹配 → toast + 声音提示（已实现，bugfix 完成）
2. **标签 timeline 浏览** — 按时间线查看笔记
3. **会话级自动注入** — TUI 启动时提示用户选择模块

> ~~**`/auto` 自动化管线扩展**~~ — ⏸️ 推迟到 v1.9。`replace_input`/`replace_output` 因缺乏 payload mutation API 无法真正实现；`notify`/`collect` 与现有功能重复。

---

## 二、改动范围

| 文件 | 状态 | 说明 |
|------|------|------|
| `src/lib/state.ts` | ✅ **已修改** | 新增 `KickmeRule` 类型 + CRUD + ID 计数器 seed 修复 |
| `src/shell-fix-tui.ts` | ✅ **已修改** | `/kickme` 处理器 + 事件监听集成（含 `scope` 过滤）+ palette 命令 |
| `src/shell-fix.ts` | ✅ **已修改** | `/kickme` 服务器降级 + handleKickmeCommand |
| `src/shell-fix-tui.ts` | ❌ **待改** | 会话级自动注入（`mode === "prompt"` 多选弹窗） |
| `src/lib/template-store.ts` | ❌ **待改** | 新增 `listNotesByTime` / `queryNotesByTime` |
| `src/shell-fix-tui.ts` | ❌ **待改** | `/note timeline` TUI 命令 |
| `src/shell-fix.ts` | ❌ **待改** | `/note timeline` 服务器降级 |
| 所有文件 | ❌ | 最终验证 + docs 更新 |

---

## 三、详细设计

### 3.1 /kickme 通知系统 ✅ (v1.8.0 committed)

**概念：** 用户注册关键词/正则匹配规则，当用户消息或 LLM 回复中匹配时，弹出 toast 通知 + 可选提示音。

**规则模型（state.ts）：**
```typescript
interface KickmeRule {
  id: string;
  label: string;         // 显示名称
  enabled: boolean;
  matchType: "keyword" | "regex";
  pattern: string;       // 匹配模式
  title: string;         // toast 标题
  message: string;       // toast 正文（支持 {matched} 占位符）
  sound: boolean;        // 是否播放提示音
  scope: "user" | "llm" | "both";  // 监听范围
}
```

**持久化：** 存放于 `PluginState.kickme: KickmeRule[]`

**CRUD 函数（state.ts）：**
- `getKickmeRules()` → `KickmeRule[]`
- `addKickmeRule(partial)` → `string`（返回 id）
- `removeKickmeRule(id)` → `boolean`
- `toggleKickmeRule(id)` → `boolean`
- `setKickmeSound(id, on)` → `boolean`

**TUI 本地处理器（shell-fix-tui.ts）：**
```
/kickme                           → listKickmeRulesOutput() 面板
/kickme add <keyword> <title> <message>
/kickme rm <id>
/kickme on|off <id>
/kickme sound <id> on|off
```

**事件集成（shell-fix-tui.ts）：**
```
session.next.prompted → checkKickmeRules(text)  // scope=user|both
session.next.text.ended → checkKickmeRules(text) // scope=llm|both
```

**checkKickmeRules 逻辑：**
1. 遍历所有 enabled 规则
2. 按 matchType 做 keyword/regex 匹配
3. 匹配则 `api.ui.toast({title, message})`
4. 若 sound=true 则 `api.attention.notify()`
5. 每条文本只触发第一个匹配规则（break）

**服务器降级（shell-fix.ts）：**
- `PIPE_CMD_RE` / `SLASH_CMD_RE` 加入 `kickme`
- `handleKickmeCommand()` 函数处理 `/kickme` 后备
- palette 命令 `shellfix.kickme` 通过 dispatch 尝试本地，失败走服务器

---

### 3.2 /auto 自动化管线扩展 — ⏸️ 推迟到 v1.9

**Oracle 评审意见（2026-07-13）：**

`replace_input`/`replace_output` 因插件 API 不支持 payload mutation，无法真正实现替换语义。`notify` 与 kickme、`collect` 与 autoCollectTags 功能重复，增加维护负担。**建议整体推迟到 v1.9，重新设计触发机制（如 `trigger: "user_input"` 的动态上下文注入）。**

详见 [v1.9 开发方案草案](Draft-ShellFix-V1.9-开发方案.md)（待创建）。

---

### 3.3 会话级自动注入

**概念：** 当 TUI 插件初始化时，如果 `auto.mode === "prompt"`，弹出对话框让用户选择本次会话要启用的模块。

#### 3.3.1 模块列表

```typescript
// shell-fix-tui.ts 中已有的 AUTO_MODULES
const AUTO_MODULES = [
  { name: "coding", label: "编程规范", description: "TypeScript/React/Go 等语言规范" },
  { name: "windows", label: "Windows 专属", description: "PowerShell/WSL/路径转换" },
  { name: "tech-stack", label: "技术栈", description: "当前项目的语言/框架/工具" },
  { name: "review", label: "代码审查", description: "CR 审查规则和标准" },
  { name: "security", label: "安全规范", description: "安全编码规范" },
  { name: "git", label: "Git 规范", description: "commit message / branch / PR 规范" },
  { name: "requirements", label: "需求分析", description: "需求澄清与拆分" },
];
```

#### 3.3.2 实现（多选弹窗设计）

Oracle 评审指出 `setTimeout(1000, ...)` 有竞态条件风险，`DialogSelect` 每次只能 toggle 一个模块。改用 `session.ready` 生命周期事件 + 多选弹窗：

```typescript
// shell-fix-tui.ts — tui() 函数末尾
const s = loadState();
if (s.auto.mode === "prompt") {
  const unsub = api.event.on("session.ready", () => {
    unsub(); // 只触发一次
    const current = getEnabledAutoModules();
    const options = AUTO_MODULES.map((m) => ({
      label: `${current.includes(m.name) ? "✅" : "  "} ${m.label}`,
      value: m.name,
      description: m.description,
    }));
    api.ui.dialog?.replace?.(() =>
      api.ui.DialogMultiSelect({
        title: "本次会话启用哪些自动化模块？",
        options,
        selected: current,
        onConfirm: (selected: string[]) => {
          // 一次性设置所有模块状态
          for (const m of AUTO_MODULES) {
            setEnabled(m.name, selected.includes(m.name));
          }
        },
        onCancel: () => {},
      })
    );
  });
}
```

#### 3.3.3 提示词动态生成

根据用户选择的模块，在 `autoInject()` 中生成对应的 system prompt 段落：

```typescript
function autoInject(): string {
  const modules = getEnabledAutoModules();
  if (modules.length === 0) return "";
  const snippets = modules.map(m => AUTO_MODULE_PROMPTS[m]);
  return snippets.filter(Boolean).join("\n\n");
}
```

需要预定义 `AUTO_MODULE_PROMPTS` 字典，每个模块对应一段提示词文本。

#### 3.3.4 状态命令

```
/auto mode prompt|auto|silent     → 切换模式
/auto modules                     → 查看当前启用的模块
/auto modules coding on           → 启用 coding 模块
/auto modules coding off          → 禁用 coding 模块
```

---

### 3.4 标签 timeline 浏览

**概念：** 按时间线查看笔记，支持按标签过滤和时间范围过滤。

#### 3.4.1 数据结构

现有 `NoteEntry`（template-store.ts）：
```typescript
interface NoteEntry {
  tag: string;        // 标签路径（如 "架构/存储层"）
  content: string;    // 笔记内容
  created: string;    // ISO 时间戳
}
```

已有函数：
- `listNotes()` → `NoteEntry[]`
- `queryNotes(prefix)` → `NoteEntry[]`
- `getNote(tag)` → `NoteEntry | undefined`
- `saveNote(tag, content)` → `void`
- `removeNote(tag)` → `boolean`
- `listTagTree(parent?)` → `string[]`

#### 3.4.2 新增函数（template-store.ts）

```typescript
/** 按时间倒序获取笔记（最新在前） */
export function listNotesByTime(limit?: number, since?: string): NoteEntry[] {
  const notes = listNotes();
  const filtered = since
    ? notes.filter(n => n.created >= since)
    : notes;
  return filtered
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, limit ?? filtered.length);
}

/** 按标签 + 时间过滤 */
export function queryNotesByTime(prefix: string, limit?: number, since?: string): NoteEntry[] {
  const notes = queryNotes(prefix);
  const filtered = since
    ? notes.filter(n => n.created >= since)
    : notes;
  return filtered
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, limit ?? filtered.length);
}
```

#### 3.4.3 命令语法

```
/note timeline                    → 按时间倒序列出所有笔记（默认 20 条）
/note timeline --limit 50         → 最多 50 条
/note timeline --since 2025-01-01 → 从指定日期开始
/note timeline --since 7d         → 最近 7 天
/note timeline #架构#              → 按标签过滤
/note timeline #架构# --since 3d   → 组合过滤
```

#### 3.4.4 TUI 输出格式

```
📅 笔记时间线（最近 20 条）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#2026-07-13 14:30# #架构#/存储层
数据库连接池配置完成，使用 HikariCP，最大连接数 20

#2026-07-12 09:15# #编码规范#/TypeScript
确认项目中统一使用 interface 而非 type

#2026-07-11 18:00# #Git#/分支策略
采用 trunk-based 开发，feature flag 控制

...（共 47 条笔记，显示最近 20 条）
```

#### 3.4.5 服务器降级

在 `shell-fix.ts` 的 `handleNoteCommand()` 中添加 `timeline` 子命令处理：

```
/note timeline → 通过 Write-Host 输出时间线
```

---

## 四、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | kickme 大量规则影响性能 | 低 | 轻量字符串匹配，无阻塞操作 |
| 2 | 通知过于频繁骚扰用户 | 低 | 用户可开关/删除规则 |
| 3 | 会话级提示在首次启动时干扰 | 低 | 仅 mode=prompt 时触发 |
| 4 | session.ready 事件是否可用 | 低 | 兼容回退：若无该事件，用 setTimeout |
| 5 | timeline 笔记量大时 UI 输出过长 | 低 | 默认 limit=20，支持分页 |

---

## 五、交付清单

### ✅ /kickme（3h — 已完成，含 bugfix）
- [x] `state.ts` — 新增 `KickmeRule` 类型 + 存储 + CRUD 函数
- [x] `/kickme` 本地处理器：list / add / rm / on / off / sound
- [x] 事件监听集成：checkKickmeRules 在 prompted + text.ended 中调用
- [x] toast + 声音通知
- [x] 服务器降级（slash 命令 + palette）
- [x] scope 过滤（checkKickmeRules 接收 scope 参数）
- [x] ID 计数器 seed 修复（防进程重启碰撞）

### ❌ 会话级自动注入（1.5h）
- [ ] shell-fix-tui.ts — tui() 初始化检测 mode === "prompt"
- [ ] shell-fix-tui.ts — session.ready 多选弹窗（DialogMultiSelect）
- [ ] shell-fix-tui.ts — AUTO_MODULE_PROMPTS 字典 + autoInject() 动态生成
- [ ] shell-fix-tui.ts — `/auto modules` 子命令处理器
- [ ] shell-fix.ts — 服务器降级

### ❌ 标签 timeline（1h）
- [ ] template-store.ts — 新增 listNotesByTime / queryNotesByTime
- [ ] shell-fix-tui.ts — `/note timeline` TUI 处理器
- [ ] shell-fix.ts — 服务器降级

### 最终验证
- [ ] diagnostics 0 错误
- [ ] amend v1.8.0 commit（含 bugfix）
