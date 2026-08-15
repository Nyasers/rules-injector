#!/usr/bin/env python3
"""scripts/verify-zip.py — CI verify 用：校验发布 zip 真实性与完整性

背景：zip 必须由标准库 zipfile 生成（build-release.py），不可用 `tar -a -cf xxx.zip`
——GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip（无 PK 头/无 EOCD），安装端报
"end of central directory record signature not found"。本脚本在 CI verify 阶段兜底：
魔数 + EOCD + sha256 三重校验，缺一即 fail（删 release）。

用法:
  python3 scripts/verify-zip.py <zip> [<sha256-file>]
  （sha256 文件内容为 hex 摘要，大小写均可、含或不含换行均可；缺省跳过 sha256 对比）
"""

import hashlib
import sys
from pathlib import Path


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print("usage: python3 scripts/verify-zip.py <zip> [<sha256-file>]", file=sys.stderr)
        return 2

    zip_path = Path(args[0])
    sha_path = Path(args[1]) if len(args) > 1 else None

    buf = zip_path.read_bytes()

    # 1. 魔数：本地文件头签名 PK\x03\x04（zip 必以它开头；tar 伪 zip 是文件名/ustar 头）
    if len(buf) < 4 or buf[:4] != b"PK\x03\x04":
        print(f"::error::NOT a zip: {zip_path} (missing local file header magic PK\\x03\\x04)")
        return 1

    # 2. EOCD：end of central directory record 签名 PK\x05\x06，位于文件尾
    #    （记录体 22 字节 + 注释最长 65535 字节，从尾部 65557 字节窗口内搜索）
    tail = buf[-65557:] if len(buf) > 65557 else buf
    eocd_at = tail.rfind(b"PK\x05\x06")
    if eocd_at < 0:
        print(f"::error::NOT a zip: {zip_path} (missing end of central directory record)")
        return 1

    # 3. sha256 对比（发布资产自证：zip 摘要必须与 .sha256 文件一致，防上传损坏/串包）
    if sha_path is not None:
        expected = sha_path.read_text(encoding="utf-8").strip().lower()
        actual = hashlib.sha256(buf).hexdigest()
        if expected != actual:
            print(f"::error::sha256 mismatch for {zip_path}")
            print(f"  expected: {expected}")
            print(f"  actual:   {actual}")
            return 1
        print(f"sha256 OK: {actual}")

    print(f"zip OK: {zip_path} ({len(buf)} bytes, EOCD at -{len(tail) - eocd_at})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
