# Tasks: Sidebar UI 信息精简

依赖顺序：1 → 2

## T1 模板与样式精简

- 描述：routes/sidebar.js 三处改动——① renderGroups 规则行去掉状态文字与来源标签，标题按 enabled 加 off class；② CSS 加 `.r-title.off` 弱化色，删废弃的 `.r-state`；③ 说明区块文案替换为 D3 精简版。
- 关联 AC：AC1、AC2、AC3、AC4、AC5、AC8
- 允许修改：`routes/sidebar.js`（WIDGET_CSS / WIDGET_JS / HTML 模板）
- 完成标志：renderGroups 输出无「生效中/已停用」、无「内置/自编」标签、overridden 标签保留、标题带 off class；CSS 含 .r-title.off；说明文案为新版

## T2 验收与宿主实测

- 描述：语法检查 + 拉取 sidebar HTML 验证 DOM 结构 + 功能回归（开关/展开/编辑链路 API 正常，无 500）。
- 关联 AC：AC6、AC7
- 允许修改：无（只验证）
- 完成标志：node --check 通过；HTML 中规则行结构符合 AC1-AC5/AC8；/sidebar/data 与 toggle 端点正常
