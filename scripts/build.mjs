// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/build.mjs — rules-injector rspack 构建（对齐姊妹插件 dsh-hanako scripts/build.mjs）
// 产物：dist/ 下 5 个入口 ESM bundle（压缩），插件本体零依赖打包（node: 内建全 external，
// lib/ 模块被各入口 import 内联进 bundle，交付物不再单独含 lib/ 目录）。
// 入口 = 宿主/用户加载的全部入口：
//   index（default class 生命周期）、routes/card、routes/sidebar（default 路由函数）、
//   tools/option-card（工具具名导出 name/description/parameters/execute）、
//   cli（无导出 CLI，顶层执行，输出固定为 cli.mjs）
// 用法：
//   node scripts/build.mjs                       # 本地已装 @rspack/core 时
//   RSPACK_ENV=<构建环境目录> node scripts/build.mjs   # 用独立构建环境（可选，本项目不用）
// 注意：@rspack/core 不声明为插件运行时依赖（交付物零依赖，构建工具只作 devDependencies
// 声明），构建期 npm ci 即装 @rspack/core + archiver 两个包，无 RSPACK_ENV 式独立构建环境。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// rspack 解析：RSPACK_ENV 指向构建环境（可选），否则本地 node_modules
// rspack 2.x 为 ESM-only（type:module，exports 无 require 入口），require() 加载报
// MODULE_NOT_FOUND；改动态 import，且目录 URL 不被 ESM 支持（ERR_UNSUPPORTED_DIR_IMPORT），
// 需按包 exports/main 解析到实际入口文件——CJS 旧版与 ESM 新版均兼容。
function resolveRspackEntry(coreDir) {
  const pkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"));
  const dot = pkg.exports?.["."];
  let entry = null;
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") entry = dot.default ?? dot.import ?? dot.require;
  if (!entry) entry = pkg.main ?? "dist/index.js";
  return join(coreDir, entry);
}
let rspackPkg;
const envDir = process.env.RSPACK_ENV;
if (envDir) {
  rspackPkg = await import(pathToFileURL(resolveRspackEntry(join(envDir, "node_modules", "@rspack", "core"))).href);
} else {
  rspackPkg = await import("@rspack/core");
}
// 具名导出兜底：ESM 包直接取 rspack；CJS 包经 import() interop 后 default 内取
const rspack = rspackPkg.rspack ?? rspackPkg.default?.rspack;

// 入口：宿主按 manifest 路径加载的 index/route/tool + 插件根 cli.mjs（skill 调用）
// cli.mjs 输出名固定为 cli.mjs（node cli.mjs <action> 直接执行，skill 调用路径不断），
// 其余 [name].js 保持子目录结构（routes/、tools/）
const ENTRY_SPECS = [
  ["index", "index.js"],
  ["routes/card", "routes/card.js"],
  ["routes/sidebar", "routes/sidebar.js"],
  ["tools/option-card", "tools/option-card.js"],
  ["cli", "cli.mjs"],
];
const entries = Object.fromEntries(ENTRY_SPECS.map(([name, file]) => [name, join(ROOT, file)]));

// 构建前收集各入口源码的 file:// URL —— 构建后产物里出现的这些字面量要替换回
// import.meta.url（rspack 会把 import.meta.url 静态化为源码绝对路径，分发到对方机器
// 后路径失效；替换后 bundle 保留运行时语义）。
const staticUrlToMeta = new Map(
  ENTRY_SPECS.map(([, file]) => [pathToFileURL(join(ROOT, file)).href, file]),
);

const compiler = rspack({
  name: "rules-injector",
  mode: "production",
  target: "node",
  entry: entries,
  output: {
    path: join(ROOT, "dist"),
    filename: "[name].js",
    module: true,
    clean: true,
    // library type module：把入口具名导出真正 emit 为 ESM export（宿主动态 import 拿
    // index default class / routes default fn / tools 具名导出；无 library 时 entry 导出
    // 不会出现在文件顶层）
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  // usedExports: false + sideEffects: false —— 关闭导出级 tree-shaking：
  // 普通 ESM entry 的导出没有外部消费者，默认会被整体摇成空壳（工具文件顶层是
  // 纯声明+函数，无副作用）；插件本体全部保留（体积可忽略）。
  optimization: { minimize: true, usedExports: false, sideEffects: false },
  devtool: false,
  node: false,
});

await new Promise((resolvePromise, reject) => {
  compiler.run((err, stats) => {
    compiler.close(() => {});
    if (err) return reject(err);
    if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
    console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
    resolvePromise();
  });
});

// cli 入口输出为 dist/cli.js（filename [name].js），交付要求根路径 cli.mjs
// （node cli.mjs <action>，skill 调用路径不断）→ 构建后改名
const cliJs = join(ROOT, "dist", "cli.js");
const cliMjs = join(ROOT, "dist", "cli.mjs");
if (!existsSync(cliJs)) throw new Error(`构建产物缺失 dist/cli.js（entry "cli" 未输出）`);
renameSync(cliJs, cliMjs);
console.log("renamed dist/cli.js -> dist/cli.mjs");

// 构建后处理：静态化路径字面量 → import.meta.url（运行时语义）
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js") || p.endsWith(".mjs")) {
      let code = readFileSync(p, "utf8");
      let changed = false;
      for (const [url, entryName] of staticUrlToMeta) {
        // 替换带引号的完整字面量（压缩产物里是 "file:///..." 或 'file:///...'）→ 无引号表达式
        for (const quoted of [`"${url}"`, `'${url}'`]) {
          if (code.includes(quoted)) {
            code = code.split(quoted).join("import.meta.url");
            changed = true;
            console.log(`patched import.meta.url -> ${entryName}`);
          }
        }
      }
      if (changed) writeFileSync(p, code, "utf8");
    }
  }
}
walk(join(ROOT, "dist"));

console.log("build done ->", join(ROOT, "dist"));
