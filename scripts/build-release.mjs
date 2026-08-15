#!/usr/bin/env node
// scripts/build-release.mjs — rules-injector 发布打包（Node 版，替代 build-release.py）
//
// 用法:
//   node scripts/build-release.mjs            # 打包 releases/rules-injector-<version>.zip + .sha256
//   node scripts/build-release.mjs --force    # 覆盖已存在的同版本包
//
// 行为:
//   1. 读 manifest.json 的 version（版本单一事实源：发版只 bump manifest.json，
//      package.json 的 version 仅 npm 语义占位、不参与版本判断）
//   2. 按 PACKAGE_FILES 固定清单打包（archiver 纯 Node zip，zip 内 posix 相对路径、
//      无外层目录；不用系统 tar——GNU tar 不认 .zip 后缀会静默产出 tar 伪 zip）
//   3. 自校验：重开 zip 核对 namelist 与清单一致、包内 manifest version 与源一致
//   4. 原子写：zip 与 .sha256 都先写临时文件再 rename 落位（中断不留半成品）
//   5. 产出 .sha256：与 zip 同名成对（hex 大写摘要、无尾换行，对齐 dsh-hanako pack.mjs 惯例）
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { ZipArchive } from "archiver";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES_DIR = join(ROOT, "releases");

// 发布包内容清单（0.8.0 起：RULES.md 废弃 → rules/ 种子目录 + lib/ 模块）
// 0.8.6：种子移除「规则管理规则.md」（拆分废弃，职责拆入开发文档与行为约束）
// 0.9.2：规则管理逻辑收敛进 skills/rules-manager/bin/cli.mjs（单一脚本，复用插件根 lib/rules-fs.js）；tools/ 仅注册工具（option-card + shared）
// 0.9.4：cli.mjs 上移至插件根与 lib 同层（import ./lib/rules-fs.js，消除跨层路径）；skills/rules-manager/ 仅剩 SKILL.md
// 注意：package.json / package-lock.json / node_modules 一律不进包——构建工具只作声明，
// 插件交付物保持零依赖，交付清单由本固定清单唯一决定。
const PACKAGE_FILES = [
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
];

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

// 标准库 zip 读取（自校验用）：仅依赖 ZIP 格式本身，无需第三方解压库
function findEocd(buf) {
  const tail = buf.subarray(Math.max(0, buf.length - 65557)); // EOCD 在尾部 65557 字节窗口内
  const at = tail.lastIndexOf(EOCD_SIG);
  return at < 0 ? null : { buf: tail, at };
}

function listZipEntries(buf) {
  const eocd = findEocd(buf);
  if (!eocd) throw new Error("zip 缺少 EOCD");
  const total = eocd.buf.readUInt16LE(eocd.at + 10);
  const cdOffset = eocd.buf.readUInt32LE(eocd.at + 16);
  const names = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("central directory 头签名错误");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function readZipEntry(buf, entryName) {
  const eocd = findEocd(buf);
  const total = eocd.buf.readUInt16LE(eocd.at + 10);
  const cdOffset = eocd.buf.readUInt32LE(eocd.at + 16);
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name === entryName) {
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const localOffset = buf.readUInt32LE(p + 42);
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(
        localOffset + 30 + lNameLen + lExtraLen,
        localOffset + 30 + lNameLen + lExtraLen + compSize,
      );
      if (method === 0) return data; // stored
      if (method === 8) return inflateRawSync(data); // deflate
      throw new Error(`不支持的压缩方式 ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 中找不到 ${entryName}`);
}

function fail(msg) {
  console.error(`[error] ${msg}`);
  process.exitCode = 1;
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  } catch (e) {
    fail(`manifest.json 读取失败: ${e.message}`);
    return;
  }
  const version = manifest.version;
  if (typeof version !== "string" || !version) {
    fail("manifest.json 缺少有效 version 字段");
    return;
  }

  const out = join(RELEASES_DIR, `rules-injector-${version}.zip`);
  const shaOut = `${out}.sha256`;

  // 先确认清单齐全再查目标冲突：报错信息更准确（缺失优先于已存在）
  const missing = PACKAGE_FILES.filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length > 0) {
    fail(`清单文件缺失: ${missing.join(", ")}`);
    return;
  }

  const force = process.argv.includes("--force");
  if (existsSync(out) && !force) {
    fail(`${out} 已存在，加 --force 覆盖（或先 bump 版本）`);
    return;
  }

  mkdirSync(RELEASES_DIR, { recursive: true });

  // 原子写：先写临时文件再 rename 落位，中断不留半成品（对齐 dsh-hanako pack.mjs
  // 的 .tmp 惯例）。临时文件点前缀开头，不会被 CI upload 的
  // releases/rules-injector-*.zip* 通配误收。
  const tmpZip = join(RELEASES_DIR, `.rules-injector-${version}.zip.tmp`);
  const tmpSha = `${tmpZip}.sha256.tmp`;

  try {
    // archiver 纯 Node zip：跨平台真 zip（含 PK 头/EOCD），不用 tar -a -cf——
    // GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip，安装端报
    // "end of central directory record signature not found"
    const output = createWriteStream(tmpZip);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const done = new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(output);
    for (const f of PACKAGE_FILES) {
      archive.file(join(ROOT, f), { name: f }); // name 强制 posix 相对路径、无外层目录
    }
    await archive.finalize();
    await done;

    // 自校验（针对临时产物，通过后才落位）：文件清单与 version 一致才认成功
    const buf = readFileSync(tmpZip);
    let names;
    try {
      names = listZipEntries(buf);
    } catch (e) {
      fail(`自校验失败: ${e.message}`);
      return;
    }
    // archiver 按条目名排序归档（确定性、跨平台稳定），清单比对按集合一致判断、
    // 不依赖条目顺序（Python zipfile 版保留插入序，Node 版以确定性排序替代）
    if (names.length !== PACKAGE_FILES.length || [...names].sort().join("\0") !== [...PACKAGE_FILES].sort().join("\0")) {
      fail("自校验失败: 包内文件清单与 PACKAGE_FILES 不符");
      return;
    }
    let vm;
    try {
      vm = JSON.parse(readZipEntry(buf, "manifest.json").toString("utf8")).version;
    } catch (e) {
      fail(`自校验失败: 包内 manifest.json 无法读取（${e.message}）`);
      return;
    }
    if (vm !== version) {
      fail(`自校验失败: 包内 manifest version=${vm} != 源 ${version}`);
      return;
    }

    // sha256 摘要（hex 大写、无尾换行）：与 zip 同名成对产出，发布资产 zip + sha256 成对
    const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
    writeFileSync(tmpSha, sha, "utf8");

    // 双双原子落位（各自先写临时文件再 rename，中断不留半成品）
    renameSync(tmpZip, out);
    renameSync(tmpSha, shaOut);

    console.log(`[ok] rules-injector-${version}.zip 打包完成（${names.length} 个文件，version=${version}）`);
    console.log(`[ok] rules-injector-${version}.zip.sha256  SHA256 ${sha}`);
  } finally {
    // 失败路径清理临时文件，不残留半成品
    for (const p of [tmpZip, tmpSha]) {
      try {
        rmSync(p, { force: true });
      } catch {
        // 忽略清理失败
      }
    }
  }
}

await main();
