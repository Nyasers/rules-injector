# Option-card session_busy 自动重试

## Goal

给 `/card/choose` 端点补 `session_busy` 自动重试：会话忙（流式输出中）时按 2s/5s/10s 延迟最多重试 3 次，期间客户端保持「正在发送…」，全部耗尽仍忙才返回 `session_busy`。零落盘原则不变。

## Non-Goals

- 不做服务端幂等 / used 标记（零落盘 vs 服务端存取的权衡，本次明确不动）
- 不改客户端 UI 交互与反馈文案（`session_busy` 分支保留为兜底）
- 不处理 iframe 重载后重复提交（既有行为，不在本次范围）

## Acceptance Criteria

- [ ] `/card/choose` 收到 `session_busy` 错误时自动重试，间隔 2s/5s/10s，最多 3 次
- [ ] 重试成功返回 `{ ok: true, ...result }`，与普通成功一致
- [ ] 3 次重试耗尽仍 busy，返回 `{ ok: false, error: "session_busy" }`（错误文案保持原有，客户端「等待回复结束」分支继续可用）
- [ ] 非 busy 错误（如 `session_manifest_not_found`）不重试，立即返回
- [ ] 成功路径（第一次调用即成功）行为不变，调用次数为 1
- [ ] 零落盘不变：不新增任何持久化文件或服务端内存状态
- [ ] busy 判定：`/busy/i` 正则匹配错误消息（与解语花 `claimAndSend` 一致）

## Boundary Conditions

- `ctx.bus` 缺失或没有 `request` 方法 → TypeError 被 catch 捕获，直接返回错误，不重试（非 busy 错误）
- 重试窗口内宿主对 `/card/choose` 的 HTTP 超时 → 客户端收到网络错误，走既有「发送失败」降级路径
- 重试期间并发请求（双窗口 / iframe 重载后重复点击）→ 既有行为，不新增防护（Non-Goal）
- `session:send` 抛出的错误不是字符串而是 Error 对象 → `String(e)` 兜底后正则匹配

## Constraints

- 零落盘：不引入服务端状态
- ESM，Node 原生 `setTimeout` promise 封装
- 参考实现：解语花 `lib/send.js` `claimAndSend` 的重试段（生产验证过 2s/5s/10s）

## Design Decisions

- 重试延迟沿用解语花生产验证的 `[2000, 5000, 10000]`，不另调参
- 重试逻辑封装为独立函数 `sendWithBusyRetry(requestFn, payload, delays)` 并导出，便于 mock 单测（延迟作为参数注入，测试可传短延迟）
- 客户端不改：现有 fetch 无超时，重试期间按钮已锁 + 显示「正在发送…」，最终结果两种（成功 / 耗尽后 session_busy）都能落到现有反馈分支
