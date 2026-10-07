// Pagination test: OpenAlex basic paging stops at 10,000 results, so the pager
// must never offer a page beyond that, and says so when the total exceeds it.
//
// Run: node tools/pagination_test.js
//
// The helpers and the pager live inline in index.html; this test slices the
// script section out (same slice as tools/export_test.js) and executes it in a
// vm sandbox with a minimal DOM shim, then drives the real doSearch -> render
// path for several totals / page sizes.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf("    function esc(s) {");
const end = html.indexOf("    function expandAbs(btn) {");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the search section in index.html");
  process.exit(1);
}
const section = html.slice(start, end);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const NOTE = "OpenAlex allows paging through the first 10,000 results. Refine the search to see more.";

// ── DOM shim ──
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
let fakeTotal = 0;
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, RegExp, Error, parseInt, isNaN,
  alert: m => { throw new Error("unexpected alert: " + m); },
  window: {},
  fetch: async () => ({
    ok: true, status: 200,
    json: async () => ({ total: fakeTotal, page: 1, articles: [
      { title: "Trial of X", authors: "Smith J", authors_full: "John Smith", journal: "NEJM",
        article_type: "article", year: 2020, citations: 10, doi: "10.1056/x", url: "https://doi.org/10.1056/x",
        is_oa: false, abstract: "Abstract" }] }),
  }),
  document: {
    getElementById: byId,
    querySelector: sel => (sel === ".search-panel" ? { scrollIntoView() {} } : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeEl(),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#search-section" });
const run = code => vm.runInContext(code, sandbox);
const has = name => run("typeof " + name) === "function";

// Runs a search against a fake API answering `total` and returns the rendered HTML.
async function render(total, perPage) {
  fakeTotal = total;
  byId("queryInput").value = "";
  byId("fromYearSelect").value = "2014";
  byId("toYearSelect").value = "2026";
  byId("perPageSlider").value = String(perPage);
  byId("sortSelect").value = "cited";
  await run("doSearch()");
  return byId("resultArea").innerHTML;
}

(async () => {
  // 1. the shared helper
  check("1  maxPages is defined", has("maxPages"));
  if (has("maxPages")) {
    check("1  maxPages(50) = 200 (got " + run("maxPages(50)") + ")", run("maxPages(50)") === 200);
    check("1  maxPages(20) = 500 (got " + run("maxPages(20)") + ")", run("maxPages(20)") === 500);
    check("1  maxPages(100) = 100 (got " + run("maxPages(100)") + ")", run("maxPages(100)") === 100);
    check("1  totalPagesFor(13343, 100) = 100 (got " + run("totalPagesFor(13343, 100)") + ")", run("totalPagesFor(13343, 100)") === 100);
    check("1  totalPagesFor(1243, 100) = 13 (got " + run("totalPagesFor(1243, 100)") + ")", run("totalPagesFor(1243, 100)") === 13);
  }

  // 1b. the per-page slider offers up to 100
  const slider = /<input[^>]*id="perPageSlider"[^>]*>/.exec(html);
  check("1b perPageSlider input found", !!slider && slider[0].length > 0);
  const sliderMax = slider && /[ ]max="([0-9]+)"/.exec(slider[0]);
  check("1b perPageSlider max = 100 (got " + (sliderMax && sliderMax[1]) + ")", !!sliderMax && sliderMax[1] === "100");

  // 2. the pager, driven through the real doSearch -> render path
  const small = await render(300, 50);
  check("2  total 300, per page 50 -> Page 1 of 6", /Page 1 of 6</.test(small));
  check("2  total 300 -> no 10,000 note", small.indexOf(NOTE) < 0);

  const big = await render(20000, 50);
  check("3  total 20000, per page 50 -> Page 1 of 200 (cap)", /Page 1 of 200</.test(big));
  check("3  total 20000 -> note shown", big.indexOf(NOTE) >= 0);

  const big20 = await render(20000, 20);
  check("3  total 20000, per page 20 -> Page 1 of 500 (cap)", /Page 1 of 500</.test(big20));

  const edge = await render(10000, 50);
  check("4  total exactly 10000 -> Page 1 of 200", /Page 1 of 200</.test(edge));
  check("4  total exactly 10000 -> no note", edge.indexOf(NOTE) < 0);

  const over = await render(10001, 50);
  check("4  total 10001 -> note shown", over.indexOf(NOTE) >= 0);

  // 5. the pager must not step past the cap
  fakeTotal = 20000;
  await render(20000, 50);
  run("currentPage = 200");
  let navigated = false;
  const realFetch = sandbox.fetch;
  sandbox.fetch = async (...a) => { navigated = true; return realFetch(...a); };
  await run("pageNav(1)");
  sandbox.fetch = realFetch;
  check("5  pageNav(1) on page 200 of 20000/50 does not fetch page 201", !navigated);

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall pagination checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
