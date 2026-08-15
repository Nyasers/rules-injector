# Specs

## Active
- [option-card-return-markdown] 选项卡片回传 Markdown 化：回传文本从纯文本平铺改为标题结构（`# 选项卡片` 大标题 + `## 问题`/`## 回答` 小标题）；选项与自定义统一为回答正文纯内容（去 `我选择：`/`自定义输入：` 冗余前缀），跳过保留短语；需重启宿主生效 — [spec](specs/active/option-card-return-markdown-2026-08-13/spec.md) (阶段: spec)
- [option-card-deferred-return] 选项卡片回传改走 deferred 通道：根治伪造用户消息（历史污染/session_user_message 隐式耦合），busy 由宿主托管 30s 补投（点击一次必达），移除自研 2s/5s/10s 重试；回传文本格式不变，UI 隐身（卡片锁定态补偿） — [spec](specs/active/option-card-deferred-return-2026-08-13/spec.md) (阶段: spec)
- [sidebar-ui-declutter] 侧边栏 UI 信息精简：去冗余状态文字与来源标签，规则行只留 标题+开关+覆盖标记，说明文案精简 — [spec](specs/active/sidebar-ui-declutter-2026-08-13/spec.md) (阶段: spec)

## Completed
- [builtin-seed-demote] 内置种子下架降级：种子下架的内置规则，已自定义过（顶层有同名自编）→ 直接删除旧副本；未自定义过 → 降级到顶层自编区并默认禁用（资产保留不生效）；升级同步从「只增不覆盖」扩展为双向 — (2026-08-13)
- [file-based-rules-store] 文件化规则存储：RULES.md 拆每规则一文件（种子→数据目录工作副本，同名用户优先）；开关 = 扩展名（.md/.disabled）；状态统一 data.db（node:sqlite 三表）；升级只增不覆盖 + 内容指纹判改过；侧边栏内置编辑 + manage_rules 工具 — (2026-08-13)
- [cli-lib-colocate] 0.9.4 cli.mjs 上移至插件根与 lib 同层（import ./lib/rules-fs.js，消除跨层路径）；skills/rules-manager/ 仅剩 SKILL.md — (2026-08-13)
- [shared-js-cleanup] 0.9.3 清理 0.8.0 前遗留 tools/shared.js（RULES.md 解析死代码），PLUGIN_ROOT 内联 index/sidebar；tools/ 仅剩注册工具 — (2026-08-13)
- [manage-rules-cli-merge] 0.9.2 规则管理逻辑收敛进 cli.mjs（单一脚本，复用插件根 lib/rules-fs.js；tools/manage_rules.js 删除，tools/ 仅注册工具）；修复 0.9.1 cli 跨层 import 路径 — (2026-08-13)
- [manage-rules-skill-slim] 0.9.1 skill 瘦身：skills/rules-manager/ 只留 SKILL.md + cli.mjs 薄壳，逻辑模块归位插件根（tools/manage_rules.js + lib/rules-fs.js 单一事实源，cli 跨层引用），消除 lib 重复打包；SKILL.md 去个人路径与过时信息 — (2026-08-13)
- [manage-rules-skill-takeover] manage_rules 工具 → 插件技能：skills/rules-manager/（SKILL.md + cli.mjs + lib/rules-fs.js + tools/manage_rules.js）随包分发替代工具（contributes.tools 摘除）；修复 toggle 判定落后（endsWith('.disabled') 对 .mdisabled 误判启用）、修复 skill CLI 种子假通道（seedDir 改 ctx 显式传递，播种首次可用） — (2026-08-13)
- [option-card-consumed-host-fail] 排查：消费标记在真实宿主失效（0.7.16 实测失败）；读宿主 renderer 源码证实根因——iframe src 源自消息数据 route、宿主不感知 iframe 内 URL 变化，重建即丢 hash；**决策：维持现状（Non-Goal 不翻案，零落盘优先）** — (2026-08-13)
- [option-card-consumed-mark] 选项卡片消费标记：发送成功后 history.replaceState 把 u/v/m 写回 URL hash（与卡片数据同住，零新增存储），已提交卡片重载后按模式显示具体回复并锁定，历史卡片不可重复选择 — (2026-08-13)
- [option-card-busy-retry] /card/choose 补 session_busy 自动重试（2s/5s/10s，零落盘不变） — (2026-08-13)
- [release-build-script] 打包流程脚本化：scripts/build-release.py 一键打包 + 自校验 — (2026-08-13)
- [build-toolchain-node] 打包工具链 Python → Node 统一：build-release.py / verify-zip.py 删除，改 archiver 纯 Node zip（scripts/build-release.mjs）+ verify-zip.mjs 三重校验 + CI setup-node（.nvmrc 24.18.0，npm ci），交付清单 PACKAGE_FILES 不变、构建工具不进交付包 — (2026-08-13)
- [rspack-bundle-build] 打包工具链升级 rspack bundle 两步构建（scripts/build.mjs + scripts/pack.mjs，对齐 dsh-hanako build.mjs + pack.mjs）：5 入口（index / routes/card / routes/sidebar / tools/option-card / cli）rspack 压缩为 ESM bundle（library type module 保持具名导出，usedExports/sideEffects 关闭防摇空，import.meta.url 静态化后处理复刻）；lib/ 内联进 bundle 不再单独交付，交付清单 13 项；build-release.mjs 删除（zip/sha256/原子写/自校验逻辑并入 pack.mjs）；版本单一事实源仍为 manifest.json — (2026-08-15)

## Superseded
（暂无）
