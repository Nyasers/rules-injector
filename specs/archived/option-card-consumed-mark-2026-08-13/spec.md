# Option-card 消费标记（防历史卡片重复选择）

## Goal

堵住 0.7.6「重启存活（历史卡片重载后依然可点）」特性带来的重复选择缝隙：卡片发送成功后写入消费标记（`history.replaceState` 把 `u=1` + 回复内容写回 URL hash），已提交卡片重载后锁定（保留原问题文本 + 状态条显示具体回复 + 禁用按钮），历史卡片不再可重复选择。消费状态与卡片数据同住 hash，URL 自包含、零新增存储。

## Non-Goals

- 不做服务端幂等 / used 标记（零落盘 vs 服务端存取的权衡，维持不变）
- 不改 `POST /card/choose` 服务端逻辑（消费状态全在浏览器端）
- 不用 localStorage / sessionStorage（localStorage 在 opaque origin 下同样抛 SecurityError——宿主 iframe 能用 localStorage 反而证明其非 opaque origin，`replaceState` 必然可用，storage 通道无存在前提；且 key 永久累积、origin 共享串扰，违背零落盘与系统清洁度）
- 不处理发送中/失败状态（发送失败不消费，刷新后仍可重试，既有能力保留）
- 不改变回传消息格式（`（选项卡片）<问题>` 前缀不变，Agent 侧语义不受影响）

## Acceptance Criteria

- [x] 点选/自定义发送/跳过且服务端返回 `ok` → `history.replaceState` 把 `u=1, v=<值>, m=<模式>` 写回 URL hash（v=选择值或自定义输入全文，m=option/custom/skip）
- [x] 已提交卡片重载后：保留原问题 + 状态条按模式显示「已跳过」或「已发送 · <值>」（`oc-status ok`），选项按钮不渲染
- [x] 三种模式分别记录：option 记选择值、custom 记自定义全文、skip 记空值 + skip 模式
- [x] 消费标记幂等：重复写入后 `u/v/m` 仍为单值，payload 其他字段（q/o/c/p）不变
- [x] 不同卡片互不串扰（hash 即卡片数据载体，状态天然随卡片走）
- [x] consumed 优先于 TTL：过期但已提交的卡片按已提交显示
- [x] 零落盘不变：无新增服务端状态/文件，无浏览器持久存储

## Boundary Conditions

- replaceState 被沙箱拒绝（极端环境）→ try/catch 静默降级，保持既有行为（仅本次实例锁定，重载后可重选）
- 发送失败（`session_busy` 耗尽/网络错误）→ 不写消费标记，刷新卡片后可重试（现有反馈分支不变）
- 自定义输入超长 → `v` 截断至 200 字符（与 /card/choose 服务端 question 截断一致）

## Constraints

- 零落盘：不引入服务端状态，不引入浏览器持久存储
- 纯前端改动：`routes/card.js` 模板内 JS（约 40 行），`tools/option-card.js` 注释同步

## Design Decisions

- 单通道 hash 而非双通道：`history.replaceState` 让消费状态随 URL 自包含（重载/分享/重启都带状态），与卡片数据同住 hash，最贴合零落盘语义。曾引入 localStorage 作降级通道，但证据链显示其无存在前提（见 Non-Goals），且带来 key 累积与 origin 串扰，已移除
- 记录回复内容（v/m）而非布尔标记：重载后状态条显示「已跳过」或「已发送 · <值>」，与点击后的即时反馈文案一致，用户可回溯自己回复了什么（含自定义输入全文）
- 写入时机在成功回调而非点击时：发送失败不应消耗卡片，刷新后重试是既有能力
- consumed 分支不渲染选项按钮（与 invalid 分支一致），保留原问题文本 + 状态条提示
