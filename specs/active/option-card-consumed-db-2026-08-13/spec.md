# Option-card 落库 option_cards 表（数据 + 消费一条记录，只用 id 取）

## Goal

选项卡片数据入库 data.db 新建 `option_cards` 表，卡片数据（问题/选项/会话）与消费情况（值/模式/时间）同一条记录；route 只携带 `id`，渲染与消费判定全部由服务端从库读取（薄 iframe 厚服务端）。根治 0.7.16 实测失败的缝隙：真实宿主重建 iframe 丢弃 hash 消费标记，历史卡片可重复选择。入库同时获得 TTL 清理能力，过期记录定时除旧。

## Non-Goals

- 不改回传消息格式（`（选项卡片）<问题>` 前缀不变，Agent 侧语义不受影响）
- 不迁移历史卡片（0.7.16 及更早卡片未入库、无 id，降级为 hash 自包含渲染，行为维持现状）
- 不引入 localStorage / 新依赖（node:crypto / node:sqlite 均为内置）
- 不迁移/不删除已废弃的 card_consumed 空表（从未写入，残留无害，代码不再引用）
- 不做容量上限清理（双表统一纯时间 TTL 24h，窗口内量级极小，无膨胀风险）

## Acceptance Criteria

- [ ] data.db 新建 `option_cards` 表：card_id 主键 + q/o/c/p + 消费三字段（value/mode/ts），消费判定 = ts IS NOT NULL
- [ ] option-card 创建时落库（INSERT OR IGNORE，幂等），route 只带 `id`（query 形式 `/card?id=<cardId>`）
- [ ] card_id 生成：sha256(q|o|c|p) 前 16 位，同一输入幂等、不同卡片不同
- [ ] GET /card 带 id → 服务端查库 SSR 渲染完整卡片（问题、选项按钮、消费锁定态），无任何客户端数据解析
- [ ] 已消费卡片重载（含宿主重建 iframe / 插件重启）→ SSR 直接渲染锁定态：按钮不渲染，按模式显示「已发送 · <值>」或「已跳过」
- [ ] 未消费卡片渲染可点；点击/自定义/跳过 → POST /card/choose 更新消费字段（WHERE ts IS NULL 条件更新，已消费忽略）→ session:send 注入会话（问题文本取库中 q，权威）
- [ ] 三种模式分别落库：option 记选择值、custom 记自定义全文、skip 记空值 + skip 模式
- [ ] 发送失败（busy 耗尽/网络错误）不更新消费字段，刷新后仍可重试
- [ ] 除旧策略（双表统一纯时间 TTL 24h）：option_cards 在插件启动 + 卡片创建时删除 `c` 早于 now-24h 的记录（与渲染层失效语义同步）；injected_sessions 在插件启动 + 判据写入时删除注入时间早于 now-24h 的记录（超窗会话重新活跃时重新注入）
- [ ] GET /card 无 id 或库中查无 → 降级 hash 自包含渲染（旧卡片兼容，行为 = 现状）
- [ ] 真实宿主实测：点选发送成功后宿主重建 iframe（滚动/重渲染/切会话返回），再次点击不产生新消息
- [ ] 零新依赖；node:sqlite 单库不变

## Boundary Conditions

- 无 id 或库中查无（旧卡片 / 库损坏丢失 / 已过 TTL 被清理）→ hash 降级渲染；TTL 后查无 → 渲染「卡片已失效」
- db 未初始化（dataDir 损坏）→ GET /card 带 id 也降级 hash；choose 照常 session:send（无 id 时用 body 的 question/sessionPath）
- 并发双击 → 前端 picked 锁 + 服务端条件更新双保险
- 卡片渲染层 TTL（24h）：过期未消费卡片显示失效、已消费仍显示已提交（consumed 优先）；记录被 TTL 清理后查无 → 失效
- skip 模式 value 为空串 → value 存 ''、mode=skip、ts 非空
- cardId 缺失的 choose 请求 → 回退现状（body 携带 question/sessionPath 直接 send，不落库）
- 同一卡片重复生成（同 q/o/c/p 同 id）→ INSERT OR IGNORE 保留首条

## Constraints

- 不引入新依赖；沿用 node:sqlite（DatabaseSync）、node:crypto
- route 形式 `/card?id=<cardId>`（query），宿主 webview 按 URL 处理；服务端同时解析 hash 中的 id 作兼容
- 消费更新幂等：UPDATE ... WHERE card_id = ? AND ts IS NULL
- 回传消息文本以库中 q 为权威，库无记录时用 body 的 question
- 版本号 0.8.6 → 0.8.7

## Design Decisions

- **演进背景（三次折返）**：早期方案整卡落盘独立文件（散文件）；后为追求零落盘改为 URL hash 自包含，0.7.16 在真实宿主实测失败（重建 iframe 丢 replaceState 写入），出现重复消费 bug；本次回归持久化并收敛到 data.db 单库 `option_cards` 表——数据与消费一条记录，id 为唯一关联键，服务端渲染，与宿主管理自身 UI 状态同模式（薄 iframe 厚服务端）
- **表名 option_cards**：带语义前缀避免与其他 card 概念混淆；用下划线而非连字符（SQL 标识符惯例，连字符表名需引号包裹，项目既有表名均为下划线）
- **SSR 而非客户端 fetch**：数据入库后，GET /card 直接服务端渲染完整卡片（含消费锁定态），iframe 不再需要解析 hash 数据、不再动态渲染按钮、不再写 replaceState——模板 JS 大幅瘦身，消费判定天然跨重建/跨重启成立
- **route 只带 id**：卡片内容不再编码进 URL，route 短且固定；宿主重建 iframe 时 id 保留（route 引用宿主持有），从库恢复一切
- **消费更新用条件写（ts IS NULL）**而非覆盖：已消费卡片重复提交被服务端忽略，与前端锁定双保险
- **除旧策略（双表统一纯时间 TTL）**：option_cards 24h 与渲染层失效语义同步（存储生命周期与展示一致）；injected_sessions 24h 判据保留窗口，超窗删除后会话重新活跃会重新注入（清单跟随会话活跃度）。写入点顺带 prune + 启动时全量 prune，无容量上限
- **旧卡片降级保留**：无 id / 库查无时走 hash 自包含渲染（现状模板逻辑作为降级分支保留），24h TTL 内升级不中断；不为旧卡片做数据迁移
- **option_cards 表结构**：
  ```sql
  CREATE TABLE IF NOT EXISTS option_cards (
    card_id TEXT PRIMARY KEY,
    q       TEXT NOT NULL,              -- 问题
    o       TEXT NOT NULL,              -- 选项 JSON 数组
    c       INTEGER NOT NULL,           -- 创建时间戳
    p       TEXT,                       -- sessionPath（回传注入用，可空）
    value   TEXT NOT NULL DEFAULT '',   -- 消费值（未消费=''）
    mode    TEXT NOT NULL DEFAULT '',   -- 消费模式（option/custom/skip；未消费=''）
    ts      INTEGER                     -- 消费时间戳（NULL = 未消费）
  );
  ```
