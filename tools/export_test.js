// Export test: the search export carries the query actually sent, the server
// filters (years, sort, per page, page) plus the client ones, the API total as
// rows_total, and an XLSX autofilter on the header row.
//
// Run: node tools/export_test.js
//
// The export suite and doSearch live inline in index.html; this test slices
// that script section out and executes it in a vm sandbox with a minimal DOM
// shim, then drives the real doSearch -> render -> export path.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf("    function esc(s) {");
const end = html.indexOf("    function expandAbs(btn) {");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not locate the export/search section in index.html");
  process.exit(1);
}
const section = html.slice(start, end);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// ── fixture: one page of 50 rows, as /api/search returns them ──
const TOTAL = 14148;
const articles = [];
for (let i = 0; i < 50; i++) {
  articles.push({
    title: (i % 5 === 0 ? "Trial " + i + " of sepsis" : "Study " + i + " on cardiology"),
    authors: "Smith J; Doe A", authors_full: "John Smith and Ann Doe",
    journal: "New England Journal of Medicine", article_type: i % 4 === 0 ? "review" : "article",
    year: 2014 + (i % 13), citations: 1000 - i, doi: "10.1056/x" + i,
    url: "https://doi.org/10.1056/x" + i, is_oa: i % 2 === 0, abstract: "Abstract text " + i,
  });
}

// ── DOM shim ──
const escHTML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function makeEl() {
  const el = { value: "", disabled: false, style: {}, _text: "", _html: "", click() {} };
  Object.defineProperty(el, "textContent", {
    get() { return el._text; }, set(t) { el._text = String(t); el._html = escHTML(t); } });
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(h) { el._html = String(h); } });
  el.querySelector = sel => (sel === ".qfilter" && /class="qfilter"/.test(el._html) ? { value: "" } : null);
  return el;
}
const els = {};
const byId = id => (els[id] = els[id] || makeEl());
const blobs = [];
let xlsxSheet = null;
const XLSX = {
  utils: {
    encode_col: c => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; },
    encode_cell: a => XLSX.utils.encode_col(a.c) + (a.r + 1),
    encode_range: r => XLSX.utils.encode_cell(r.s) + ":" + XLSX.utils.encode_cell(r.e),
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: xlsxSheet._rows - 1, c: xlsxSheet._cols - 1 } }),
    aoa_to_sheet: aoa => {
      const ws = { _rows: aoa.length, _cols: Math.max(...aoa.map(r => r.length)) };
      aoa.forEach((row, r) => row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r, c })] = { v }; }));
      ws["!ref"] = "A1:" + XLSX.utils.encode_cell({ r: ws._rows - 1, c: ws._cols - 1 });
      xlsxSheet = ws;
      return ws;
    },
    book_new: () => ({ sheets: [] }),
    book_append_sheet: (wb, ws) => wb.sheets.push(ws),
  },
  writeFile: () => {},
};
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, RegExp, Error, parseInt, isNaN,
  alert: m => { throw new Error("unexpected alert: " + m); },
  window: {},
  Blob: class { constructor(parts) { this.text = parts.join(""); blobs.push(this.text); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  DOMParser: class {
    parseFromString(s) {
      const t = String(s).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      return { body: { textContent: t } };
    }
  },
  XLSX,
  fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify({ total: TOTAL, page: 1, articles })) }),
  document: {
    getElementById: byId,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeEl(),
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#export-section" });
const run = code => vm.runInContext(code, sandbox);
const lastBlob = () => blobs[blobs.length - 1];
const csvHeader = text => text.replace(/^﻿/, "").split("\r\n")[1];

async function search(q) {
  byId("queryInput").value = q;
  byId("fromYearSelect").value = "2014";
  byId("toYearSelect").value = "2026";
  byId("perPageSlider").value = "50";
  byId("sortSelect").value = "cited";
  await run("doSearch()");
  const res = byId("resultArea").innerHTML;
  if (!/14148 total results/.test(res)) throw new Error("doSearch did not render the page: " + res.slice(0, 200));
}

(async () => {
  // ── empty keyword: the measured live case ──
  await search("");
  run('downloadJSON("search","s.json")');
  const j = JSON.parse(lastBlob()).export;

  // 1. JSON query is the raw keyword
  check('1  JSON export.query is "" for an empty keyword (got ' + JSON.stringify(j.query) + ")", j.query === "");

  // 2. provenance always shows the query
  run('downloadCSV("search","s.csv")');
  const csvH = csvHeader(lastBlob());
  run('downloadXLSX("search","s.xlsx")');
  const xlsxH = xlsxSheet.A1.v;
  run('downloadBibTeX("search","s.bib")');
  const bibH = lastBlob().split("\n")[0];
  check("2  CSV provenance has query: none (got " + JSON.stringify(csvH) + ")", /· query: none ·/.test(csvH));
  check("2  XLSX provenance has query: none", /· query: none ·/.test(xlsxH));
  check("2  BibTeX provenance has query: none", /^% .*· query: none ·/.test(bibH));

  // 3. server filters always present
  const wantF = "years 2014–2026 · sort most cited · 50 per page · page 1 of 283 · all types";
  check("3  export.filters = " + JSON.stringify(wantF) + " (got " + JSON.stringify(j.filters) + ")", j.filters === wantF);

  // 6. totals
  check("6  rows_total 14148 (got " + JSON.stringify(j.rows_total) + ")", j.rows_total === TOTAL);
  check('6  rows_total_unit "articles" (got ' + JSON.stringify(j.rows_total_unit) + ")", j.rows_total_unit === "articles");
  check("6  rows_exported 50, rows_loaded 50 (got " + j.rows_exported + ", " + j.rows_loaded + ")", j.rows_exported === 50 && j.rows_loaded === 50);

  // 7. provenance names the API total; the full line as decided
  const wantLine = "Praxvera export · Literature search · query: none · 50 rows (14,148 articles matched in total) · " +
    wantF + " · source: OpenAlex · ";
  check("7  CSV provenance line (got " + JSON.stringify(csvH) + ")", csvH.startsWith('"' + wantLine) || csvH.startsWith(wantLine));
  check("7  XLSX provenance line", xlsxH.startsWith(wantLine));

  // 8. XLSX autofilter: header row 2 to the last data row, all 9 columns
  const gotRef = xlsxSheet["!autofilter"] && xlsxSheet["!autofilter"].ref;
  check('8  XLSX autofilter ref "A2:I52" (got ' + JSON.stringify(gotRef) + ")", gotRef === "A2:I52");

  // 4. the export reads what was sent, not the live form
  byId("queryInput").value = "cancer";
  byId("fromYearSelect").value = "1990";
  byId("perPageSlider").value = "5";
  byId("sortSelect").value = "date";
  run('downloadJSON("search","s.json")');
  const j4 = JSON.parse(lastBlob()).export;
  check("4  form edits after the search do not leak into the export (got " + JSON.stringify([j4.query, j4.filters]) + ")",
    j4.query === "" && j4.filters === wantF);
  run('downloadCSV("search","s.csv")');
  check("4  provenance still says query: none", /· query: none ·/.test(csvHeader(lastBlob())));

  // ── keyword "covid" ──
  await search("covid");
  run('downloadJSON("search","s.json")');
  const jc = JSON.parse(lastBlob()).export;
  check('1  JSON export.query is "covid" (got ' + JSON.stringify(jc.query) + ")", jc.query === "covid");
  run('downloadCSV("search","s.csv")');
  check('2  CSV provenance has query: "covid"', /· query: ""covid"" ·/.test(csvHeader(lastBlob())));

  // 5. client filters follow the server ones
  run('currentType="review"; currentFilter="sepsis"; currentSort="title_asc"');
  run('downloadJSON("search","s.json")');
  const j5 = JSON.parse(lastBlob()).export;
  const want5 = "years 2014–2026 · sort most cited · 50 per page · page 1 of 283 · type: review · " +
    'filter: "sepsis" · re-sorted on page: title A→Z';
  check("5  client filters appended (got " + JSON.stringify(j5.filters) + ")", j5.filters === want5);
  check("5  rows_exported 3 with rows_loaded 50 and rows_total 14148 (got " + [j5.rows_exported, j5.rows_loaded, j5.rows_total] + ")",
    j5.rows_exported === 3 && j5.rows_loaded === 50 && j5.rows_total === TOTAL);
  run('downloadCSV("search","s.csv")');
  check("7  filtered provenance: showing 3 of 50 rows (14,148 articles matched in total)",
    /showing 3 of 50 rows \(14,148 articles matched in total\)/.test(csvHeader(lastBlob())));

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall export checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
