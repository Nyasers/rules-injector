# Tasks: File-based Rules Store

依赖顺序：1 → 2 → 3 → 4 → 5 → 6 → 7

## T1 种子拆分（迁移脚本第一步）

- 描述：把 RULES.md 按 `##` 小节拆成 5 个种子文件放入插件目录 `rules/`（序号前缀排序），规则管理小节内容按 D6 修订；RULES.md 移除。
- 关联 AC：AC9、AC12
- 允许修改：`Projects/rules-injector/RULES.md`、新建 `Projects/rules-injector/rules/*.md`
- 完成标志：`rules/` 下 5 个文件、内容与现 RULES.md 各小节一致（规则管理小节为新文本）、RULES.md 不存在

## T2 data.db 模块

- 描述：新建 `lib/db.js`，node:sqlite DatabaseSync 初始化 `data.db`（meta/injected_sessions/card_consumed 三表，DELETE journal、busy_timeout、foreign_keys），初始化失败不抛全局崩溃（容错，工具报「未初始化」）。
- 关联 AC：AC7、AC10、Boundary「db 损坏」
- 允许修改：新建 `lib/db.js`、`index.js`（挂载 db 生命周期）
- 完成标志：单测覆盖建库/建表/幂等/损坏文件报错不崩

## T3 播种与文件化规则加载器

- 描述：新建 `lib/rules-fs.js`：播种（种子 → 数据目录 `rules/builtin/`，只增不覆盖、内容指纹判改过）、加载（builtin + custom 合并、同名 custom 优先、`.disabled/` 过滤、按文件名排序）、开关（移动到 `.disabled/` 原子 rename）、恢复默认（删副本待播种）。
- 关联 AC：AC1、AC2、AC3、AC4、AC5、Boundary「只读/缺失/非法」
- 允许修改：新建 `lib/rules-fs.js`、`lib/db.js`（无）
- 完成标志：单测覆盖播种幂等、升级同步三态、同名优先、.disabled 过滤

## T4 注入通道改造

- 描述：`tools/shared.js` 的 parseRules/loadRulesState 等替换为从 `lib/rules-fs.js` 加载生效清单；指纹判据（contentHash/buildRulesText）输入换源且输出格式与现状一致；injected-sessions 读写从 jsonl 改为 data.db 表。
- 关联 AC：AC6、AC7、AC10
- 允许修改：`tools/shared.js`、`index.js`
- 完成标志：指纹计算与现状同输入同输出（迁移前旧清单对比）、注入判据走表

## T5 状态迁移

- 描述：一次性迁移：rules-state.json（$global.enabled → meta、各小节 enabled → 文件位置、custom 覆盖 → custom 同名文件）+ injected-sessions.jsonl → 表；旧文件改名 .bak。
- 关联 AC：AC7、AC8
- 允许修改：`_tmp/scripts/` 迁移脚本、数据目录产物
- 完成标志：迁移后开关/覆盖/判据在新机制下等价，.bak 存在，重启判据延续

## T6 侧边栏 UI

- 描述：`routes/sidebar.js` 改造：builtin/custom 分组列表（来源 + 开关态 + 删除）、开关 = 移动文件、删除 custom / 内置恢复默认、新增自定义规则（命名 + textarea 编辑）、编辑现有（textarea 保存）。
- 关联 AC：AC11
- 允许修改：`routes/sidebar.js`（及内联模板）
- 完成标志：手测：新增/编辑/开关/删除/恢复默认 全链路可用

## T7 验收与打包

- 描述：逐条 AC1-12 验证（单测 + 宿主实测），更新 SPECS.md，打包 0.8.0，实装复测（含已注入会话不重复注入）。
- 关联 AC：全部
- 允许修改：specs、releases/
- 完成标志：evidence.md 全绿，0.8.0 包自校验通过并安装
