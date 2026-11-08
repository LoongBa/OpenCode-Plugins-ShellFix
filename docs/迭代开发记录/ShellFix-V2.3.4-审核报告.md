# v2.3.4 审核报告 — 发布渠道迁移到 `@tkwf/opencode-shellfix`

> 对应开发方案：`docs/迭代开发记录/ShellFix-V2.3.4-开发方案.md`
> 审核日期：2026-11-08
> 版本：2.3.3 → 2.3.4（发布迁移，无功能变更）

---

## 一、结论

实现完成，静态检查通过（改动文件 LSP 零 error；`npm pack --dry-run` 包名/版本/内容均正确）。**已部署到本地环境**（9 个文件哈希全部一致，`PLUGIN_VERSION=2.3.4`，备份 `.bak\20261108_155505_*`）。

npm 侧已具备发布条件：本地 `npm whoami` = **`coffeedrunk`**，`npm org ls tkwf` = **`coffeedrunk - owner`**；包名 `@tkwf/opencode-shellfix` 在 registry 返回 404（未被占用）。

**发布已完成**（commit `617057f` → tag `V2.3.4` → CI run `42460850095` 全绿）：npm 上 `@tkwf/opencode-shellfix@2.3.4` 已上线（`latest`），GitHub Release `V2.3.4` = Latest。详见 §七。

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
| 2 | `npm view @tkwf/opencode-shellfix version` | ✅ | 返回 `2.3.4`；`dist-tags.latest = 2.3.4` |
| 3 | `opencode plugin @tkwf/opencode-shellfix` | ⏳ | 未在本机执行（本机已手动部署，装 npm 包会双重加载）；其他机器可直接用 |
| 4 | 重启后版本号 / 状态面板 | ✅（部署） | 部署版 `PLUGIN_VERSION = "2.3.4"`；重启后生效 |
| 5 | 功能回归（编码 / export / git 免交互） | ⏳ | 逻辑零改动，重启后抽验 |
| 6 | 输入框无插件红字（v2.3.3 回归） | ⏳ | 重启后确认 + `shellfix.log` 正常写入 |
| 7 | 空目录 `npm install @tkwf/opencode-shellfix` | ✅ | `added 1 package`，11 个文件（含 `src/lib/log-file.ts`） |

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
| scoped 名安装兼容性 | `npm install` 已验证通过；`opencode plugin @tkwf/opencode-shellfix` 未在本机执行（本机已手动部署，避免双重加载），留给其他机器首用验证 |
| 历史版本缺口 | npm 上 `@tkwf/opencode-shellfix` 从 2.3.4 起算，2.3.0~2.3.3 只存在于 GitHub Release |
| 旧包用户 | `opencode-shellfix` 停在 2.2.12，无自动升级路径；靠 README + 后续 deprecate 引导 |
| CI secret | 已验证为 tkwf 账号（`coffeedrunk`）token：发布日志 `_npmUser: coffeedrunk`，无需再改 |
| 实机验证 | 用例 3/5/6 需重启 OpenCode 后确认 |

---

## 七、发布结果（2026-11-08）

| 项 | 结果 |
|----|------|
| commit | `617057f` `chore: v2.3.4 发布渠道迁移到 @tkwf/opencode-shellfix` |
| tag | `V2.3.4`（指向 `617057f`） |
| CI run | `42460850095` — **success**（`release` ✅ / `publish-npm` ✅，11s） |
| npm | `@tkwf/opencode-shellfix@2.3.4`，`dist-tags.latest = 2.3.4`，`_npmUser: coffeedrunk` |
| tarball | 64.4 kB / 11 files，`shasum 38a9991…`（与本地 `npm pack --dry-run` 一致） |
| GitHub Release | `V2.3.4` = **Latest** |
| 安装验证 | 空目录 `npm install @tkwf/opencode-shellfix` → `added 1 package`，11 文件 |

### 发布过程中的一次「假失败」

CI 发布成功（日志 `+ @tkwf/opencode-shellfix@2.3.4`）后，`npm view` / `npm install` 仍返回 **404** 约 4~5 分钟。原因不是权限：

- npm 提示 `Your package is being processed and may take a few minutes to become available.`
- registry 中可查到占位版本 `0.0.0-stage` —— 发布处理中的标志
- 该窗口内：`/@tkwf%2fopencode-shellfix/2.3.4` 与 tarball 均 **200**，但根 packument 仍 **404**（npm CLI 走的正是根 packument）
- 约 5 分钟后 packument 生效，`npm view` 立即返回 `2.3.4`

> 结论：**npm 没有「手动创建包」这一步**，`npm publish` 即创建；新包首发后遇到短暂 404 属正常异步处理，不要重复发布（同版本重发会 `EPUBLISHCONFLICT`）。

### 后续发布方式（已确定）

打 tag 即自动发布，无需本地 `npm publish`：

```
改版本号 → 方案/审核 → commit → git tag V{x.y.z} → git push origin V{x.y.z}
→ CI: release（GitHub Release）+ publish-npm（npm publish）
→ 验证 npm view @tkwf/opencode-shellfix version
→ 本地 deploy.ps1 部署
```

---

## 八、待确认

1. 重启 OpenCode 后验证 §四 用例 3/5/6（重点：输入框不再出现红字、版本号 2.3.4）。
2. 本次审核报告更新（发布结果）是否随下一次改动一并提交。
3. 旧包 deprecate 待 `loongba` 账号恢复后执行。
