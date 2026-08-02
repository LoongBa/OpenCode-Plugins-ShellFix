# v1.5 开发方案 — /my Git 同步

> 当前版本：v1.4.0 → 目标版本：v1.5.0
> 对应设计文档：docs/D0-ShellFix-全功能设计.md §8
> 预计工作量：~6h

---

## 一、目标

建立 `/my` 模板系统的远程 Git 同步能力，让团队成员共享模板，同时保留本地自定义模板的完全控制权。

**核心场景：**
1. 团队维护一个公开 Git 仓库存放共享模板
2. 开发者 `git clone` 后首次配好 `template_repo` 配置
3. 以后每次 `/my sync` 拉取最新远程模板
4. 远程模板与本地内置模板共存，优先级：用户 > 远程 > 内置

---

## 二、改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shell-fix.ts` | **修改** | 新增 `/my sync` + `/my sync-config` 子命令 |
| `src/template-store.ts` | **修改** | 新增远程仓库克隆/拉取/合并逻辑 |
| `src/state.ts` | **修改** | 新增 `sync` 配置字段 |
| `docs/_Draft/Draft-ShellFix-V1.5-开发方案.md` | **新增** | 本文件 |
| `docs/D0-ShellFix-全功能设计.md` | **后续更新** | |

---

## 三、详细设计

### 3.1 配置方式

两种配置路径，按优先级：

```
1. 项目级: opencode.jsonc / .opencode/config.jsonc → shellfix.sync
2. 全局: ~/.config/opencode/shellfix.state.json → sync 字段
```

配置结构：

```typescript
// state.ts 新增
export interface SyncConfig {
  /** 远程模板仓库 URL */
  repoUrl: string;
  /** 分支（默认 main） */
  branch: string;
  /** 启动时自动同步 */
  autoSyncOnStart: boolean;
  /** 上次同步的 commit hash（用于增量同步） */
  lastSyncCommit: string;
  /** 同步时间 */
  lastSyncAt: string;
}
```

项目级配置文件示例：

```jsonc
// opencode.jsonc
{
  "plugins": ["shell-fix"],
  "shellfix": {
    "sync": {
      "repo_url": "https://github.com/team/shellfix-templates.git",
      "branch": "main",
      "auto_sync_on_start": false
    }
  }
}
```

### 3.2 远程存储结构

克隆到 `~/.config/opencode/templates/remote/`：

```
~/.config/opencode/templates/
├── index.json              ← 本地（用户）索引
├── note/                   ← 笔记存储
└── remote/                 ← 远程仓库目录
    ├── index.json          ← 远程模板索引（可选）
    ├── deploy.json
    ├── rollback.json
    └── review.json
```

远程仓库的 `index.json` 格式（可选，不提供则扫描目录下所有 `.json` 文件）：

```json
[
  {
    "name": "deploy",
    "file": "deploy.json",
    "description": "标准部署流程"
  },
  {
    "name": "rollback",
    "file": "rollback.json",
    "description": "回滚流程"
  }
]
```

每个模板文件的格式：

```json
{
  "name": "deploy",
  "template": "请部署版本 {0} 到 {1} 环境...",
  "description": "标准部署流程",
  "tags": ["deploy", "ops"]
}
```

### 3.3 同步流程

```
/my sync
├── 检查 state.sync.repoUrl 是否配置
│   └── 未配置 → 提示：'请先配置远程仓库，/my sync-config help'
├── 检查 ~/.config/opencode/templates/remote/ 是否存在
│   ├── 不存在 → git clone --depth 1 <url> -b <branch>
│   └── 存在   → git -C remote fetch + reset --hard origin/<branch>
├── 读取远程模板文件
│   ├── 存在 index.json → 按 index 列表加载
│   └── 无 index.json   → 扫描 *.json（排除 index.json 自身）
├── 验证每个模板格式（name/template 必须存在）
│   └── 格式错误 → 跳过 + 列出警告
├── 合并到内存索引（优先级：用户 > 远程 > 内置）
├── 记录同步元数据（lastSyncCommit + lastSyncAt）
└── 报告同步结果
```

### 3.4 模板优先级

```
优先级（高 → 低）：
  1. 用户自定义（/my save）— 覆盖同名的远程/内置
  2. 远程同步（remote/）   — 覆盖同名的内置
  3. 内置模板（BUILTIN_TEMPLATES）— 只读保底

同名冲突处理：
  用户级 "deploy"   → 始终使用用户级（用户的最大）
  远程 "deploy"     → 被用户级覆盖，内置则被远程覆盖
  内置 "deploy"     → 被远程或用户覆盖
```

### 3.5 /my sync 子命令

```
/my sync                    → 拉取远程仓库 + 合并模板
/my sync --force            → 强制重新 clone（丢弃本地 remote/）
/my sync --dry-run          → 仅预览将同步的模板，不写入
/my sync status             → 查看上次同步状态

/my sync-config             → 查看当前同步配置
/my sync-config set <key> <val> → 设置配置项
/my sync-config set repo_url https://github.com/team/templates.git
/my sync-config set branch main
/my sync-config set auto_sync_on_start true
/my sync-config help        → 帮助
```

### 3.6 状态面板集成

```
/shellfix 面板新增：
║  sync     [ON]  远程仓库: team/templates       ║
║  当前: 3 remote / 7 builtin / 2 user           ║
```

其中 `sync [ON]` 表示 `repoUrl` 已配置且 remote/ 目录存在。

---

## 四、实现方案

### 4.1 文件组织

```
src/
├── shell-fix.ts          ← 新增 /my sync 子命令处理（在 handleMyCommand 中扩展）
├── state.ts              ← 新增 SyncConfig 接口
├── template-store.ts     ← 新增远程仓库管理函数
└── inject-modules.ts     ← 不变
```

### 4.2 template-store.ts 新增函数

```typescript
/** 远程仓库根目录 */
const REMOTE_DIR = join(TEMPLATE_DIR, "remote");

/** 设置/获取同步配置 */
export function getSyncConfig(): SyncConfig | null;
export function setSyncConfig(cfg: Partial<SyncConfig>): void;

/** 克隆远程仓库 */
export function cloneRemoteRepo(url: string, branch: string): Promise<CloneResult>;

/** 拉取远程仓库更新 */
export function pullRemoteRepo(): Promise<PullResult>;

/** 加载远程模板 */
export function loadRemoteTemplates(): TemplateEntry[];

/** 合并远程模板到索引（按优先级） */
export function mergeRemoteTemplates(): { added: number; updated: number; skipped: number };
```

### 4.3 Git 操作

使用原生 `git` CLI 执行（避免 `simple-git` 依赖）：

```typescript
import { execSync } from "child_process";

function gitClone(url: string, dir: string, branch: string): void {
  execSync(
    `git clone --depth 1 --branch ${branch} ${url} "${dir}"`,
    { stdio: "pipe", timeout: 30000 }
  );
}

function gitPull(dir: string): void {
  execSync(
    `git -C "${dir}" fetch origin && git -C "${dir}" reset --hard origin/HEAD`,
    { stdio: "pipe", timeout: 30000 }
  );
}
```

> 注意：execSync 在 Bun 运行时需验证兼容性。采用 try-catch 包裹，不可用时报友好错误。

### 4.4 同步报告格式

```
/my sync 输出示例：

══════════════════════════════════════
远程仓库同步完成
══════════════════════════════════════

源：team/shellfix-templates (main)
最新 commit: a1b2c3d

新增远程模板：
  ✅ deploy    — 标准部署流程
  ✅ rollback  — 回滚流程
  ⚠️ review    — 被本地模板覆盖（同名冲突）

总计：2 added, 0 updated, 1 skipped
本地：7 builtin + 2 user + 3 remote
```

---

## 五、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | `execSync` 在 Bun 中不可用 | 中 | try-catch 包裹，报错时提示用 `git clone` 手动操作 |
| 2 | Git 操作超时（大仓库） | 低 | `--depth 1` 浅克隆，30s 超时 |
| 3 | 远程模板格式不兼容 | 低 | 加载时逐条验证 `name`/`template` 字段，跳过无效项 |
| 4 | 远程仓库访问权限（私有仓库） | 中 | 提示用户需自行配置 Git 凭据（SSH key / credential helper） |
| 5 | 同时多处 clone 冲突 | 低 | 单进程操作，加文件锁（可选） |

---

## 六、交付清单

- [ ] `state.ts` — 新增 SyncConfig 接口 + setter/getter
- [ ] `template-store.ts` — 新增 `cloneRemoteRepo` / `pullRemoteRepo` / `loadRemoteTemplates` / `mergeRemoteTemplates`
- [ ] `/my sync` — 拉取 + 合并 + 报告
- [ ] `/my sync --force` — 强制重新 clone
- [ ] `/my sync --dry-run` — 预览不写入
- [ ] `/my sync status` — 查看同步状态
- [ ] `/my sync-config` — 查看配置
- [ ] `/my sync-config set` — 设置配置项
- [ ] 状态面板集成 — `/shellfix` 显示 sync 状态
- [ ] 项目级配置读取 — opencode.jsonc → shellfix.sync
- [ ] 错误处理 — Git 不可用/超时/权限问题友好提示
- [ ] diagnostics 无错误