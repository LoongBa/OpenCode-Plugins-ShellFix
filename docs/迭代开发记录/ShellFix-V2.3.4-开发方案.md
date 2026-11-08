# ShellFix V2.3.4 开发方案 — 发布迁移到 `@tkwf/opencode-shellfix`

> 版本：2.3.3 → 2.3.4（发布渠道迁移，无功能变更）
> 日期：2026-11-08
> 状态：待用户确认

---

## 一、背景

v2.3.0 ~ v2.3.3 的代码与 GitHub Release 均已就绪，但 **npm 发布连续 4 次失败**（`E403 Forbidden`）。

根因链（已取证）：

1. `opencode-shellfix` 的直接 owner 是 npm 账号 `loongba`，注册邮箱为 GitHub noreply 地址（`76543969+LoongBa@users.noreply.github.com`），**该地址不接收任何邮件** → 无法收验证码 → 无法登录、无法重签 token、无法改邮箱
2. 本地 `~/.npmrc` 残留 token 已失效（`E401`）；GitHub secret `NPM_TOKEN` 对应的 token 可认证但对本包无写权限（`E403`）
3. 已按 npm 官方路径提交账号恢复工单（Reset my email + Connect to GitHub），**等待支持处理（约 1 个工作日）**
4. 备用通道 `tkwf` org 无法收录该包：npm 权限规则要求「包的**直接 owner** 必须是该 org 的成员」才能 Add Existing Package，`loongba` 不在 `tkwf` 中 → `forbidden`
5. npm 不支持包重命名/转移，**非 scoped 包无法搬进 scope**，只能新建发布

用户决策：**以 `tkwf` 发布新包；`loongba` 账号修复后再加入该 org**。

## 二、方案

### 2.1 包名与版本

| 项 | 现值 | 新值 |
|----|------|------|
| npm 包名 | `opencode-shellfix` | **`@tkwf/opencode-shellfix`** |
| 版本 | `2.3.3` | **`2.3.4`** |
| 发布可见性 | `publishConfig.access: public`（已有） | 不变（scoped 包首次发布必须 public） |

> 名字可用性已实测：`https://registry.npmjs.org/@tkwf/opencode-shellfix` 返回 **404**（未被占用）。
> 用 2.3.4 而非复用 2.3.3：`V2.3.3` 标签已指向 `aab6fba`，新包从 2.3.4 起算，版本历史与 git 标签一一对应，避免"同名不同源"的困惑。

### 2.2 代码改动（2 处）

| 文件 | 改动 |
|------|------|
| `package.json` | `name` → `@tkwf/opencode-shellfix`；`version` → `2.3.4`；补 `repository` 字段（npm 页面可跳 GitHub） |
| `src/lib/state.ts` | `PLUGIN_VERSION = "2.3.4"` |

> 运行时逻辑零改动：插件不读取自身包名，包名变更不影响任何功能。

### 2.3 发布通道（`.github/workflows/publish.yml`）

workflow 结构**不改**，但 secret 必须更换：

| secret | 现值 | 新值 |
|--------|------|------|
| `NPM_TOKEN` | `loongba` 账号 token（对本包 E403） | **`tkwf` 所属账号的 Automation token**（Automation 类型可绕过 2FA/OTP） |

两条发布路径（建议先 A 验证、再 B 常态化）：

- **A. 本地首发**：临时使用 tkwf 账号 token 执行 `npm publish --access public`，**不写入全局 `~/.npmrc`**（用 `--userconfig` 指向临时文件），首发成功后再配 CI
- **B. CI 发布**：更新 GitHub secret `NPM_TOKEN` → 打 tag `V2.3.4` → workflow 自动 release + publish

### 2.4 文档改动

| 文件 | 改动 |
|------|------|
| `README.md` | 当前版本 → v2.3.4；安装命令 → `opencode plugin @tkwf/opencode-shellfix`；`opencode.json` 示例同步；新增「发布渠道迁移」说明（旧包停在 2.2.12） |
| `docs/03-安装与使用.md` | 同上（安装/升级命令、手动配置示例） |
| `CHANGELOG.md` | v2.3.4 条目（发布渠道迁移，无功能变更） |

### 2.5 旧包收尾（延后，不在本版实施）

1. `loongba` 账号恢复后，登录并**加入 `tkwf` org**（成员即可）
2. 加入后即可把 `opencode-shellfix` 通过 Add Existing Package 授权给 org 团队（**注意：包名不会变成 scoped，仍是 `opencode-shellfix`**，只是 org 成员获得发布权限）
3. 执行 `npm deprecate opencode-shellfix "已迁移至 @tkwf/opencode-shellfix"`，老用户升级时看到提示

---

## 三、测试矩阵

| # | 用例 | 预期 |
|---|------|------|
| 1 | `npm pack --dry-run` | 包名 `@tkwf/opencode-shellfix`、版本 2.3.4、内容含 `src/` |
| 2 | 发布后 `npm view @tkwf/opencode-shellfix version` | `2.3.4` |
| 3 | `opencode plugin @tkwf/opencode-shellfix` | 安装成功，`opencode.json` 的 `plugin` 数组出现该名 |
| 4 | 重启后 `$env:SHELLFIX_VERSION` / 状态面板 | `2.3.4` |
| 5 | 中文不乱码 / export 转换 / git 免交互 | 与 2.3.3 一致（回归） |
| 6 | 输入框无插件红字（v2.3.3 修复回归） | 无红字，`shellfix.log` 正常写入 |
| 7 | `npm install @tkwf/opencode-shellfix` 于空目录 | 成功拉取，无 scope 权限错误 |

> 用例 3 是本次唯一的技术不确定性：`opencode plugin` 的 positional 定义为「npm module name」，理论上直通 scoped 名；发布后实机验证，若失败则退化为 `opencode.json` 手写 `"plugin": ["@tkwf/opencode-shellfix"]`。

---

## 四、风险

| 项 | 说明 | 应对 |
|----|------|------|
| 安装命令变化 | 老用户脚本里的 `opencode-shellfix` 仍指向 2.2.12 | 旧包不删除；恢复后 deprecate 指向新包；README 顶部写明新名 |
| secret 未换 | CI 仍用 loongba token → 对新 scope 依旧 E403 | 打 tag 前先确认 secret 已更新，或先走本地首发验证 |
| scoped 首次发布默认私有 | 未带 `access public` 会 402/发布为私有 | `publishConfig.access` 已存在，仍显式加 `--access public` |
| 包名易打错 | `@tkwf/opencode-shellfix` 较长 | 文档提供可复制命令块 |
| 双包并存混淆 | 两个包同时存在 | CHANGELOG / README 明确「新包 = 唯一维护线」 |

---

## 五、实施顺序

1. 写本方案 → **用户确认**
2. 改 `package.json`（name/version/repository）+ `src/lib/state.ts`
3. 文档三处（README / docs03 / CHANGELOG）
4. 校验：LSP 零 error、`npm pack --dry-run`、`tsc --noEmit` 无新增错误
5. 部署 2.3.4 到本地（哈希校验）
6. 写审核报告 → 用户确认 → commit
7. 用户提供 tkwf 账号 Automation token → 本地首发 `npm publish --access public`
8. 验证 `npm view` + `opencode plugin @tkwf/opencode-shellfix`
9. 更新 GitHub secret `NPM_TOKEN` → 打 tag `V2.3.4` → push（CI 发布）
10. 旧包 deprecate 留待 `loongba` 账号恢复

---

## 六、待确认

1. 版本号用 **2.3.4**（新包首发）是否同意？
2. `package.json` 补 `repository` 字段（`git+https://github.com/LoongBa/OpenCode-Plugins-ShellFix.git`）是否同意？
3. 发布方式：先本地首发验证（推荐），还是直接改 secret 走 CI？
4. 是否同意按本方案实施 v2.3.4？
