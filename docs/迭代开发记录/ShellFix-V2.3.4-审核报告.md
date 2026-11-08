# v2.3.4 审核报告 — 发布渠道迁移到 `@tkwf/opencode-shellfix`

> 对应开发方案：`docs/迭代开发记录/ShellFix-V2.3.4-开发方案.md`
> 审核日期：2026-11-08
> 版本：2.3.3 → 2.3.4（发布迁移，无功能变更）

---

## 一、结论

实现完成，静态检查通过（改动文件 LSP 零 error；`npm pack --dry-run` 包名/版本/内容均正确）。**已部署到本地环境**（9 个文件哈希全部一致，`PLUGIN_VERSION=2.3.4`，备份 `.bak\20261108_155505_*`）。

npm 侧已具备发布条件：本地 `npm whoami` = **`coffeedrunk`**，`npm org ls tkwf` = **`coffeedrunk - owner`**；包名 `@tkwf/opencode-shellfix` 在 registry 返回 404（未被占用）。发布动作待用户确认提交后执行。

---

## 二、交付清单核对

| # | 项 | 状态 | 说明 |
|---|----|------|------|
| 1 | `package.json` | ✅ | `name` → `@tkwf/opencode-shellfix`；`version` → `2.3.4`；新增 `repository`（`git+https://github.com/LoongBa/OpenCode-Plugins-ShellFix.git`）；`publishConfig.access: public` 保留 |
| 2 | `src/lib/state.ts` | ✅ | `PLUGIN_VERSION = "2.3.4"`（单行改动，编码/行尾未变） |
| 3 | `README.md` | ✅ | 当前版本 v2.3.4；安装命令 `opencode plugin @tkwf/opencode-shellfix`；`opencode.json` 示例同步；新增「发布渠道迁移」说明（旧包停 2.2.12） |
| 4 | `docs/03-安装与使用.md` | ✅ | 当前版本 v2.3.4（原 v1.1.0 陈旧值一并修正）；新增「方式零：npm 一键安装」；版本验证预期输出 `2.3.4` |
| 5 | `CHANGELOG.md` | ✅ | v2.3.4 条目（迁移原因、安装命令、旧包状态） |

> 运行时逻辑**零改动**：插件不读取自身包名，包名变更不影响任何功能路径。

---

## 三、实现要点与关键决策

1. **版本取 2.3.4 而非复用 2.3.3**：`V2.3.3` 标签已指向 `aab6fba`，新包从 2.3.4 起算，保证 git 标签与 npm 版本一一对应，避免「同名不同源」。
2. **包名迁移而非转移**：npm 权限规则要求「非 scoped 包的直接 owner 必须是目标 org 成员」才能 Add Existing Package；`loongba` 不在 `tkwf` 中，且 npm 无重命名/转移能力 → 只能新建 scoped 包。
3. **`repository` 字段**：npm 页面可直接跳 GitHub，便于用户核对源码（包名变了，溯源更重要）。
4. **发布通道不改进 workflow**：`.github/workflows/publish.yml` 结构保持 `on.push.tags: V*` → release + `npm publish`；唯一变化是 secret `NPM_TOKEN` 已由用户更新为 tkwf 账号（`coffeedrunk`）的 token。
5. **旧包不删除、不立即 deprecate**：`opencode-shellfix` 停在 2.2.12；待 `loongba` 账号恢复并入 org 后，再 `npm deprecate` 指向新包（此操作需原 owner 权限）。
6. **文档双写迁移说明**：README 与 docs/03 都写明「旧包停更 + 新包名」，避免老用户脚本静默停在 2.2.12。

---

## 四、测试矩阵核对

| # | 用例 | 状态 | 说明 |
|---|------|------|------|
| 1 | `npm pack --dry-run` | ✅ | `@tkwf/opencode-shellfix@2.3.4`，11 文件 / 64.4 kB（含 `src/lib/log-file.ts`） |
| 2 | `npm view @tkwf/opencode-shellfix version` | ⏳ | 待发布后验证 |
| 3 | `opencode plugin @tkwf/opencode-shellfix` | ⏳ | 待发布后实机验证（scoped 名兼容性，方案唯一技术不确定点） |
| 4 | 重启后版本号 / 状态面板 | ✅（部署） | 部署版 `PLUGIN_VERSION = "2.3.4"`；重启后生效 |
| 5 | 功能回归（编码 / export / git 免交互） | ⏳ | 逻辑零改动，重启后抽验 |
| 6 | 输入框无插件红字（v2.3.3 回归） | ⏳ | 重启后确认 + `shellfix.log` 正常写入 |
| 7 | 空目录 `npm install @tkwf/opencode-shellfix` | ⏳ | 待发布后验证 |

---

## 五、静态检查

| 项 | 结果 |
|----|------|
| `lsp_diagnostics`（`src/lib/state.ts`） | 零 error |
| `npm pack --dry-run` | 包名/版本正确；`files: ["src/"]` 生效；README 自动纳入 |
| 部署哈希校验 | **9/9 一致**（`shell-fix.ts`、`shell-fix-tui.ts`、`lib/` 7 个） |
| 部署版本号 | `plugins/lib/state.ts` → `PLUGIN_VERSION = "2.3.4"` |
| 文档残留检查 | README / docs03 中已无「旧包名作为安装命令」的残留（仅迁移说明中提及） |

---

## 六、遗留项与风险

| 项 | 说明 |
|----|------|
| scoped 名安装兼容性 | `opencode plugin` 的 positional 定义为「npm module name」，理论直通；若实机失败，退化为 `opencode.json` 手写 `"plugin": ["@tkwf/opencode-shellfix"]` |
| 历史版本缺口 | npm 上 `@tkwf/opencode-shellfix` 从 2.3.4 起算，2.3.0~2.3.3 只存在于 GitHub Release |
| 旧包用户 | `opencode-shellfix` 停在 2.2.12，无自动升级路径；靠 README + 后续 deprecate 引导 |
| CI secret | 已由用户更新为 tkwf 账号 token；若后续换 token 需同步 |
| 实机验证 | 用例 2/3/5/6/7 需重启 + 发布后确认 |

---

## 七、待确认

1. 提交信息建议：`chore: v2.3.4 发布渠道迁移到 @tkwf/opencode-shellfix`
2. 提交后执行：本地 `npm publish --access public` 首发 → 验证 `npm view` + `opencode plugin` → 打 tag `V2.3.4` 触发 CI 发布
3. 是否同意提交（AGENTS.md 要求用户明确确认后才能 commit）
