// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/option-card.js — 对话内选项卡片
// 0.10.1（新前端兼容改造）：不再返回 details.card（webview 插件卡 → 新前端聊天流是占位壳），
// 改为落库 + 返回一段完整交互卡 HTML 片段（details.option_card.html）。Agent 拿到该片段后
// 交给 show_card 渲染成聊天内交互卡（Interactive 形态，两代机制一致、始终内嵌），
// 用户点击经 host bridge 调用 option_choose 工具回传（deferred 通道唤醒，见 option-choose.js）。
// 后续（片段版能力对齐 SSR renderActive）：把 routes/card.js 的 OC_CSS 全量与 renderActive 的
// 渲染/交互能力搬进片段版 —— 统一竖排（oc-layout-v 目录列表）、
// 自定义输入（Enter/发送）、跳过、oc-picked 选中 + 锁定 + 状态条反馈；回传从声明式 data-invoke
// 改为手动 window.card.invoke（按响应显示状态并锁定），自定义 choice 经 manifest slots 传动态值。
// 兼容：旧 webview 卡（/card?id=）仍由 routes/card.js SSR 渲染（renderActive/Consumed/Invalid
// 保留），只是本工具不再产出 webview 卡。
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
  "创建一张聊天内交互式选项卡：用户点击选项 / 输入自定义 / 跳过，选择即回传。\n" +
  '返回纯 JSON（content：{"cardId", "question", "options", "layout", "chooseTool"}），\n' +
  'Agent 拿到后调用 show_card(template="rules-injector-option-card/assets/option-card.card.html", state={cardId, question, options}) 铸造，\n' +
  "用户点击后经 host bridge 调 option_choose 工具，把选择经后台通道投递为 Markdown 消息\n" +
  "（大标题「# 选项卡片」立身份，下分「## 问题」与「## 回答」两个小标题各带正文）进入当前会话。\n\n" +
  "何时使用（自动触发的触发契约）：\n" +
  "- 需要用户在多个方案 / 选项中选一个（A/B、吃什么、哪个风格、哪个时间）\n" +
  "- 需要用户确认是否执行某个操作（是 / 否 / 稍后）\n" +
  "- 任何需要用户拍板、做决策或给偏好的场景\n" +
  "- 即使只有 2 个选项（是/否），也要用本工具（不要用纯文字让用户打字回复）\n\n" +
  "何时不使用：\n" +
  "- 没有决策点、只是陈述或提问\n" +
  "- 答案只有一个可能（普通对话即可）\n" +
  "- 主要是采集自由长文本（卡片带自定义输入仅作备选，选项仍是主体）\n\n" +
  "参数：question 为问题本身（简洁，卡片标题），options 为 2~6 个候选选项——" +
  "统一竖排（目录列表）。卡片同时提供自定义输入与「跳过」入口，\n" +
  "选择即锁卡防重（mode=custom / mode=skip 与点选同等回传）。\n\n" +
  "回传消息为 Markdown 标题结构：『# 选项卡片 / ## 问题 / ## 回答 <内容>』。\n" +
  "收到含「选项」标题的 Markdown 消息时，应视为用户做出的选择，继续执行对应分支；\n" +
  "回答正文为「跳过，不做选择」时视为放弃决策，不追问。";

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
      description:
        "候选选项（2~6 个），竖排渲染为可点击按钮；卡片同时带自定义输入与跳过入口",
    },
  },
  required: ["question", "options"],
};

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// 卡片样式（与 routes/card.js 的 OC_CSS 同源全量；fragment 无 <body>，布局 class 挂在根 div，
// 原 body.oc-layout-*/body.oc-cols-* 选择器改写为 .oc-card.oc-layout-*/.oc-card.oc-cols-*）
const OC_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--font-serif, 'Noto Serif SC', serif); background: transparent; padding: 0; }
.oc-card {
  background: transparent;
  border: none; /* 宿主 webview 容器自带描边，不再自画，避免双线重叠 */
  border-radius: var(--radius-chat-card, 4px);
  padding: 16px 18px 12px;
}
.oc-q { font-size: 18px; font-weight: 500; line-height: 1.5; color: var(--text, #2A2622); margin-bottom: 14px; }
.oc-status { margin-top: 14px; display: flex; align-items: center; gap: 7px; min-height: 16px; font-family: var(--font-ui, system-ui, sans-serif); font-size: 12px; color: var(--text-muted, #6B6158); }
.oc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border, #D8CFBE); flex: none; }
.oc-status.busy { color: var(--text-light, #4A433C); }
.oc-status.busy .oc-dot { background: var(--accent, #537D96); }
.oc-status.ok { color: var(--green, #4A6B4A); }
.oc-status.ok .oc-dot { background: var(--green, #4A6B4A); }
.oc-status.err { color: var(--danger, #8B2C1F); }
.oc-status.err .oc-dot { background: var(--danger, #8B2C1F); }

/* ── 竖排：目录列表 ── */
.oc-card.oc-layout-v .oc-list { display: flex; flex-direction: column; }
.oc-card.oc-layout-v .oc-row {
  display: flex; align-items: center; justify-content: center; gap: 14px; width: 100%;
  padding: 13px 18px;
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  border-bottom: 0.5px solid var(--border, #D8CFBE);
  border-radius: 0;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 13.5px; font-weight: 500; text-align: left;
  color: var(--text, #2A2622);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.oc-card.oc-layout-v .oc-list .oc-row:last-child { border-bottom: none; }
.oc-card.oc-layout-v .oc-row:hover { background: var(--accent-light, rgba(83,125,150,0.08)); }
.oc-card.oc-layout-v .oc-row:disabled { cursor: default; }
.oc-card.oc-layout-v .oc-row.oc-picked {
  background: var(--accent-light, rgba(83,125,150,0.08));
  border-left-color: var(--accent, #537D96);
  color: var(--accent-hover, #3F6179);
}
.oc-card.oc-layout-v .oc-row:not(.oc-picked):disabled { opacity: 0.35; }
.oc-card.oc-layout-v .oc-idx { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--text-muted, #6B6158); min-width: 20px; flex: none; }
.oc-card.oc-layout-v .oc-label { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.oc-card.oc-layout-v .oc-arrow { width: 13px; height: 13px; color: var(--text-muted, #6B6158); flex: none; transition: color 0.15s ease; }
.oc-card.oc-layout-v .oc-row:hover .oc-arrow, .oc-card.oc-layout-v .oc-row.oc-picked .oc-arrow { color: var(--accent, #537D96); }

/* ── 次级入口：自定义输入 / 跳过 ── */
.oc-extras {
  display: flex; align-items: center; gap: 30px;
  margin-top: 8px; padding-top: 8px;
  border-top: 0.5px solid var(--border, #D8CFBE);
}
.oc-extra {
  display: inline-flex; align-items: center; gap: 12px;
  background: transparent; border: none;
  padding: 10px 4px;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 28px; font-weight: 500;
  color: var(--text-muted, #6B6158);
  cursor: pointer;
  transition: color 0.15s ease;
}
.oc-extra:hover { color: var(--accent, #537D96); }
.oc-extra:disabled { cursor: default; opacity: 0.4; }
.oc-extra svg { width: 28px; height: 28px; flex: none; }
#oc-skip-btn {
  flex: none;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 14px; font-weight: 500;
  color: #FFF7EE;
  background: var(--danger, #C0392B);
  border: none;
  border-radius: 8px;
  padding: 8px 18px;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
#oc-skip-btn:hover { opacity: 0.85; }
#oc-skip-btn:disabled { opacity: 0.4; cursor: default; }
/* id 选择器特异性高于 .oc-fb，需 id+class 双选器才能盖过按钮底色 */
#oc-custom-send.oc-fb, #oc-skip-btn.oc-fb {
  flex: none;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 13px; font-weight: 500;
  color: var(--green, #4A6B4A);
  background: transparent;
  border: none;
  padding: 8px 4px;
  cursor: default;
}
.oc-custom { margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--border, #D8CFBE); }
.oc-custom-row { display: flex; gap: 8px; }
.oc-custom-input {
  flex: 1; min-width: 0;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 14px; color: var(--text, #2A2622);
  background: transparent;
  border: 0.5px solid var(--border, #D8CFBE);
  border-radius: var(--radius-chat-card, 4px);
  padding: 11px 14px;
  outline: none;
  transition: border-color 0.15s ease;
}
.oc-custom-input:focus { border-color: var(--accent, #537D96); }
.oc-custom-input::placeholder { color: var(--text-muted, #6B6158); }
.oc-custom-send {
  flex: none;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 14px; font-weight: 500;
  color: var(--bg-card, #FBF7EE);
  background: var(--accent, #537D96);
  border: none;
  border-radius: 8px;
  padding: 8px 18px;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.oc-custom-send:hover { opacity: 0.85; }
.oc-custom-send:disabled { opacity: 0.4; cursor: default; }
`;

// 交互脚本（手动 window.card.invoke 版，替代声明式 data-invoke）：
// 点击选项 → oc-picked + 锁定全部 + label「正在发送…」→「已发送 · value」；自定义 Enter/发送 →
// invoke custom 并传 {choice: 输入值}（slots 允许键）；跳过 → invoke skip →「已跳过」；
// invoke 失败信封 {ok:false, code, error} → label 置「发送失败」+ 状态条 oc-status.err。
const INTERACTION_JS = `(function () {
  var statusEl = document.getElementById("oc-status");
  var statusText = document.getElementById("oc-status-text");
  var customInput = document.getElementById("oc-custom-input");
  var skipBtn = document.getElementById("oc-skip-btn");
  var sendBtn = document.getElementById("oc-custom-send");
  var picked = false;

  function setStatus(text, cls) {
    statusEl.style.display = "flex";
    statusText.textContent = text;
    statusEl.className = "oc-status" + (cls ? " " + cls : "");
  }
  function lockAll() {
    document.querySelectorAll(".oc-row").forEach(function (b) { b.disabled = true; });
    skipBtn.disabled = true;
    sendBtn.disabled = true;
    customInput.disabled = true;
  }

  // 反馈策略：正常路径反馈文本顶掉触发按钮（零新增高度）；错误路径显示底部状态条 oc-status.err。
  // 消费闸门（已消费幂等）在 option_choose 侧（submitOption 返回 alreadyConsumed），此处只按
  // invoke 返回 ok 判定成功。binding 的 input 为固定参数，slots 列表内的键允许运行时传
  // （不能覆盖固定键）：自定义输入 extra={choice: v} 走 custom binding 的 slots:["choice"]。
  function submit(bindingId, value, mode, fbLabel, extra) {
    if (picked) return;
    picked = true;
    lockAll();
    if (fbLabel) {
      fbLabel.textContent = "正在发送…";
      statusEl.style.display = "none";
      if (fbLabel === sendBtn || fbLabel === skipBtn) {
        fbLabel.classList.add("oc-fb");
        (fbLabel === sendBtn ? skipBtn : sendBtn).style.display = "none";
      }
    }
    if (!window.card || typeof window.card.invoke !== "function") {
      if (fbLabel) fbLabel.textContent = "发送失败";
      setStatus("发送失败：交互桥不可用", "err");
      return;
    }
    // 先入 Promise 再调 invoke：同步抛错也落入 catch，统一按失败信封/异常处理
    Promise.resolve().then(function () {
      return window.card.invoke(bindingId, extra || {});
    }).then(function (data) {
      if (data && data.ok) {
        if (fbLabel) fbLabel.textContent = mode === "skip" ? "已跳过" : "已发送 · " + value;
      } else {
        if (fbLabel) fbLabel.textContent = "发送失败";
        setStatus("发送失败：" + ((data && (data.error || data.code)) || "unknown"), "err");
      }
    }).catch(function (e) {
      if (fbLabel) fbLabel.textContent = "发送失败";
      setStatus("发送失败：" + (e && e.message ? e.message : String(e)), "err");
    });
  }

  document.querySelectorAll(".oc-row").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (picked) return;
      btn.classList.add("oc-picked");
      submit(btn.getAttribute("data-binding"), btn.getAttribute("data-v"), "option", btn.querySelector(".oc-label"), {});
    });
  });
  sendBtn.addEventListener("click", function () {
    if (picked) return;
    var v = customInput.value.trim();
    if (!v) return;
    submit("custom", v, "custom", sendBtn, { choice: v });
  });
  customInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      sendBtn.click();
    }
  });
  skipBtn.addEventListener("click", function () {
    if (picked) return;
    submit("skip", "", "skip", skipBtn, {});
  });
})();`;

// 生成聊天内交互卡 HTML 片段（show_card code）——与 routes/card.js renderActive 同构的能力搬移：
//   布局：统一竖排（oc-layout-v，目录列表）；
//   结构：oc-q + oc-list（选项按钮 oc-idx/oc-label/oc-arrow，oc-picked 由脚本加）
//        + oc-custom（input#oc-custom-input + 发送）+ oc-extras（发送 + 跳过#oc-skip-btn）
//        + oc-status（状态条，默认隐藏）。
//   交互：手动 window.card.invoke(bindingId, input)（替代声明式 data-invoke，以便按响应显示
//        状态并锁定）。manifest toolBindings：选项/skip 固定 input（cardId/choice/mode 不变），
//        自定义输入 binding 用 slots:["choice"] 传运行时动态 choice（slots 为运行时参数
//        allowlist，唯一非空字符串数组；不能覆盖固定键）。
function buildCardHtml({ cardId, question, options }) {
  const rootClass = "oc-card oc-layout-v";

  // manifest toolBindings：每个选项一个 binding id optN（固定 choice/mode）、skip 一个、custom 一个
  const bindings = {};
  options.forEach((opt, i) => {
    bindings["opt" + (i + 1)] = {
      tool: "rules-injector_option_choose",
      input: { cardId: cardId, choice: opt, mode: "option" },
    };
  });
  bindings.skip = {
    tool: "rules-injector_option_choose",
    input: { cardId: cardId, choice: "", mode: "skip" },
  };
  bindings.custom = {
    tool: "rules-injector_option_choose",
    input: { cardId: cardId, mode: "custom" },
    slots: ["choice"],
  };
  // JSON 内嵌进 <script> 标签：< 转义为 \u003c，防止选项文本里的 </script> 提前闭合脚本
  const manifestJson = JSON.stringify({ toolBindings: bindings }).replace(
    /</g,
    "\\u003c",
  );

  const ARROW =
    '<svg class="oc-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  const rows = options
    .map(
      (opt, i) =>
        '<button class="oc-row" data-binding="opt' +
        (i + 1) +
        '" data-v="' +
        esc(String(opt)) +
        '" aria-label="选择 ' +
        esc(String(opt)) +
        '">' +
        '<span class="oc-idx">' +
        String(i + 1).padStart(2, "0") +
        "</span>" +
        '<span class="oc-label">' +
        esc(String(opt)) +
        "</span>" +
        ARROW +
        "</button>",
    )
    .join("\n");

  return [
    "<style>" + OC_CSS + "</style>",
    '<script type="application/json" data-card-manifest>' +
      manifestJson +
      "</script>",
    '<div class="' + rootClass + '">',
    '  <div class="oc-q" id="oc-q">' + esc(question) + "</div>",
    '  <div class="oc-list" id="oc-list">' + rows + "</div>",
    '  <div class="oc-custom">',
    '    <div class="oc-custom-row">',
    '      <input class="oc-custom-input" id="oc-custom-input" type="text" maxlength="200" placeholder="输入你的答案…" aria-label="自定义答案">',
    "    </div>",
    "  </div>",
    '  <div class="oc-extras">',
    '    <button class="oc-custom-send" id="oc-custom-send">发送</button>',
    '    <button class="oc-extra" id="oc-skip-btn" aria-label="跳过">跳过</button>',
    "  </div>",
    '  <div id="oc-status" class="oc-status" style="display:none"><span class="oc-dot"></span><span id="oc-status-text"></span></div>',
    "</div>",
    "<script>" + INTERACTION_JS + "</script>",
  ].join("\n");
}

export async function execute(input, ctx) {
  const question = String(input.question || "").trim();
  const options = (Array.isArray(input.options) ? input.options : [])
    .map((o) => String(o).trim())
    .filter(Boolean)
    .slice(0, 6);

  if (!question) throw new Error("question is required");
  if (options.length < 2) throw new Error("at least 2 options required");

  const created = Date.now();
  const sessionPath = ctx.sessionPath || null;
  const cardId = createHash("sha256")
    .update(
      [question, options.join("\x00"), String(created), sessionPath || ""].join(
        "\x00",
      ),
    )
    .digest("hex")
    .slice(0, 16);
  try {
    const db = getDb(ctx);
    db.pruneCards(Date.now() - CARD_TTL_MS);
    db.createCard({
      cardId,
      q: question,
      o: JSON.stringify(options),
      c: created,
      p: sessionPath,
    });
  } catch (e) {
    /* db 不可用：不落库，回传时靠参数降级 */
  }

  const html = buildCardHtml({ cardId, question, options });

  // 纯 JSON 返回（content 可被 Agent 直接读取）：Agent 拿到后经宿主 recipe（rules-injector-option-card）
  // 铸造，show_card(template, state={cardId, question, options})。details 保留 html 与旧字段兼容旧流程。
  const payload = {
    cardId,
    question,
    options,
    layout: "v",
    chooseTool: "rules-injector_option_choose",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: {
      option_card: {
        ...payload,
        html,
      },
    },
  };
}
