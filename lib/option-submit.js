// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/option-submit.js — 选项卡片回传共用逻辑
// 0.10.1 抽出：routes/card.js 的 POST /card/choose 与 tools/option-choose.js（交互卡 binding 目标）
// 共用同一套回传逻辑，避免两处重复（deferred 回传 + 消费锁 + Markdown 构造）。
// 两种入口语义一致：route 由 SSR webview 卡调用，option-choose 由聊天内交互卡（show_card +
// host bridge binding）调用。回传一律走 deferred 通道（trigger_parent_turn 唤醒父回合），
// 成功后在库中标记消费（条件更新 WHERE ts IS NULL，幂等防重）。
// 入口差异（防伪造投递）：HTTP 入口（POST /card/choose）为严格模式——空/未知 cardId 一律
// 400 拒绝，不接受 legacy 参数（question/sessionPath）投递（防攻击者构造 body 向任意会话
// 投递任意内容）；插件工具入口（option_choose）受信，以 { allowLegacy: true } 保留参数降级
// （db 不可用/查无记录时回退参数），不牺牲工具的容错。

import { StateDb } from "./db.js";

// db 懒单例（模块级，与 routes/tools 各自持有实例，同一 data.db，SQLite 多连接安全）
let _db = null;
function getDb(ctx) {
  if (!_db) {
    _db = new StateDb(ctx.dataDir);
    _db.init();
  }
  return _db;
}

// 模块级 in-flight claim：cardId -> Promise（投递承诺）。
// pre-check（ts IS NULL）到 markCardConsumed（WHERE ts IS NULL）之间无互斥，
// 并发 submitOption（同一 cardId：用户连点 / route 与交互卡 binding 双路径）都能
// 通过 pre-check 并各自 register+resolve 造成双投递；claim 使同一卡同时仅一次投递。
// 重复请求不直接返回成功，而是 await 同一投递承诺的最终结果——进行中的投递最终成功则
// 幂等成功、最终失败则透传失败（修复：投递进行中直接返回成功会对最终失败的投递谎报成功）；
// 投递结束（成功/失败）后释放条目，后续重试可再 claim。
const inflight = new Map(); // cardId -> Promise<投递结果 {ok, error?, code?}>（deferred 投递中）

/**
 * 回传一次选项选择。与 routes/card.js 0.8.11 逻辑完全等价。
 * @param {object} ctx 工具/路由上下文（要求 ctx.dataDir、ctx.bus）
 * @param {object} args { cardId, choice, mode, question?, sessionPath? }
 * @param {object} [opts] 入口选项 { allowLegacy? }
 * @param {boolean} [opts.allowLegacy] 受信调用方（插件工具域）为 true：cardId 非空但库无记录时
 *   保留 question/sessionPath 参数降级（db 不可用场景）；缺省/false（HTTP 入口）拒绝未知 cardId。
 * @returns {Promise<{ok:boolean, error?:string, code?:string|null}>}
 */
export async function submitOption(
  { dataDir, bus },
  { cardId, choice, mode, question, sessionPath } = {},
  opts = {},
) {
  const m = mode === "custom" || mode === "skip" ? mode : "option";

  // 空/非字符串 cardId 一律拒绝（防 legacy 参数伪造投递：任何入口都不接受无 cardId 的投递）
  if (typeof cardId !== "string" || !cardId.trim()) {
    return { ok: false, error: "cardId is required", code: "validation_error" };
  }

  // 优先库中数据（权威）：q 构造回传文本、p 定位会话；库无记录（旧卡片/查无）回退参数字段
  let q = "",
    p = "",
    card = null;
  try {
    card = getDb({ dataDir }).getCard(cardId);
    if (card) {
      q = card.q;
      p = card.p || "";
    }
  } catch {
    /* db 不可用（card 保持 null） */
  }
  // cardId 非空但库无记录：严格模式（HTTP 入口，不传 allowLegacy）直接拒绝未知 cardId（防伪造投递）；
  // allowLegacy=true（受信工具入口）保留参数 question/sessionPath 降级（db 不可用场景）
  if (!card && opts.allowLegacy !== true) {
    return { ok: false, error: "card not found", code: "validation_error" };
  }
  // 已消费（ts 非空）即幂等跳过：消费标记兼作闸门，点击/授权重试不再重复回传
  if (card && card.ts != null) return { ok: true, alreadyConsumed: true };
  if (!q)
    q =
      typeof question === "string" && question.trim()
        ? question.trim().slice(0, 200)
        : "";
  if (!q) return { ok: false, error: "question is required", code: "validation_error" };
  if (
    (m === "option" || m === "custom") &&
    (typeof choice !== "string" || !choice.trim())
  ) {
    return { ok: false, error: "choice is required for this mode", code: "validation_error" };
  }
  const sp =
    p ||
    (typeof sessionPath === "string" && sessionPath ? sessionPath : undefined);

  // 回传 Markdown 化（deferred 通道支持 md 渲染）。大标题立身份（# 选项卡片）+ 两小标题下放正文。
  const text =
    m === "skip"
      ? `# 选项卡片\n\n## 问题\n${q}\n\n## 回答\n跳过，不做选择`
      : `# 选项卡片\n\n## 问题\n${q}\n\n## 回答\n${choice.trim()}`;

  // in-flight claim（在 pre-check 之后、deferred:register 之前；校验早退不占锁）：
  // 同一 cardId 仅发起一次投递；重复请求复用进行中的投递承诺（await 其最终结果：
  // 成功→幂等成功，失败→透传失败），register→resolve→markCardConsumed 全过程互斥
  let claim = false;
  if (typeof cardId === "string" && cardId) {
    const pending = inflight.get(cardId);
    if (pending) return pending; // 复用进行中的投递结果（成功→幂等成功；失败→透传失败）
    claim = true;
  }
  const delivery = (async () => {
    try {
      const taskId = `oc-${cardId || "legacy"}-${Date.now().toString(36)}`;
      const reg = await bus.request("deferred:register", {
        taskId,
        sessionPath: sp,
        meta: {
          type: "rules-injector",
          label: "选项卡片回传",
          deliveryIntent: "trigger_parent_turn",
        },
      });
      if (!reg || reg.ok !== true)
        throw new Error(reg?.error || "deferred:register failed");
      await bus.request("deferred:resolve", { taskId, result: text });
      // resolve 成功后落库消费（条件更新 WHERE ts IS NULL，已消费忽略；db 不可用静默降级）
      if (typeof cardId === "string" && cardId) {
        try {
          getDb({ dataDir }).markCardConsumed(
            cardId,
            m === "skip" ? "" : choice.trim(),
            m,
          );
        } catch {
          /* 忽略 */
        }
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || String(err),
        code: err?.code || null,
      };
    }
  })();
  if (claim) inflight.set(cardId, delivery);
  const result = await delivery;
  // 释放 claim：仅释放自己的 promise 条目（成功/失败都释放），后续重试可再 claim
  if (claim && inflight.get(cardId) === delivery) inflight.delete(cardId);
  return result;
}
