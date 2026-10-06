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
// What the server answers in openalex_query: filter and sort only, encoded.
const OAQ = "filter=primary_location.source.issn%3A0028-4793%2Cpublication_year%3A2014-2026&sort=cited_by_count%3Adesc";
let fakeTotal = TOTAL;
let fakeOAQ = OAQ;
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
  fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(
    Object.assign({ total: fakeTotal, page: 1, articles }, fakeOAQ === null ? {} : { openalex_query: fakeOAQ }))) }),
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

async function search(q, total = TOTAL, perPage = 50) {
  fakeTotal = total;
  byId("queryInput").value = q;
  byId("fromYearSelect").value = "2014";
  byId("toYearSelect").value = "2026";
  byId("perPageSlider").value = String(perPage);
  byId("sortSelect").value = "cited";
  await run("doSearch()");
  const res = byId("resultArea").innerHTML;
  if (res.indexOf(total + " total results") < 0) throw new Error("doSearch did not render the page: " + res.slice(0, 200));
}
// CSV quotes the provenance cell when it holds commas/quotes; undo that.
const unquote = h => (h.startsWith('"') ? h.slice(1, -1).replace(/""/g, '"') : h);
// All four exports of the current search: provenance text of each + the JSON export object.
function exportsNow() {
  run('downloadJSON("search","s.json")');
  const jsonText = lastBlob();
  run('downloadCSV("search","s.csv")');
  const csvText = lastBlob();
  run('downloadXLSX("search","s.xlsx")');
  const xlsxH = xlsxSheet.A1.v;
  run('downloadBibTeX("search","s.bib")');
  const bibText = lastBlob();
  return { jsonText, j: JSON.parse(jsonText).export, csvText, csvH: unquote(csvHeader(csvText)), xlsxH, bibText, bibH: bibText.split("\n")[0] };
}
const WEB = "https://openalex.org/works?" + OAQ;
const API = "https://api.openalex.org/works?" + OAQ + "&per-page=100&cursor=*";
const LINKS = "Full result set on OpenAlex: " + WEB +
  " (website export up to 100,000 works, CSV/RIS) · API: " + API + " (cursor paging)";
const TIP = "Tip: narrow the year range to keep each search under 10,000 results.";
const LIMIT = "(OpenAlex paging limit; ";

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
  const wantF = "years 2014–2026 · sort most cited · 50 per page · page 1 of 200 (OpenAlex paging limit; 283 pages by total) · all types";
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
  const want5 = "years 2014–2026 · sort most cited · 50 per page · page 1 of 200 (OpenAlex paging limit; 283 pages by total) · type: review · " +
    'filter: "sepsis" · re-sorted on page: title A→Z';
  check("5  client filters appended (got " + JSON.stringify(j5.filters) + ")", j5.filters === want5);
  check("5  rows_exported 3 with rows_loaded 50 and rows_total 14148 (got " + [j5.rows_exported, j5.rows_loaded, j5.rows_total] + ")",
    j5.rows_exported === 3 && j5.rows_loaded === 50 && j5.rows_total === TOTAL);
  run('downloadCSV("search","s.csv")');
  check("7  filtered provenance: showing 3 of 50 rows (14,148 articles matched in total)",
    /showing 3 of 50 rows \(14,148 articles matched in total\)/.test(csvHeader(lastBlob())));


  // ── 9. OpenAlex links + paging-limit provenance ──
  await search("", TOTAL, 50);
  const big = exportsNow();
  check("9  total 14148/50: filters say the limit (got " + JSON.stringify(big.j.filters) + ")",
    big.j.filters.indexOf("page 1 of 200 (OpenAlex paging limit; 283 pages by total)") >= 0);
  check("9  CSV provenance carries links text", big.csvH.indexOf(LINKS) >= 0);
  check("9  XLSX provenance carries links text", big.xlsxH.indexOf(LINKS) >= 0);
  check("9  BibTeX provenance is a % comment carrying links text", /^% /.test(big.bibH) && big.bibH.indexOf(LINKS) >= 0);
  check("9  CSV and XLSX provenance are the same text", big.csvH === big.xlsxH);
  check("9  CSV provenance cell is correctly quoted (comma in text)", csvHeader(big.csvText).startsWith('"') && csvHeader(big.csvText).endsWith('"'));
  check("9  JSON export.openalex_web_url", big.j.openalex_web_url === WEB);
  check("9  JSON export.openalex_api_url", big.j.openalex_api_url === API);
  check("9  JSON export.paging_limit_results 10000", big.j.paging_limit_results === 10000);
  check("9  JSON export.pages_reachable 200, pages_by_total 283 (got " + [big.j.pages_reachable, big.j.pages_by_total] + ")",
    big.j.pages_reachable === 200 && big.j.pages_by_total === 283);
  check("9  Tip present in CSV, XLSX and BibTeX when total > 10000",
    big.csvH.indexOf(TIP) >= 0 && big.xlsxH.indexOf(TIP) >= 0 && big.bibH.indexOf(TIP) >= 0);
  check("9  provenance line still ends with the ISO date",
    /· \d{4}-\d{2}-\d{2}$/.test(big.csvH) && /· \d{4}-\d{2}-\d{2}$/.test(big.xlsxH) && /· \d{4}-\d{2}-\d{2}$/.test(big.bibH));
  console.log("   example (total 14148 / 50 per page): " + big.csvH);

  // 10. small result set: unchanged page text, no limit text, no Tip, links still there
  await search("", 300, 50);
  const small = exportsNow();
  check("10 total 300/50: page text unchanged (got " + JSON.stringify(small.j.filters) + ")",
    small.j.filters === "years 2014–2026 · sort most cited · 50 per page · page 1 of 6 · all types");
  check("10 no paging-limit text in any provenance",
    [small.csvH, small.xlsxH, small.bibH, small.j.filters].every(t => t.indexOf("paging limit") < 0));
  check("10 no Tip in any provenance", [small.csvH, small.xlsxH, small.bibH].every(t => t.indexOf(TIP) < 0));
  check("10 links still present in CSV, XLSX, BibTeX",
    small.csvH.indexOf(LINKS) >= 0 && small.xlsxH.indexOf(LINKS) >= 0 && small.bibH.indexOf(LINKS) >= 0);
  check("10 JSON fields: limit 10000, reachable 6, by total 6 (got " + [small.j.paging_limit_results, small.j.pages_reachable, small.j.pages_by_total] + ")",
    small.j.paging_limit_results === 10000 && small.j.pages_reachable === 6 && small.j.pages_by_total === 6);

  // 11. Tip only when total > 10000
  await search("", 10000, 50);
  const edge = exportsNow();
  check("11 total exactly 10000: no Tip, no limit text",
    edge.csvH.indexOf(TIP) < 0 && edge.csvH.indexOf("paging limit") < 0);
  await search("", 10001, 50);
  const over = exportsNow();
  check("11 total 10001: Tip and limit text present",
    over.csvH.indexOf(TIP) >= 0 && over.csvH.indexOf(LIMIT) >= 0);

  // 12. no openalex_query from the server: no link text, JSON urls null
  fakeOAQ = null;
  await search("", TOTAL, 50);
  const noq = exportsNow();
  check("12 no openalex_query: no links text in CSV/XLSX/BibTeX",
    [noq.csvH, noq.xlsxH, noq.bibH].every(t => t.indexOf("Full result set on OpenAlex") < 0));
  check("12 no openalex_query: JSON urls null",
    noq.j.openalex_web_url === null && noq.j.openalex_api_url === null);
  fakeOAQ = OAQ;

  // 13. the API key never appears in any export
  const everything = [big, small, edge, over, noq].map(e => [e.jsonText, e.csvText, e.xlsxH, e.bibText].join("\n")).join("\n");
  check('13 no "api_key" anywhere in any export', everything.indexOf("api_key") < 0);

  // 14. pager note link (shown when total > 10000), href through escAttr
  const LINK_TEXT = "Open the full result set on OpenAlex";
  await search("", 10001, 50);
  const pageOver = byId("resultArea").innerHTML;
  check("14 total 10001: pager note links to the full result set on OpenAlex (new tab, noopener noreferrer)",
    pageOver.indexOf('href="' + WEB.replace(/&/g, "&amp;") + '"') >= 0 &&
    /target="_blank" rel="noopener noreferrer"[^>]*>Open the full result set on OpenAlex</.test(pageOver));
  await search("", 10000, 50);
  check("14 total exactly 10000: no pager link", byId("resultArea").innerHTML.indexOf(LINK_TEXT) < 0);
  fakeOAQ = null;
  await search("", 10001, 50);
  check("14 no openalex_query: no pager link", byId("resultArea").innerHTML.indexOf(LINK_TEXT) < 0);
  fakeOAQ = 'filter=x"><img src=x onerror=1>';
  await search("", 10001, 50);
  const hostile = byId("resultArea").innerHTML;
  check("14 hostile openalex_query is escaped in the pager href", hostile.indexOf('"><img') < 0 && hostile.indexOf("&quot;&gt;&lt;img") >= 0);
  fakeOAQ = OAQ;

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall export checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
