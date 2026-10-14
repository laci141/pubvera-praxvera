// Export menu: the separate export buttons are ONE "Export" menu button (WAI-ARIA APG menu button pattern).
//
// Run: node tools/export_menu_test.js
//
// Behaviour test without a browser: metaRow() and the export-menu block are sliced out of index.html,
// metaRow()'s real markup is parsed into a tiny fake DOM, and the real listeners are driven with fake
// keyboard and click events. Layout (343/360 px, panel inside the viewport) is checked with Playwright.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }
// Source of a script-level function (indented 4 spaces), or "".
function fn(name) {
  const m = src.match(new RegExp("^    function " + name + "\\([^)]*\\)\\s*\\{[^]*?^    \\}", "m"));
  return m ? m[0] : "";
}

// ── tiny DOM: enough for the selectors the menu code uses ──
class El {
  constructor(tag, attrs) { this.tag = tag; this.attrs = attrs || {}; this.children = []; this.parent = null; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v) { if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get id() { return this.attrs.id || ""; }
  get dataset() {
    const d = {};
    for (const k in this.attrs) if (k.startsWith("data-")) d[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = this.attrs[k];
    return d;
  }
  get classList() { const c = (this.attrs.class || "").split(/\s+/); return { contains: x => c.includes(x) }; }
  focus() { doc.activeElement = this; }
  contains(o) { for (; o; o = o.parent) if (o === this) return true; return false; }
  all() { const out = []; const walk = e => e.children.forEach(c => { out.push(c); walk(c); }); walk(this); return out; }
  matches(sel) { return sel.split(",").some(s => matchChain(this, s.trim().split(/\s+/).filter(x => x !== ">"))); }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel) { return this.all().filter(e => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matchSimple(e, s) {
  if (!e) return false;
  const parts = s.match(/:not\(\[[^\]]+\]\)|\[[^\]]+\]|\.[\w-]+|^[a-z]+/g) || [];
  return parts.every(p => {
    if (p.startsWith(":not(")) return !matchSimple(e, p.slice(5, -1));
    if (p[0] === ".") return e.classList.contains(p.slice(1));
    if (p[0] === "[") {
      const m = p.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return m[2] === undefined ? e.hasAttribute(m[1]) : e.getAttribute(m[1]) === m[2];
    }
    return e.tag === p;
  });
}
function matchChain(e, parts) {
  if (!matchSimple(e, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;
  for (let a = e.parent; a; a = a.parent) if (matchChain(a, parts.slice(0, -1))) return true;
  return false;
}
function parse(html, root) {
  let cur = root;
  for (const m of html.matchAll(/<(\/?)(\w+)([^>]*)>/g)) {
    if (m[1]) { cur = cur.parent; continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? "" : a[2];
    const el = new El(m[2], attrs); el.parent = cur; cur.children.push(el);
    if (!/^(input|br|img)$/.test(m[2])) cur = el;
  }
}

const body = new El("body");
const listeners = { click: [], keydown: [] };
const doc = {
  activeElement: body, body,
  querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s),
  getElementById: id => body.all().find(e => e.id === id) || null,
  addEventListener: (t, f) => { if (listeners[t]) listeners[t].push(f); },
};
function fire(type, target, trusted, key) {
  const e = { type, target, key, isTrusted: trusted !== false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
  listeners[type].forEach(f => f(e));
  return e;
}
const anchor = new El("a"); anchor.parent = body; body.children.push(anchor);   // the synthetic download anchor
const calls = [];
// Each fake exporter clicks the detached download anchor, like triggerDownload() / XLSX.writeFile().
const exporter = fmt => (k, f) => { calls.push(fmt + " " + k + " " + f); fire("click", anchor, false); };
const sandbox = { document: doc, console,
  downloadXLSX: exporter("xlsx"), downloadCSV: exporter("csv"), downloadJSON: exporter("json"), downloadBibTeX: exporter("bib") };
vm.createContext(sandbox);

let html = "";
try {
  // The export-menu block (functions + listener registrations) sits right before metaRow().
  const a = src.indexOf("    // ── Export menu"), b = src.indexOf("    // Toolbar above the cards");
  if (a >= 0 && b > a) vm.runInContext(src.slice(a, b), sandbox);
  vm.runInContext(fn("metaRow"), sandbox);
  html = vm.runInContext("metaRow('3 shown','search','praxvera-search.json')", sandbox);
  parse(html, body);
} catch (e) { console.log("note: " + e.message); }

const triggers = body.querySelectorAll('[aria-haspopup="menu"]');
const trigger = triggers[0] || null;
const menu = trigger ? doc.getElementById(trigger.getAttribute("aria-controls")) : null;
const items = menu ? menu.querySelectorAll('[role="menuitem"]') : [];

check("E1 one trigger \"⬇ Export ▾\" with aria-haspopup=menu, aria-expanded=false, aria-controls -> hidden role=menu panel",
  triggers.length === 1 && trigger.tag === "button" && trigger.getAttribute("aria-expanded") === "false" &&
  /⬇ Export ▾<\/button>/.test(html) && !!menu && menu.getAttribute("role") === "menu" && menu.hidden);

const oldButtons = (html.match(/<button[^>]*class="dl"[^>]*>⬇ (BibTeX|Excel|CSV|JSON)</g) || []).length;
check("E2 menu has 4 role=menuitem buttons (Excel, CSV, JSON, BibTeX); no separate export buttons remain (" +
  items.length + " items, " + oldButtons + " old)",
  items.length === 4 && oldButtons === 0 && items.every(i => i.tag === "button" && i.getAttribute("type") === "button") &&
  ["Excel", "CSV", "JSON", "BibTeX"].every(l => new RegExp('role="menuitem"[^>]*>' + l + "<").test(html)));

const inlineOnclick = (html.match(/onclick=/g) || []).length;
check("E3 no inline onclick in the toolbar markup (" + inlineOnclick + ")", inlineOnclick === 0);

if (trigger) { trigger.focus(); fire("click", trigger); }
check("E4 click on the trigger opens the menu, sets aria-expanded=true and focuses the first item",
  !!menu && !menu.hidden && trigger.getAttribute("aria-expanded") === "true" && doc.activeElement === items[0]);

let nav = false;
if (items.length) {
  fire("keydown", doc.activeElement, true, "ArrowDown");
  const d1 = doc.activeElement === items[1];
  fire("keydown", doc.activeElement, true, "End");
  const end = doc.activeElement === items[items.length - 1];
  fire("keydown", doc.activeElement, true, "ArrowDown");
  const wrapDown = doc.activeElement === items[0];
  fire("keydown", doc.activeElement, true, "ArrowUp");
  const wrapUp = doc.activeElement === items[items.length - 1];
  fire("keydown", doc.activeElement, true, "Home");
  nav = d1 && end && wrapDown && wrapUp && doc.activeElement === items[0];
}
check("E5 ArrowDown/ArrowUp cycle with wrap, Home/End jump", nav);

if (items.length) fire("keydown", doc.activeElement, true, "Escape");
check("E6 Escape closes the menu, sets aria-expanded=false and returns focus to the trigger",
  !!menu && menu.hidden && trigger.getAttribute("aria-expanded") === "false" && doc.activeElement === trigger);

if (trigger) fire("keydown", trigger, true, "ArrowDown");
const arrowOpen = !!menu && !menu.hidden && trigger.getAttribute("aria-expanded") === "true" && doc.activeElement === items[0];
if (items.length) fire("keydown", doc.activeElement, true, "Tab");
check("E7 ArrowDown on the trigger opens and focuses the first item; Tab closes",
  arrowOpen && !!menu && menu.hidden && trigger.getAttribute("aria-expanded") === "false");

if (trigger) fire("click", trigger);
fire("click", anchor, false);
const keptOpen = !!menu && !menu.hidden;
fire("click", body, true);
check("E8 outside trusted click closes; untrusted click (download anchor) is ignored",
  keptOpen && !!menu && menu.hidden && trigger.getAttribute("aria-expanded") === "false");

// Every item downloads its format with the right file, closes the menu and returns focus to the opener.
const got = [];
const okDl = items.length === 4 && items.every(it => {
  fire("click", trigger);
  doc.activeElement = body;   // WebKit: a mouse click does not focus the button
  calls.length = 0;
  fire("click", it);
  got.push(calls.join("+"));
  return calls.length === 1 && menu.hidden && trigger.getAttribute("aria-expanded") === "false" && doc.activeElement === trigger;
});
const want = ["xlsx search praxvera-search.xlsx", "csv search praxvera-search.csv",
  "json search praxvera-search.json", "bib search praxvera-search.bib"];
check("E9 each item calls its exporter once, closes the menu and returns focus to the trigger (" + got.join(" | ") + ")",
  okDl && want.every(w => got.includes(w)));

// CSS: classes used by the markup exist; panel colour, position, touch targets.
const style = src.slice(src.indexOf("<style"), src.indexOf("</style>")).replace(/\/\*[^]*?\*\//g, "");
const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ sel: m[1].split(",").map(s => s.trim()), body: m[2].replace(/\s+/g, "") }));
const used = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
const missing = [...used].filter(c => !new RegExp("\\." + c + "(?![\\w-])").test(style));
check("E10 every class used by the toolbar/menu markup exists in the CSS (missing: " + (missing.join(",") || "none") + ")",
  used.size > 0 && missing.length === 0);

const panel = rules.filter(r => r.sel.includes(".dl-menu")).map(r => r.body).join(";");
const bg = (panel.match(/(?:^|;)background(?:-color)?:[^;]+/g) || []).pop() || "";
const bgM = bg.match(/:rgba\(\d+,\d+,\d+,(0?\.\d+)\)$/);
check("E11 .dl-menu background is one solid rgba with alpha 0.90, no gradient (\"" + bg.replace(/^;/, "") + "\")",
  !!bgM && Math.abs(parseFloat(bgM[1]) - 0.9) < 1e-9 && !/gradient/.test(panel));
check("E12 .dl-menu is position:absolute, right:0, has a z-index and max-width:calc(100vw - 32px)",
  /position:absolute/.test(panel) && /(^|;)right:0/.test(panel) && /z-index:\d+/.test(panel) &&
  /max-width:calc\(100vw-32px\)/.test(panel));
const trig = rules.filter(r => r.sel.includes(".dl-trigger")).map(r => r.body).join(";");
const item = rules.filter(r => r.sel.includes('.dl-menu [role="menuitem"]')).map(r => r.body).join(";");
check("E13 touch targets: trigger min-height and min-width 44px, menu items min-height 44px",
  /min-height:44px/.test(trig) && /min-width:44px/.test(trig) && /min-height:44px/.test(item));

console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
