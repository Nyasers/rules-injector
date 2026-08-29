// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// index.js — 规则注入器（rules-injector）
// 注入通道：仅 deferred（宿主 display:false custom_message 投递，模型可见、界面隐身）。
// display 表达位：插件在 register meta 里携带 display 意图（INJECT_DISPLAY），
//   宿主 server bundle kY() 投递构造器当前硬编码 display:!1（0.446.6 验证），
//   meta.display 暂不消费，属能力预留；宿主支持后注入消息将按意图显隐。
// 注入时机：
//   1. session_created —— 新会话全量注入当前规则清单（清单标识 = 内容指纹）；
//      兼容宿主两种 emit 形态（顶层 sessionId / session 对象内 sessionId）
//   2. session_user_message —— 用户消息提交时一次性检查：读最新状态算指纹，与已注入指纹对比，
//      实质变化才注入最新清单（旧实现：rules-state.json 变化时立即重注入，连续多次状态变化会
//      产生多条中间态投递，全部进入上下文；现改为状态变化只更新状态文件，用户消息前合并为一次投递）
//   3. 上下文压缩后 —— 全量重注入（宿主压缩事件到位后挂载，见 reinjectAllActive 注释）
// 清单标识即内容指纹（sha256 前 16 位）：内容未变化的重复操作（如重复关闭已关闭的规则）
//   指纹不变、不重复推送；只有清单实质内容变化才换新指纹并重注入。
//   （语义见 lib/rules-fs.js「规则清单与指纹」；判据实现见 lib/db.js）
// 已注入判据：data.db injected_sessions 持久化每个会话最后成功注入的清单指纹
//   （upsert，每会话恒一条），与当前清单内容指纹对比，不同才推送、推完更新记录。
//   插件重启后判据依然成立，已注入会话不会因重启而静默失效（sessionKeyCache 内存 Map
//   仅作热防并发缓存）。
//   判据键首次选定后固定：同一 sessionPath 首次注入时选定 key（原生 sessionId 优先，
//   反查失败落派生键兜底也缓存），后续即使反查成功也不替换——防键漂移（反查失败用
//   派生键注入、稍后反查成功换原生键）导致同内容二次注入与 injected_sessions 双记录。
//   重载恢复：sessionKeyCache 是 onload 局部内存、插件重载后清空；重载后内存未命中时
//   先查 data.db 中 sessionKeyFor(sessionPath) 派生键是否已有注入记录——有则复用派生键
//   （历史键恢复），保证重载前后同一 sessionPath 的判据键一致；无记录才走原生 sessionId
//   或派生键兜底。极端 edge（历史原生键 + 重载 + 反查失败落派生键再恢复）：不重复注入
//   （键固定后判据命中），可能多一条历史记录，可接受。
// taskId 角色：投递任务标识（宿主 deferred store 的键），只要求每次投递唯一，与内容指纹解耦。
//   格式 ri-<sessionId>-<hash>-<ts>：sessionId 标识会话、hash 仅作可追溯信息、时间戳保证唯一。
//   历史 bug（0.7.0）：taskId 曾用 ${key}-${hash}，hash 回退历史值时 taskId 复用，
//   撞宿主 deferred store 的 _tasks 幂等（defer 静默跳过 + resolve 只投 pending），投递被吞且记录误写。
//
// 机制依据（宿主 bundle 0.446.6 验证）：
// - session_created 事件：存在两种 emit 形态——核心 createSession 路径在事件顶层带
//   sessionId/sessionPath/agentId；session:create bus handler / REST 路由在 session 对象内
//   携带（payload 亦可能再包一层 session）。bus.subscribe 回调第二参为 sessionPath
//   （恢复旧会话不触发，天然防重复）；事件未带 sessionId 时异步 session:get 反查后再注入，
//   保证同一会话键收敛（原生 sessionId 优先，反查失败才落派生键）
// - session_user_message 事件：用户提交消息时 emit（desktop-session-submit 与 bridge 两条路径
//   均发，payload 带 clientMessageId/message，第二参为 sessionPath），早于 turn 的 prompt 组装，
//   是「用户消息提交时一次性检查」的挂载点。事件本身不含 sessionId，需 session:get 反查
//   （反查失败回退 sessionKeyFor 派生键）
// - deferred:register / deferred:resolve：宿主把终态结果投递为 custom_message
//   （customType=hana-background-result, display=false）：消息在历史里但 UI 不渲染，
//   会话转 prompt 时转成 role:"custom" 消息进入模型上下文
// - 投递策略（2026-08-12 宿主 bundle 0.446.6 源码验证）：
//   ① deliveryIntent="trigger_parent_turn"：触发父回合 → 会话 busy → 首条用户消息被拦
//   ② deliveryIntent="notify_ui_only"：改道 recordCustomEntry，写 hana-deferred-result，
//      不进模型上下文，规则丢失
//   ③ 不设 deliveryIntent + meta.triggerParentTurn=false：走 deliverCustomMessage，
//      写 hana-background-result（进上下文），triggerTurn=false（notifyOnly 模式），
//      不触发回合、不 busy。这是唯一两头都通的组合，不需要 abort。
// - 参考实现：hana-remote-dev 的 src/lib/wake.js（deferred 回调三件套）
// - 宿主无公开压缩事件：压缩后重注入需宿主能力申请（session_compacted / context_reset）
// 修复 0.7.3（中间态泄漏）：
//   A. 状态稳定期：watch 状态文件（目录级）仅刷新 lastStateChangeAt，绝不触发注入；
//      doInject 前距上次状态变化不足 STABLE_MS 则顺延到稳定后再读最新状态判据。
//      语义：开关快速反复拨动（净效果为零 → 最终态与已注入指纹一致）不产生推送；
//      真正稳定后的变更才注入。延迟任务不共享 timer，执行时重新检查，重复任务由判据①短路。
//   B. 消息级去重：session_user_message 按 clientMessageId 记录最近处理消息，
//      同一消息（desktop 与 bridge 双路径均发同一值）只检查一次，防双路径对同一消息双推。
// 修复 0.7.4（取消防抖窗口，判据收敛到内容，注入锚点回到消息提交）：
//   A. 删除 watch 状态文件驱动的 800ms 防抖窗口：时间窗口既不可靠（fs.watch 事件派发与
//      doInject 读取存在竞态）也无必要——判定只认「即将注入」时刻状态内容的 hash 与
//      injected-sessions.jsonl 记录的相等性，内容没变就不推，变了如实注入。
//   B. sessionId 缓存（session_created 写入 sessionPath -> sessionId）：session_user_message
//      同步取缓存，消除 session:get 异步反查约 10s 延迟——doInject 回到消息提交时刻执行，
//      中间态（开关打开又关闭中的「打开」）不再被延迟快照捕获后泄漏进上下文。
//   C. injected-sessions.jsonl 尾部剔除：追加前检查最后一行是否为当前 session，是则先剔除
//      再追加——尾部始终反映该 session 最近一次注入，判据①读到的 persisted 恒为最新值。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { StateDb } from "./lib/db.js";
import { runMigration } from "./lib/migrate.js";
import { loadEffectiveRules, buildRulesText, contentHashOf } from "./lib/rules-fs.js";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SEED_DIR = path.join(PLUGIN_ROOT, "rules"); // 内置规则种子（插件目录，只读）

const MARK_START = "<!--rules-injector:begin-->";
const MARK_END = "<!--rules-injector:end-->";

// 注入消息的 display 意图：true=界面可见（宿主支持后生效），false=隐身（现状）。
// 宿主 0.446.6 的 deferred 投递构造器 kY() 硬编码 display:!1，暂不消费本字段。
const INJECT_DISPLAY = true;

// TTL 保留窗口（24h，双表统一：卡片与渲染层失效语义同步，注入判据跟随会话活跃度）
const CARD_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// 兜底会话键：sessionId 缺失（宿主解析失败）时由 sessionPath 派生，避免以完整路径作键。
// 常规路径已改用宿主原生 sessionId 作 injected-sessions.jsonl 的记录键。
function sessionKeyFor(sessionPath) {
  return "ri-" + createHash("sha1").update(sessionPath).digest("hex").slice(0, 12);
}

// deferred 通道投递规则文本：register 登记投递策略，resolve 携带规则全文，
// 宿主异步投递为 display:false 的 custom_message（模型可见、界面不显示）。
// 注意：不设 deliveryIntent（默认走 deliverCustomMessage），用 triggerParentTurn:false
// 压住回合触发，兼顾“进模型上下文”与“不 busy”（见文件头投递策略③）。
async function injectViaDeferred(bus, sessionPath, sessionId, rulesText, taskId, log) {
  let reg;
  try {
    reg = await bus.request("deferred:register", {
      taskId,
      sessionPath,
      ...(sessionId ? { sessionId } : {}),
      meta: {
        type: "rules-injector",
        label: "行为规则注入",
        triggerParentTurn: false,
        display: INJECT_DISPLAY,
      },
    });
  } catch (e) {
    return { ok: false, mode: "unsupported", error: e };
  }
  if (!reg || reg.ok !== true) return { ok: false, mode: "register-failed" };
  try {
    await bus.request("deferred:resolve", { taskId, result: rulesText });
  } catch (e) {
    return { ok: false, mode: "resolve-failed", error: e };
  }
  return { ok: true, mode: "deferred" };
}

export default class RulesInjectorPlugin {
  async onload() {
    const { log, bus } = this.ctx;
    const dataDir = this.ctx.dataDir;
    const rulesDir = path.join(dataDir, "rules"); // 规则工作副本 + 用户区（唯一事实源）
    const injected = new Map(); // 记录键(sessionId) -> 已注入清单的内容 hash（热缓存：防同进程并发/重复，权威判据在 data.db）

    // data.db 统一状态库（meta / injected_sessions / card_consumed）。
    // 容错：db 损坏/不可读时 init 抛错 → 注入停用（防误注入），侧边栏报「未初始化」，不拖垮插件。
    const db = new StateDb(dataDir);
    try {
      db.init();
      // 0.8.7：启动时 TTL 除旧（卡片 24h 过期；注入判据超窗删除）
      try { db.pruneCards(Date.now() - CARD_TTL_MS); db.pruneSessions(Date.now() - SESSION_TTL_MS); } catch { /* 清理失败不影响启动 */ }
      // 一次性迁移：检测到旧文件（rules-state.json / injected-sessions.jsonl）自动迁移到文件化 + data.db
      const mig = runMigration(dataDir, SEED_DIR);
      if (mig.migrated) {
        const s = mig.summary;
        log.info(`[rules-injector] 迁移完成: global_enabled=${s.globalEnabled} 播种=${s.seed.added} 禁用=${s.disabledApplied} custom=${s.customWritten} 判据导入=${s.imported}`);
      }
    } catch (e) {
      log.error(`[rules-injector] data.db init failed: ${e?.message || e}（规则注入停用，检查插件数据目录）`);
    }

    // sessionPath -> 宿主原生 sessionId 缓存（session_created 写入）。
    // 0.7.4：session_user_message 直接取缓存，消除 session:get 异步反查的约 10s 延迟
    // （0.7.3 中间态泄漏的根因：doInject 被反查延迟拖离消息提交时刻，快照落在开关拨动窗口内）。
    const sessionIdCache = new Map();
    const sessionKeyCache = new Map(); // sessionPath -> 首次选定的判据键（稳定身份，派生键兜底也缓存，后续不替换；重载后内存清空，由 data.db 派生键记录恢复）

    const doInject = async (sessionPath, sessionId, force) => {
      if (!db.ok) return; // db 不可用：注入停用
      // 判据锚点 =「即将注入」时刻的规则文件内容（实时读文件算指纹，无状态文件快照）
      // 判据键首次选定后固定：sessionKeyCache 落定 sessionPath -> key（原生 sessionId 优先，
      // 反查失败落派生键兜底也缓存，后续不替换）；sessionId 参数仅用于 injectViaDeferred
      // 的会话定位，与判据键职责分离——防反查失败（派生键注入）后被后续反查成功的
      // 原生 sessionId 顶替导致键漂移（同内容二次注入 + injected_sessions 双记录）。
      // 重载恢复：sessionKeyCache 为 onload 局部内存、重载后清空；内存未命中时先查 data.db
      // 中 sessionKeyFor(sessionPath) 派生键是否已有注入记录——有则复用派生键（历史用派生键
      // 注入的会话重载后不漂回原生键），无记录才走原生 sessionId 或派生键兜底。极端 edge
      // （历史原生键 + 重载 + 反查失败落派生键再恢复）：不重复注入（判据命中），可能多一条
      // 历史记录，可接受。
      const key =
        sessionKeyCache.get(sessionPath) ||
        (db.getFingerprint(sessionKeyFor(sessionPath)) != null ? sessionKeyFor(sessionPath) : null) ||
        sessionId ||
        sessionKeyFor(sessionPath);
      if (!sessionKeyCache.has(sessionPath)) sessionKeyCache.set(sessionPath, key);

      // 全局总开关（meta global_enabled，'0' = 关闭；默认开启）：关闭期不推不记
      if (db.getMeta("global_enabled") === "0") return;

      // 加载生效规则（自动播种，幂等）+ 组装清单
      const { rules } = loadEffectiveRules(SEED_DIR, rulesDir);
      const rulesText = buildRulesText(rules);
      const hash = contentHashOf(rules); // 内容指纹（null=空清单）；与 buildRulesText 同源

      // 判据①（即将注入前一刻）：持久化已注入 hash（data.db，跨重启有效）
      const persisted = db.getFingerprint(key);
      if (!force && persisted === hash) return;
      // 判据②：内存热缓存——本进程内异步推送中，防并发重推
      if (!force && injected.get(key) === hash) return;

      injected.set(key, hash); // 先标记，防并发
      if (!rulesText) return; // 空清单：无内容可推（不更新持久化记录，旧 hash 保留）
      try {
        // taskId 是投递任务标识，只要求唯一：hash 仅作可追溯信息，时间戳保证唯一（防宿主 _tasks 幂等吞投递）
        const taskId = `${key}-${hash}-${Date.now().toString(36)}`;
        const via = await injectViaDeferred(bus, sessionPath, sessionId, rulesText, taskId, log);
        if (!via.ok) {
          log.warn(`[rules-injector] deferred inject ${via.mode}${via.error ? `: ${via.error.message || via.error}` : ""}`);
          return;
        }
        // 推送成功：更新 data.db 判据（每会话恒一条，upsert）
        db.setFingerprint(key, hash);
        log.info(`[rules-injector] injected ${hash} into ${sessionPath} (pure deferred, no abort)`);
      } catch (e) {
        injected.delete(key);
        log.warn(`[rules-injector] inject failed for ${sessionPath}: ${e?.message || e}`);
      }
    };

    // 状态变更策略（0.7.4+）：开关/内容变化只改文件系统与 data.db（单一事实源），不触发即时投递；
    // 注入判定收敛到用户消息提交时（session_user_message）的 doInject——实时读文件算指纹，
    // 与已注入记录对比，实质变化才投递。无 watch、无时间窗口（判定只认「即将注入」时刻的内容）。
    // （0.7.0 旧实现：watch rules-state.json → onStateChange 立即重注入；0.7.4 取消防抖窗口；
    //   0.8.0 文件化后连资产 watch 也移除：doInject 每次实时播种 + 读文件，种子变更自然在下一次生效。）

    // 上下文压缩后全量重注入：宿主当前无公开压缩事件（session_compacted / context_reset），
    // 待宿主能力到位后在此挂载；届时遍历 data.db 判据记录，force 重投当前指纹即可。
    // const onCompacted = (sessionPath, sessionId) => { if (db.getFingerprint(sessionId || sessionKeyFor(sessionPath))) doInject(sessionPath, sessionId, true); };

    // 按 sessionPath 取宿主原生 sessionId：优先缓存（session_created 时写入，同步可得），
    // 未命中才异步 session:get 反查并回填缓存；反查失败回退 sessionKeyFor 派生键。
    const resolveSessionId = async (sessionPath) => {
      if (sessionIdCache.has(sessionPath)) return sessionIdCache.get(sessionPath);
      try {
        const res = await bus.request("session:get", { sessionPath });
        const sid = res?.session?.sessionId || null;
        if (sid) sessionIdCache.set(sessionPath, sid);
        return sid;
      } catch { return null; }
    };

    const handledMsgs = new Map(); // sessionPath -> 最近处理的消息 clientMessageId（方案 B：防双路径对同一消息双推）
    const unsub = bus.subscribe((ev, ssp) => {
      if (ev?.type === "session_created") {
        const session = ev.session || {};
        const sp = ssp || ev.sessionPath || ev.payload?.session?.sessionPath || session.path || session.sessionPath;
        if (!sp) return;
        // 兼容宿主两种 emit 形态：核心 createSession 路径 sessionId 在事件顶层，
        // session:create bus handler / REST 路由在 session 对象内（含 payload 包装）
        const sid = ev.sessionId || ev.session?.sessionId || ev.session?.sessionRef?.sessionId || ev.payload?.session?.sessionId || null;
        if (sid) {
          sessionIdCache.set(sp, sid); // 缓存原生 sessionId，供 session_user_message 同步取用
          doInject(sp, sid, false);
        } else {
          // 事件未携带 sessionId：异步 session:get 反查后再注入（与 session_user_message 兜底一致），
          // 保证同一会话永远收敛到同一 key——原生 sessionId 优先，反查也失败才落派生键
          // （此时两条路径都用派生键，key 依然一致）
          resolveSessionId(sp).then((s2) => doInject(sp, s2, false));
        }
        return;
      }
      // 用户消息提交时一次性检查：读最新状态算指纹，与已注入指纹对比（判据锚点在「即将注入」），
      // 实质变化才投递最新清单；内容未变的轮次由判据快速短路，不产生投递。
      // 0.7.4 起无时间窗口合并：每次提交按当时状态判定，中间态如实反映（doInject 贴近提交时刻，
      // 用户提交前已完成的开关变更才是「当前状态」，提交后的拨动由下一条消息触发）。
      if (ev?.type === "session_user_message") {
        const sp = ssp;
        if (!sp) return;
        // 消息级去重：同一消息（clientMessageId，双路径均发同一值）只检查一次；
        // 拿不到 msgId 时降级为不按消息去重（由判据①兜底）。
        const msgId = ev?.payload?.clientMessageId ?? ev?.clientMessageId ?? null;
        if (msgId != null) {
          if (handledMsgs.get(sp) === msgId) return;
          handledMsgs.set(sp, msgId);
        }
        // 缓存命中则 doInject 与消息提交同步执行（不再被反查延迟拖离提交时刻）
        const sid = sessionIdCache.get(sp);
        if (sid) doInject(sp, sid, false);
        else resolveSessionId(sp).then((s2) => doInject(sp, s2, false));
      }
    });

    this.register(() => unsub());
    log.info("[rules-injector] loaded (file-based rules, data.db)");
  }
}
