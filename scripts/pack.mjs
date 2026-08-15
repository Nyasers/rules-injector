// scripts/pack.mjs — rules-injector 发布打包（rspack bundle + archiver，对齐姊妹插件
// dsh-hanako scripts/pack.mjs 的两步结构：build（rspack）→ 静态项复制 → 铺平 → zip → SHA256）
// 版本单一事实源 = manifest.json version（发版只 bump manifest.json；package.json 的
// version 仅 npm 语义占位、不参与版本判断）——与 dsh-hanako（package.json 管版本）相反。
// 交付物 = 代码 bundle（dist/，lib/ 已内联进 bundle）+ manifest + README + skills + rules，
// 零依赖（package.json / package-lock.json / node_modules 一律不进包，构建工具只作声明）。
// 用法：
//   node scripts/pack.mjs            # 打包 releases/rules-injector-<version>.zip + .sha256
//   node scripts/pack.mjs --force    # 覆盖已存在的同版本包
// 产出：releases/rules-injector-<version>.zip + .sha256（发布产物）；铺平目录 _tmp/pkg/（zip
// 中间原料，可清空）。zip 内 posix 相对路径、无外层目录（保持既有形态），打包后自校验
// 包内文件清单与 version 一致才认成功；原子写（tmp + rename、点前缀临时文件）。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { ZipArchive } from "archiver";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES_DIR = join(ROOT, "releases");

// 交付物固定清单（build 产物 + 静态项；0.9.4 起 rspack bundle 构建：lib/ 内联进各入口
// bundle 不再单独交付，skills/rules-manager/ 仅剩 SKILL.md，rules/ 5 个种子，共 13 项）
// 注意：package.json / package-lock.json / node_modules 一律不进包——构建工具只作声明，
// 插件交付物保持零依赖，交付清单由本固定清单唯一决定。
const PACKAGE_FILES = [
  "index.js",
  "cli.mjs",
  "routes/card.js",
  "routes/sidebar.js",
  "tools/option-card.js",
  "manifest.json",
  "README.md",
  "skills/rules-manager/SKILL.md",
  "rules/卡片收尾规则.md",
  "rules/中文思考规则.md",
  "rules/命令执行优先级.md",
  "rules/选项卡片规则.md",
  "rules/临时文件规范.md",
];

// build 产物之外的静态项（复制进 dist 交付目录；dist 即完整交付目录）
const STATIC_ITEMS = ["manifest.json", "README.md", "skills", "rules"];

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

// fail：打印错误、置非零退出码并抛异常（经 finally 清理临时文件后由顶层 catch 收口）
function fail(msg) {
  console.error(`[error] ${msg}`);
  process.exitCode = 1;
  const e = new Error(msg);
  e.isFail = true;
  throw e;
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  } catch (e) {
    fail(`manifest.json 读取失败: ${e.message}`);
  }
  const version = manifest.version;
  if (typeof version !== "string" || !version) fail("manifest.json 缺少有效 version 字段");

  const out = join(RELEASES_DIR, `rules-injector-${version}.zip`);
  const shaOut = `${out}.sha256`;
  const force = process.argv.includes("--force");
  if (existsSync(out) && !force) fail(`${out} 已存在，加 --force 覆盖（或先 bump 版本）`);

  // 1. 构建 bundle（rspack，产物 dist/）
  console.log("[pack] build...");
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, RSPACK_ENV: process.env.RSPACK_ENV || "" },
  });

  // 2. 静态项复制进 dist —— dist 即完整交付目录（bundle + manifest + README + skills +
  //    rules），包根结构 = 标准插件形态（根 index.js + cli.mjs + routes/ + tools/，
  //    无 dist 这层目录）
  const distDir = join(ROOT, "dist");
  for (const item of STATIC_ITEMS) {
    const src = join(ROOT, item);
    if (!existsSync(src)) fail(`静态项不存在：${item}`);
    cpSync(src, join(distDir, item), { recursive: true });
  }
  const missing = PACKAGE_FILES.filter((f) => !existsSync(join(distDir, f)));
  if (missing.length > 0) fail(`清单文件缺失: ${missing.join(", ")}`);

  // 3. dist → 铺平目录（zip 中间原料，放 _tmp 可随时清空）
  const pkgDir = join(ROOT, "_tmp", "pkg", `rules-injector-v${version}`);
  rmSync(pkgDir, { recursive: true, force: true });
  cpSync(distDir, pkgDir, { recursive: true });

  // 4. zip + SHA256（发布产物归档 releases/，与项目群惯例一致）
  //    archiver 纯 Node 跨平台 zip（对齐 dsh-hanako）：不用 tar -a -cf——GNU tar（Linux）
  //    不认 .zip 后缀会静默产出 tar 伪 zip（CI ubuntu 踩坑 2026-08-14，安装端报
  //    end of central directory record signature not found）
  mkdirSync(RELEASES_DIR, { recursive: true });
  const tmpZip = join(RELEASES_DIR, `.rules-injector-${version}.zip.tmp`); // 点前缀临时文件
  const tmpSha = `${tmpZip}.sha256.tmp`;

  try {
    const output = createWriteStream(tmpZip);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const done = new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(output);
    // zip 根 = 交付物根（无外层目录，zip 内 posix 相对路径，保持既有形态）；按固定清单
    // 逐文件归档（archive.directory() 会额外写入零长度目录条目，清单自校验会失败）
    for (const f of PACKAGE_FILES) {
      archive.file(join(pkgDir, f), { name: f }); // name 强制 posix 相对路径
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
    }
    // archiver 按条目名排序归档（确定性、跨平台稳定），清单比对按集合一致判断、
    // 不依赖条目顺序
    if (names.length !== PACKAGE_FILES.length || [...names].sort().join("\0") !== [...PACKAGE_FILES].sort().join("\0")) {
      fail("自校验失败: 包内文件清单与 PACKAGE_FILES 不符");
    }
    let vm;
    try {
      vm = JSON.parse(readZipEntry(buf, "manifest.json").toString("utf8")).version;
    } catch (e) {
      fail(`自校验失败: 包内 manifest.json 无法读取（${e.message}）`);
    }
    if (vm !== version) fail(`自校验失败: 包内 manifest version=${vm} != 源 ${version}`);

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

try {
  await main();
} catch (e) {
  if (!e?.isFail) {
    console.error(`[error] ${e?.stack ?? e}`);
    process.exitCode = 1;
  }
}
