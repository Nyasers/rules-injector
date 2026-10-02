---
name: rules-injector-option-card
description: 当需要用户在多个方案 / 选项中选一个（A/B 选择、确认操作、要偏好、多选一）时铸造选项卡片：候选选项以按钮竖排呈现，另带自定义输入与「跳过」入口，选择经宿主回传为 Markdown 消息。即使只有 2 个选项（是 / 否）也用它，不要让用户打字回复。
profile: card-skill
default-enabled: true
---

# 选项卡片

一张选项卡片是一次决策点：一个问题、若干个候选选项，用户点一下就把选择交出去。需要用户在多个方案里选一个、确认一次操作、或表明偏好时用它；若只是陈述或提问、答案只有一个、或主要是采集自由长文本，则不是它的场合（卡片的自定义输入只是备选，选项仍是主体）。

卡片上的可见文字用对话当前的语言书写。模板自带字符串为中文（与 rules-injector 的 option_card 工具一致）；对话用其他语言时翻译这些字符串。

## 模板

`rules-injector-option-card/assets/option-card.card.html` 是一份完整、合法的卡片文档，承载了下面描述的一切。铸造前读它，按原样使用，除非这次选择需要它没有的东西。

## 铸造方式：先拿 JSON，再 show_card

不要自己编造卡片内容。先调用 rules-injector 的 `option_card` 工具：

- 参数：`question`（问题本身，简洁，作卡片标题）、`options`（2~6 个候选选项）。
- 返回纯 JSON：`content` 里是 `{"cardId","question","options","layout","chooseTool"}`。

拿到 JSON 后，用宿主 recipe 铸造：

`show_card(template="rules-injector-option-card/assets/option-card.card.html", state={cardId, question, options})`

`state` 整体替换模板自带的默认值（默认 cardId 为空、示例问题与选项），所以三个键都要传。布局固定为竖排（`layout: "v"`），无需在 state 里指定。问题与选项必须以工具返回的 JSON 为准，不要改写、也不要增删用户没提过的选项。

## 交互与回传

卡片脚本用 `window.card.invoke` 把选择送回宿主：

- 点选项 → `invoke("opt", {cardId, choice: 选项文本, mode: "option"})`
- 自定义输入（Enter 或「发送」）→ `invoke("custom", {cardId, choice: 输入值, mode: "custom"})`
- 跳过 → `invoke("skip", {cardId, choice: "", mode: "skip"})`

三个 binding（`opt` / `skip` / `custom`）都指向 `rules-injector_option_choose` 工具，`cardId / choice / mode` 全部经 manifest slots 运行时传入（binding input 为空对象）。宿主调用该工具后，把选择经后台（deferred）通道投递为 Markdown 消息进入当前会话：

『# 选项卡片 / ## 问题 / ## 回答 <内容>』

- 收到含「选项」标题的 Markdown 消息，视为用户做出的选择，继续执行对应分支；
- 回答正文为「跳过，不做选择」时视为放弃决策，不追问。

消费闸门在 `option_choose` 侧：已消费的卡片幂等跳过，重复点击 / 重复投递不会产生第二条消息。

## 布局

- **统一竖排（目录列表）**：根元素 `oc-card oc-layout-v`。每行一个选项按钮：两位编号（`oc-idx`）+ 选项文本（`oc-label`）+ 箭头（`oc-arrow`），`aria-label="选择 X"`；点中行加 `oc-picked`（accent 描边与浅底）并锁定全部控件。
- **次级入口**：自定义输入（`oc-custom-input` + 「发送」）与「跳过」（`#oc-skip-btn`），与点选同等回传。
- **状态条**：`oc-status` 默认隐藏；发送中 / 成功（「已发送 · 值」/「已跳过」）/ 失败（「发送失败」+ 底部错误状态条）时出现。
- **未绑定场景**：`cardId` 为空（模板被独立打开、未经宿主铸造）时按钮禁用并提示，避免把选择发给不存在的卡片。
- 视觉遵循宿主纸张风：平面暖纸色、方角、发丝分隔线、无渐变、无阴影、无 emoji，颜色全部走 CSS 变量（`--bg-card` / `--text` / `--border` / `--accent` 等）。

## Outside a host that understands recipes

这个包在不把 recipe 当概念的宿主里就是一份普通技能文件：上面的文字本身就是铸造指引，模板路径只是可以打开的文件，卡片自带默认状态（示例问题与两个示例选项），独立打开也能完整展示，只是没有宿主桥、无法把选择回传。
