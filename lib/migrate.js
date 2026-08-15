// lib/migrate.js — 一次性迁移：rules-state.json + injected-sessions.jsonl → 文件化 + data.db
// 触发：插件 onload 检测到旧文件（rules-state.json / injected-sessions.jsonl）存在时自动执行一次。
// 动作：
//   1. rules-state.json：$global.enabled → meta global_enabled；各小节 enabled:false → 对应种子 .disabled；
//      custom 覆盖 → 生成顶层 <key>.md；原文件改名 .bak
//   2. injected-sessions.jsonl → data.db injected_sessions 表（逐行导入）；原文件改名 .bak
//   3. seedBuiltin 播种内置种子（幂等，双向同步：新增补充 + 下架清理）
// 幂等：旧文件不存在时直接跳过（迁移后 .bak 存在，不重复执行）。
import { StateDb } from "./db.js";
import { seedBuiltin, extractTitle, findRuleFile } from "./rules-fs.js";
import fs from "node:fs";
import path from "node:path";

/** 标题 → 规则 key 映射（从种子扫描）。 */
export function buildTitleToKey(seedDir) {
  const map = new Map();
  if (!fs.existsSync(seedDir)) return map;
  for (const f of fs.readdirSync(seedDir)) {
    if (!f.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(seedDir, f), "utf8");
    const key = f.replace(/\.md$/, ""); // 文件名即 key（标题）
    map.set(extractTitle(content, key), key);
  }
  return map;
}

/**
 * 执行迁移（幂等）。返回 { migrated: boolean, summary }；无旧文件返回 migrated=false。
 */
export function runMigration(dataDir, seedDir) {
  const statePath = path.join(dataDir, "rules-state.json");
  const jsonlPath = path.join(dataDir, "injected-sessions.jsonl");
  const hasOld = fs.existsSync(statePath) || fs.existsSync(jsonlPath);
  if (!hasOld) return { migrated: false, summary: null };

  const titleToKey = buildTitleToKey(seedDir);
  let globalDisabled = false;
  const disabledKeys = [];
  const customOverrides = [];
  if (fs.existsSync(statePath)) {
    let state;
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { state = {}; }
    if (state.$global && state.$global.enabled === false) globalDisabled = true;
    for (const [title, st] of Object.entries(state)) {
      if (title === "$global" || !st || typeof st !== "object") continue;
      const key = titleToKey.get(title);
      if (!key) continue;
      if (st.enabled === false) disabledKeys.push(key);
      if (typeof st.custom === "string" && st.custom.trim()) {
        customOverrides.push({ key, content: st.custom.trim() });
      }
    }
  }

  const db = new StateDb(dataDir);
  db.init();
  db.setMeta("global_enabled", globalDisabled ? "0" : "1");

  const rulesDir = path.join(dataDir, "rules");
  const builtinDir = path.join(rulesDir, "builtin");
  const seedStat = seedBuiltin(seedDir, builtinDir, rulesDir);
  let disabledApplied = 0;
  for (const key of disabledKeys) {
    const file = findRuleFile(builtinDir, key);
    if (!file || file.endsWith(".disabled")) continue;
    fs.renameSync(file, file.replace(/\.md$/, ".disabled"));
    disabledApplied++;
  }
  let customWritten = 0;
  for (const { key, content } of customOverrides) {
    fs.writeFileSync(path.join(rulesDir, key + ".md"), content + "\n", "utf8"); // 顶层自编区
    customWritten++;
  }

  let imported = 0;
  if (fs.existsSync(jsonlPath)) {
    const lines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      let sid = null, hash = null;
      if (typeof rec?.sessionId === "string" && typeof rec?.hash === "string") { sid = rec.sessionId; hash = rec.hash; }
      else {
        const keys = Object.keys(rec);
        if (keys.length === 1 && typeof rec[keys[0]] === "string") { sid = keys[0]; hash = rec[keys[0]]; }
      }
      if (sid && hash) { db.setFingerprint(sid, hash); imported++; }
    }
  }
  db.close();

  if (fs.existsSync(statePath)) fs.renameSync(statePath, statePath + ".bak");
  if (fs.existsSync(jsonlPath)) fs.renameSync(jsonlPath, jsonlPath + ".bak");

  return {
    migrated: true,
    summary: {
      seed: seedStat, disabledApplied, customWritten, imported,
      globalEnabled: !globalDisabled,
    },
  };
}
