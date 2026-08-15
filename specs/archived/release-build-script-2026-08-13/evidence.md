# Evidence — Release 打包脚本化

验证日期：2026-08-13
测试：`scripts/build-release.py` 实跑（项目根 workdir）

## Acceptance Checklist

- [x] 脚本读 `manifest.json` 的 version，输出 `releases/rules-injector-<version>.zip`
  Evidence: 实测 `python scripts/build-release.py --force` → `[ok] rules-injector-0.7.15.zip 打包完成（8 个文件，version=0.7.15）`，exit 0

- [x] 包内容 = 固定 8 文件清单，zip 内为 posix 相对路径、无外层目录
  Evidence: 脚本自校验 `names == PACKAGE_FILES` 通过；包内路径为 `routes/card.js` 等（arcname 强制 posix）

- [x] 同版本包已存在时拒绝打包（非 0 退出），`--force` 覆盖
  Evidence: 重复运行（无 --force）→ `[error] rules-injector-0.7.15.zip 已存在…`，repeat-exit=1；加 --force → 覆盖成功，force-exit=0

- [x] 清单中文件缺失时报错并列出缺失项（非 0 退出）
  Evidence: 临时移走 `tools/shared.js` → `[error] 清单文件缺失: tools/shared.js`，exit 1（随后恢复文件，restored=True）

- [x] 自校验：打包后重开 zip，文件数 = 8、包内 manifest version 与源一致，不一致报错
  Evidence: 自校验通过；另抽查 zip 内 8 文件 sha256 与源码逐一比对，全部 MATCH

- [x] 脚本输出可读的完成信息
  Evidence: 输出 `[ok] <文件名> 打包完成（8 个文件，version=0.7.15）`

## 对抗式审查

- [x] 实测暴露的真实缺陷已修复：missing 检查原在 exists 检查之后，清单缺失时被「已存在」报错短路、报错信息误导；已将 missing 检查提前（缺失优先于已存在）
- [x] 边界覆盖：manifest.json 损坏/缺 version → try/except + 类型检查（代码审查，返回 1 不产出半成品包）；`releases/` 不存在 → `mkdir(exist_ok=True)` 自动创建；Windows 路径分隔符 → arcname 强制 posix
- [x] Non-Goals 未越界：未做版本 bump（manifest/README 仍手工维护）；发布包清单与 0.7.14 结构一致
- [x] 可合并性：单文件脚本、零第三方依赖、4 个路径全实测（正常/覆盖/拒绝/缺失）
