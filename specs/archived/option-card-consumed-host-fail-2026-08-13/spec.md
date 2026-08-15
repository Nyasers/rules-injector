# 排查记录：option-card 消费标记在宿主环境失效

日期：2026-08-13
状态：已归档（决策：维持现状，Non-Goal 维持）

## 任务背景

堵住 option_card「历史卡片可重复选择」缝隙（0.7.6 重启存活特性的副作用）：
发送成功后写入消费标记，已提交卡片重载后锁定，不再重复回传。

## 已完成（0.7.16）

- 机制：发送成功回调里 `history.replaceState` 把 `u=1` + `v`（选择值/自定义全文）+ `m`（模式）写回 URL hash，
  与卡片数据同住 hash（URL 自包含、零新增存储，无 localStorage）。
- 代码：`Projects/rules-injector/routes/card.js`（consumed 分支 + markConsumed）、`tools/option-card.js`（注释）。
- 验证：
  - 逻辑层 8/8（`_tmp/tests/oc-consumed-logic.py`）
  - Edge headless 端到端 6/6（`_tmp/tests/build-e2e.py` + `oc-consumed-e2e.html`，点选/跳过/自定义三种写入 + 三种重载显示）
- 打包安装：`releases/rules-injector-0.7.16.zip`（自校验通过），已解压覆盖
  `E:\Hanako\.hanako\plugins\rules-injector`（manifest 0.7.16 确认）；
  旧版备份 `E:\Hanako\.hanako\plugin-backups\rules-injector-0.7.15-before-consumed-mark`。
- 归档：`specs/archived/option-card-consumed-mark-2026-08-13/{spec,evidence}.md`，SPECS.md、README 已更新。

## 实测结果（真实宿主）：失败

- 现象：同一张「消费标记实测：选一个选项提交」卡片，先自定义回传「自定义测试」，
  之后又回传「我选择：需要调整」——第二条回传未被消费标记拦截。
- 回传链路本身正常（custom/option 格式均精确匹配），问题在卡片端锁定未生效。

## 待定位根因（三个待确认问题，问 Nyaser）

~~1. 第二次点击时卡片界面：正常三枚按钮（未被锁过）？还是显示「已发送 · 自定义测试」锁定态但按钮可点？~~
~~2. 第二次点击前卡片是否重载/重新渲染（滚动离开再回来、切会话、消息重渲染）？~~
~~3. 若显示锁定态仍可点，是读取分支（consumed 判定）问题；若显示正常按钮，是写入/URL 丢失问题。~~

→ 已通过宿主源码直接证实（见下「根因已收敛」），无需再问。

## 初步假设（按嫌疑排序）

- ~~A. `history.replaceState` 在宿主 webview 被拒（sandbox opaque origin）→ try/catch 静默降级， hash 未写入，重载后恢复可点（Edge headless 通过但宿主翻车的反差指向这类环境差异）。~~
  ~~- 注意：若宿主 iframe 为 opaque origin，localStorage 同样不可用——之前「localStorage 可用 ⇒ replaceState 可用」的推理基于 hana-remote-dev 实证，但该实证来自另一插件，宿主版本可能已变。~~
- B. 宿主重挂载卡片时用 option-card 返回的初始 route 重建 URL，iframe 内 replaceState 改过的 hash 被丢弃（宿主持有原始 route 的引用，不读 iframe 当前 location）。 ✅ 已证实
- C. 多实例（desktop/bridge 双路径或会话恢复）各自独立渲染，消费标记只写进提交者的 iframe URL， 另一实例的 hash 仍是初始值。（次要：当前实测为单宿主，不解释本现场）

## 根因已收敛（2026-08-13 新会话，读宿主源码证实）

从 `resources/seed/renderer-0.446.6.tar.gz`（宿主 renderer 代码）取证：

1. **iframe src 完全来自消息块数据**：`pu({card:t})` 组件里
   `u = t.route`（初始 route，含初始数据 hash），`f = xl('/api/plugins/' + pluginId + u, agentId)`，
   `iframe src = f.iframeSrc`。宿主每次渲染卡片都用消息数据里的 route 拼 URL，**不读 iframe 当前 location**。
2. **宿主不感知 iframe 内 URL 变化**：renderer 全量检索 `hashchange / contentWindow.location / replaceState / pushState`
   无任何引用。iframe 内改 hash（无论 replaceState 还是 pushState）对宿主透明，不会同步到任何宿主状态。
3. **sandbox 为 `allow-scripts allow-same-origin`**：iframe 与宿主同源，replaceState 技术可用，假设 A（沙箱拒绝）排除。

**结论**：假设 B 证实。卡片 iframe 一旦被宿主卸载重挂载（消息流重渲染、虚拟列表回收、切会话、对话重载），
重建时必然回到初始 route（含初始数据 hash），`u/v/m` 消费标记蒸发，按钮恢复可点。
**`history.pushState` 不能解决**：宿主不监听 hashchange、不读 iframe location，pushState 与 replaceState 在宿主视角无差别。
消费状态必须放到「宿主重建 iframe 时必然读取的源头」——即插件服务端（GET /card 渲染端）。

## 决策（2026-08-13，Nyaser 拍板）

**方案 C：维持现状**——历史卡片可重复选择视为特性（0.7.6 重启存活特性的原始设计），Non-Goal 不翻案。

理由（Nyaser）：零落盘原则优先于消费标记闭环；在宿主管理 iframe URL 的框架下，
可靠的消费标记必须依赖服务端状态（方案 A），与「无状态、零落盘」偏好冲突；
重复选择的实际危害（语义冲突回传）概率低，可接受。

本次排查沉淀：宿主渲染机制已摸清（iframe src 源自消息数据 route、不读 iframe location），
若未来翻案，方案 A（插件状态文件 + 服务端渲染锁定态）是已验证方向的直接路径，
无需重新侦查。

## 下一步

- ~~方案选型~~ → 已定 C，无修复动作，无需重打包。
- 归档本记录至 `specs/archived/option-card-consumed-host-fail-2026-08-13/`，SPECS.md 同步。
