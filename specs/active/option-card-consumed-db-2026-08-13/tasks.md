# Tasks — option-card 落库 option_cards 表

## T1 lib/db.js：option_cards 建表 + CRUD + TTL 清理
- 描述：`CREATE TABLE IF NOT EXISTS option_cards`（替换 card_consumed 建表）；`createCard`（INSERT OR IGNORE）、`markCardConsumed` 改为 UPDATE ... WHERE ts IS NULL、`getCard`（整行查询，替代 getCardConsumed）、`pruneCards(ttlMs)`（DELETE WHERE c < ?）
- 关联 AC：表结构 / 消费条件更新 / TTL 清理
- 允许修改：`lib/db.js`
- 完成标志：node 脚本实测建表/幂等插入/条件更新/TTL 删除全通过

## T2 tools/option-card.js：card_id 生成 + 创建落库 + route 只带 id
- 描述：sha256(q|o|c|p) 前 16 位；createCard 落库（db 不可用不抛错，route 仍生成但仅带 id）；route 改为 `/card?id=<cardId>`
- 关联 AC：id 幂等 / 创建落库 / route 只带 id
- 允许修改：`tools/option-card.js`
- 完成标志：单测断言 id 稳定 + 落库行完整

## T3 routes/card.js 服务端：GET /card SSR + POST /card/choose 走库 + 降级
- 描述：GET /card 解析 query/hash 的 id → 查库 → SSR 渲染完整卡片（未消费可点 / 已消费锁定态 / 查无降级 hash / 无 id 降级 hash）；POST /card/choose 以 cardId 为主：查库取 q/p → 条件更新消费字段 → session:send（库无记录回退 body 字段）
- 关联 AC：SSR 渲染 / 消费锁定 / 回传注入 / 降级分支
- 允许修改：`routes/card.js`
- 完成标志：逻辑层模拟 + headless e2e 通过

## T4 routes/card.js iframe JS：SSR 场景瘦身 + 降级分支
- 描述：SSR 渲染时 JS 仅剩点击/自定义/跳过/反馈/锁定（去掉 hash 数据解析与 replaceState）；无 id 降级分支保留现状 hash 解析逻辑
- 关联 AC：点击注入 / 即时反馈 / 旧卡片兼容
- 允许修改：`routes/card.js`
- 完成标志：headless e2e 三种模式 + 降级路径通过

## T5 测试：逻辑层 + headless e2e
- 描述：`_tmp/tests/` 下 node 脚本测 db 层（幂等/条件更新/TTL）；Edge headless 测 SSR 渲染/消费锁定/降级
- 关联 AC：全部可验证项
- 允许修改：`_tmp/tests/`
- 完成标志：逻辑层全绿 + e2e 场景全绿

## T6 打包 + 安装 + 真实宿主验证
- 描述：scripts/build-release.py 打包 0.8.7 → 解压覆盖插件目录 → 真实宿主发卡片/点选/重建 iframe 再点验证锁定
- 关联 AC：真实宿主实测
- 允许修改：releases/ 产物、插件安装目录
- 完成标志：真实宿主实测通过（重建后不可重复选择）

## T7 文档 + 归档
- 描述：SPECS.md Active→Completed、README changelog 0.8.7、spec 归档 archived/
- 关联 AC：无
- 允许修改：SPECS.md、README.md、specs/
- 完成标志：文档闭环
