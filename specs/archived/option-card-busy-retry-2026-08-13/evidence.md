# Evidence — Option-card session_busy 自动重试

验证日期：2026-08-13
测试：`_tmp/tests/card-busy-retry.test.mjs`（mock requestFn，6 场景全过）

## Acceptance Checklist

- [x] `/card/choose` 收到 `session_busy` 错误时自动重试，间隔 2s/5s/10s，最多 3 次
  Evidence: 单测场景2（恒 busy 调用 4 次 = 初始 + 3 次重试）；场景6 实测默认延迟总等待 17031ms（2+5+10s 窗口内）

- [x] 重试成功返回 `{ ok: true, ...result }`，与普通成功一致
  Evidence: 单测场景1（busy 一次后重试成功，返回 `{ ok: true }`）；handler 返回语句未变（`c.json({ ok: true, ...result })`）

- [x] 3 次重试耗尽仍 busy，返回 `{ ok: false, error: "session_busy" }`
  Evidence: 单测场景2 抛出原 busy 错误；由 handler 既有 catch 返回 `{ ok: false, error: err.message }`，错误文案保持原样，客户端「等待回复结束」分支继续可用

- [x] 非 busy 错误（如 `session_manifest_not_found`）不重试，立即返回
  Evidence: 单测场景3（调用 1 次即抛出）

- [x] 成功路径（第一次调用即成功）行为不变，调用次数为 1
  Evidence: 单测场景4

- [x] 零落盘不变：不新增任何持久化文件或服务端内存状态
  Evidence: 改动仅新增纯函数 `sendWithBusyRetry`（内存态）与 handler 调用点；无文件写入、无全局状态

- [x] busy 判定：`/busy/i` 正则匹配错误消息（与解语花 `claimAndSend` 一致）
  Evidence: 单测场景5（message 为 undefined 时 `String(e)` 兜底为 "Error"，不误判 busy、不重试）；正则与解语花 `lib/send.js` 相同

## 对抗式审查

- [x] 验收标准可独立复现：`sendWithBusyRetry` 为独立纯函数，mock 测试不依赖路由上下文，重写实现后同标准仍可验证
- [x] 无隐性假设（安全侧）：
  - busy 判定依赖宿主 `session:send` 错误 message 含 "busy"（解语花生产验证过）；若宿主改错误格式，误判方向是「不重试、立即报错」，不会导致双发
  - 假设宿主 HTTP 层容纳 17s 请求（解语花同款延迟生产可用）；若超时，客户端走既有「发送失败」网络错误降级路径，可重试
- [x] Non-Goals 未越界：未引入服务端幂等 / used 标记；未改客户端 UI 与反馈文案；未处理 iframe 重载重复提交（保持既有行为）
- [x] 可合并性：改动约 20 行，单测覆盖全分支，无回归面（成功路径、非 busy 路径行为逐字节未变）
