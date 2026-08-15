# Evidence: File-based Rules Store

## Acceptance Checklist

- [x] AC1 首次初始化：种子复制到数据目录 `rules/builtin/`，内容一致
  Evidence: rules-fs-test2 #2（播种 2 文件，内容逐字节）；migrate-test 实测播种 6 文件、禁用态 1（中文思考规则.disabled）

- [x] AC2 播种幂等：重复初始化不重复复制、不覆盖用户修改
  Evidence: rules-fs-test2 #2/#3（重复播种 skipped=2；用户改过的 kept=1 且保留用户版内容）

- [x] AC3 升级同步：新增复制、改过保留、未改跳过
  Evidence: rules-fs-test2 #3（新增种子 added=1；改过 kept=1；未改 skipped）

- [x] AC4 custom 同名优先：生效清单只出现一次，内容为 custom 版
  Evidence: rules-fs-test2 #5（同名 custom 覆盖、title=用户版、filter 后 length=1）

- [x] AC5 开关文件化：`.disabled` 改名生效/恢复
  Evidence: rules-fs-test2 #4/#6（禁用 → .disabled 且不在清单；启用 → .md 恢复）

- [x] AC6 指纹语义不变：内容变化 → 指纹变；内容未变 → 不变
  Evidence: rules-fs-test2 #7（同清单同指纹、清单变化指纹变化、注入文本含 16 位指纹行）；fingerprint-compare2（旧 hash 精确复现 73f0f4148df508c6，新 hash 差异原因全部定位：顺序/编号保留/规则管理修订）

- [x] AC7 迁移 injected_sessions：jsonl → data.db，判据延续
  Evidence: migrate-test 实测导入 7 条（全部 73f0f4148df508c6，含当前会话）；db-test #4 upsert 语义

- [x] AC8 rules-state.json 退役：状态迁移 + .bak
  Evidence: migrate-test（rules-state.json → .bak；global_enabled=1；中文思考规则 → .disabled）

- [x] AC9 RULES.md 废弃：拆 6 种子文件、原文件移出
  Evidence: verify-rules-split（5/5 逐字一致 + 规则管理修订版）；RULES.md 移至 _tmp/misc/RULES.md.bak-2026-08-13

- [x] AC10 全局总开关：meta global_enabled
  Evidence: db-test #3（setMeta/getMeta）；migrate-test（global_enabled=1）；index.js doInject 检查 '0' 短路

- [x] AC11 侧边栏 UI（分组/开关/编辑/新增/删除）
  Evidence: 宿主 0.8.0 实测三层全通过——① 模板层：sidebar 页面 HTML+JS 核查，分组/开关/编辑/删除/恢复默认/新建结构完整；② 数据层：/sidebar/data 返回 builtin 6 条（含中文思考规则禁用态）+ custom 空组，key/title/enabled/filename/fullText 字段齐全；③ 写端点层：/sidebar/rules/toggle 实测（中文思考规则 启用→禁用，净效果为零），快速拨动后无重注入推送（顺带验证「净效果为零不推送」语义）

- [x] AC12 规则管理规则小节内容随新架构修订
  Evidence: rules/规则管理规则.md 已改（规则资产/开关/维护入口/判据全为新语义）

- [x] AC13 manage_rules 工具
  Evidence: 冒烟全绿（list/create/dup 拒绝/get/toggle 幂等/update/delete/路径穿越防护/restore）

## 对抗式审查

- [x] 无隐性假设：播种只增不覆盖有显式三态（added/kept/skipped）；db 损坏 init 抛错由 onload 容错（注入停用不崩）；工具文件名防穿越（排除分隔符）
- [x] Non-Goals 未越界：未做规则 DSL/多 Agent/原生依赖；card_consumed 只建表未改消费现状决策
- [x] 中文 key 边界：Windows 文件名合法；localeCompare zh-CN 排序稳定；.disabled 扩展名与 .md 互转在 findRuleFile/toggleRule 中一致
- [x] 宿主实测（0.8.0 已加载）：迁移自动执行 + 注入新指纹 + 工具宿主可用——本会话已实测
  Evidence:
  - 迁移自动执行：manage_rules list 实测 6 个内置规则，其中「中文思考规则」为禁用态（.disabled），与 migrate-test 预期一致，迁移在真实宿主环境自动完成
  - 重注入：本会话收到新指纹 4365e362f1e57cb1 注入（旧指纹 73f0f4148df508c6 作废），AC6/AC7 判据在宿主环境成立
  - 工具宿主可用：manage_rules list/get 实测正常（本会话调用），文件名=标题映射成立（规则管理规则.md 等）
  - 侧边栏渲染：已完成（模板/数据/写端点三层实测，见 AC11）

## 待办

1. 宿主加载 0.8.0 → 已完成，迁移自动执行（list 实测 6 内置规则、中文思考规则 .disabled）
2. 重注入 → 已完成（本会话指纹 73f0f4148df508c6 → 4365e362f1e57cb1）
3. manage_rules 宿主调用 → 已完成（list/get 实测通过）
4. 侧边栏分组目检 → 已完成（模板/数据/写端点三层实测，AC11 勾选）
5. Close：spec 归档、SPECS.md 更新 → 本会话执行
