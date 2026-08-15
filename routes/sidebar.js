// routes/sidebar.js — 规则注入器侧边栏（配置面板）· 文件化规则版（0.8.0）
// 数据源：数据目录 rules/（builtin 工作副本 + custom 用户区）+ data.db（全局开关）
// 开关 = 文件扩展名（.md ↔ .mdisabled）；custom 支持新增/编辑/删除；builtin 支持开关/编辑/恢复默认
// 内置自定义 = 顶层同名自编覆盖（优先级高于 builtin）；恢复默认 = 移除覆盖 + 副本回归种子，开关态保持
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StateDb } from "../lib/db.js";
import { seedBuiltin, scanRules, toggleRule, deleteRuleFile, resetRuleToSeed, findRuleFile, loadEffectiveRules, normalizeHeading, ENABLED_EXT, DISABLED_EXT } from "../lib/rules-fs.js";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SEED_DIR = path.join(PLUGIN_ROOT, "rules");

// db 懒单例（模块级，跨请求复用；插件重载后重建）
let _db = null;
function getDb(ctx) {
  if (!_db) {
    _db = new StateDb(ctx.dataDir);
    _db.init(); // 失败抛错，由调用方容错
  }
  return _db;
}

// 规则目录：builtin 子目录 = 内置工作副本；顶层 = 用户自编区（默认语义优先于 builtin）
function dirs(ctx) {
  const rulesDir = path.join(ctx.dataDir, "rules");
  return { rulesDir, builtin: path.join(rulesDir, "builtin"), custom: rulesDir };
}

// 分组数据（确保播种）：builtin/custom 各自完整列表（含禁用态）；fullText = 文件原文（编辑用）
function collectGroups(ctx) {
  const d = dirs(ctx);
  seedBuiltin(SEED_DIR, d.builtin, d.custom);
  const withText = (rules) => rules.map((r) => {
    try { return { ...r, fullText: fs.readFileSync(path.join(dirFor(d, r.source), r.filename), "utf8") }; }
    catch { return r; }
  });
  const builtin = withText(scanRules(d.builtin, "builtin"));
  const custom = withText(scanRules(d.custom, "custom"));
  // 同名覆盖标记 + 内置行编辑预填：已有同名自编时用自编内容（继续编辑上次的版本）
  const customByKey = new Map(custom.map((r) => [r.key, r]));
  return [
    { source: "builtin", rules: builtin.map((r) => {
      const ov = customByKey.get(r.key);
      return ov ? { ...r, overridden: true, fullText: ov.fullText ?? r.fullText } : r;
    }) },
    { source: "custom", rules: custom },
  ];
}

function dirFor(d, source) {
  return source === "custom" ? d.custom : d.builtin;
}

function ruleDirFor(ctx, source) {
  const d = dirs(ctx);
  return source === "custom" ? d.custom : d.builtin;
}

function globalEnabled(ctx) {
  const db = getDb(ctx);
  return db.getMeta("global_enabled") !== "0";
}

const WIDGET_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--font-ui, system-ui, sans-serif); color: var(--text, #2A2622); background: transparent; }
.card { background: var(--bg-card, #FBF7EE); padding: 24px 20px 18px; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.title { display: flex; align-items: center; gap: 8px; font-family: var(--font-serif, serif); font-size: 16px; font-weight: 500; color: var(--text, #2A2622); letter-spacing: 0.04em; }
.t-icon { width: 17px; height: 17px; color: var(--accent, #537D96); flex: none; }
.badge { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted, #6B6158); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent, #537D96); }
.dot.off { background: var(--border, #D8CFBE); }
.grp { padding: 15px 0; }
.grp + .grp { border-top: 0.5px solid var(--border, #D8CFBE); }
.grp-label { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-muted, #6B6158); letter-spacing: 0.14em; margin-bottom: 11px; }
.grp-label::after { content: ""; flex: 1; height: 0.5px; background: var(--border, #D8CFBE); }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--text-light, #4A433C); }
.row-t { line-height: 1.4; }
.sw { position: relative; display: inline-block; width: 34px; height: 19px; flex: none; }
.sw input { opacity: 0; width: 0; height: 0; }
.sl { position: absolute; inset: 0; border-radius: 10px; background: var(--border, #D8CFBE); transition: background .15s; cursor: pointer; }
.sl:before { content: ""; position: absolute; width: 15px; height: 15px; left: 2px; top: 2px; border-radius: 50%; background: #FFFDF7; box-shadow: 0 1px 2px rgba(42,38,34,.18); transition: transform .15s; }
.sw input:checked + .sl { background: var(--accent, #537D96); }
.sw input:checked + .sl:before { transform: translateX(15px); }
.rule { border: 0.5px solid var(--border, #D8CFBE); border-radius: var(--radius-chat-card, 4px); margin-bottom: 9px; }
.rule-h { display: flex; align-items: center; gap: 6px; padding: 10px 12px; font-size: 12.5px; color: var(--text-light, #4A433C); cursor: pointer; user-select: none; }
.rule-h .arr { width: 11px; height: 11px; color: var(--text-muted, #6B6158); transition: transform .15s; flex: none; }
.rule.open .rule-h .arr { transform: rotate(90deg); }
.rule-h .r-title { flex: 1; }
.rule-h .r-title.off { color: var(--text-muted, #6B6158); }
.tag { font-size: 9.5px; padding: 1px 5px; border-radius: 2px; background: var(--accent-light, rgba(83,125,150,.08)); color: var(--accent-hover, #3F6179); }
.tag.ov { background: rgba(157,95,77,.08); color: #9D5F4D; }
.rule-b { display: none; padding: 0 12px 12px; }
.rule.open .rule-b { display: block; }
.rule-b textarea { width: 100%; min-height: 96px; border: 0.5px solid var(--border, #D8CFBE); border-radius: var(--radius-chat-card, 4px); background: transparent; color: var(--text, #2A2622); padding: 8px 10px; font-size: 11.5px; font-family: inherit; line-height: 1.6; resize: vertical; }
.rule-b textarea:focus { outline: none; border-color: var(--accent, #537D96); }
.rule-b .fname { font-size: 10.5px; color: var(--text-muted, #6B6158); margin: 6px 2px 6px; font-family: var(--font-mono, monospace); }
.btns { display: flex; gap: 8px; }
.btn { flex: 1; padding: 7px 0; font-size: 12px; font-weight: 500; font-family: var(--font-serif, serif); border: 0.5px solid var(--border, #D8CFBE); border-radius: var(--radius-chat-card, 4px); background: transparent; color: var(--accent, #537D96); cursor: pointer; text-align: center; letter-spacing: 0.06em; transition: background .15s; }
.btn:hover { background: var(--accent-light, rgba(83,125,150,.08)); }
.btn.danger { color: var(--danger, #8B2C1F); }
#newWrap input { width: 100%; border: 0.5px solid var(--border, #D8CFBE); border-radius: var(--radius-chat-card, 4px); background: transparent; color: var(--text, #2A2622); padding: 8px 10px; font-size: 11.5px; font-family: inherit; }
.new input:focus { outline: none; border-color: var(--accent, #537D96); }
.hint { font-size: 10.5px; color: var(--text-muted, #6B6158); margin-top: 8px; line-height: 1.6; }
.st { font-size: 11px; color: var(--text-muted, #6B6158); min-height: 15px; line-height: 1.5; margin-top: 12px; text-align: center; letter-spacing: 0.04em; }
.empty { font-size: 11.5px; color: var(--text-muted, #6B6158); padding: 4px 0; }
`;

const WIDGET_JS = `
(function(){
"use strict";
var base = window.location.pathname.replace(/\\/sidebar\\/?$/, "") || "/api/plugins/rules-injector";
var q = window.location.search || "";
var $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function setSt(msg){ $("st").textContent = msg || ""; }

function render(d){
  var enabled = d.config && d.config.enabled !== false;
  $("gEnabled").checked = enabled;
  $("dot").className = "dot" + (enabled ? "" : " off");
  $("badgeText").textContent = enabled ? "注入中" : "已暂停";
  $("rules").innerHTML = renderGroups(d.groups || []);
  bindGroups(d.groups || []);
}

function renderGroups(groups){
  var html = "";
  for (var gi = 0; gi < groups.length; gi++){
    var g = groups[gi];
    html += '<div class="grp" data-source="' + esc(g.source) + '"><div class="grp-label">' + (g.source === "builtin" ? "内置规则" : "自定义规则") + '</div>';
    var list = g.rules || [];
    if (!list.length) html += '<div class="empty">（无）</div>';
    for (var i = 0; i < list.length; i++){
      var r = list[i];
      html += '<div class="rule" data-key="' + esc(r.key) + '" data-source="' + esc(r.source) + '">'
        + '<div class="rule-h">'
        + '<svg class="arr" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2l4 4-4 4"/></svg>'
        + '<span class="r-title' + (r.enabled ? "" : " off") + '">' + esc(r.title) + '</span>'
        + (r.overridden ? '<span class="tag ov">被覆盖</span>' : "")
        + '<label class="sw" onclick="event.stopPropagation()"><input type="checkbox" data-toggle="1" data-key="' + esc(r.key) + '" data-source="' + esc(r.source) + '"' + (r.enabled ? " checked" : "") + '><span class="sl"></span></label>'
        + '</div>'
        + '<div class="rule-b">'
        + '<div class="fname">' + esc(r.filename) + '</div>'
        + '<textarea data-edit="' + esc(r.key) + '">' + esc(r.fullText || "") + '</textarea><div class="btns" style="margin-top:8px"><div class="btn" data-save="' + esc(r.key) + '">保存</div>'
        + (g.source === "custom" ? '<div class="btn danger" data-del="' + esc(r.key) + '">删除</div>' : '<div class="btn danger" data-restore="' + esc(r.key) + '">恢复默认</div>')
        + '</div>'
        + '</div>'
        + '</div>';
    }
    html += '</div>';
  }
  return html;
}

function bindGroups(groups){
  var hs = document.querySelectorAll(".rule-h");
  for (var i = 0; i < hs.length; i++){
    hs[i].addEventListener("click", function(){ this.parentNode.classList.toggle("open"); });
  }
  var toggles = document.querySelectorAll("[data-toggle]");
  for (var j = 0; j < toggles.length; j++){
    toggles[j].addEventListener("change", function(){
      fetch(base + "/sidebar/rules/toggle" + q, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: this.getAttribute("data-source"), key: this.getAttribute("data-key"), enabled: this.checked })
      })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d && d.ok) { setSt("已保存"); reload(); } else setSt("保存失败"); })
      .catch(function(){ setSt("保存失败"); });
    });
  }
  var saves = document.querySelectorAll("[data-save]");
  for (var k = 0; k < saves.length; k++){
    saves[k].addEventListener("click", function(){
      var key = this.getAttribute("data-save");
      var ta = document.querySelector('textarea[data-edit="' + CSS.escape(key) + '"]');
      fetch(base + "/sidebar/rules/save" + q, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key, content: ta ? ta.value : "" })
      })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d && d.ok) { setSt("已保存"); reload(); } else setSt(d && d.error ? d.error : "保存失败"); })
      .catch(function(){ setSt("保存失败"); });
    });
  }
  var dels = document.querySelectorAll("[data-del]");
  for (var m = 0; m < dels.length; m++){
    dels[m].addEventListener("click", function(){
      var key = this.getAttribute("data-del");
      fetch(base + "/sidebar/rules/delete" + q, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key })
      })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d && d.ok) { setSt("已删除"); reload(); } else setSt("删除失败"); })
      .catch(function(){ setSt("删除失败"); });
    });
  }
  var restores = document.querySelectorAll("[data-restore]");
  for (var n = 0; n < restores.length; n++){
    restores[n].addEventListener("click", function(){
      var key = this.getAttribute("data-restore");
      if (!window.confirm("恢复默认将丢弃对该规则的全部修改，只改内容、保持当前开关状态。确定？")) return;
      fetch(base + "/sidebar/rules/restore" + q, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key })
      })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d && d.ok) { setSt("已恢复默认"); reload(); } else setSt("恢复失败"); })
      .catch(function(){ setSt("恢复失败"); });
    });
  }
}

function reload(){
  fetch(base + "/sidebar/data" + q)
    .then(function(r){ return r.json(); })
    .then(function(d){ if (d && d.ok) render(d); })
    .catch(function(){});
}

$("gEnabled").addEventListener("change", function(){
  fetch(base + "/sidebar/data" + q, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: this.checked })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){ if (d && d.ok) { render(d); setSt("已保存"); } else setSt("保存失败"); })
  .catch(function(){ setSt("保存失败"); });
});

$("btnCreate").addEventListener("click", function(){
  var name = $("newName").value.trim();
  var content = $("newContent").value;
  if (!name) { setSt("请填写规则名"); return; }
  fetch(base + "/sidebar/rules/create" + q, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name, content: content })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){ if (d && d.ok) { setSt("已创建"); $("newName").value = ""; $("newContent").value = ""; reload(); } else setSt(d && d.error ? d.error : "创建失败"); })
  .catch(function(){ setSt("创建失败"); });
});

try { parent.postMessage({ source: "hana-plugin", type: "ready" }, "*"); } catch(e){}
reload();
})();
`;

export default function (app, ctx) {
  app.get("/sidebar", (c) => {
    const th = c.req.query("hana-theme") || "inherit";
    const hanaCss = c.req.query("hana-css") || "";
    const hcLink = hanaCss ? `<link rel="stylesheet" href="${esc(hanaCss)}">` : "";
    return c.html(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${hcLink}
<style>${WIDGET_CSS}</style>
</head><body data-hana-theme="${th}" data-surface="widget">
<div class="card">
  <div class="head">
    <div class="title"><svg class="t-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>规则注入</div>
    <div class="badge"><span class="dot" id="dot"></span><span id="badgeText">注入中</span></div>
  </div>

  <div class="grp">
    <div class="grp-label">注入开关</div>
    <div class="row">
      <span class="row-t">新建会话时注入行为规则</span>
      <label class="sw"><input type="checkbox" id="gEnabled" checked><span class="sl"></span></label>
    </div>
    <div class="hint">注入规则以隐藏消息形式写入会话历史（界面不显示正文，模型每轮可见）；恢复旧会话不重复注入。</div>
  </div>

  <div class="grp" id="rulesWrap">
    <div id="rules"></div>
  </div>

  <div class="grp" id="newWrap">
    <div class="grp-label">新建自定义规则</div>
    <input id="newName" placeholder="规则名（即标题，如 卡片收尾规则）" maxlength="48" autocomplete="off">
    <textarea id="newContent" placeholder="规则要点（每行一条，- 开头；首行标题自动对齐规则名）" style="width:100%;min-height:72px;border:0.5px solid var(--border,#D8CFBE);border-radius:var(--radius-chat-card,4px);background:transparent;color:var(--text,#2A2622);padding:8px 10px;font-size:11.5px;font-family:inherit;line-height:1.6;resize:vertical;margin-top:8px"></textarea>
    <div class="btns" style="margin-top:8px"><div class="btn" id="btnCreate">创建规则</div></div>
  </div>

  <div class="grp">
    <div class="grp-label">说明</div>
    <div class="hint">规则开关 = 文件扩展名（.md 启用 / .mdisabled 停用）；内置与自定义规则均可编辑，内置规则编辑会生成同名自编覆盖（优先级更高），恢复默认移除覆盖并保持开关状态。</div>
  </div>

  <div class="st" id="st"></div>
</div>
<script>${WIDGET_JS}</script>
</body></html>`);
  });

  app.get("/sidebar/data", (c) => {
    try {
      return c.json({ ok: true, config: { enabled: globalEnabled(ctx) }, groups: collectGroups(ctx) });
    } catch (e) {
      return c.json({ ok: false, error: `未初始化: ${e?.message || e}` }, 500);
    }
  });

  app.post("/sidebar/data", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch {}
    try {
      const db = getDb(ctx);
      const enabled = body.enabled === true ? true : body.enabled === false ? false : globalEnabled(ctx);
      db.setMeta("global_enabled", enabled ? "1" : "0");
      return c.json({ ok: true, config: { enabled }, groups: collectGroups(ctx) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || e }, 500);
    }
  });

  app.post("/sidebar/rules/toggle", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch {}
    const { source, key, enabled } = body || {};
    if (typeof key !== "string" || !key.trim() || !/^[^\\\/:*?"<>|]{1,48}$/.test(key)) {
      return c.json({ ok: false, error: "key 非法" }, 400);
    }
    try {
      const d = dirs(ctx);
      const srcDir = ruleDirFor(ctx, source === "custom" ? "custom" : "builtin");
      const otherDir = srcDir === d.builtin ? d.custom : d.builtin;
      const ok = toggleRule(srcDir, key, !!enabled);
      // 被自定义过的内置规则：顶层同名覆盖与内置副本开关两处同步，避免恢复默认后生效状态跳变
      if (ok && findRuleFile(otherDir, key)) toggleRule(otherDir, key, !!enabled);
      return c.json({ ok, key, enabled: !!enabled });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || e }, 500);
    }
  });

  app.post("/sidebar/rules/save", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch {}
    const { key, content } = body || {};
    if (typeof key !== "string" || !/^[^\\\/:*?"<>|]{1,48}$/.test(key)) {
      return c.json({ ok: false, error: "key 非法" }, 400);
    }
    if (typeof content !== "string" || content.length > 50000) {
      return c.json({ ok: false, error: "内容非法" }, 400);
    }
    try {
      const d = dirs(ctx);
      const cFile = findRuleFile(d.custom, key);
      const bFile = findRuleFile(d.builtin, key);
      if (!cFile && !bFile) return c.json({ ok: false, error: "规则不存在" }, 404);
      // 保存恒写顶层自编区：custom 已有同名 → 更新；否则（内置规则）→ 新建同名自编覆盖（自定义内置规则），
      // 开关态跟随内置（内置禁用则覆盖也建为禁用态），首行标题自动对齐文件名
      const file = cFile || path.join(d.custom, key + (bFile.endsWith(DISABLED_EXT) ? DISABLED_EXT : ENABLED_EXT));
      fs.writeFileSync(file, normalizeHeading(content, key) + "\n", "utf8");
      return c.json({ ok: true, key, created: !cFile });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || e }, 500);
    }
  });

  app.post("/sidebar/rules/delete", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch {}
    const { key } = body || {};
    if (typeof key !== "string" || !/^[^\\\/:*?"<>|]{1,48}$/.test(key)) {
      return c.json({ ok: false, error: "key 非法" }, 400);
    }
    try {
      const ok = deleteRuleFile(ruleDirFor(ctx, "custom"), key);
      return c.json({ ok, key });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || e }, 500);
    }
  });

  app.post("/sidebar/rules/restore", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch {}
    const { key } = body || {};
    if (typeof key !== "string" || !/^[^\\\/:*?"<>|]{1,48}$/.test(key)) {
      return c.json({ ok: false, error: "key 非法" }, 400);
    }
    try {
      const d = dirs(ctx);
      const hadOverride = deleteRuleFile(d.custom, key); // 移除同名自编覆盖（若有）
      const ok = resetRuleToSeed(SEED_DIR, d.builtin, key); // 内置副本内容回归种子，开关态保持
      return c.json({ ok, key, removedOverride: hadOverride });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || e }, 500);
    }
  });

  app.post("/sidebar/rules/create", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch {}
    const { name, content } = body || {};
    if (typeof name !== "string" || !/^[^\\\/:*?"<>|]{1,48}$/.test(name)) {
      return c.json({ ok: false, error: "规则名非法（不含路径分隔符）" }, 400);
    }
    if (typeof content !== "string" || content.length > 50000) {
      return c.json({ ok: false, error: "内容非法" }, 400);
    }
    try {
      const customDir = ruleDirFor(ctx, "custom");
      fs.mkdirSync(customDir, { recursive: true });
      const file = path.join(customDir, name + ".md");
      if (fs.existsSync(file)) return c.json({ ok: false, error: "同名规则已存在" }, 409);
      fs.writeFileSync(file, normalizeHeading(content, name) + "\n", "utf8");
      return c.json({ ok: true, key: name });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || e }, 500);
    }
  });

  app.get("/sidebar/rules/active", (c) => {
    try {
      const { rules, stats } = loadEffectiveRules(SEED_DIR, path.join(ctx.dataDir, "rules"));
      return c.json({ ok: true, enabled: globalEnabled(ctx), rules, stats });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || e }, 500);
    }
  });
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
