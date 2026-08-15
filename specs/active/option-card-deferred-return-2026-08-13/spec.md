# Option-card 回传改走 deferred 通道（根治伪造用户消息）

## Goal

选项卡片回传链路从「`session:send` 注入用户消息」改为「deferred 通道投递后台事件」（display:false custom_message + 触发父回合）。根治三条病根：

1. **伪造用户发言**：程序化交互结果被注入用户消息流，用户没说过的话进入历史；且会触发 `session_user_message` 事件（插件自身监听该事件做规则注入判定，形成隐式耦合）。
2. **busy 自研重试**：2s/5s/10s 三次重试，耗尽即失败需用户重点；宿主 deferred 已有 30s 补投机制（无限重试直到送达），自研轮子可删。
3. **双信道分裂**：规则注入走 deferred（后台事件），回传走用户消息，同一插件两条信道，语义不一致。

改造后：回传 = 宿主原生后台事件，模型可见、界面隐身、不进用户消息流；busy 由宿主托管，点击一次必达。

## Non-Goals

- 不改回传消息文本格式（`（选项卡片）<问题>\n我选择：<选项>` 不变，Agent 侧识别契约零改动，仅消息角色从 user 变为 hana-background-result 后台事件）
- 不改卡片渲染/消费落库（option_cards 表、SSR、消费锁定态全部不动）
- 不迁移历史卡片（旧卡片走同一 POST /card/choose，服务端统一改造，无分支）
- 不改规则注入的 `triggerParentTurn:false`（规则是背景知识，不唤醒的语义不变）
- 不引入新依赖（deferred:register / deferred:resolve 为宿主原生通道）

## Acceptance Criteria

- [ ] POST /card/choose 回传改走 deferred：`deferred:register`（meta.type=rules-injector，deliveryIntent=trigger_parent_turn）+ `deferred:resolve`（result = 回传文本），移除 `session:send`
- [ ] 三种模式回传文本格式不变（option/custom/skip），resolve result 即回传文本
- [ ] 消费标记（markCardConsumed）在 deferred:resolve 成功后标记（任务已登记必达；resolve 失败不标记，卡片保持可重试）
- [ ] busy 场景：agent 流式输出中点击 → POST 立即成功 → 卡片锁定「已发送 · value」→ 宿主补投机制保障 agent 空闲后必达，无 session_busy 错误、无重试等待
- [ ] 移除 `sendWithBusyRetry` 及 BUSY_RETRY_DELAYS（自研 2s/5s/10s 重试整体删除，busy 由宿主托管）
- [ ] 真实宿主实测：点击后 agent 收到 hana-background-result 类型消息（模型可见、UI 隐身），会话历史中无伪造用户消息
- [ ] 自定义输入、跳过两种模式同样走 deferred 并验证
- [ ] legacyShell 旧卡片（无 id）choose 同样走 deferred（服务端统一改造，不分支）
- [ ] deferred:register/resolve 失败 → 返回 ok:false + 错误，客户端显示发送失败，消费不标记，刷新可重试
- [ ] 零新依赖；版本 0.8.9 → 0.8.10

## Boundary Conditions

- **register/resolve 失败**（宿主不支持 / 会话已关闭）：返回 `{ ok:false, error }`，客户端显示「发送失败」，卡片不锁定可重试，消费不标记
- **宿主补投窗口（≤30s）内会话关闭**：宿主 suppressDelivery（任务滞留，投递放弃）。卡片已锁定但消息丢失——与现状（busy 时 session:send 失败、卡片不锁定）语义不同，文档注明「点击即锁定即达，会话关闭则投递作废」
- **并发双击**：前端 picked 锁 + 消费条件更新（ts IS NULL）双保险（不变）
- **同一卡片重复选择**：消费条件更新幂等忽略（不变）
- **taskId 唯一性**：`oc-<cardId>-<ts36>`，cardId 可追溯 + 时间戳保证唯一（沿用规则注入 taskId 约定：「唯一即可，hash 仅可追溯」）
- **回传文本以库中 q 为权威**（不变），库无记录回退 body 字段（不变）

## Constraints

- 不引入新依赖；沿用宿主 deferred 通道（bundle 0.446.6 已验证）
- 投递策略：显式 `deliveryIntent: "trigger_parent_turn"`（ZCe 判定 → 唤醒父回合；与默认「resolved 即唤醒」等价，显式声明意图，参考 hana-remote-dev src/lib/wake.js 惯例）
- 不设 `triggerParentTurn:false`（那会压住唤醒——规则注入的语义，回传不需要）
- 消费更新幂等：UPDATE ... WHERE card_id = ? AND ts IS NULL（不变）
- 版本号 0.8.9 → 0.8.10

## Design Decisions

- **走 deferred 的根因**：`session:send` 注入用户消息是「伪造用户发言」。用户消息流是用户真实输入的信道，程序化交互结果混入会造成：历史记录失真（导出/回溯污染）、触发 `session_user_message` 事件（rules-injector 自身监听的注入判定锚点，形成隐式耦合）、与其他对用户消息响应的宿主/插件逻辑冲突。deferred 投递 `custom_message`（display:false）是宿主原生后台事件通道，模型可见、界面隐身、不进用户消息流——语义正确。
- **唤醒语义（宿主源码验证，bundle 0.446.6）**：`ZCe(e)` 判定「是否触发父回合」：`deliveryIntent === "trigger_parent_turn"` → true；默认（无 triggerParentTurn:false）且 status=resolved → true。规则注入用 `triggerParentTurn:false` 压住唤醒是因为规则是背景知识；回传需要 agent 醒来处理分支，显式 `trigger_parent_turn`。参考实现 hana-remote-dev wake.js 的三件套。
- **busy 由宿主托管**：`_deliverTask` 投递失败（含 busy 冲突）任务留在 undelivered 状态，`flushUndelivered` 以 30s 间隔自动补投，直到送达或会话不可运行。点击一次必达，自研 2s/5s/10s 三次重试删除。
- **result 保持文本格式**：resolve result = 回传文本（「（选项卡片）<q>\n…」）。宿主 WCe 投递时字符串原样内嵌进 `<hana-background-result>` 消息体，Agent 收到的内容与现状文本同构，工具描述里的识别契约零改动；消息角色从 user 变为后台事件，对 Agent 反而是更可信的语义（插件事件，非用户发言）。
- **消费标记时机**：resolve 成功即标记（任务已登记，宿主必达），与现状「session:send 成功即标记」等价。实际送达异步（补投窗口 ≤30s），但消费状态与服务端确认解耦，客户端体验是「点击即锁定」。
- **UI 行为变化（显式契约变更）**：回传消息从「UI 可见的用户消息」变为「UI 隐身的后台事件」（宿主 kY() 构造器硬编码 display:!1，0.446.6 无显隐开关，meta.display 属能力预留）。代价：对话历史不再显示「我选择：xx」；补偿：卡片消费锁定态（「已发送 · value」）永久可见，消费信息不丢失。对话历史更干净（无伪造发言）。
- **降级策略（已定：方案 B 直接报错）**：deferred:register 失败（宿主不支持）时直接返回错误，不降级 session:send。理由：规则注入已依赖 deferred（不支持时 injectViaDeferred 返回 mode=unsupported 仅记录），回传同样依赖，语义一致；保留双路径是历史兼容兜底，违背项目极简原则，拒绝。
- **taskId**：`oc-<cardId>-<ts36>`——cardId 可追溯、时间戳唯一（沿用规则注入 taskId 的「唯一即可，hash 仅作可追溯信息」约定，规避宿主 deferred store 幂等吞投递的历史 bug 教训）。
