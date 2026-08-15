# Evidence — Option-card 消费标记

## 验证方式

- 逻辑层：Python 脚本（`_tmp/tests/oc-consumed-logic.py`）8 组用例
- 端到端：Edge headless（`--headless=new --virtual-time-budget=6000`）跑从 `routes/card.js` 提取的真实模板（`_tmp/tests/build-e2e.py` 生成，mock fetch 返回 `ok:true`），6 个场景

## 逻辑层（8/8 通过）

1. 编解码往返：q/o/c/p 完整保留
2. option：u=1, v=值, m=option，q/o/c/p 不变
3. skip：u=1, v='', m=skip
4. custom：u=1, v=自定义全文, m=custom
5. 幂等：重复写入后 u=1 且 v 为最新单值（键数恒为 7：q,o,c,p,u,v,m）
6. 判定：u=1 → consumed
7. 判定：无 u → 未消费
8. 卡片隔离：A 消费不影响 B

## 端到端（6/6 通过，Edge headless 真实 DOM）

点击/操作场景（after-click，按钮全锁定 firstBtnDisabled/extraBtnsDisabled=true）：

| 场景 | hash 写入 | 结果 |
|---|---|---|
| 点选第一个选项 | `u:1, v:"验收通过", m:"option"` | ✓ |
| 点跳过 | `u:1, v:"", m:"skip"` | ✓ |
| 自定义输入「自定义内容ABC」+ 发送 | `u:1, v:"自定义内容ABC", m:"custom"` | ✓ |

重载场景（loaded，`oc-status ok`，按钮不渲染）：

| 场景 | statusText | 结果 |
|---|---|---|
| 重载 option 已提交卡片 | 「已发送 · 验收通过」 | ✓ |
| 重载 skip 已提交卡片 | 「已跳过」 | ✓ |
| 重载 custom 已提交卡片 | 「已发送 · 自定义内容ABC」 | ✓ |

## 静态确认

- `markConsumed` 仅在 `if (data.ok)` 分支内调用（发送失败不消费）——`routes/card.js` submit() 成功回调
- 无 localStorage/sessionStorage 引用（单通道 hash，grep 确认）
- `v` 截断 200 字符（与 /card/choose 服务端 question 截断一致）

## 环境说明

- 验证机 node 不可用，逻辑验证与 build 脚本以 Python 3.13 重写（项目无单测框架，specs 走 evidence 模式）
- replaceState 在宿主 webview 的真实行为需桌面端验收（Edge headless 已覆盖标准浏览器行为；宿主为 Electron webview，SKILL.md 明确「code sandboxing 不是默认路径」，且 hana-remote-dev 的 localStorage 实证反证 iframe 非 opaque origin）
