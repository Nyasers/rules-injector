# Evidence: Sidebar UI 信息精简

## Acceptance Checklist

- [x] AC1 规则行不再显示「生效中/已停用」状态文字
  Evidence: renderGroups 已移除 r-state 文字节点（代码级）；宿主实测待 0.8.1 装包
- [x] AC2 分组内不再显示来源标签（builtin 无「内置」、custom 无「自编」）
  Evidence: 标签分支已删，仅 overridden 分支保留（代码级）；宿主实测待装包
- [x] AC3 「被覆盖」标签保留（overridden=true 时显示）
  Evidence: tag ov 分支保留，数据驱动（custom 同名才出现）；宿主实测待装包
- [x] AC4 规则行精简为：箭头 + 标题 +（被覆盖标签）+ 开关
  Evidence: 模板结构已改（代码级）；宿主实测待装包
- [x] AC5 说明区块文案精简为一句开关语义（.md 启用 / .mdisabled 停用）
  Evidence: 新文案已替换（代码级）；宿主实测待装包
- [x] AC9 「规则文件」分组标题删除
  Evidence: rulesWrap 的 grp-label 已删（代码级）；宿主实测待装包
- [x] AC10 禁用文件命名为整体扩展名 .mdisabled，代码不做历史形态兼容（旧式 .disabled/.md.disabled 扫描忽略，手动清理）
  Evidence: rules-fs-mdisabled-test 13/13 全绿（key 提取 / toggle 互转 / scan 识别 / 旧式文件被忽略 / seedBuiltin 不重复播种 / findRuleFile / .mdisabled 不被 .md/.disabled 后缀误匹配）；normalizeDisabledNames 已从代码移除（Nyaser：手动清理就好，代码里不要留）
  补充：.md.disabled 方案（0.8.1）实测产生双重扩展名 `中文思考规则.md.md`（旧版 toggle 的 endsWith('.disabled') 误匹配 + replace 拼接），注入清单出现重复规则 → 淘汰，0.8.2 改 .mdisabled
  数据目录已手动清理：删 `中文思考规则.md.md`，`中文思考规则.disabled` → `中文思考规则.mdisabled`（禁用态）
- [ ] AC6 功能不回归（开关/展开/编辑/保存/删除/恢复默认/新建）
  Evidence: 待 0.8.1 装包后宿主实测
- [x] AC7 展开区保留文件名显示
  Evidence: fname 节点未动，保留（代码级）
- [x] AC8 禁用规则标题弱化（text-muted 灰）
  Evidence: CSS .r-title.off 已加，标题按 enabled 拼 off class（代码级）；视觉效果待装包目检

## 对抗式审查

（待装包实测后补）

## 待办

1. 0.8.1 已打包交付（17 文件，自校验通过，2026-08-13），待宿主安装
2. 装包后实测：DOM 结构（无状态文字/来源标签、off class、新文案）、功能回归（AC6）、禁用标题弱化视觉效果
3. 全绿后 Close：spec 归档、SPECS.md 更新
