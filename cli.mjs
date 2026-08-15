// cli.mjs — rules-manager CLI（插件根，与 lib/ 同层：规则管理逻辑收敛于此）
// 文件系统层复用同层 lib/rules-fs.js（单一事实源，随插件包分发）。
// 用法：node cli.mjs <action> [--name N] [--content "..."|--content-file F] [--enabled true|false] [--dataDir P] [--seedDir P]
// action: list | get | create | update | delete | toggle | restore
// dataDir 解析：--dataDir > 环境变量 RULES_INJECTOR_DATA_DIR > 平台默认插件数据目录
// seedDir  解析：--seedDir  > 环境变量 RULES_INJECTOR_SEED_DIR  > 平台默认插件种子目录
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  seedBuiltin, scanRules, findRuleFile, toggleRule, deleteRuleFile, resetRuleToSeed, normalizeHeading, ENABLED_EXT, DISABLED_EXT,
} from "./lib/rules-fs.js";

const NAME_RE = /^[^\\\/:*?"<>|]{1,48}$/;
const DEFAULT_DATA_DIR = () => path.join(os.homedir(), ".hanako", "plugin-data", "rules-injector");
const DEFAULT_SEED_DIR = () => path.join(os.homedir(), ".hanako", "plugins", "rules-injector", "rules");

function parseArgs(argv) {
  const args = { action: null, name: null, content: null, contentFile: null, enabled: null, dataDir: null, seedDir: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    switch (a) {
      case "--name": case "-n": args.name = next(); break;
      case "--content": case "-c": args.content = next(); break;
      case "--content-file": case "-f": args.contentFile = next(); break;
      case "--enabled": case "-e": {
        const v = next();
        args.enabled = v === "true" ? true : v === "false" ? false : null;
        break;
      }
      case "--dataDir": case "-d": args.dataDir = next(); break;
      case "--seedDir": case "-s": args.seedDir = next(); break;
      case "--help": case "-h": args.help = true; break;
      default:
        if (a.startsWith("-")) { console.error(`未知参数: ${a}`); process.exit(2); }
        positional.push(a);
    }
  }
  args.action = args.action ?? positional[0] ?? null;
  return args;
}

// ─── 规则管理逻辑（原 tools/manage_rules.js，收敛于此） ───

function dirs(dataDir) {
  const rulesDir = path.join(dataDir, "rules");
  return { builtin: path.join(rulesDir, "builtin"), custom: rulesDir }; // 用户自编区 = 顶层
}

function findAny(d, name) {
  return findRuleFile(d.builtin, name) || findRuleFile(d.custom, name);
}

function listRules(dataDir, seedDir) {
  const d = dirs(dataDir);
  seedBuiltin(seedDir, d.builtin, d.custom); // 确保播种
  const all = [...scanRules(d.builtin, "内置"), ...scanRules(d.custom, "自编")];
  const customKeys = new Set(scanRules(d.custom, "自编").map((r) => r.key));
  const merged = new Map();
  for (const r of all) merged.set(r.key, r); // custom 后写覆盖 builtin
  const lines = [...merged.values()]
    .sort((a, b) => a.key.localeCompare(b.key, "zh-CN"))
    .map((r) => {
      const src = r.source === "自编" ? "自编" : "内置";
      const ov = r.source !== "自编" && customKeys.has(r.key) ? "（被自编覆盖）" : "";
      return `${r.enabled ? "[启用]" : "[禁用]"} ${r.key} [${src}]${ov} — ${r.filename}`;
    });
  return lines.join("\n") || "（无规则）";
}

function getRule(dataDir, name) {
  const file = findAny(dirs(dataDir), name);
  if (!file) return null;
  return fs.readFileSync(file, "utf8");
}

function run(input, dataDir, seedDir) {
  const action = input?.action;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const content = typeof input?.content === "string" ? input.content : "";
  const enabled = input?.enabled === true ? true : input?.enabled === false ? false : null;
  const d = dirs(dataDir);

  if (action === "list") {
    return listRules(dataDir, seedDir);
  }

  if (!name) return "需要 name 参数";
  if (!NAME_RE.test(name)) return `规则名非法：「${name}」（不含路径分隔符，≤48 字符）`;

  switch (action) {
    case "get": {
      const text = getRule(dataDir, name);
      return text === null ? `规则「${name}」不存在` : `【${name}】\n${text}`;
    }
    case "create": {
      if (!content.trim()) return "content 不能为空";
      fs.mkdirSync(d.custom, { recursive: true });
      const file = path.join(d.custom, name + ENABLED_EXT);
      if (fs.existsSync(file)) return `同名规则「${name}」已存在（可 update）`;
      fs.writeFileSync(file, normalizeHeading(content, name).trimEnd() + "\n", "utf8");
      return `已创建自定义规则「${name}」（.md，默认启用）`;
    }
    case "update": {
      if (!content.trim()) return "content 不能为空";
      const cFile = findRuleFile(d.custom, name);
      const bFile = findRuleFile(d.builtin, name);
      if (!cFile && !bFile) return `规则「${name}」不存在`;
      if (cFile) {
        fs.writeFileSync(cFile, normalizeHeading(content, name).trimEnd() + "\n", "utf8");
        return `已更新自定义规则「${name}」（保留当前开关状态）`;
      }
      // 内置规则自定义 = 建同名自编覆盖（开关态跟随内置），覆盖内置生效
      fs.mkdirSync(d.custom, { recursive: true });
      const ext = bFile.endsWith(DISABLED_EXT) ? DISABLED_EXT : ENABLED_EXT;
      fs.writeFileSync(path.join(d.custom, name + ext), normalizeHeading(content, name).trimEnd() + "\n", "utf8");
      return `已自定义内置规则「${name}」：写入顶层自编区同名覆盖（${ext === DISABLED_EXT ? "禁用" : "启用"}态，与内置开关一致），生效优先于内置`;
    }
    case "delete": {
      const ok = deleteRuleFile(d.custom, name);
      return ok ? `已删除自定义规则「${name}」` : `自定义规则「${name}」不存在`;
    }
    case "toggle": {
      if (enabled === null) return "toggle 需要 enabled 参数（true/false）";
      const file = findAny(d, name);
      if (!file) return `规则「${name}」不存在`;
      const dir = path.dirname(file);
      const otherDir = dir === d.builtin ? d.custom : d.builtin;
      const otherFile = findRuleFile(otherDir, name);
      const cur = file.endsWith(DISABLED_EXT) ? false : true;
      const otherCur = otherFile ? (otherFile.endsWith(DISABLED_EXT) ? false : true) : null;
      if (cur === enabled && (otherCur === null || otherCur === enabled)) {
        return `规则「${name}」已经是${enabled ? "启用" : "禁用"}状态（${otherFile ? "两处一致" : "单处"}）`;
      }
      toggleRule(dir, name, enabled);
      // 被自定义过的内置规则：两处开关同步（内置副本 + 顶层同名覆盖），避免恢复默认后状态跳变
      if (otherFile && otherCur !== enabled) toggleRule(otherDir, name, enabled);
      return `已${enabled ? "启用" : "禁用"}规则「${name}」（${otherFile ? "内置与覆盖两处同步" : "单处"}）`;
    }
    case "restore": {
      const hadOverride = deleteRuleFile(d.custom, name); // 移除同名自编覆盖（若有）
      const ok = resetRuleToSeed(seedDir, d.builtin, name); // 内置副本内容回归种子，开关态保持
      return ok
        ? `已恢复内置规则「${name}」为默认（${hadOverride ? "移除自编覆盖，" : ""}内容回归种子版，开关状态保持）`
        : `内置规则「${name}」不存在于种子`;
    }
    default:
      return `未知 action: ${action}`;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node cli.mjs <action> [选项]
action: list | get | create | update | delete | toggle | restore
选项:
  -n, --name <名>          规则名（create/update/get/delete/toggle/restore 需要）
  -c, --content <文本>     规则全文（create/update 需要；首行 # 标题自动对齐 name）
  -f, --content-file <路径> 从文件读规则全文（多行内容推荐；与 -c 互斥，优先）
  -e, --enabled <true|false> toggle 目标状态
  -d, --dataDir <路径>     数据目录（默认: 平台插件数据目录）
  -s, --seedDir <路径>     内置种子目录（默认: 平台插件目录 rules/）
  -h, --help               显示帮助`);
    return;
  }

  const action = args.action;
  const valid = new Set(["list", "get", "create", "update", "delete", "toggle", "restore"]);
  if (!action || !valid.has(action)) {
    console.error(`需要有效 action: ${[...valid].join(" / ")}`);
    process.exit(2);
  }

  let content = args.content;
  if (args.contentFile) {
    content = fs.readFileSync(args.contentFile, "utf8");
  }

  const dataDir = args.dataDir ?? process.env.RULES_INJECTOR_DATA_DIR ?? DEFAULT_DATA_DIR();
  let seedDir = args.seedDir ?? process.env.RULES_INJECTOR_SEED_DIR ?? null;
  if (!seedDir) {
    const d = DEFAULT_SEED_DIR();
    if (fs.existsSync(d)) seedDir = d;
  }

  const text = run({ action, name: args.name, content, enabled: args.enabled }, dataDir, seedDir);
  process.stdout.write(text + "\n");
}

main();
