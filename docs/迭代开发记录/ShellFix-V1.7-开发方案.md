# v1.7 开发方案 — 增强与稳定

> 当前版本：v1.6.0（未提交）→ 目标版本：v1.7.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §10
> 预计工作量：~6h

---

## 一、目标

v1.7 是稳定性版本，聚焦四个方向：

1. **`/my` 增强** — `edit` 交互式编辑 + `sync --push` 远程推送
2. **`/note` 增强** — `:last` 真正实现 + `cache` 手动缓存
3. **事件订阅自动化** — `event.on` 监听 → 自动采集 `#标签#`
4. **全面错误处理 + 性能优化** — 补全错误处理盲区 + 缓存优化

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shell-fix.ts` | **修改** | 新增 `/my edit` + `/my sync --push` + `/note :last` 实现 + 错误处理 |
| `src/shell-fix-tui.ts` | **修改** | 新增 `/my edit` 本地处理 + 事件订阅 |
| `src/lib/template-store.ts` | **修改** | 新增 `editTemplate` + `pushTemplatesToRemote` |
| `src/lib/state.ts` | **修改** | 新增 `lastMessage` 存储字段 |
| All files | **修改** | 全面错误处理 + 性能优化 |

---

## 三、详细设计

### 3.1 /my edit — 交互式编辑

**当前问题：** 用户修改已有模板只能 `/my save <name>` 重新输入全文，没有编辑体验。

**实现方案：** TUI 侧本地处理 + 服务器回退双路径。

**TUI 侧（本地处理）：**
```
用户 Ctrl+P → 选择模板 → 显示当前内容
→ DialogPrompt 编辑 → 保存 → toast
```

**服务器侧（slash 命令）：**
```
/my edit <name>                    → 显示当前内容 + 引导编辑
/my edit <name> <new content>       → 直接替换全文
```

**具体实现：**

```typescript
// TUI handler 新增
case "edit": {
  const name = tokens[1];
  if (!name) return { toast: "用法: /my edit <name> [内容]" };
  const tmpl = getTemplate(name);
  if (!tmpl) return { toast: `模板 "${name}" 不存在` };
  const content = tokens.slice(2).join(" ");
  if (content) {
    saveTemplate({ name, template: content, description: tmpl.description });
    return { toast: `模板 "${name}" 已更新` };
  }
  return { output: `模板: ${name}\n描述: ${tmpl.description || ""}\n\n当前内容:\n${tmpl.template}` };
}
```

### 3.2 /my sync --push

**当前问题：** 只能从远程拉取模板，不能将本地模板分享回团队仓库。

**实现方案：** 在 `template-store.ts` 新增 `pushTemplatesToRemote` 函数。

```typescript
export function pushTemplatesToRemote(userTemplates: TemplateEntry[]): PushResult {
  // 1. 检查 remote/ 存在且为 Git 仓库
  // 2. 将用户模板写入 remote/ 目录
  // 3. git add + git commit
  // 4. git push origin HEAD:<branch>
  // 5. 返回结果（成功/失败 + 消息）
}
```

**推送流程：**
```
/my sync --push <name> [name...]
├── 验证 remote/ 存在且为 Git 仓库
├── 将指定模板写入 remote/ 目录（JSON 格式）
├── git add <files>
├── git commit -m "shellfix: sync template <name>"
├── git push origin HEAD:<branch>
└── 报告结果

/my sync --push --all
├── 推送所有用户自定义模板
```

**安全考虑：**
- 推送前先拉取最新代码（git pull --rebase）
- 推送失败时提示用户手动处理
- 不存储 Git 凭据，依赖已配置的 credential helper

### 3.3 /note :last 真正实现

**当前问题：** `:last` 是占位符，没有真正截取上一条消息。

**实现方案：** 基于 `event.on("session.next.text.ended")` 事件订阅。

```typescript
// shell-fix-tui.ts — 事件订阅
api.event.on("session.next.text.ended", (event) => {
  // 提取 LLM 回复文本
  const text = extractText(event.data);
  if (text) {
    // 自动缓存到 lastMessage
    setLastMessage(text);
  }
});
```

**用户交互：**
```
/note #架构/存储层#:last
→ TUI 本地处理：从 lastMessage 缓存读取
→ 保存到笔记
→ toast: "笔记 #架构/存储层# 已保存（来自缓存）"

/note cache <内容>
→ 手动缓存一段文本
→ toast: "已缓存"
```

**注意：** `lastMessage` 缓存是进程内变量，不持久化到文件。重新启动 OpenCode 后缓存为空。

### 3.4 事件订阅 — 自动采集 #标签#

**实现方案：** 在 `shell-fix-tui.ts` 的 `tui()` 函数中注册事件监听。

```typescript
// 自动采集 LLM 回复中的 #标签#
api.event.on("session.next.text.ended", (event) => {
  const text = extractText(event.data);
  if (!text) return;
  
  // 正则匹配 #标签#
  const tags = text.match(/#([^#\s]+)#/g);
  if (!tags) return;
  
  for (const tagMatch of tags) {
    const tag = tagMatch.slice(1, -1);
    // 提取标签后的上下文作为笔记内容
    const context = extractContext(text, tagMatch);
    saveNote(tag, context);
  }
});
```

**配置开关：** 通过 `/auto` 模块控制（如 `auto-collect` 模块）。

### 3.5 全面错误处理加固

**统一错误格式：** 所有错误输出使用 `⚠️` 前缀。

```
⚠️ 克隆失败: 认证失败 — 请检查 Git 凭据
⚠️ 模板不存在: deploy
⚠️ 条件索引无效: 3
```

**检查清单：**

| 模块 | 当前状态 | 需要加固 |
|------|---------|---------|
| `state.ts` | 文件读写有 try-catch | ✅ 已够 |
| `template-store.ts` | 文件读写有 try-catch | ⚠️ JSON 解析需更健壮 |
| `auto-rules.ts` | 纯静态数据 | ✅ 无需 |
| `shell-fix.ts` | execSync 有 try-catch | ⚠️ 需要统一错误格式 |
| `shell-fix-tui.ts` | 全部 try-catch | ✅ 已够 |

**具体加固项：**
1. `/my sync` — Git 命令失败时区分"未安装 Git"、"认证失败"、"网络超时"
2. `/note` — 标签格式校验（禁止空标签、禁止含空格、禁止含 `#`）
3. `/auto conditions` — 谓词值校验（os 只接受 win32/darwin/linux）
4. `/my save` — 内容非空校验
5. 所有 execSync — 统一超时处理 + 错误消息清理

### 3.6 性能优化

| 优化项 | 当前 | 优化后 |
|--------|------|--------|
| 分支名查询 | 每次 `renderTemplate` 调用 | 缓存到进程级变量 |
| 条件评估 | 每次 system.transform 调用 | 缓存评估结果 |
| 状态文件读取 | 每次 `loadState` 读内存缓存 | 已缓存，无需优化 |
| 模板索引加载 | 每次 `loadIndex` 读内存缓存 | 已缓存，无需优化 |

**条件评估缓存：**
```typescript
let _conditionCache: Record<string, boolean> | null = null;

function getCachedShouldInject(modName: string): boolean {
  if (_conditionCache === null) {
    _conditionCache = {};
    for (const mod of AUTO_MODULES) {
      _conditionCache[mod.name] = shouldInjectModule(mod.name);
    }
  }
  return _conditionCache[modName] ?? false;
}

// 在 /auto 命令操作后清除缓存
function clearConditionCache(): void {
  _conditionCache = null;
}
```

---

## 四、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `/my sync --push` 需要 Git 写权限 | 中 | 推送失败时提示手动处理 |
| 2 | `/note :last` 依赖 event.on 订阅 | 低 | 备选 `/note cache` 手动路径 |
| 3 | 事件订阅可能影响性能 | 低 | 轻量正则匹配，无阻塞操作 |
| 4 | 性能缓存可能导致 stale 结果 | 低 | 操作后清除缓存 |

---

## 五、交付清单

### /my 增强
- [ ] `/my edit <name>` — 显示模板内容 + 引导编辑
- [ ] `/my edit <name> <content>` — 直接替换全文
- [ ] `/my sync --push <name>` — 推送单个模板到远程
- [ ] `/my sync --push --all` — 推送所有用户模板
- [ ] `pushTemplatesToRemote()` — 实现 Git push 逻辑

### /note 增强
- [ ] `event.on("session.next.text.ended")` 订阅
- [ ] `lastMessage` 缓存（进程内变量）
- [ ] `/note #tag#:last` — 从缓存读取并保存
- [ ] `/note cache <内容>` — 手动缓存
- [ ] 自动采集 `#标签#`（配置开关）

### 错误处理
- [ ] 统一错误格式 — 所有错误使用 `⚠️` 前缀
- [ ] 错误消息人性化 — 区分 Git 未安装/认证失败/网络超时
- [ ] 输入校验加固 — 空内容/空标签/非法谓词值

### 性能优化
- [ ] 条件评估缓存 — 避免重复 execSync
- [ ] 分支名缓存 — 统一到 `resolveGitBranchCached`
- [ ] `clearConditionCache()` — 条件变更后清除缓存

### 最终验证
- [ ] diagnostics 无错误（shell-fix.ts / shell-fix-tui.ts / lib/*）
- [ ] 完整的 `/auto` 命令流程测试（TUI 侧 + 服务器回退）