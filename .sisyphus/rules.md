# 工作流程

> 项目：OpenCode-Plugins-ShellFix
> 插件名：opencode-shellfix（npm）

---

## 版本迭代流程

```
开发方案 → 实现开发 → 审核报告 → 提交/push → 打 tag 发布
```

### 1. 编写开发方案

`docs\迭代开发记录\ShellFix-V{ver}-开发方案.md`

- 开发前必须编写，未经方案不得开始实现
- 先写方案，经用户确认后再开始实现

### 2. 实现开发

- 按方案交付清单逐项实现并标记
- 所有改动通过 LSP 诊断（零 error）

### 3. 编写审核报告

`docs\迭代开发记录\ShellFix-V{ver}-审核报告.md`

- 实现完成后编写，审核完成后方可提交

### 4. 提交 & push

- 不得擅自提交，**必须等用户确认**审核报告后明确说"可以提交"
- 提交信息遵循仓库既有风格（semantic commit）

### 5. 打 tag 发布

- 不得擅自打 tag，**必须等用户同意**
- tag 格式：`V{ver}`（如 `V2.2.11`）
- tag 自动触发：GitHub Release + npm 发布（`publish.yml`）
- **tag 后立即部署到本地**：将源码复制到 `~/.config/opencode/plugins/`（含 `lib/` 子目录），确保本地环境立即使用新版本

---

## 禁止行为

- ❌ 未经用户确认审核报告就提交
- ❌ 未经用户同意就打 tag
- ❌ 跳过开发方案直接实现