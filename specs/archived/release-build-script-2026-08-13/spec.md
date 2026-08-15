# Release 打包脚本化

## Goal

新增 `scripts/build-release.py`：一键打包发布包到 `releases/rules-injector-<version>.zip`，替代手工 `python -c` 打包，带自校验。

## Non-Goals

- 不做版本 bump（manifest/README 版本号仍手工维护）
- 不改发布包文件清单（与 0.7.14 包内部结构保持一致：8 个文件、无外层目录）

## Acceptance Criteria

- [ ] 脚本读 `manifest.json` 的 version，输出 `releases/rules-injector-<version>.zip`
- [ ] 包内容 = 固定 8 文件清单，zip 内为 posix 相对路径（`routes/card.js` 等）、无外层目录
- [ ] 同版本包已存在时拒绝打包（非 0 退出），`--force` 覆盖
- [ ] 清单中文件缺失时报错并列出缺失项（非 0 退出）
- [ ] 自校验：打包后重开 zip，文件数 = 8、包内 manifest version 与源一致，不一致报错
- [ ] 脚本输出可读的完成信息（文件名、文件数、version）

## Boundary Conditions

- `manifest.json` 损坏 / JSON 解析失败 → 脚本报错退出，不产出半成品包
- `releases/` 目录不存在 → 自动创建
- 包内路径分隔符：Windows 下 pathlib 为反斜杠，必须用 arcname 强制 posix 风格

## Constraints

- Python 3 标准库（zipfile / json / pathlib / argparse），零第三方依赖
- 脚本位于 `scripts/`，不进发布包清单
