// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/option-card.js — 对话内选项卡片（原型）
// 工具：把问题与选项写入 data.db option_cards 表（数据 + 消费一条记录），route 只带 id（/card?id=<cardId>），
// 渲染与消费判定由服务端从库读取（薄 iframe 厚服务端）。用户点击按钮后由 routes/card.js 负责注入会话。
// 0.8.7：根治 0.7.16 hash 消费标记在真实宿主失效的问题（重建 iframe 丢 hash）——入库后 id 是唯一关联键，跨重建/跨重启成立。
import { createHash } from "node:crypto";
import { StateDb } from "../lib/db.js";

const CARD_TTL_MS = 24 * 60 * 60 * 1000;

// db 懒单例（模块级，与 routes 各自持有实例，同一 data.db 文件，SQLite 多连接安全）
let _db = null;
function getDb(ctx) {
  if (!_db) {
    _db = new StateDb(ctx.dataDir);
    _db.init();
  }
  return _db;
}

export const name = "option_card";
export const description =
  "在对话中渲染一张可点击的选项卡片，用户点击某个选项后，会经插件后台通道投递一条 Markdown 消息" +
  "（大标题「# 选项卡片」立身份，下分「## 问题」与「## 回答」两个小标题各带正文）" +
  "进入当前会话（模型可见、界面隐身）并唤醒 agent 继续处理。\n\n" + +
  "何时使用（自动触发的触发契约）：\n" +
  "- 需要用户在多个方案/选项中选一个（如选方案 A 还是 B、吃什么、用哪个风格、选哪个时间）\n" +
  "- 需要用户确认是否执行某个操作（是 / 否 / 稍后）\n" +
  "- 任何需要用户拍板、做决策或提供偏好的场景\n" +
  "- 注意：即使只有 2 个选项（如 是/否、A/B 二选一），也要用本工具渲染卡片，不要用纯文字提问让用户打字回复\n\n" +
  "何时不使用：\n" +
  "- 没有决策点、只是陈述或提问\n" +
  "- 答案只有一个可能（用普通对话即可）\n" +
  "- 需要用户输入自由文本（不适合做成选项）\n\n" +
  "参数：question 为问题本身（简洁，卡片标题），options 为 2~6 个候选选项。" +
  "选项不超过 3 个时自动横排并排，超过 3 个自动竖列。\n\n" +
  "用户点击后回传的消息为 Markdown 标题结构（经后台通道投递）：\n" +
  "『# 选项卡片\n\n## 问题\n<问题文本>\n\n## 回答\n<回答内容>』\n" +
  "（回答正文即用户的选择/输入内容，点击选项与自定义输入同为文本回答、不加前缀；跳过时为「跳过，不做选择」）。\n" +
  "收到含「选项卡片」标题的 Markdown 消息时，应把它视为用户通过选项卡片做出的选择结果，" +
  "接续执行对应分支，不再重复提问；回答正文为「跳过，不做选择」时视为放弃决策，不追问。";

export const parameters = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "需要用户选择的问题，会作为卡片标题与回传消息的前缀",
    },
    options: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 6,
      description: "候选选项（2~6 个），每个渲染为一个可点击按钮",
    },
  },
  required: ["question", "options"],
};

export async function execute(input, ctx) {
  const question = String(input.question || "").trim();
  const options = (Array.isArray(input.options) ? input.options : [])
    .map((o) => String(o).trim())
    .filter(Boolean)
    .slice(0, 6);

  if (!question) throw new Error("question is required");
  if (options.length < 2) throw new Error("at least 2 options required");

  // 0.8.7：卡片数据落库 data.db option_cards（数据与消费同一条记录），route 只带 id（query 形式）。
  // 渲染与消费判定由服务端从库读取（薄 iframe 厚服务端）；宿主重建 iframe 时 route 引用固定，id 保留。
  // 除旧为纯时间 TTL（24h，与渲染层失效语义同步；db 内部 prune，创建时顺带执行）。
  // db 不可用静默降级（不落库，route 照常生成）。
  const created = Date.now();
  const sessionPath = ctx.sessionPath || null;
  const cardId = createHash("sha256")
    .update([question, options.join("\x00"), String(created), sessionPath || ""].join("\x00"))
    .digest("hex")
    .slice(0, 16);
  try {
    const db = getDb(ctx);
    db.pruneCards(Date.now() - CARD_TTL_MS);
    db.createCard({ cardId, q: question, o: JSON.stringify(options), c: created, p: sessionPath });
  } catch (e) { /* db 不可用：不落库，降级由 /card 侧处理 */ }
  const route = `/card?id=${cardId}`;

  // 按选项数估算卡片高度（宽度宿主固定 400px）：横排按钮 min-height 60/76px（实际即此值，贴合）；
  // 竖排行高由 padding 13×2 + 文字行高决定 ≈ 43px（0.7.10 起从 46 修正，消除每行虚高的 3px 留白）。
  // 顶部问题 41px + 常驻输入框 56px + 底部入口 50px + 卡片 padding 28px + 余量。
  // 反馈不再预留固定高度：正常路径反馈文本顶掉按钮（零新增高度），
  // 错误路径状态条靠 ResizeObserver 上报动态拓展（宿主跟随 resize）。
  function estimateCardHeight() {
    const base = 41 + 56 + 50 + 28 + 8; // 问题 + 输入框 + 底部入口 + padding + 余量
    if (options.length <= 3) {
      return base + (options.length === 2 ? 76 : 60);
    }
    return base + options.length * 43;
  }

  return {
    content: [{ type: "text", text: `已向用户展示选项卡片：${question}` }],
    details: {
      card: {
        type: "webview",
        route,
        title: question,
        description: `${question}｜请在下方点击选项`,
        aspectRatio: `400:${estimateCardHeight()}`,
      },
    },
  };
}
