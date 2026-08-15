#!/usr/bin/env python3
"""rules-injector 发布打包脚本

用法:
  python scripts/build-release.py            # 打包 releases/rules-injector-<version>.zip + .sha256
  python scripts/build-release.py --force    # 覆盖已存在的同版本包

行为:
  1. 读 manifest.json 的 version
  2. 按 PACKAGE_FILES 固定清单打包（zip 内为 posix 相对路径、无外层目录）
  3. 自校验：包内文件清单与 version 与源一致
  4. 原子写：zip 与 .sha256 都先写临时文件再 rename 落位（中断不留半成品）
  5. 产出 .sha256：与 zip 同名成对（hex 大写摘要，对齐 dsh-hanako pack.mjs 惯例）
"""

import argparse
import hashlib
import json
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
RELEASES_DIR = ROOT / "releases"

# 发布包内容清单（0.8.0 起：RULES.md 废弃 → rules/ 种子目录 + lib/ 模块）
# 0.8.6：种子移除「规则管理规则.md」（拆分废弃，职责拆入开发文档与行为约束）
# 0.9.2：规则管理逻辑收敛进 skills/rules-manager/bin/cli.mjs（单一脚本，复用插件根 lib/rules-fs.js）；tools/ 仅注册工具（option-card + shared）
# 0.9.4：cli.mjs 上移至插件根与 lib 同层（import ./lib/rules-fs.js，消除跨层路径）；skills/rules-manager/ 仅剩 SKILL.md
PACKAGE_FILES = [
    "routes/card.js",
    "routes/sidebar.js",
    "tools/option-card.js",
    "index.js",
    "cli.mjs",
    "manifest.json",
    "README.md",
    "lib/db.js",
    "lib/migrate.js",
    "lib/rules-fs.js",
    "skills/rules-manager/SKILL.md",
    "rules/卡片收尾规则.md",
    "rules/中文思考规则.md",
    "rules/命令执行优先级.md",
    "rules/选项卡片规则.md",
    "rules/临时文件规范.md",
]


def sha256_hex(path: pathlib.Path) -> str:
    """流式 sha256，hex 大写（对齐 dsh-hanako pack.mjs 的 .toUpperCase()）"""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def main() -> int:
    ap = argparse.ArgumentParser(description="rules-injector 发布打包")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的同版本包")
    args = ap.parse_args()

    try:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"[error] manifest.json 读取失败: {e}")
        return 1

    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        print("[error] manifest.json 缺少有效 version 字段")
        return 1

    out = RELEASES_DIR / f"rules-injector-{version}.zip"
    sha_out = RELEASES_DIR / f"rules-injector-{version}.zip.sha256"

    # 先确认清单齐全再查目标冲突：报错信息更准确（缺失优先于已存在）
    missing = [f for f in PACKAGE_FILES if not (ROOT / f).exists()]
    if missing:
        print(f"[error] 清单文件缺失: {', '.join(missing)}")
        return 1

    if out.exists() and not args.force:
        print(f"[error] {out.name} 已存在，加 --force 覆盖（或先 bump 版本）")
        return 1

    RELEASES_DIR.mkdir(exist_ok=True)

    # 原子写：先写临时文件再 rename 落位，中断不留半成品（对齐 dsh-hanako pack.mjs
    # 的 .tmp 惯例）。临时文件点前缀开头，不会被 CI upload 的
    # releases/rules-injector-*.zip* 通配误收。
    tmp_zip = RELEASES_DIR / f".rules-injector-{version}.zip.tmp"
    tmp_sha = RELEASES_DIR / f".rules-injector-{version}.zip.sha256.tmp"

    try:
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED) as z:
            for f in PACKAGE_FILES:
                z.write(ROOT / f, arcname=f)  # arcname 强制 posix 相对路径

        # 自校验（针对临时产物，通过后才落位）：文件清单与 version 一致才认成功
        with zipfile.ZipFile(tmp_zip) as z:
            names = z.namelist()
            if names != PACKAGE_FILES:
                print("[error] 自校验失败: 包内文件清单与 PACKAGE_FILES 不符")
                return 1
            try:
                vm = json.loads(z.read("manifest.json"))["version"]
            except (json.JSONDecodeError, KeyError):
                print("[error] 自校验失败: 包内 manifest.json 无法读取")
                return 1
            if vm != version:
                print(f"[error] 自校验失败: 包内 manifest version={vm} != 源 {version}")
                return 1

        # sha256 摘要（hex 大写）：与 zip 同名成对产出，发布资产 zip + sha256 成对
        sha = sha256_hex(tmp_zip)
        tmp_sha.write_text(sha, encoding="ascii")

        # 双双原子落位（各自先写临时文件再 rename，中断不留半成品）
        tmp_zip.replace(out)
        tmp_sha.replace(sha_out)
    finally:
        # 失败路径清理临时文件，不残留半成品
        for p in (tmp_zip, tmp_sha):
            try:
                if p.exists():
                    p.unlink()
            except OSError:
                pass

    print(f"[ok] {out.name} 打包完成（{len(names)} 个文件，version={version}）")
    print(f"[ok] {sha_out.name}  SHA256 {sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
