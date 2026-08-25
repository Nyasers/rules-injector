// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/option-submit.js — 选项卡片回传共用逻辑
// 0.10.1 抽出：routes/card.js 的 POST /card/choose 与 tools/option-choose.js（交互卡 binding 目标）
// 共用同一套回传逻辑，避免两处重复（deferred 回传 + 消费锁 + Markdown 构造）。
// 两种入口语义一致：route 由 SSR webview 卡调用，option-choose 由聊天内交互卡（show_card +
// host bridge binding）调用。回传一律走 deferred 通道（trigger_parent_turn 唤醒父回合），
// 成功后在库中标记消费（条件更新 WHERE ts IS NULL，幂等防重）。

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

/**
 * 回传一次选项选择。与 routes/card.js 0.8.11 逻辑完全等价。
 * @param {object} ctx 工具/路由上下文（要求 ctx.dataDir、ctx.bus）
 * @param {object} args { cardId?, choice, mode, question?, sessionPath? }
 * @returns {Promise<{ok:boolean, error?:string, code?:string|null}>}
 */
export async function submitOption(
  { dataDir, bus },
  { cardId, choice, mode, question, sessionPath } = {},
) {
  const m = mode === "custom" || mode === "skip" ? mode : "option";

  // 优先库中数据（权威）：q 构造回传文本、p 定位会话；库无记录（旧卡片/查无）回退参数字段
  let q = "",
    p = "",
    card = null;
  if (typeof cardId === "string" && cardId) {
    try {
      card = getDb({ dataDir }).getCard(cardId);
      if (card) {
        q = card.q;
        p = card.p || "";
      }
    } catch {
      /* db 不可用 */
    }
  }
  // 已消费（ts 非空）即幂等跳过：消费标记兼作闸门，点击/授权重试不再重复回传
  if (card && card.ts != null) return { ok: true, alreadyConsumed: true };
  if (!q)
    q =
      typeof question === "string" && question.trim()
        ? question.trim().slice(0, 200)
        : "";
  if (!q) return { ok: false, error: "question is required" };
  if (
    (m === "option" || m === "custom") &&
    (typeof choice !== "string" || !choice.trim())
  ) {
    return { ok: false, error: "choice is required for this mode" };
  }
  const sp =
    p ||
    (typeof sessionPath === "string" && sessionPath ? sessionPath : undefined);

  // 回传 Markdown 化（deferred 通道支持 md 渲染）。大标题立身份（# 选项卡片）+ 两小标题下放正文。
  const text =
    m === "skip"
      ? `# 选项卡片\n\n## 问题\n${q}\n\n## 回答\n跳过，不做选择`
      : `# 选项卡片\n\n## 问题\n${q}\n\n## 回答\n${choice.trim()}`;

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
}
