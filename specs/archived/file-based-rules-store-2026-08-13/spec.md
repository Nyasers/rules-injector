# Spec: File-based Rules Store（文件化规则存储）

日期：2026-08-13
状态：spec（待对焦确认）

## Goal

把 rules-injector 的规则体系从「单文件 RULES.md + rules-state.json」升级为**文件化规则存储**：

1. RULES.md 废弃，规则拆成每规则一个 markdown 文件（内置种子，插件目录只读）
2. 插件初始化把内置种子播种到数据目录 `rules/builtin/`（工作副本），`rules/custom/` 用户自编，同名用户优先
3. 规则开关 = 文件位置（`.disabled/` 子目录，原子 rename），不落表
4. 插件升级只新增缺失种子、不覆盖已存在文件（内容指纹判改过）
5. 状态统一进 `data.db`（node:sqlite）：`meta` + `injected_sessions` + `card_consumed`
6. 侧边栏 UI：规则文件级管理（列表/开关/删除）+ 内置编辑（新增/编辑自定义规则）

## Non-Goals

- 不做规则语法 DSL，规则保持 markdown 文本
- 不做多 Agent 分角色规则
- 不引入 better-sqlite3 等原生依赖（只用 node:sqlite 内置模块）
- 不做规则导入/导出、规则模板市场
- 消费标记（card_consumed 表）只建表迁移，不改变「历史卡片可重复选择」现状决策

## Acceptance Criteria

- [ ] AC1 首次初始化：插件把内置种子复制到数据目录 `rules/builtin/`，内容与种子逐字节一致
- [ ] AC2 播种幂等：重复初始化不重复复制、不覆盖工作副本中用户修改过的文件
- [ ] AC3 升级同步：新增种子文件被复制；内容被改过的既有文件保留；内容未变的跳过（幂等）
- [ ] AC4 custom 同名优先：custom 与 builtin 同名时，生效清单只出现一次，内容为 custom 版
- [ ] AC5 开关文件化：规则文件改名 `.disabled` 后不出现在注入清单；改回 `.md` 后恢复；无需任何表操作
- [ ] AC6 指纹语义不变：生效清单内容变化 → 指纹变化 → 触发注入；内容未变 → 指纹不变、不推送
- [ ] AC7 迁移 injected_sessions：jsonl 数据导入 data.db 表后，已注入会话重启后判据依然成立（不静默失效、不重复注入）
- [ ] AC8 rules-state.json 退役：内容迁至新机制（开关 → 文件位置、custom 覆盖 → custom 文件），旧文件改 .bak
- [ ] AC9 RULES.md 废弃：拆成 5 个种子文件（卡片收尾/命令执行/临时文件/规则管理/选项卡片），原文件移出插件目录
- [ ] AC10 全局总开关语义保留：关闭后不注入任何规则，开启后按文件清单注入
- [ ] AC11 侧边栏 UI：builtin/custom 分组列表、每规则开关与删除、custom 新增/编辑（内置编辑器，纯文本 textarea）
- [ ] AC13 manage_rules 工具：agent 可 list/get/create/update/delete/toggle/restore 规则，文件名防路径穿越
- [ ] AC12 规则管理规则小节的注入文本随新架构同步修订（不再引用 rules-state.json）

## Boundary Conditions

- 插件目录只读或种子读取失败 → 跳过播种，继续用已存在的工作副本，不崩
- 数据目录 `rules/` 不存在 → 播种时创建（builtin/、custom/ 齐建）
- custom 文件为空/仅空白 → 忽略该文件并标记异常，不注入
- 单规则文件超长（> 50KB）→ 忽略并提示
- 开关改名目标已存在同名 → 覆盖（幂等）；改名失败（如文件被占用）→ 报错不崩
- data.db 损坏/不可读 → 初始化失败不拖垮插件，工具报「未初始化」，可删除重建
- 并发播种（多实例同时启动）→ 播种幂等 + busy_timeout 兜底
- 用户编辑规则文件内容 → 下次注入检查时指纹变化 → 注入新清单
- 同名规则 builtin/custom 同时存在且 builtin 在 .disabled/、custom 启用 → custom 生效

## Constraints

- 存储：node:sqlite `DatabaseSync`，`PRAGMA journal_mode = DELETE`（无 -wal/-shm 侧车）、`busy_timeout = 5000`、`foreign_keys = ON`（沿用 hana-remote-dev 已验证模板）
- 指纹判据语义保持：sha256 前 16 位、内容驱动、无计数器
- 注入时机不变：session_created 全量 / session_user_message 检查 / 上下文压缩后重注入
- 插件目录只读：内置种子不可写、不可移动，只读源
- 零新增原生依赖

## Design Decisions

### D1 规则存在性 = 文件系统，开关 = 扩展名改名，不落表

```
插件目录/（只读种子源，随版本管理）
└── rules/card-close.md ...

数据目录/（工作副本 + 用户区，唯一事实源）
└── rules/
    ├── builtin/card-close.md       # 启用（.md）
    ├── builtin/card-close.disabled # 禁用（改名 .disabled，同目录平铺）
    ├── custom/my-rule.md           # 用户自编
    └── custom/old-rule.disabled    # 用户自编且禁用
```

排序：文件名字母序（localeCompare）；可选数字前缀（`0-xxx.md`）微调置顶，不强制编号。
理由：数据目录可读写后，改扩展名（原子 rename）即状态变更，零表同步负担；状态自包含在文件名（一次扫描分流），
无「禁用目录被删 → 规则掉出变启用」的风险；对标 `.env.example` 惯例。
被拒绝：enabled_rules 全量表（影子同步负担）、disabled_rules 内容指纹表（多一层间接）、
`.disabled/` 子目录方案（双目录遍历 + 目录删除风险）、enabled/disabled 双目录（层级过深）、
强制序号前缀（规则是内容资产非序列项，用户自编规则不应被要求编号）。

### D2 升级同步 = 只增不覆盖 + 内容指纹判改过

```
对每个种子文件：
  工作副本缺失          → 复制
  内容与种子相同        → 跳过（幂等）
  内容与种子不同        → 保留用户版（改过 = 用户接管）
```

配套出口：「恢复默认」= 删除被改过的副本，下次播种回归种子版。

### D3 data.db 三表（node:sqlite，DELETE journal）

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);            -- schema_version 等
CREATE TABLE injected_sessions (
  session_id  TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  injected_at TEXT NOT NULL
);
CREATE TABLE card_consumed (
  card_id TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  mode    TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
```

rules-state 相关表（enabled/disabled）全部不建——开关在文件系统。
被拒绝：WAL（侧车文件破坏单文件约束）、better-sqlite3（原生依赖）。

### D4 指纹与清单组装（语义不变，输入换源）

生效清单 = 按序拼接「文件存在 + 非 .disabled/ 的规则文件内容」（custom 同名覆盖 builtin）。
指纹 = sha256(生效清单文本) 前 16 位。判据存 injected_sessions 表。

### D5 迁移路径

1. RULES.md 按 `##` 小节拆成 5 个种子文件（规则管理小节内容随 D6 修订）
2. rules-state.json：`$global.enabled` → data.db meta 全局开关；各小节 `enabled` → 文件扩展名（禁用的改 `.disabled`）；`custom` 覆盖内容 → 生成 custom 同名文件；旧文件 .bak
3. injected-sessions.jsonl → injected_sessions 表（逐行导入，键 sessionId）；旧文件 .bak
4. 首次播种内置种子到 builtin/

### D6 规则管理规则小节内容修订

注入文本中「规则管理规则」不再引用 rules-state.json / RULES.md，改写为：规则资产 = 数据目录 rules/ 工作副本；开关 = 文件位置；状态判据 = data.db。

## 对焦确认记录（2026-08-13）

- Goal 确认无异议
- AC6 执行口径：组装逻辑保持与现状一致的输出格式（`## 标题` + `- 要点`），避免换源引起全量无意义重注入；仅规则管理小节内容修订（D6）触发一次合理重注入
- UI 编辑器：纯文本 textarea 直接改 .md 内容（最简），不做预览/语法辅助

### 执行发现（2026-08-13，验证旧 hash=73f0f4148df508c6 精确复现后确认）

- 旧组装（shared.js）会剥掉编号行的 `N. ` 前缀（`replace(/^\s*\d+\.\s+/, "")`），故现状注入清单中「命令执行优先级」编号丢失；新组装保留编号（`- 1. ...`）——格式优化，且不增加重注入次数（规则管理小节修订本就触发一次）
- 指纹对比结果：旧 hash 精确复现为 73f0f4148df508c6（对比方法可靠）；新 hash 因顺序（文件名 locale 序）+ 编号保留 + 规则管理修订而不同，触发一次重注入，预期内
- **决策（Nyaser）：规则文件名不带编号、直接与标题一致**（如「卡片收尾规则.md」）——key = 文件名去扩展名即标题，映射层移除；custom 覆盖语义 = 同名即同标题；排序按中文 locale
- **新增能力（Nyaser）：tools/manage_rules.js**——agent 可自建/修改规则（list/get/create/update/delete/toggle/restore），路径穿越防护（文件名排除分隔符），builtin 受播种保护

## 待办决策记录

| 决策点 | 定案 |
|---|---|
| 1. RULES.md 去留 | 废弃，rules/ 唯一规则源 |
| 2. custom 默认开关 | 自动消解：文件在 = 启用，.disabled/ = 禁用 |
| 3. UI 范围 | 文件级 + 内置编辑 |
| 4. 升级同步 | 只增不覆盖 + 内容指纹判改过 |
| 5. 编辑器形态 | 纯文本 textarea |
