// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/option-choose.js — 交互卡回传工具（0.10.1）
// 聊天内交互卡（show_card Interactive 形态）的 host bridge 绑定目标：
//   交互卡代码里的 data-card-manifest toolBindings 把 "choose" 绑定到本工具，
//   用户点击选项/提交自定义/跳过时，卡片 JS 调 window.card.invoke("choose", {...})，
//   宿主经 Card Host Gateway 执行本工具（会话的 source session + target Agent 工具域）。
// 内部复用 lib/option-submit.js 的共享回传逻辑（deferred 回传 + 消费锁 + Markdown 构造）。
// 相比 SSR webview 卡（route /card/choose）：本工具直接进插件工具域，无需 iframe、
// 无 webview 占位壳，是官方「聊天内联走 Interactive Card」的落地形态。

import { submitOption } from "../lib/option-submit.js";

export const name = "option_choose";
export const description =
  "选项卡片的点击回传（用户已在聊天内交互卡上选择/输入/跳过，此工具承载回传，内部走 deferred 通道）" +
  "。由交互卡 host bridge 自动调用，一般不直接手动触发。若手动调用：传入 cardId（option-card 落库返回）" +
  "与 choice（选项文本或自定义输入）/mode（option|custom|skip）。";

export const readOnly = false;
export const sessionPermission = { kind: "external_side_effect" };

export const parameters = {
  type: "object",
  properties: {
    cardId: {
      type: "string",
      description:
        "选项卡片 ID（来自 option-card 工具返回的 details.option_card.cardId）",
    },
    choice: {
      type: "string",
      description:
        "用户选择：mode=option 时为选中选项原文；mode=custom 时为自定义输入；mode=skip 时留空",
    },
    mode: {
      type: "string",
      enum: ["option", "custom", "skip"],
      description: "回传模式：option=点选 / custom=自定义输入 / skip=跳过",
    },
    question: {
      type: "string",
      description: "问题原文（库无该卡时回退用；通常由卡片 JS 一并带上）",
    },
  },
  required: ["cardId", "mode"],
};

export async function execute(input, ctx) {
  const cardId = String(input?.cardId || "").trim();
  const mode =
    input?.mode === "custom" || input?.mode === "skip" ? input.mode : "option";
  const choice = typeof input?.choice === "string" ? input.choice.trim() : "";

  if (!cardId) throw new Error("缺少 cardId（来自 option-card 的返回值）");

  const r = await submitOption(ctx, {
    cardId,
    choice,
    mode,
    question: input?.question,
    sessionPath: ctx.sessionPath,
  });
  if (!r.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `回传失败：${r.error || "unknown"}` }],
      details: { option_choose: { cardId, mode, ok: false, error: r.error } },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: mode === "skip" ? "已跳过" : `已回传选择：${choice}`,
      },
    ],
    details: {
      option_choose: {
        cardId,
        mode,
        ok: true,
        choice: mode === "skip" ? "" : choice,
      },
    },
  };
}
