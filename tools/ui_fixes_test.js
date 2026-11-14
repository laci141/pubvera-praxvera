// UI fixes test (Praxvera UI fixes 1): full abstract with a Read more / Show less
// toggle, one count per place, Enter to search, and the CSS fixes.
//
// Run: node tools/ui_fixes_test.js
//
//   A  the full abstract is rendered (no 200-char cut), the toggle button sits
//      after the abstract, hidden until applyAbsToggles finds an overflow, and
//      toggleAbs flips class, text and aria-expanded both ways;
//   B  .article-abstract.collapsed carries max-height + overflow, the base rule
//      does not;
//   E  results header "1,243 results" / "1 result"; meta text "Page X of Y" in
//      the normal render and in the "No TYPE articles on this page" case;
//   G  Enter in #queryInput runs doSearch; not while composing, not while
//      #searchBtn is disabled;
//   CSS margin, target sizes, footer colour, blur values, Sort By in the year grid.
//
// Same slicing as tools/pagination_test.js (script section run in a vm sandbox
// with a DOM shim) and tools/toolbar_wrap_test.js (CSS read as text). A section
// that cannot be found is a FAIL, never a silent pass.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let ran = 0, failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const start = html.indexOf("    function esc(s) {");
const end = html.indexOf("    function toggleAbs(btn) {");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the search section in index.html");
  process.exit(1);
}
const section = html.slice(start, end);
const fnSrc = name => {
  const m = new RegExp("^    function " + name + "\\([^)]*\\) \\{\\n[\\s\\S]*?\\n    \\}$", "m").exec(html);
  return m ? m[0] : "";
};

// ── DOM shim (as in pagination_test.js) ──
const escHTML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function makeEl() {
  const el = { value: "", disabled: false, style: {}, _text: "", _html: "", click() {} };
  Object.defineProperty(el, "textContent", {
    get() { return el._text; }, set(t) { el._text = String(t); el._html = escHTML(t); } });
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(h) { el._html = String(h); } });
  el.querySelector = () => null;
  return el;
}
const els = {};
const byId = id => (els[id] = els[id] || makeEl());
const CY = new Date().getFullYear();
const LONG = "Background " + "x".repeat(400) + " TAILMARK end of the abstract.";
let fakeTotal = 0;
let fakeAbstracts = [LONG];
let qsa = () => [];
// Fake timers: nothing fires until flushTimers(); delays are recorded.
const timers = new Map();
let timerSeq = 0;
function flushTimers() { const due = [...timers.values()]; timers.clear(); due.forEach(t => t.fn()); }
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, RegExp, Error, parseInt, isNaN,
  alert: m => { throw new Error("unexpected alert: " + m); },
  setTimeout: (fn, ms) => { timers.set(++timerSeq, { fn, ms }); return timerSeq; },
  clearTimeout: id => { timers.delete(id); },
  window: {},
  fetch: async () => ({
    ok: true, status: 200,
    json: async () => ({ total: fakeTotal, page: 1, articles: fakeAbstracts.map((ab, i) => (
      { title: "Trial " + i, authors: "Smith J", authors_full: "John Smith", journal: "NEJM",
        article_type: "article", year: 2020, citations: 10, doi: "10.1056/x" + i, url: "https://doi.org/10.1056/x" + i,
        is_oa: false, abstract: ab })) }),
  }),
  document: {
    getElementById: byId,
    querySelector: sel => (sel === ".search-panel" ? { scrollIntoView() {} } : null),
    querySelectorAll: sel => qsa(sel),
    addEventListener: () => {},
    createElement: () => makeEl(),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#search-section" });
const run = code => vm.runInContext(code, sandbox);
// A missing function is a FAIL of its own checks, not an abort of the rest.
const tryRun = code => { try { return run(code); } catch (e) { return "threw: " + e.message; } };

async function render(total, abstracts, perPage = 20) {
  fakeTotal = total;
  fakeAbstracts = abstracts;
  byId("queryInput").value = "";
  byId("fromYearSelect").value = "2014";
  byId("toYearSelect").value = String(CY);
  byId("perPageSlider").value = String(perPage);
  byId("sortSelect").value = "cited";
  await run("doSearch()");
  return byId("resultArea").innerHTML;
}

// ── CSS helpers (as in toolbar_wrap_test.js) ──
const styleOpen = /<style\b[^>]*>/.exec(html);
const style = html.slice(styleOpen ? styleOpen.index + styleOpen[0].length : -1, html.indexOf("</style>"))
  .replace(/\/\*[^]*?\*\//g, "");
function mediaSplit(css, headRe) {
  const re = new RegExp(headRe.source, "g");
  const bodies = [];
  let rest = "", last = 0, m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    bodies.push(css.slice(re.lastIndex, i - 1));
    rest += css.slice(last, m.index);
    last = i;
    re.lastIndex = i;
  }
  return { bodies, rest: rest + css.slice(last) };
}
function decls(css, sel) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(",").map(s => s.trim()).includes(sel)).map(m => m[2]).join(";");
}
const flat = d => d.replace(/\s+/g, "");
const base = mediaSplit(style, /@media[^{]*\{/).rest;
const narrow = mediaSplit(style, /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/).bodies.join("\n");
const has = (d, decl) => new RegExp("(^|;)" + decl.replace(/[().*]/g, "\\$&") + "(;|$)").test(flat(d));

(async () => {
  // ── A: full abstract, button outside, hidden until it overflows ──
  const page = await render(1243, [LONG, ""]);
  const cards = page.split('<div class="article-card">').slice(1);
  check("A1 two cards rendered (found " + cards.length + ")", cards.length === 2);
  const c0 = cards[0] || "", c1 = cards[1] || "";
  check("A1 the full abstract is rendered (TAILMARK present)", c0.indexOf("TAILMARK end of the abstract.") >= 0);
  check("A1 no 200-char cut and no '...' suffix", c0.indexOf(LONG.substring(0, 200) + "...") < 0 && c0.indexOf("...") < 0);
  const btnRe = /<button type="button" class="expand-btn" data-action="toggleAbs" aria-expanded="false" aria-controls="abs-0" hidden>Read more<\/button>/;
  check("A3 abstract div carries id=\"abs-0\"", /<div class="article-abstract collapsed" id="abs-0">/.test(c0));
  check("A3 the button follows the abstract div, outside it",
    /<div class="article-abstract collapsed" id="abs-0">[^<]*TAILMARK[^<]*<\/div>\s*<button type="button" class="expand-btn"/.test(c0) && btnRe.test(c0));
  check("A6 empty abstract: no id, no button", /<div class="article-abstract collapsed">\s*<\/div>/.test(c1) &&
    c1.indexOf("expand-btn") < 0 && c1.indexOf("abs-1") < 0);

  // applyAbsToggles: unhides only a button whose abstract overflows.
  const mkBtn = id => ({ hidden: true, getAttribute: n => (n === "aria-controls" ? id : null) });
  const mkAbs = (scrollHeight, clientHeight, collapsed = true) =>
    ({ scrollHeight, clientHeight, classList: { contains: c => c === "collapsed" && collapsed } });
  const over = mkBtn("abs-o"), fits = mkBtn("abs-f"), edge = mkBtn("abs-e");
  els["abs-o"] = mkAbs(195, 68);
  els["abs-f"] = mkAbs(50, 50);
  els["abs-e"] = mkAbs(69, 68);
  let asked = "";
  qsa = sel => { asked = sel; return [over, fits, edge]; };
  tryRun("applyAbsToggles()");
  qsa = () => [];
  check("A4 applyAbsToggles queries #resultArea .expand-btn[aria-controls] (got " + asked + ")",
    asked === "#resultArea .expand-btn[aria-controls]");
  check("A4 overflowing abstract (195 > 68 + 1): button shown", over.hidden === false);
  check("A4 abstract that fits (50 = 50): button stays hidden", fits.hidden === true);
  check("A4 1 px rounding (69 = 68 + 1): button stays hidden", edge.hidden === true);
  check("A4 renderResults calls applyAbsToggles after applyCiteWidths",
    /applyCiteWidths\(\);\n\s*applyAbsToggles\(\);/.test(section));

  // ── R: re-evaluation in both directions, and on a width change ──
  // (a) collapsed, button visible, content now fits -> hidden.
  const ra = Object.assign(mkBtn("abs-ra"), { hidden: false });
  els["abs-ra"] = mkAbs(68, 68);
  // (b) collapsed, button hidden, content now overflows -> shown.
  const rb = mkBtn("abs-rb");
  els["abs-rb"] = mkAbs(195, 68);
  // (c) expanded by the user: no overflow, "Show less" visible -> left alone.
  const rcAttrs = { "aria-controls": "abs-rc", "aria-expanded": "true" };
  const rc = { hidden: false, textContent: "Show less", getAttribute: n => rcAttrs[n],
    setAttribute: (n, v) => { rcAttrs[n] = String(v); } };
  els["abs-rc"] = mkAbs(195, 195, false);
  qsa = () => [ra, rb, rc];
  tryRun("applyAbsToggles()");
  qsa = () => [];
  check("Ra collapsed abstract that now fits (68 = 68): visible button hidden", ra.hidden === true);
  check("Rb collapsed abstract that now overflows (195 > 69): hidden button shown", rb.hidden === false);
  check("Rc expanded abstract: Show less button stays visible, text and aria-expanded unchanged",
    rc.hidden === false && rc.textContent === "Show less" && rcAttrs["aria-expanded"] === "true");

  // (d) / (e): onViewportResize, debounced, width changes only.
  const hasResize = tryRun("typeof onViewportResize") === "function";
  check("Rd onViewportResize is defined in the search section", hasResize);
  if (hasResize) {
    run("var __absRuns = 0; var __absReal = applyAbsToggles; applyAbsToggles = function () { __absRuns++; return __absReal(); };");
    timers.clear();
    sandbox.window.innerWidth = 1366;
    run("__absReal()");                       // last evaluated at 1366 px
    sandbox.window.innerWidth = 360;          // rotation / window resize
    run("onViewportResize(); onViewportResize(); onViewportResize();");
    const pending = [...timers.values()];
    check("Rd 3 resize events -> nothing runs before the debounce (runs " + run("__absRuns") + ")", run("__absRuns") === 0);
    check("Rd 3 resize events -> one pending 150 ms timer (pending " + pending.length + ", ms " +
      pending.map(t => t.ms).join(",") + ")", pending.length === 1 && pending[0].ms === 150);
    flushTimers();
    check("Rd width 1366 -> 360: applyAbsToggles ran exactly once after the debounce (runs " + run("__absRuns") + ")",
      run("__absRuns") === 1);
    run("__absRuns = 0");
    run("onViewportResize()");                // height-only: width still 360
    flushTimers();
    check("Re same innerWidth (height-only resize): applyAbsToggles does not run (runs " + run("__absRuns") + ")",
      run("__absRuns") === 0);
    run("applyAbsToggles = __absReal");
  } else {
    check("Rd/Re onViewportResize can be driven", false);
  }

  // (f) exactly one resize listener, on window, outside the delegated document block.
  const resizeRegs = [...html.matchAll(/(\w+)\.addEventListener\(\s*(["'])resize\2\s*,\s*(\w+)\s*\)/g)];
  const anyResize = (html.match(/addEventListener\(\s*["']resize["']/g) || []).length;
  const dAt = html.indexOf("    // ── Delegated data-action listeners");
  check("Rf exactly one \"resize\" listener in index.html (found " + anyResize + ")",
    anyResize === 1 && resizeRegs.length === 1);
  check("Rf it is window.addEventListener('resize', onViewportResize), not on document",
    resizeRegs.length === 1 && resizeRegs[0][1] === "window" && resizeRegs[0][3] === "onViewportResize");
  check("Rf it sits outside the search-section slice and before the delegated document block",
    resizeRegs.length === 1 && resizeRegs[0].index >= end && dAt > 0 && resizeRegs[0].index < dAt);

  // ── A5 (c): toggleAbs flips class, text and aria-expanded both ways ──
  const tsrc = fnSrc("toggleAbs");
  check("A5 toggleAbs found in index.html", tsrc !== "");
  const cls = new Set(["article-abstract", "collapsed"]);
  const abs = { classList: { toggle: c => (cls.has(c) ? (cls.delete(c), false) : (cls.add(c), true)) } };
  const attrs = { "aria-controls": "abs-7", "aria-expanded": "false" };
  const btn = { textContent: "Read more", getAttribute: n => attrs[n], setAttribute: (n, v) => { attrs[n] = String(v); } };
  const tsb = { document: { getElementById: id => (id === "abs-7" ? abs : null) } };
  vm.createContext(tsb);
  try { vm.runInContext(tsrc, tsb); } catch (e) { /* reported below */ }
  if (typeof tsb.toggleAbs === "function") {
    tsb.toggleAbs(btn);
    check("A5 first click: collapsed removed, \"Show less\", aria-expanded true",
      !cls.has("collapsed") && btn.textContent === "Show less" && attrs["aria-expanded"] === "true");
    tsb.toggleAbs(btn);
    check("A5 second click: collapsed back, \"Read more\", aria-expanded false",
      cls.has("collapsed") && btn.textContent === "Read more" && attrs["aria-expanded"] === "false");
  } else {
    check("A5 toggleAbs runs in a sandbox", false);
  }
  check("A5 expandAbs is gone from index.html", html.indexOf("expandAbs") < 0);

  // ── B: collapsed carries the clamp, the base rule does not ──
  const absBase = decls(base, ".article-abstract"), absCol = decls(base, ".article-abstract.collapsed");
  check("B base .article-abstract has no max-height and no overflow:hidden",
    !/max-height/.test(absBase) && !/overflow\s*:\s*hidden/.test(absBase));
  check("B .article-abstract.collapsed has max-height:calc(1.6em*3) and overflow:hidden",
    has(absCol, "max-height:calc(1.6em*3)") && has(absCol, "overflow:hidden"));

  // ── E (d): header and meta strings ──
  check("E resultsHeaderText(1243) = \"1,243 results\" (got " + tryRun("resultsHeaderText(1243)") + ")",
    tryRun("resultsHeaderText(1243)") === "1,243 results");
  check("E resultsHeaderText(1) = \"1 result\" (got " + tryRun("resultsHeaderText(1)") + ")",
    tryRun("resultsHeaderText(1)") === "1 result");
  check("E total 1243: header \"1,243 results\"", page.indexOf('<div class="results-header">1,243 results</div>') >= 0);
  check("E total 1243, 20 per page: meta \"Page 1 of 63\"", page.indexOf('<span class="meta">Page 1 of 63<span class="qcount">') >= 0);
  check("E no \"total results\", \"showing\" or \" total · \" left", !/total results|showing|total ·/.test(page));
  const one = await render(1, [LONG]);
  check("E total 1: header \"1 result\"", one.indexOf('<div class="results-header">1 result</div>') >= 0);
  check("E total 1: meta \"Page 1 of 1\"", one.indexOf('<span class="meta">Page 1 of 1<span class="qcount">') >= 0);
  await render(1243, [LONG]);
  run("currentType = 'review'; refreshView();");
  const none = byId("resultArea").innerHTML;
  check("E no-type case keeps its header", none.indexOf('<div class="results-header">No review articles on this page.</div>') >= 0);
  check("E no-type case meta \"Page 1 of 63\"", none.indexOf('<span class="meta">Page 1 of 63<span class="qcount">') >= 0);

  // ── G (e): Enter in #queryInput ──
  const MARK = "    // ── Delegated data-action listeners";
  const bAt = html.indexOf(MARK), bEnd = html.indexOf("\n  </script>", bAt);
  const block = bAt >= 0 && bEnd > bAt ? html.slice(bAt, bEnd) : "";
  check("G delegated listener block found", block !== "");
  function keyHarness(disabled) {
    const calls = [];
    const L = {};
    const spy = n => (...a) => { calls.push([n, ...a]); };
    const ks = {
      document: {
        getElementById: id => (id === "searchBtn" ? { disabled } : null),
        addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); },
      },
      window: {},
      doSearch: spy("doSearch"), prefill: spy("prefill"), toggleAbs: spy("toggleAbs"), copyBibtex: spy("copyBibtex"),
      pageNav: spy("pageNav"), pubveraSignIn: spy("pubveraSignIn"), applyTypeFilter: spy("applyTypeFilter"),
      applySort: spy("applySort"),
    };
    vm.createContext(ks);
    vm.runInContext(block, ks);
    const key = (k, id, composing) => {
      const e = { key: k, isComposing: composing, target: { id, dataset: {} }, prevented: false,
        preventDefault() { e.prevented = true; } };
      (L.keydown || []).forEach(f => f(e));
      return e;
    };
    return { calls, key };
  }
  let h = keyHarness(false), e = h.key("Enter", "queryInput", false);
  check("G Enter in #queryInput -> doSearch() once, preventDefault",
    JSON.stringify(h.calls) === '[["doSearch"]]' && e.prevented);
  h = keyHarness(true); e = h.key("Enter", "queryInput", false);
  check("G Enter while #searchBtn is disabled does nothing", h.calls.length === 0 && !e.prevented);
  h = keyHarness(false); e = h.key("Enter", "queryInput", true);
  check("G Enter while composing (isComposing) does nothing", h.calls.length === 0 && !e.prevented);
  h = keyHarness(false); e = h.key("a", "queryInput", false);
  check("G another key does nothing", h.calls.length === 0 && !e.prevented);
  h = keyHarness(false); e = h.key("Enter", "perPageSlider", false);
  check("G Enter in another field does nothing", h.calls.length === 0 && !e.prevented);

  // ── CSS (f) ──
  check("C .results-header margin-top:24px", has(decls(base, ".results-header"), "margin-top:24px"));
  check("C .qsort min-height:44px", has(decls(base, ".qsort"), "min-height:44px"));
  check("C .qfilter min-height:44px", has(decls(base, ".qfilter"), "min-height:44px"));
  const pdl = decls(base, ".pager .dl");
  check("C .pager .dl min-height:44px and min-width:44px", has(pdl, "min-height:44px") && has(pdl, "min-width:44px"));
  const eb = decls(base, ".expand-btn");
  check("C .expand-btn min-height:24px with vertical padding",
    has(eb, "min-height:24px") && /(^|;)padding:[1-9]\d*px0(;|$)/.test(flat(eb)));
  check("C .dl-trigger stays min-height:44px", has(decls(base, ".dl-trigger"), "min-height:44px"));
  check("K .footer color:#94a3b8", has(decls(base, ".footer"), "color:#94a3b8"));
  for (const sel of [".search-panel", ".article-card"]) {
    const d = decls(base, sel);
    check("L " + sel + " backdrop-filter and -webkit-backdrop-filter blur(15px)",
      has(d, "backdrop-filter:blur(15px)") && has(d, "-webkit-backdrop-filter:blur(15px)") && !/blur\(18px\)/.test(d));
  }
  const ec = decls(narrow, ".errcard");
  check("L .errcard blur(11px) with both properties inside @media (max-width:768px)",
    has(ec, "backdrop-filter:blur(11px)") && has(ec, "-webkit-backdrop-filter:blur(11px)"));

  // ── F: Sort By in the same grid as the year selects ──
  const gAt = html.indexOf('<div class="search-grid');
  let gEnd = -1;
  if (gAt >= 0) {
    const re = /<div\b|<\/div>/g;
    re.lastIndex = gAt;
    let depth = 0, m;
    while ((m = re.exec(html))) { depth += m[0] === "</div>" ? -1 : 1; if (depth === 0) { gEnd = re.lastIndex; break; } }
  }
  const grid = gEnd > 0 ? html.slice(gAt, gEnd) : "";
  check("F one search-grid in the markup (found " + (html.match(/class="search-grid[ "]/g) || []).length + ")",
    (html.match(/class="search-grid[ "]/g) || []).length === 1);
  check("F fromYearSelect, toYearSelect and sortSelect are inside the same grid",
    ["fromYearSelect", "toYearSelect", "sortSelect"].every(id => grid.indexOf('id="' + id + '"') >= 0));
  check("F that grid carries search-grid-3", /^<div class="search-grid search-grid-3">/.test(grid));
  check("F .search-grid-3 is repeat(3,minmax(0,1fr))",
    has(decls(base, ".search-grid-3"), "grid-template-columns:repeat(3,minmax(0,1fr))"));
  check("F @media (max-width:768px) .search-grid stays one column",
    has(decls(narrow, ".search-grid"), "grid-template-columns:1fr"));

  if (ran === 0) {
    console.error("FAIL: zero checks ran - refusing to pass silently");
    process.exit(1);
  }
  console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("FAIL: " + (e && e.stack || e)); process.exit(1); });
