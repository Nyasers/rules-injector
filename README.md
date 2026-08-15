# rules-injector — 规则注入器

会话创建时把内置规则通过宿主 deferred 通道以隐藏消息注入会话历史：界面不显示注入正文，模型在后续每一轮都能看到规则，不干扰用户会话。

## 注入机制

- **通道**：宿主 deferred（`deferred:register` / `deferred:resolve`），投递为 `display:false` 的 `custom_message`（customType=`hana-background-result`），模型可见、界面隐身。
- **时机**：`session_created` 新会话全量注入；用户消息提交时（`session_user_message` 事件）一次性检查重注入（新指纹作废声明）。清单标识即内容指纹（sha256 前 16 位），任何状态变更（打开/关闭/新增/编辑）都反映为指纹更新，清单始终与规则文件同步；关闭规则后注入的清单中不再包含该规则。**推送判据即内容指纹**：内容未变化的重复操作（如重复关闭）指纹不变、不重复推送。状态变更不即时投递——注入判定收敛到用户消息提交时执行，判据只认「即将注入」时刻的清单内容指纹与已注入记录的对比（v0.7.2 修复：旧实现监听 rules-state.json 变化立即重注入，连续变更产生多条中间态投递污染模型输入；v0.7.3 曾以 800ms 稳定窗口 + 消息级去重防中间态，但 fs.watch 事件派发竞态与 session:get 异步反查约 10s 延迟使窗口失效；v0.7.4 取消防抖窗口：判定完全基于内容 hash 相等性，sessionId 缓存让 doInject 贴近消息提交时刻执行；v0.8.0 文件化后连资产 watch 也移除：doInject 每次实时播种 + 读文件算指纹）。
- **规则资产（v0.8.0）**：内置规则种子在插件目录 `rules/`（只读，随版本管理）；初始化播种到数据目录 `rules/builtin/`（工作副本，升级双向同步：新增补充、内容指纹判改过、用户修改过的文件保留；种子下架的内置规则：已自定义过（顶层有同名自编）→ 直接删除旧内置副本，未自定义过 → 降级到顶层自编区并默认禁用，资产不丢、归属变 custom）。用户自编规则放 `rules/` 顶层（v0.8.4 起不再套 `custom/` 子目录），默认语义顶层优先于 `rules/builtin/` 同名规则；内置规则自定义 = 新建同名自编覆盖（v0.8.6，优先级高于内置、开关态跟随内置），恢复默认 = 删除根的副本（开关状态保持）；被自定义过的内置规则开关时内置副本与顶层覆盖两处同步。开关 = 文件扩展名（`.md` 启用 ↔ `.mdisabled` 禁用，改名即开关）。**规则名即标题**（v0.8.4）：key = 文件名去扩展名 = 显示标题，映射层移除；文件首行 `# 标题` 由写入侧（UI/工具）自动对齐规则名，不再作为显示标题来源。排序按文件名 locale 序（zh-CN）。
- **状态（v0.8.0）**：统一 `plugin-data/rules-injector/data.db`（node:sqlite，零依赖）：`meta`（全局开关/版本）+ `injected_sessions`（注入判据）+ `card_consumed`（卡片消费）。旧 `rules-state.json` / `injected-sessions.jsonl` 首次启动自动迁移为 .bak。

## 投递策略（宿主 bundle 0.446.6 源码验证，2026-08-12）

deferred 投递的 `meta.deliveryIntent` 决定走哪条通道，三种策略各有权衡：

| deliveryIntent | 宿主路径 | 规则进模型上下文 | 触发回合（busy） | 结论 |
|---|---|---|---|---|
| `trigger_parent_turn` | `deliverCustomMessage` + triggerTurn | ✅ | ❌ 会话 busy，首条用户消息被拦 | 需配合 `session:abort` 收尾，存在时序竞争窗口 |
| `notify_ui_only` | `recordCustomEntry` | ❌ 写 `hana-deferred-result`，模型只能查到任务、读不到内容 | ✅ | 规则失效，不可用 |
| **不设** + `meta.triggerParentTurn: false` | `deliverCustomMessage` + triggerTurn:false（notifyOnly 模式） | ✅ | ✅ | **正解**，无需 abort |

关键源码位置（server bundle `index.js`）：

- `_deliverTask`：`deliveryIntent` 为 `notify_ui_only`/`ui_only` 时改道 `_recordUiOnlyTask`（`type="custom"` 条目，不进上下文）。
- `ZCe`：`meta.triggerParentTurn === false` → 不触发回合；`deliveryIntent === "trigger_parent_turn"` → 触发。
- `deliverCustomMessage`：`triggerTurn:false` 走 notifyOnly 分支，只写消息不触发回合。

**v0.5.0 的问题**：`trigger_parent_turn` + `session:abort` 组合下，注入触发父回合使会话短暂 busy，用户首条消息被 `session_busy` 拦截（重发即通）。v0.5.1 改为不设 deliveryIntent + `triggerParentTurn:false`，规则照常进上下文且不触发回合，abort 逻辑整体删除。

## display 表达位（v0.5.2）

插件在 `deferred:register` 的 `meta` 里携带 `display` 意图（`INJECT_DISPLAY` 常量，当前为 `true`），表达「注入消息是否希望界面可见」。

宿主 server bundle `kY()` 投递构造器当前硬编码 `display:!1`（0.446.6 验证），`meta.display` 暂不消费，此字段属能力预留：宿主支持后，注入消息将按意图显隐；支持前行为不变（隐身注入）。

## 使用

1. 把插件目录放入 Hana 插件目录（或解压 release 包），重载插件。首次启动自动迁移旧状态（rules-state.json / injected-sessions.jsonl → data.db + 文件化），并播种内置规则到数据目录。
2. 侧边栏「规则」管理注入开关、内置规则开关/恢复默认、自定义规则新增/编辑/删除（数据目录 `rules/`，用户下一条消息注入最新清单时生效）。

## 构建与发版

**构建**（工具链统一 Node，对齐姊妹插件 dsh-hanako：rspack bundle 两步构建 + archiver 纯 Node 生成 zip，zip + sha256 成对产出；构建期依赖 @rspack/core + archiver 两个 devDependency，交付物零依赖由固定清单保证）：

```bash
npm ci                   # 安装构建工具（@rspack/core + archiver；首次可 npm install 生成 package-lock.json）
npm run build            # = node scripts/build.mjs：rspack bundle，5 入口（index/routes/card/routes/sidebar/tools/option-card/cli）压缩为 ESM bundle，产物 dist/
npm run pack             # = node scripts/pack.mjs（内部先调 build）→ archiver 打包 releases/rules-injector-<ver>.zip + .sha256
npm run pack -- --force  # 覆盖已存在的同版本包
```

- 版本单一事实源 = `manifest.json` 的 `version`（发版只 bump manifest.json，`package.json` 的 version 仅作 npm 语义占位、不参与版本判断）；按 `PACKAGE_FILES` 固定清单打包（zip 内 posix 相对路径、无外层目录），打包后自校验清单与 version 一致才认成功。
- 交付物为 rspack 压缩 bundle：`lib/` 模块被各入口 import 内联进 bundle、不再单独交付（交付清单 13 项：index.js + cli.mjs + routes/×2 + tools/option-card.js + skills/ + rules/×5 + manifest.json + README.md）；`import.meta.url` 静态化后处理复刻 dsh-hanako（分发后路径仍指向实际安装位置）。
- 原子写：zip 与 `.sha256` 都先写临时文件再 rename 落位，中断不留半成品；`.sha256` 与 zip 同名成对产出（hex 大写摘要）。历史 `releases/` 旧包不补 sha256，只对新包生效。
- 构建工具不进交付包：`package.json` / `package-lock.json` / `node_modules` 不在 `PACKAGE_FILES` 清单内，插件交付物保持零依赖。

发布 zip 真实性/完整性校验（CI verify 用，魔数 `PK\x03\x04` + EOCD `PK\x05\x06` + sha256 三重校验，缺一即非零退出）：

```bash
node scripts/verify-zip.mjs releases/rules-injector-<ver>.zip releases/rules-injector-<ver>.zip.sha256
```

**发版流程**（GitHub Actions 三段式：create-release → build → verify，push tag `v*` 自动触发）：

1. bump `manifest.json` 的 `version`（如 0.9.4 → 0.9.5），同时更新 README「版本历史」
2. `git commit` → `git tag v0.9.5` → `git push origin v0.9.5`
3. CI 自动建 pre-release（`--generate-notes`，已存在则跳过）→ `npm ci` + `npm run pack` 打包并上传 `rules-injector-0.9.5.zip` + `.sha256`（`--clobber` 幂等）→ verify 查资产齐全 + 三重校验，缺任一即删 release 并 fail（公开 release 不留残缺）

> 资产名版本段无 v 前缀（`rules-injector-0.9.5.zip`，tag 是 `v0.9.5`）：CI verify 用 `${TAG#v}` 去 v 后拼资产名精确匹配，manifest version 与 tag 不一致会直接 verify fail（焊死版本单一事实源）。手动触发 `workflow_dispatch`（无 tag）只打包并走 artifact 3 天窗口，不出 release。

## 版本历史

- 0.9.4（2026-08-13）cli.mjs 上移至插件根：与 lib/ 同层相邻，import 改 `./lib/rules-fs.js`（消除 0.9.2 起从 skills/rules-manager/bin/ 出发的 `../../../` 跨层路径）；skills/rules-manager/ 仅剩 SKILL.md（技能回归纯说明书，CLI 随插件根分发）。
- 0.9.3（2026-08-13）清理 0.8.0 前遗留 `tools/shared.js`：文件化改造后其 RULES.md 解析/指纹/状态读写均为死代码（RULES_PATH 指向已废弃的 RULES.md），实际仅 `PLUGIN_ROOT` 常量被 index.js / routes/sidebar.js 引用；常量内联两处（各自 `path.resolve(dirname(fileURLToPath(import.meta.url)), "..")`），shared.js 删除，`tools/` 仅剩注册工具 option-card。
- 0.9.2（2026-08-13）规则管理逻辑收敛：`skills/rules-manager/bin/cli.mjs` 合并原 tools/manage_rules.js 的 action 分发（list/get/create/update/delete/toggle/restore），cli 成为完整单一脚本，文件系统层仅复用插件根 `lib/rules-fs.js`；`tools/manage_rules.js` 删除，`tools/` 回归仅注册工具（option-card + shared）。修复 cli 跨层 import 路径（0.9.1 从 bin/ 出发的 `../../` 只到 skills/，实际需 `../../../` 到插件根）。
- 0.9.1（2026-08-13）skill 瘦身修正：`skills/rules-manager/` 只保留 SKILL.md + bin/cli.mjs 薄壳，逻辑模块归位插件根（tools/manage_rules.js + lib/rules-fs.js，单一事实源，cli 跨层引用）——消除 lib/rules-fs.js 随包重复打包（0.9.0 包内同文件出现两遍）；SKILL.md 移除本机个人路径（fnm node 绝对路径改为环境通用说明，示例不再硬编码 `$node`）与过时信息（残留的 manage_rules 工具等价描述、已下架规则「规则管理规则」的 restore 示例改为真实内置规则）。
- 0.9.0（2026-08-13）规则管理迁入插件技能：`skills/rules-manager/`（SKILL.md + bin/cli.mjs + lib/rules-fs.js + tools/manage_rules.js）随插件包分发，替代 manifest 注册的 manage_rules 工具（contributes.tools 摘除、tools/manage_rules.js 移入技能包，消除插件工具双份维护）。修复 manage_rules toggle 状态判定落后于 0.8.2 `.mdisabled` 命名：`endsWith('.disabled')` 对 `.mdisabled` 误判为启用态，导致禁用规则启用时误报「已经是启用状态」；判定改用 `DISABLED_EXT` 常量，工具描述同步 `.mdisabled`。修复 skill CLI 种子通道：cli.mjs 的 `-s/--seedDir` 原先只设置环境变量而 manage_rules.js 硬编码自身目录（skill 包内指向不存在的 `skills/rules-manager/rules`），播种始终落空；现 seedDir 经 ctx 显式传递（`ctx.seedDir ?? 默认插件目录 rules/`），CLI 首次可真正播种与开关。
- 0.8.11（2026-08-13）选项卡片回传 Markdown 化：/card/choose 回传文本从纯文本平铺（`（选项卡片）<问题>\n我选择：<选项>`）改为 Markdown 标题结构——大标题 `# 选项卡片` 立身份，`## 问题` / `## 回答` 两个小标题各带正文（deferred 通道投递的消息体支持 md 渲染，Agent 侧信息层级更清晰，问题与选择分离）。点击选项与自定义输入统一为回答正文纯内容（两者同为文本回答，「## 回答」小标题已表达语义，去掉 `我选择：`/`自定义输入：` 冗余前缀）；跳过保留「跳过，不做选择」短语（放弃操作非文本回答，避免与内容混淆）。身份标记「选项卡片」保留，工具描述与注入规则同步措辞；格式变更需重启宿主生效（工具描述与规则在启动时加载）。
- 0.8.10（2026-08-13）选项卡片回传改走 deferred 通道：/card/choose 由 `session:send` 注入用户消息改为 `deferred:register`（meta.deliveryIntent=trigger_parent_turn，唤醒父回合）+ `deferred:resolve`（result=回传文本）投递后台事件。根治伪造用户消息三病根：历史污染（程序化交互结果不再进入用户消息流）、误触发 `session_user_message` 事件（规则注入判定锚点的隐式耦合解除）、busy 自研重试（2s/5s/10s 删除，改由宿主 30s 补投托管，点击一次必达）。回传文本格式不变（「（选项卡片）<问题>」前缀识别契约零改动），消息角色从用户消息变为 hana-background-result 后台事件（模型可见、界面隐身，与规则注入同通道）；消费标记在 resolve 成功后执行。行为变更：回传消息不再显示在对话流（卡片锁定态「已发送 · value」补偿）；register/resolve 失败直接报错不降级（方案 B，与规则注入同策略）。
- 0.8.9（2026-08-13）静态态补尺寸上报：`renderConsumed` / `renderInvalid` 注入 `SIZE_REPORT_JS`（仅尺寸上报，无交互逻辑，锁定态语义不变）。修复刷新后已消费卡片出现滚动条：0.8.8 静态化后这两态无 JS，刷新时宿主只能依赖创建时 `aspectRatio` 的估算高度，实际渲染高度与估算的偏差（custom 态输入框回填、按钮文本变长等）把内容顶出 iframe 视口。三个渲染路径（active / consumed / invalid）尺寸上报行为统一，刷新后无论卡片处于哪一态高度都能自适应。
- 0.8.8（2026-08-13）已消费卡片锁定态保留按钮区：`renderConsumed` 静态复刻客户端「刚回复完」的 DOM 形态（option：选中按钮 `oc-picked` + label 替换为「已发送 · value」；custom：发送按钮变绿显示结果（.oc-fb）、跳过按钮隐藏、输入框保留已提交内容；skip：跳过按钮变绿「已跳过」、发送按钮隐藏；按钮/输入/发送全禁用，无 JS）。修复刷新后渲染不一致：此前已消费卡片 SSR 只渲染「问题 + 状态行」、按钮区整体移除，而客户端刚回复完形态保留按钮区，iframe 重载与否两条路径长成两副面孔（实测复现：custom/skip 刷新后按钮消失，option 未重载时保留按钮）。现在无论 iframe 是否重载，刷新后与刚回复完同形。兜底：选项数据异常或 option 值匹配不到选项时退化为纯状态行。
- 0.8.6（2026-08-13）内置规则自定义对齐：内置规则与自定义规则同等对待——UI 内置行增加编辑入口（textarea + 保存），保存 = 写入顶层同名自编覆盖（优先级高于 builtin，开关态跟随内置），不再直写内置副本；「恢复默认」带确认弹窗，语义 = 删除根的副本（移除同名自编覆盖），内置副本内容保持；`resetRuleToSeed` 不再强制 .md（开关态保持）；save API 恒写顶层自编区、manage_rules update 支持内置规则；内置行编辑预填同名自编内容（继续编辑上次版本）；被自定义过的内置规则开关时内置副本与顶层覆盖两处同步（避免恢复默认后状态跳变）。种子移除「规则管理规则.md」（拆分废弃，职责拆入开发文档与行为约束），发布清单同步为 5 条种子。
- 0.8.5（2026-08-13）内置种子双向同步：`seedBuiltin` 新增反向降级——种子下架的内置规则：已自定义过（顶层已有同名自编）→ 直接删除旧内置副本；未自定义过 → 降级到顶层自编区并默认禁用（.mdisabled），资产保留不生效、归属变 custom；播种统计新增 `demoted`/`removed`；loadEffectiveRules / manage_rules / sidebar / migrate 四处调用统一显式传顶层目录。
- 0.8.4（2026-08-13）文件名与标题统一（对焦决策落地）：`title` 恒等于 key（文件名去扩展名），移除首行标题映射层；新增 `normalizeHeading` 写入侧自动对齐首行 `# 规则名`（UI 新建/保存、manage_rules create/update 全入口）；新建表单文案明确「规则名即标题」。用户自编区去 `custom/` 化：自编规则直接放数据目录 `rules/` 顶层，默认语义顶层优先于 `rules/builtin/` 同名（loadEffectiveRules / sidebar / manage_rules / migrate 四处路径统一）。内置种子首行本与文件名一致，指纹不变，不触发重注入。
- 0.8.3（2026-08-13）侧边栏 UI 修复：新建表单从自定义规则列表区移出，独立成组（grp-label「新建自定义规则」+ 分隔线）；规则名输入加 autocomplete 关闭，创建成功清空、失败保留草稿。
- 0.8.2（2026-08-13）禁用命名改为整体扩展名 `.mdisabled`（`xxx.md` ↔ `xxx.mdisabled`）：`.md.disabled` 含 `.disabled` 后缀，旧版 toggleRule 的 `endsWith('.disabled')` 误匹配后拼 `.md` 产生双重扩展名 `xxx.md.md`（本会话实测复现）；`.mdisabled` 不以 .md/.disabled 结尾，新旧代码均无误匹配，从根上消灭双重扩展名歧义。旧式 `xxx.disabled` / `xxx.md.disabled` 不属于新命名（扫描忽略），手动清理，代码不做历史形态兼容。
- 0.8.1（2026-08-13）侧边栏信息精简：规则行去除「生效中/已停用」状态文字与「内置/自编」来源标签（分组标题已表达来源）；禁用规则标题变灰（text-muted）作弱化提示；「被覆盖」标签保留（custom 覆盖 builtin 时显示，跨分组衍生状态分组表达不了）；「规则文件」分组标题删除（层级更平）；说明区块文案精简为开关语义一句。禁用命名暂用 `.md.disabled`（0.8.2 改为 `.mdisabled`）。

- 0.8.0（2026-08-13）文件化规则存储：RULES.md 拆为每规则一文件（内置种子 → 数据目录工作副本，custom 同名优先）；开关 = 文件扩展名（.md ↔ .disabled）；升级只增不覆盖 + 内容指纹判改过；状态统一 data.db（node:sqlite 三表：meta / injected_sessions / card_consumed，DELETE journal 保单文件）；旧 rules-state.json / injected-sessions.jsonl 自动迁移 .bak；侧边栏分组列表 + 自定义规则内置编辑。规则文件名不再编号，按文件名字母序排序（可选数字前缀微调置顶）。

- 0.7.16（2026-08-13）选项卡片消费标记：发送成功后 `history.replaceState` 把 `u=1` 与回复内容（`v`=选择值/自定义输入全文，`m`=option/custom/skip）写回 URL hash——消费状态与卡片数据同住 hash，URL 自包含、零新增存储（不用 localStorage：其可用性反而证明 iframe 非 opaque origin，replaceState 必然可用；且 key 累积违背清洁度）。已提交卡片重载后按模式显示「已跳过」或「已发送 · <值>」并锁定，历史卡片不再可重复选择（修复 0.7.6 重启存活特性带来的重复回传缝隙）。写入时机在成功回调而非点击时：发送失败（busy 耗尽/网络错误）不消费，刷新后仍可重试；replaceState 被拒绝时静默降级为仅本次实例锁定。零落盘不变（无服务端状态）。

- 0.7.15（2026-08-13）选项卡片会话忙自动重试：/card/choose 收到 session_busy（流式输出中）时按 2s/5s/10s 最多重试 3 次再返回错误，期间客户端保持「正在发送…」；非 busy 错误不重试、立即返回。零落盘原则不变，无新增服务端状态（重试逻辑封装为独立函数 sendWithBusyRetry，delays 可注入便于测试）。

- 0.7.6（2026-08-13）选项卡片零落盘：卡片数据（问题/选项/时间戳/sessionPath）编码进 webview route 的 hash 段，服务端 `/card` 退化为纯静态壳，iframe JS 从 `location.hash` 解析并动态渲染按钮；删除 `choices/` 文件存储，重启存活（历史卡片重载后依然可点）。

- 0.7.5（2026-08-13）侧边栏 UI 精简：`.card` 容器去除边框与圆角（保留底色与留白），直切融入宿主侧边栏背景，视觉更干净。

- 0.7.4（2026-08-13）取消防抖窗口：删除 watch 状态文件的 800ms 稳定期机制——判定只认「即将注入」时刻状态内容 hash 与已注入记录的对比（内容没变就不推）；sessionId 缓存（session_created 写入）消除 session:get 异步反查约 10s 延迟，doInject 回到消息提交时刻执行，中间态不再被延迟快照捕获；injected-sessions.jsonl 更新改为尾部剔除（最后一行是当前会话则先删再增），尾部恒为最新。同步更新 manifest description 与 RULES.md「规则管理规则」语义。

- 0.7.3（2026-08-13）修复中间态泄漏：恢复状态文件监听但仅作稳定期信号（800ms 窗口），用户消息提交后状态仍在变化则注入顺延到稳定后再判据，快速反复拨动开关（净效果为零，最终态与已注入指纹一致）不产生推送；同时按 clientMessageId 消息级去重，防 desktop/bridge 双路径对同一消息双推。

- 0.7.2（2026-08-13）修复重复注入 bug：检查时机从「rules-state.json 变化即时重注入」改为「用户消息提交时一次性检查」（`session_user_message` 事件挂载点）。连续多次状态变更不再产生多条中间态投递，合并为一次最终态注入；无变化轮次由指纹判据快速短路。状态文件仍为单一事实源，指纹语义不变。同时移除 `update_rule` 工具：插件工具用户不可直接调用，且侧边栏已完整覆盖规则管理，回归纯侧边栏管理，RULES.md 规则管理小节同步简化。
- 0.7.1（2026-08-13）修复历史指纹回退被宿主吞投递：taskId 加入时间戳唯一化（hash 仅作可追溯信息，与投递标识解耦）；injected-sessions 记录改 JSONL 追加写（每行 `{ sessionId, hash }`，宿主原生 sessionId 作键，逆序读按最新为准，超阈值惰性压缩；旧格式整块自然失效当作未注入）。
- 0.6.0（2026-08-12）内容 hash 判据落地：injected-sessions.json 持久化各会话已注入指纹，跨重启判据成立；修复侧边栏重建 $global 丢 version/contentHash 字段问题。
- 0.5.4（2026-08-12）内容判据去重：推送判据从版本号改为清单内容 hash，重复操作（内容未变）不再重复推送；修复选项卡片长文本溢出叠印（.oc-label 可收缩换行）。
- 0.5.3（2026-08-12）关闭规则即时生效：disable 同样递增版本并触发全量重注入，规则集与状态文件严格同步。
- 0.5.2（2026-08-12）display 表达位：register meta 携带 display 意图（INJECT_DISPLAY），宿主支持后按意图显隐，当前行为不变。
- 0.5.1（2026-08-12）修复首条消息 busy：改为 notifyOnly 投递，删除 abort。
- 0.5.0 即时注入与侧边栏开关即时生效，规则状态单一事实源。
