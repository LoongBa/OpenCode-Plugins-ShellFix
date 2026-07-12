# v1.8 开发方案 — /my 增强 + 错误处理 + 性能优化

> 当前版本：v1.7（开发中）→ 目标版本：v1.8.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §10
> 预计工作量：~5.5h

---

## 一、目标

v1.8 聚焦四个方向，补全 v1.7 剩余工作：

1. **`/my edit`** — 交互式编辑模板内容
2. **`/my sync --push`** — 将本地模板推送到远程仓库
3. **全面错误处理** — 统一错误格式 + 输入校验加固
4. **性能优化** — 条件评估缓存 + 分支名缓存

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shell-fix-tui.ts` | **修改** | 新增 `/my edit` TUI 本地处理 |
| `src/shell-fix.ts` | **修改** | 新增 `/my edit` 服务器处理 + `/my sync --push` + 错误处理 |
| `src/lib/template-store.ts` | **修改** | 新增 `editTemplate` + `pushTemplatesToRemote` |
| `src/lib/state.ts` | **修改** | 新增 `autoCollectEnabled` 开关 |
| All files | **修改** | 全面错误处理 + 性能优化 |

---

## 三、详细设计

### 3.1 /my edit — 交互式编辑

**问题：** 用户修改已有模板只能 `/my save <name>` 重新输入全文。

**TUI 侧（本地）：**
```
Ctrl+P → /my → 选择模板 → 显示当前内容
→ Dialog: 编辑/确认 → saveTemplate → toast
```

**服务器侧（slash 命令）：**
```
/my edit <name>                     → 显示当前内容 + 引导
/my edit <name> <new content>        → 直接替换全文
/my edit <name> --replace <old> <new> → 字符串替换
```

**本地处理器实现：**
```typescript
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
  return { output: `模板: ${name}\n当前内容:\n${tmpl.template}` };
}
```

### 3.2 /my sync --push

**问题：** 只能拉取，不能推送本地模板回团队仓库。

**实现：** `template-store.ts` 新增 `pushTemplatesToRemote`。

```typescript
export function pushTemplatesToRemote(
  templateNames: string[],
  all?: boolean
): { success: boolean; message: string; pushed: number } {
  // 1. 检查 remote/ 存在且为 Git 仓库
  // 2. git pull --rebase 获取最新
  // 3. 将模板写入 remote/ 目录（JSON 格式）
  // 4. git add + git commit
  // 5. git push origin HEAD:<branch>
  // 6. 返回结果
}
```

**命令语法：**
```
/my sync --push <name> [name...]   → 推送指定模板
/my sync --push --all               → 推送所有用户模板
```

**安全：**
- 推送前 `git pull --rebase` 避免冲突
- 不存储 Git 凭据，依赖 credential helper
- 失败时提示用户手动处理

### 3.3 错误处理加固

**统一错误格式：** 所有用户可见错误使用 `⚠️` 前缀。

```
✅ 笔记 #deploy# 已保存
⚠️ 模板 "deploy" 不存在
⚠️ 克隆失败: 认证失败 — 请检查 Git 凭据
```

**检查清单：**

| 模块 | 当前 | 需要 |
|------|------|------|
| `state.ts` | ✅ 有 try-catch | 无需 |
| `template-store.ts` | ⚠️ 有 try-catch | JSON 解析需更健壮 |
| `shell-fix.ts` | ⚠️ execSync 有 try-catch | 统一错误格式 |
| `shell-fix-tui.ts` | ✅ 全部 try-catch | 无需 |

**加固项：**

| 项 | 当前行为 | 修复后 |
|---|---------|--------|
| `/my sync` Git 失败 | `execSync` 抛异常 | 区分：未安装Git/认证失败/网络超时 |
| `/note` 空标签 | 保存空字符串 | 校验：禁止空/含空格/含# |
| `/auto conditions` 非法谓词 | 写入非法值 | 校验：仅接受已定义的9种谓词 |
| `/my save` 空内容 | 保存空模板 | 拦截：内容非空校验 |
| 所有 `execSync` | 裸错误消息 | 统一：去掉 stderr + 友好提示 + 超时 |
| 笔记标签重名 | 覆盖旧内容 | 检测重名 → toast 提示已存在 |
| 模板名冲突 | 按优先级覆盖 | toast 提示用户/远程/内置层级 |

### 3.4 性能优化

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

// 在 /auto 操作后清除
function clearConditionCache(): void {
  _conditionCache = null;
}
```

**优化项：**

| 优化项 | 当前 | 优化后 | 节省 |
|--------|------|--------|------|
| 条件评估 | 每次 system.transform 重复 execSync | 模块加载时评估一次 | 每次 LLM 调用 5~10ms |
| 分支名查询 | 每次 renderTemplate 调用 git | 缓存到进程级变量 | 每次模板渲染 ~50ms |
| `isNaN` → `Number.isNaN` | 全局 isNaN（类型转换） | Number.isNaN（严格） | 无性能影响，代码质量 |
| `any` 类型 → 具体类型 | 多处 any | 尽量用具体接口 | 无性能影响，代码质量 |

---

## 四、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `/my sync --push` 需要 Git 写权限 | 中 | 推送失败时提示手动处理 |
| 2 | 错误处理改造覆盖面广 | 低 | 逐文件推进，不改逻辑 |
| 3 | 条件缓存可能导致 stale 结果 | 低 | 模块开关操作后清除缓存 |
| 4 | TUI 侧 `saveTemplate` 与服务器侧竞争写 | 低 | 单用户场景无竞争 |

---

## 五、交付清单

### `/my edit`（1h）
- [ ] TUI 侧本地处理器：`/my edit <name>` 显示当前内容
- [ ] TUI 侧本地处理器：`/my edit <name> <content>` 直接替换
- [ ] 服务器侧：slash 命令 `/my edit` 降级
- [ ] 内置模板只读保护（不可编辑内置模板）

### `/my sync --push`（1.5h）
- [ ] `pushTemplatesToRemote()` 函数
- [ ] `/my sync --push <name>` 推送指定模板
- [ ] `/my sync --push --all` 推送全部
- [ ] 推送前 git pull --rebase
- [ ] 错误区分：未安装/认证/网络

### 错误处理（2h）
- [ ] 统一错误格式 — `⚠️` 前缀
- [ ] `/my sync` Git 错误人性化
- [ ] `/note` 空标签/非法标签校验
- [ ] `/auto conditions` 谓词值校验
- [ ] `/my save` 内容非空校验
- [ ] execSync 超时 + 错误消息清理
- [ ] 笔记重名检测 → toast 提示

### 性能优化（1h）
- [ ] 条件评估缓存 + 清除机制
- [ ] 分支名缓存（进程级）
- [ ] `isNaN` → `Number.isNaN`
- [ ] TUI 侧不再重复执行 execSync

### 最终验证
- [ ] diagnostics 0 错误（全部文件）
- [ ] 提交 v1.8