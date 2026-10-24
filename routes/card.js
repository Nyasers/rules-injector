// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/card.js — 选项卡片（原声律 v0.2.4 迁入：≤3 横排、>3 竖列、自定义输入、跳过）
// 0.8.7（薄 iframe 厚服务端）：卡片数据落库 data.db option_cards 表，route 只带 id（/card?id=<cardId>）。
// GET /card 带 id → 服务端查库 SSR 渲染完整卡片（未消费可点 / 已消费锁定 / 过期失效）；
// 无 id → 降级为 hash 自包含壳（0.8.7 前旧卡片，iframe JS 从 location.hash 解析动态渲染）。
// POST /card/choose 接收点击/输入/跳过，优先以库中 q/p 构造回传文本，经 deferred 通道投递为
// 后台事件（custom_message，display:false 模型可见界面隐身）并触发父回合唤醒 agent；
// resolve 成功后在库中标记消费（UPDATE ... WHERE ts IS NULL 条件更新，幂等防重）。
// 严格模式（不传 allowLegacy）：空/未知 cardId 一律 400 拒绝，不接受 legacy 参数投递
// （防攻击者构造 body {question, sessionPath} 向任意会话投递任意内容；受信工具入口见 lib/option-submit.js）。
// busy 由宿主托管（30s 补投，点击一次必达）；register/resolve 失败直接报错（方案 B，不降级）。
const TTL_MS = 24 * 60 * 60 * 1000;
import { StateDb } from "../lib/db.js";
import { submitOption } from "../lib/option-submit.js";

// db 懒单例（模块级，照 sidebar.js 模式；与 tools/index 各自持有实例，同一 data.db，SQLite 多连接安全）
let _db = null;
function getDb(ctx) {
  if (!_db) {
    _db = new StateDb(ctx.dataDir);
    _db.init(); // 失败抛错，由调用方容错
  }
  return _db;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// 卡片样式（SSR 与降级壳共用）
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

/* ── 横排（≤3 个）：按选项数动态分列，块面更饱满 ── */
body.oc-layout-h .oc-list { display: grid; gap: 10px; }
body.oc-cols-2 .oc-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
body.oc-cols-3 .oc-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
body.oc-layout-h .oc-row {
  display: flex; align-items: center; justify-content: center;
  min-height: 60px;
  margin: 0; padding: 12px 12px;
  background: transparent;
  border: 0.5px solid var(--border, #D8CFBE);
  border-radius: 8px;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 14px; font-weight: 500; text-align: center;
  color: var(--text, #2A2622);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
body.oc-cols-2 .oc-row { min-height: 76px; font-size: 15.5px; }
body.oc-layout-h .oc-row:hover { background: var(--accent-light, rgba(83,125,150,0.08)); border-color: var(--accent, #537D96); }
body.oc-layout-h .oc-row:disabled { cursor: default; }
body.oc-layout-h .oc-row.oc-picked {
  background: var(--accent-light, rgba(83,125,150,0.08));
  border-color: var(--accent, #537D96);
  color: var(--accent-hover, #3F6179);
}
body.oc-layout-h .oc-row:not(.oc-picked):disabled { opacity: 0.35; }
body.oc-layout-h .oc-idx, body.oc-layout-h .oc-arrow { display: none; }
/* label 必须可收缩：flex-basis:auto 取 max-content（整行不换行宽度）+ flex-shrink:0 会导致长文本溢出按钮边界、三列互相叠印；
   min-width:0 允许收缩到内容以下，文本在按钮内换行（flex item 默认 min-width:auto 是 min-content，长词仍会撑破） */
body.oc-layout-h .oc-label { flex: 1 1 auto; min-width: 0; white-space: normal; word-break: break-word; }

/* ── 竖排（>3 个）：目录列表 ── */
body.oc-layout-v .oc-list { display: flex; flex-direction: column; }
body.oc-layout-v .oc-row {
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
body.oc-layout-v .oc-list .oc-row:last-child { border-bottom: none; }
body.oc-layout-v .oc-row:hover { background: var(--accent-light, rgba(83,125,150,0.08)); }
body.oc-layout-v .oc-row:disabled { cursor: default; }
body.oc-layout-v .oc-row.oc-picked {
  background: var(--accent-light, rgba(83,125,150,0.08));
  border-left-color: var(--accent, #537D96);
  color: var(--accent-hover, #3F6179);
}
body.oc-layout-v .oc-row:not(.oc-picked):disabled { opacity: 0.35; }
body.oc-layout-v .oc-idx { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--text-muted, #6B6158); min-width: 20px; flex: none; }
body.oc-layout-v .oc-label { flex: 1 1 auto; min-width: 0; word-break: break-word; }
body.oc-layout-v .oc-arrow { width: 13px; height: 13px; color: var(--text-muted, #6B6158); flex: none; transition: color 0.15s ease; }
body.oc-layout-v .oc-row:hover .oc-arrow, body.oc-layout-v .oc-row.oc-picked .oc-arrow { color: var(--accent, #537D96); }

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

// 尺寸上报脚本（SSR 各态共用）：宿主 iframe 高度由卡片内 JS 通过 postMessage 动态上报（ui.resize）。
// 首次渲染与 load 时各报一次，ResizeObserver 持续跟踪动态高度（错误状态条等）。
// renderActive / legacyShell 内置同逻辑（交互脚本内联），此常量供静态态（consumed/invalid）注入：
// 这两态无交互 JS，若不上报尺寸，刷新后宿主只能依赖创建时 aspectRatio 的估算高度，
// 实际渲染高度与估算的偏差（custom 态输入框回填、按钮文本变长等）会把内容顶出 iframe 视口，出现滚动条（0.8.9）。
const SIZE_REPORT_JS = `<script>
(function () {
  function reportSize() {
    var h = Math.ceil(document.body ? document.body.scrollHeight : 0);
    if (!h || h < 24) h = 24;
    var w = Math.max(document.body ? document.body.scrollWidth : 0, 24);
    try {
      window.parent.postMessage(
        { protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { width: w, height: h } },
        "*"
      );
    } catch (e) {}
  }
  if (window.ResizeObserver) {
    new ResizeObserver(reportSize).observe(document.body);
  }
  reportSize();
  window.addEventListener("load", reportSize);
})();
</script>`;

// SSR 渲染：未消费可点卡片（薄 iframe 厚服务端，JS 只剩点击/反馈/锁定，无 hash 解析无 replaceState）
function renderActive(hcLink, card) {
  let options;
  try {
    options = JSON.parse(card.o);
  } catch {
    options = null;
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
    return renderInvalid(hcLink, "卡片数据异常");
  }
  const layout = options.length > 3 ? "v" : "h";
  const ARROW =
    '<svg class="oc-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  const btnHtml = options
    .map(
      (opt, i) =>
        `<button class="oc-row" data-v="${esc(String(opt))}" aria-label="选择 ${esc(String(opt))}">` +
        `<span class="oc-idx">${String(i + 1).padStart(2, "0")}</span>` +
        `<span class="oc-label">${esc(String(opt))}</span>${ARROW}</button>`,
    )
    .join("");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>选项卡片</title>
${hcLink}
<style>${OC_CSS}</style>
</head>
<body class="oc-layout-${layout}${layout === "h" ? ` oc-cols-${options.length}` : ""}">
<div class="oc-card">
  <div class="oc-q" id="oc-q">${esc(card.q)}</div>
  <div class="oc-list" id="oc-list">${btnHtml}</div>
  <div class="oc-custom">
    <div class="oc-custom-row">
      <input class="oc-custom-input" id="oc-custom-input" type="text" maxlength="200" placeholder="输入你的答案…" aria-label="自定义答案">
    </div>
  </div>
  <div class="oc-extras">
    <button class="oc-custom-send" id="oc-custom-send">发送</button>
    <button class="oc-extra" id="oc-skip-btn" aria-label="跳过">
      跳过
    </button>
  </div>
  <div id="oc-status" class="oc-status" style="display:none"><span class="oc-dot"></span><span id="oc-status-text"></span></div>
</div>
<script>
(function () {
  var qEl = document.getElementById("oc-q");
  var question = qEl ? qEl.textContent : "";
  var surfaceSession = new URLSearchParams(location.search).get("pluginSurfaceSession");
  var cardId = new URLSearchParams(location.search).get("id");
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

  // 反馈策略：正常路径反馈文本顶掉触发按钮（零新增高度）；错误路径（busy/失败）显示底部状态条，
  // 靠 ResizeObserver 上报动态拓展高度。消费状态由服务端落库（0.8.7），重载后 SSR 直接渲染锁定态。
  function submit(value, mode, fbLabel) {
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
    fetch("card/choose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hana-Plugin-Surface-Session": surfaceSession || ""
      },
      body: JSON.stringify({ cardId: cardId, choice: value, mode: mode, question: question })
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (data.ok) {
        if (fbLabel) fbLabel.textContent = mode === "skip" ? "已跳过" : "已发送 · " + value;
      } else {
        if (fbLabel) fbLabel.textContent = "发送失败";
        setStatus("发送失败：" + (data.error || "unknown"), "err");
      }
    }).catch(function (e) {
      if (fbLabel) fbLabel.textContent = "发送失败";
      setStatus("发送失败：" + e.message, "err");
    });
  }

  document.querySelectorAll(".oc-row").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (picked) return;
      btn.classList.add("oc-picked");
      submit(btn.getAttribute("data-v"), "option", btn.querySelector(".oc-label"));
    });
  });
  sendBtn.addEventListener("click", function () {
    if (picked) return;
    var v = customInput.value.trim();
    if (!v) return;
    submit(v, "custom", sendBtn);
  });
  customInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      sendBtn.click();
    }
  });
  skipBtn.addEventListener("click", function () {
    if (picked) return;
    submit("", "skip", skipBtn);
  });

  function reportSize() {
    var h = Math.ceil(document.body ? document.body.scrollHeight : 0);
    if (!h || h < 24) h = 24;
    var w = Math.max(document.body ? document.body.scrollWidth : 0, 24);
    try {
      window.parent.postMessage(
        { protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { width: w, height: h } },
        "*"
      );
    } catch (e) {}
  }
  if (window.ResizeObserver) {
    new ResizeObserver(reportSize).observe(document.body);
  }
  reportSize();
  window.addEventListener("load", reportSize);
})();
</script>
</body>
</html>`;
}

// SSR 渲染：已消费锁定态（静态，无交互 JS）——保留按钮区，复刻客户端 submit() 成功回调后的 DOM 形态（0.8.8）：
//   option：选中按钮 oc-picked + label 替换为「已发送 · value」，其余按钮禁用；
//   custom：按钮全禁用，发送按钮变绿显示「已发送 · value」（.oc-fb），跳过按钮隐藏，输入框保留已提交内容；
//   skip：按钮全禁用，跳过按钮变绿显示「已跳过」，发送按钮隐藏。
// 与「刚回复完」的客户端锁定态同形，刷新后不再跳变（无论 iframe 是否重载，两条路径收敛同一形态）。
// 兜底：选项数据异常或 option 值匹配不到选项时，退化为纯状态行（q + 已发送/已跳过）。
function renderConsumed(hcLink, card) {
  const q = card.q;
  const mode =
    card.mode === "custom" || card.mode === "skip" ? card.mode : "option";
  const value = typeof card.value === "string" ? card.value : "";
  let options = null;
  try {
    const o = JSON.parse(card.o);
    if (Array.isArray(o) && o.length >= 2 && o.length <= 6) options = o;
  } catch {
    options = null;
  }
  const label = mode === "skip" ? "已跳过" : "已发送 · " + value;

  let bodyClass = "";
  let bodyInner = "";
  if (options && !(mode === "option" && !options.includes(value))) {
    const layout = options.length > 3 ? "v" : "h";
    bodyClass = ` class="oc-layout-${layout}${layout === "h" ? ` oc-cols-${options.length}` : ""}"`;
    const ARROW =
      '<svg class="oc-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
    const rows = options
      .map((opt, i) => {
        const picked = mode === "option" && opt === value;
        const labelText = picked ? label : opt;
        return (
          `<button class="oc-row${picked ? " oc-picked" : ""}" disabled aria-label="${picked ? "已选择 " : "选择 "}${esc(opt)}">` +
          `<span class="oc-idx">${String(i + 1).padStart(2, "0")}</span>` +
          `<span class="oc-label">${esc(labelText)}</span>${ARROW}</button>`
        );
      })
      .join("");
    const customVal = mode === "custom" ? ` value="${esc(value)}"` : "";
    const sendHide = mode === "skip" ? ' style="display:none"' : "";
    const skipHide = mode === "custom" ? ' style="display:none"' : "";
    bodyInner = `<div class="oc-card">
  <div class="oc-q">${esc(q)}</div>
  <div class="oc-list">${rows}</div>
  <div class="oc-custom">
    <div class="oc-custom-row">
      <input class="oc-custom-input" type="text" maxlength="200" placeholder="输入你的答案…" aria-label="自定义答案" disabled${customVal}>
    </div>
  </div>
  <div class="oc-extras">
    <button class="oc-custom-send${mode === "custom" ? " oc-fb" : ""}" id="oc-custom-send" disabled${sendHide}>${mode === "custom" ? esc(label) : "发送"}</button>
    <button class="oc-extra${mode === "skip" ? " oc-fb" : ""}" id="oc-skip-btn" disabled${skipHide}>${mode === "skip" ? "已跳过" : "跳过"}</button>
  </div>
</div>`;
  } else {
    bodyInner = `<div class="oc-card">
  <div class="oc-q">${esc(q)}</div>
  <div class="oc-status ok"><span class="oc-dot"></span>${esc(label)}</div>
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>选项卡片</title>
${hcLink}
<style>${OC_CSS}</style>
</head>
<body${bodyClass}>
${bodyInner}
${SIZE_REPORT_JS}
</body>
</html>`;
}

// SSR 渲染：失效/异常（静态，无交互 JS）——仅尺寸上报
function renderInvalid(hcLink, msg) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>选项卡片</title>
${hcLink}
<style>${OC_CSS}</style>
</head>
<body>
<div class="oc-card">
  <div class="oc-q">${esc(msg)}</div>
  <div class="oc-status"><span class="oc-dot"></span>卡片已失效或不存在</div>
</div>
${SIZE_REPORT_JS}
</body>
</html>`;
}

// 降级壳：无 id（0.8.7 前旧卡片，hash 自包含），iframe JS 从 location.hash 解析数据动态渲染。
// 保留原消费标记逻辑（u/v/m 写回 hash）——仅降级路径使用。
function legacyShell(hcLink) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>选项卡片</title>
${hcLink}
<style>${OC_CSS}</style>
</head>
<body>
<div class="oc-card">
  <div class="oc-q" id="oc-q"></div>
  <div class="oc-list" id="oc-list"></div>
  <div class="oc-custom">
    <div class="oc-custom-row">
      <input class="oc-custom-input" id="oc-custom-input" type="text" maxlength="200" placeholder="输入你的答案…" aria-label="自定义答案">
    </div>
  </div>
  <div class="oc-extras">
    <button class="oc-custom-send" id="oc-custom-send">发送</button>
    <button class="oc-extra" id="oc-skip-btn" aria-label="跳过">
      跳过
    </button>
  </div>
  <div id="oc-status" class="oc-status" style="display:none"><span class="oc-dot"></span><span id="oc-status-text"></span></div>
</div>
<script>
(function () {
  var TTL = 24 * 60 * 60 * 1000;
  var surfaceSession = new URLSearchParams(location.search).get("pluginSurfaceSession");
  var statusEl = document.getElementById("oc-status");
  var statusText = document.getElementById("oc-status-text");
  var customInput = document.getElementById("oc-custom-input");
  var skipBtn = document.getElementById("oc-skip-btn");
  var sendBtn = document.getElementById("oc-custom-send");
  var picked = false;

  var payload = location.hash.slice(1);
  var data = null;
  try { data = JSON.parse(decodeURIComponent(payload)); } catch (e) { data = null; }
  var question = (data && typeof data.q === "string") ? data.q : "";
  var options = (data && Array.isArray(data.o))
    ? data.o.filter(function (x) { return typeof x === "string" && x.trim(); })
    : [];
  var created = (data && Number(data.c)) || 0;
  var sessionPath = (data && typeof data.p === "string") ? data.p : "";

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

  var consumed = false;
  var cMode = "option";
  var cValue = "";
  try {
    consumed = !!(data && data.u === 1);
    if (consumed) {
      cMode = data && data.m === "skip" ? "skip" : "option";
      cValue = data && typeof data.v === "string" ? data.v : "";
    }
  } catch (e) {}
  var invalid = !question || options.length < 2 || options.length > 6 || !created || Date.now() - created > TTL;
  if (consumed) {
    document.getElementById("oc-q").textContent = question || "选项卡片";
    setStatus(cMode === "skip" ? "已跳过" : "已发送 · " + cValue, "ok");
    lockAll();
  } else if (invalid) {
    document.getElementById("oc-q").textContent = "选项卡片已失效";
    lockAll();
  } else {
    document.getElementById("oc-q").textContent = question;
    var layout = options.length > 3 ? "v" : "h";
    document.body.className = "oc-layout-" + layout + (layout === "h" ? " oc-cols-" + options.length : "");
    var list = document.getElementById("oc-list");
    var ARROW = '<svg class="oc-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
    options.forEach(function (opt, i) {
      var btn = document.createElement("button");
      btn.className = "oc-row";
      btn.setAttribute("data-v", opt);
      btn.setAttribute("aria-label", "选择 " + opt);
      var idx = document.createElement("span");
      idx.className = "oc-idx";
      idx.textContent = String(i + 1).padStart(2, "0");
      var label = document.createElement("span");
      label.className = "oc-label";
      label.textContent = opt;
      btn.appendChild(idx);
      btn.appendChild(label);
      btn.insertAdjacentHTML("beforeend", ARROW);
      list.appendChild(btn);
    });
    document.querySelectorAll(".oc-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (picked) return;
        btn.classList.add("oc-picked");
        submit(btn.getAttribute("data-v"), "option", btn.querySelector(".oc-label"));
      });
    });
  }

  // 消费标记（0.7.16，仅降级路径）：发送成功后 history.replaceState 把 u=1 + 回复内容写回 URL hash。
  function markConsumed(value, mode) {
    try {
      var payload = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      payload.u = 1;
      payload.v = typeof value === "string" ? value.slice(0, 200) : "";
      payload.m = mode === "skip" || mode === "custom" ? mode : "option";
      history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify(payload)));
    } catch (e) {}
  }

  function submit(value, mode, fbLabel) {
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
    fetch("card/choose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hana-Plugin-Surface-Session": surfaceSession || ""
      },
      body: JSON.stringify({ choice: value, mode: mode, question: question, sessionPath: sessionPath })
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (data.ok) {
        markConsumed(value, mode);
        if (fbLabel) fbLabel.textContent = mode === "skip" ? "已跳过" : "已发送 · " + value;
      } else {
        if (fbLabel) fbLabel.textContent = "发送失败";
        setStatus("发送失败：" + (data.error || "unknown"), "err");
      }
    }).catch(function (e) {
      if (fbLabel) fbLabel.textContent = "发送失败";
      setStatus("发送失败：" + e.message, "err");
    });
  }

  sendBtn.addEventListener("click", function () {
    if (picked) return;
    var v = customInput.value.trim();
    if (!v) return;
    submit(v, "custom", sendBtn);
  });
  customInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      sendBtn.click();
    }
  });
  skipBtn.addEventListener("click", function () {
    if (picked) return;
    submit("", "skip", skipBtn);
  });

  function reportSize() {
    var h = Math.ceil(document.body ? document.body.scrollHeight : 0);
    if (!h || h < 24) h = 24;
    var w = Math.max(document.body ? document.body.scrollWidth : 0, 24);
    try {
      window.parent.postMessage(
        { protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { width: w, height: h } },
        "*"
      );
    } catch (e) {}
  }
  if (window.ResizeObserver) {
    new ResizeObserver(reportSize).observe(document.body);
  }
  reportSize();
  window.addEventListener("load", reportSize);
})();
</script>
</body>
</html>`;
}

export default function (app, ctx) {
  app.get("/card", async (c) => {
    const hanaCss = c.req.query("hana-css") || "";
    const hcLink = hanaCss
      ? `<link rel="stylesheet" href="${esc(hanaCss)}">`
      : "";
    const cardId = (c.req.query("id") || "").trim();

    // 无 id → 降级壳（旧卡片 hash 自包含）；hash 不随 HTTP 请求发送，服务端拿不到，只能靠 query
    if (!cardId) return c.html(legacyShell(hcLink));

    // 有 id → SSR：查库渲染（薄 iframe 厚服务端）
    let card = null;
    try {
      card = getDb(ctx).getCard(cardId);
    } catch {
      card = null;
    } // db 不可用
    if (!card) return c.html(renderInvalid(hcLink, "卡片不存在或已失效"));
    if (Date.now() - card.c > TTL_MS)
      return c.html(renderInvalid(hcLink, "卡片已失效"));
    if (card.ts != null) return c.html(renderConsumed(hcLink, card));
    return c.html(renderActive(hcLink, card));
  });

  app.post("/card/choose", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
    // 0.10.1：回传逻辑收敛到 lib/option-submit.js（route 与交互卡 binding 共用）；
    // 不传 opts → 严格模式：空/未知 cardId 由 submitOption 返回 validation_error → 400
    const r = await submitOption(ctx, body || {});
    if (!r.ok) {
      const status = r.code === "validation_error" ? 400 : 500;
      return c.json({ ok: false, error: r.error, code: r.code || null }, status);
    }
    return c.json({ ok: true });
  });
}
