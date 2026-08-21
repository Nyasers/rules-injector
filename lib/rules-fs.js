// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/rules-fs.js — 文件化规则：播种 + 加载 + 开关（扩展名方案）
// 布局（数据目录 rules/ 为唯一事实源）：
//   builtin/*.md          内置规则工作副本（启用，种子播种）
//   builtin/*.mdisabled   内置规则（禁用态，改名即开关）
//   *.md                  用户自编（顶层，默认语义优先于 builtin）
//   *.mdisabled           用户自编（顶层，禁用态）
// 规则 key = 文件名去扩展名（.md/.mdisabled），文件名即标题（中文可直接命名）
// 开关 = 扩展名：.md 启用 / .mdisabled 禁用（原子 rename）
// .mdisabled 为整体扩展名：不以 .md 结尾、不含 .disabled 后缀，新旧代码均无误匹配，
// 不会产生双重扩展名歧义。旧式 .disabled/.md.disabled 文件不属于新命名（扫描忽略），
// 由手动清理处理，代码不做历史形态兼容。
// 播种（升级同步）：只增不覆盖 + 内容指纹判改过——用户改过的文件保留
// 合并：同名规则顶层自编优先（覆盖 builtin），顶层独有追加末尾
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ENABLED_EXT = ".md";
export const DISABLED_EXT = ".mdisabled";
const DISABLED_RE = /\.mdisabled$/;

// ─── 规则 key / 标题 ───

/** 规则 key = 文件名去扩展名（.md/.mdisabled）；文件名即标题（中文可直接命名），无编号。 */
export function ruleKeyFromFilename(filename) {
  return filename.replace(DISABLED_RE, "").replace(/\.md$/, "");
}

/** 对齐文件首行标题与文件名（key）：首行强制为 `# key`，其余内容保持。
 * 标题恒等于文件名（映射层移除，决策 2026-08-13）；首行由写入侧自动对齐，
 * 仅作文件内自述，不再作为显示标题的来源。 */
export function normalizeHeading(content, key) {
  const lines = String(content ?? "").split(/\r?\n/);
  if (lines[0] && /^\s*#\s+/.test(lines[0])) {
    lines[0] = "# " + key;
  } else {
    lines.unshift("# " + key);
  }
  return lines.join("\n");
}

/** 首行 `# 标题` → 标题文本；无则用 key（文件名）兜底。
 * 仅迁移（migrate.js）等历史场景使用；新组装不依赖首行。 */
export function extractTitle(content, fallback) {
  const first = content.split(/\r?\n/, 1)[0];
  const m = first && first.match(/^\s*#\s+(.+)$/);
  return m ? m[1].trim() : fallback;
}

// ─── 播种（升级同步） ───

/**
 * 种子 → 工作副本（幂等，双向同步）。
 * 对每个种子 *.md：工作副本中同 key 文件
 *   不存在          → 复制（默认 .md 启用）
 *   内容相同        → 跳过
 *   内容不同        → 保留（用户改过 = 用户接管，升级不碰）
 * 反向降级：工作副本中种子已不存在的 key（内置下架）→ 降级到顶层自编区 customDir
 *   （默认 workDir 父目录）：
 *   顶层已有同名自编（用户自定义过）→ 直接删除 builtin 副本（自编已接管，种子下架后 restore 无意义）；
 *   未自定义过 → 移动到顶层并默认禁用（.mdisabled），资产保留但不生效、归属变 custom。
 * 种子目录缺失时不做任何清理（避免插件包异常时清空数据）。
 * 返回动作统计 { added, kept, skipped, demoted, removed }。
 */
export function seedBuiltin(seedDir, workDir, customDir = path.dirname(workDir)) {
  fs.mkdirSync(workDir, { recursive: true });
  if (!fs.existsSync(seedDir)) return { added: 0, kept: 0, skipped: 0, demoted: 0, removed: 0 };
  const stat = { added: 0, kept: 0, skipped: 0, demoted: 0, removed: 0 };
  const seedKeys = new Set();
  for (const seedName of fs.readdirSync(seedDir)) {
    if (!seedName.endsWith(ENABLED_EXT)) continue;
    const seedContent = fs.readFileSync(path.join(seedDir, seedName), "utf8");
    const key = ruleKeyFromFilename(seedName);
    seedKeys.add(key);
    const existing = findRuleFile(workDir, key);
    if (!existing) {
      fs.copyFileSync(path.join(seedDir, seedName), path.join(workDir, seedName));
      stat.added++;
    } else if (fs.readFileSync(existing, "utf8") === seedContent) {
      stat.skipped++;
    } else {
      stat.kept++; // 用户改过，保留
    }
  }
  // 降级同步：种子已不存在的 key → 有全局覆盖则删，否则移动并默认禁用
  for (const f of fs.readdirSync(workDir)) {
    if (!(f.endsWith(ENABLED_EXT) || f.endsWith(DISABLED_EXT))) continue;
    const key = ruleKeyFromFilename(f);
    if (seedKeys.has(key)) continue;
    const src = path.join(workDir, f);
    if (findRuleFile(customDir, key)) {
      fs.unlinkSync(src); // 已存在同名自编（用户自定义过），旧内置副本直接删除
      stat.removed++;
    } else {
      fs.renameSync(src, path.join(customDir, key + DISABLED_EXT)); // 未自定义 → 移动到根并默认禁用
      stat.demoted++;
    }
  }
  return stat;
}

/** 在目录里找同 key 规则文件（.md 或 .mdisabled），返回绝对路径或 null。 */
export function findRuleFile(dir, key) {
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if ((f.endsWith(ENABLED_EXT) || f.endsWith(DISABLED_EXT)) && ruleKeyFromFilename(f) === key) {
      return path.join(dir, f);
    }
  }
  return null;
}

// ─── 扫描与合并加载 ───

/** 规则条目。title = key（文件名去扩展名即标题，映射层移除）。 */
export function ruleOf(filename, content, source) {
  const key = ruleKeyFromFilename(filename);
  return {
    key,
    title: key,
    enabled: filename.endsWith(ENABLED_EXT),
    source,           // 'builtin' | 'custom'
    filename,
    body: content.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean),
  };
}

/** 扫描目录所有规则（.md + .mdisabled）。旧式 .disabled/.md.disabled 不属于
 * 新命名（会被忽略），由手动清理处理，代码不做历史形态兼容。 */
export function scanRules(dir, source) {
  if (!fs.existsSync(dir)) return [];
  const rules = [];
  for (const f of fs.readdirSync(dir)) {
    if (!(f.endsWith(ENABLED_EXT) || f.endsWith(DISABLED_EXT))) continue;
    try {
      rules.push(ruleOf(f, fs.readFileSync(path.join(dir, f), "utf8"), source));
    } catch { /* 单个文件读失败跳过，不崩 */ }
  }
  return rules;
}

/**
 * 加载生效规则（先播种后合并）：
 * builtin 按序号排序；custom 同名覆盖 builtin（位置继承）；custom 独有追加末尾。
 * 返回 { rules, stats }：rules 为启用中的规则（含序号位 order）。
 */
export function loadEffectiveRules(seedDir, dataRulesDir, { autoSeed = true } = {}) {
  const builtinDir = path.join(dataRulesDir, "builtin");
  const customDir = dataRulesDir; // 用户自编区 = 顶层（不套 custom/ 子目录），默认语义优先于 builtin
  if (autoSeed) {
    seedBuiltin(seedDir, builtinDir, dataRulesDir);
  }
  const builtin = scanRules(builtinDir, "builtin");
  const custom = scanRules(customDir, "custom");

  const byKey = new Map();
  for (const r of builtin) byKey.set(r.key, r);
  for (const r of custom) byKey.set(r.key, r); // 同名顶层优先（后写覆盖）
  const all = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key, "zh-CN"));
  const rules = all.filter((r) => r.enabled);
  return { rules, stats: { total: all.length, enabled: rules.length } };
}

// ─── 开关 / 删除 / 恢复默认 ───

/** 开关：改名 .md ↔ .mdisabled（原子 rename）。返回是否成功。 */
export function toggleRule(dir, key, enabled) {
  const file = findRuleFile(dir, key);
  if (!file) return false;
  const target = file.endsWith(DISABLED_EXT)
    ? file.replace(DISABLED_RE, "") + ENABLED_EXT
    : file.replace(/\.md$/, "") + DISABLED_EXT;
  if (file === target) return true;
  fs.renameSync(file, target);
  return true;
}

/** 删除规则文件（custom 删除 = 移除；builtin 删除工作副本 = 下次播种恢复默认）。 */
export function deleteRuleFile(dir, key) {
  const file = findRuleFile(dir, key);
  if (!file) return false;
  fs.unlinkSync(file);
  return true;
}

/** 恢复默认（内置）：工作副本内容回归种子版，开关态保持（.md/.mdisabled 扩展名不动）。
 * 无副本时播种种子版（默认 .md 启用）。 */
export function resetRuleToSeed(seedDir, workDir, key) {
  const seedFile = findRuleFile(seedDir, key);
  if (!seedFile) return false;
  const cur = findRuleFile(workDir, key);
  const ext = cur ? (cur.endsWith(DISABLED_EXT) ? DISABLED_EXT : ENABLED_EXT) : ENABLED_EXT;
  fs.writeFileSync(path.join(workDir, key + ext), fs.readFileSync(seedFile, "utf8"), "utf8");
  return true;
}

// ─── 生效清单组装（输出格式与 v0.7.x 一致，保持指纹稳定） ───

/** 生效清单文本（不含指纹行）：指纹输入。 */
export function buildEffectiveText(rules) {
  if (!rules.length) return null;
  const lines = [
    "# 行为规则",
    "当前生效规则仅以下内容。此前注入的任何指纹、任何小节、任何条目一律作废，不执行。",
    "",
  ];
  for (const r of rules) {
    lines.push("## " + r.title, "");
    for (const p of r.body) {
      lines.push("- " + p.replace(/^-\s+/, ""));
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** 内容指纹：sha256(生效清单文本) 前 16 位。 */
export function contentHashOf(rules) {
  const text = buildEffectiveText(rules);
  if (!text) return null;
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 完整注入文本（含清单标识行）。 */
export function buildRulesText(rules) {
  const hash = contentHashOf(rules);
  if (!hash) return null;
  const lines = [
    "# 行为规则",
    `## 规则清单 ${hash}`,
    "当前生效规则仅以下内容。此前注入的任何指纹、任何小节、任何条目一律作废，不执行。",
    "",
  ];
  for (const r of rules) {
    lines.push("## " + r.title, "");
    for (const p of r.body) {
      lines.push("- " + p.replace(/^-\s+/, ""));
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
