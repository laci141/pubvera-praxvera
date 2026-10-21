// Retracted test: OpenAlex's is_retracted travels from /api/search to the
// card and to every export (JSON, CSV, XLSX, BibTeX), stays attached to its
// row after filter and client sort, and false/missing never shows a claim.
//
// Run: node tools/retracted_test.js
//
// Same approach as export_test.js: slice the inline script section out of
// index.html, run it in a vm sandbox with a minimal DOM shim, and drive the
// real doSearch -> render -> export path.
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

const WARN = "OpenAlex marks this work as retracted";
const BIB_WARN = "% " + WARN;

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// ── fixture: retracted (true), explicit false, and missing field ──
const base = {
  authors: "Smith J; Doe A", authors_full: "John Smith and Ann Doe",
  journal: "New England Journal of Medicine", article_type: "article",
  is_oa: false, abstract: "Abstract text",
};
const articles = [
  Object.assign({}, base, { title: "Bravo trial of sepsis", year: 2015, citations: 300,
    doi: "10.1056/ret", url: "https://doi.org/10.1056/ret", is_retracted: true }),
  Object.assign({}, base, { title: "Alpha study of sepsis", year: 2016, citations: 200,
    doi: "10.1056/false", url: "https://doi.org/10.1056/false", is_retracted: false }),
  Object.assign({}, base, { title: "Charlie cohort on cardiology", year: 2017, citations: 100,
    doi: "10.1056/missing", url: "https://doi.org/10.1056/missing" }),
];

// ── DOM shim (as in export_test.js) ──
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
let xlsxAoa = null;
const XLSX = {
  utils: {
    encode_col: c => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; },
    encode_cell: a => XLSX.utils.encode_col(a.c) + (a.r + 1),
    encode_range: r => XLSX.utils.encode_cell(r.s) + ":" + XLSX.utils.encode_cell(r.e),
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }),
    aoa_to_sheet: aoa => { xlsxAoa = aoa; return { "!ref": "A1:A1" }; },
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
    { total: articles.length, page: 1, articles })) }),
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

// The card markup for the article whose title contains `t`.
function cardFor(t) {
  const cards = byId("resultArea").innerHTML.split('<div class="article-card">').slice(1);
  return cards.find(c => c.indexOf(t) >= 0) || null;
}
// Minimal RFC4180 parse of one CSV line (fixture values hold no newlines).
function csvCells(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
// CSV rows as objects keyed by the column header (line 0 sep=, line 1 provenance).
function csvRows(text) {
  const lines = text.replace(/^﻿/, "").split("\r\n");
  const head = csvCells(lines[2]);
  return { head, rows: lines.slice(3).filter(Boolean).map(l => {
    const c = csvCells(l); const o = {}; head.forEach((h, i) => { o[h] = c[i]; }); return o; }) };
}
const byTitle = (rows, t) => rows.find(r => String(r.title).indexOf(t) >= 0);

(async () => {
  byId("queryInput").value = "";
  byId("fromYearSelect").value = "2014";
  byId("toYearSelect").value = "2020";
  byId("perPageSlider").value = "50";
  byId("sortSelect").value = "cited";
  await run("doSearch()");

  // a. the lastData.search mapping keeps is_retracted (boolean, missing = false)
  const mapped = JSON.parse(run("JSON.stringify(lastData.search)"));
  check("a  mapped row with is_retracted true is true (got " + JSON.stringify(byTitle(mapped, "Bravo").is_retracted) + ")",
    byTitle(mapped, "Bravo").is_retracted === true);
  check("a  mapped row with is_retracted false is false (got " + JSON.stringify(byTitle(mapped, "Alpha").is_retracted) + ")",
    byTitle(mapped, "Alpha").is_retracted === false);
  check("a  mapped row without the field is false (got " + JSON.stringify(byTitle(mapped, "Charlie").is_retracted) + ")",
    byTitle(mapped, "Charlie").is_retracted === false);

  // b. the card shows the warning only for true
  const cRet = cardFor("Bravo"), cFalse = cardFor("Alpha"), cMiss = cardFor("Charlie");
  check("b  all three cards rendered", !!(cRet && cFalse && cMiss));
  check('b  retracted card contains "' + WARN + '"', !!cRet && cRet.indexOf(WARN) >= 0);
  check("b  is_retracted false card has no warning", !!cFalse && cFalse.indexOf(WARN) < 0);
  check("b  missing is_retracted card has no warning", !!cMiss && cMiss.indexOf(WARN) < 0);
  check("b  warning comes after the title (title not hidden)",
    !!cRet && cRet.indexOf("Bravo trial") >= 0 && cRet.indexOf("Bravo trial") < cRet.indexOf(WARN));

  // c. CSV has an is_retracted column with true/false values, as the last column
  run('downloadCSV("search","s.csv")');
  const csv = csvRows(lastBlob());
  check("c  CSV header has is_retracted as the last column (got " + JSON.stringify(csv.head) + ")",
    csv.head[csv.head.length - 1] === "is_retracted");
  check("c  CSV existing column order unchanged",
    csv.head.slice(0, 9).join(",") === "title,authors,journal,year,citations,doi,article_type,is_oa,abstract");
  check("c  CSV is_retracted true / false / false (missing) (got " +
    JSON.stringify(["Bravo", "Alpha", "Charlie"].map(t => (byTitle(csv.rows, t) || {}).is_retracted)) + ")",
    (byTitle(csv.rows, "Bravo") || {}).is_retracted === "true" &&
    (byTitle(csv.rows, "Alpha") || {}).is_retracted === "false" &&
    (byTitle(csv.rows, "Charlie") || {}).is_retracted === "false");

  // c. XLSX builder gets the same column and values
  run('downloadXLSX("search","s.xlsx")');
  const xHead = xlsxAoa ? xlsxAoa[1] : [];
  const xi = xHead.indexOf("is_retracted");
  const xVal = t => { const r = (xlsxAoa || []).slice(2).find(row => String(row[0]).indexOf(t) >= 0); return r ? r[xi] : undefined; };
  check("c  XLSX header has is_retracted as the last column (got " + JSON.stringify(xHead) + ")",
    xi >= 0 && xi === xHead.length - 1);
  check("c  XLSX is_retracted true / false / false (got " + JSON.stringify([xVal("Bravo"), xVal("Alpha"), xVal("Charlie")]) + ")",
    xVal("Bravo") === "true" && xVal("Alpha") === "false" && xVal("Charlie") === "false");

  // JSON export rows carry the boolean field
  run('downloadJSON("search","s.json")');
  const jRows = JSON.parse(lastBlob()).rows;
  check("c  JSON rows is_retracted true / false / false (got " +
    JSON.stringify(["Bravo", "Alpha", "Charlie"].map(t => (byTitle(jRows, t) || {}).is_retracted)) + ")",
    (byTitle(jRows, "Bravo") || {}).is_retracted === true &&
    (byTitle(jRows, "Alpha") || {}).is_retracted === false &&
    (byTitle(jRows, "Charlie") || {}).is_retracted === false);

  // d. BibTeX comment line only above the retracted entry
  run('downloadBibTeX("search","s.bib")');
  const bib = lastBlob();
  const entries = bib.split(/\n(?=(?:% [^\n]*\n)?@article\{)/);
  const entryFor = t => entries.find(e => e.indexOf(t) >= 0) || "";
  check('d  BibTeX has "' + BIB_WARN + '" exactly once', bib.split(BIB_WARN).length - 1 === 1);
  check("d  the comment line sits directly above the retracted entry",
    new RegExp("^" + BIB_WARN + "\\n@article\\{bravo", "m").test(bib));
  check("d  no comment for the false / missing entries",
    entryFor("Alpha study").indexOf(WARN) < 0 && entryFor("Charlie cohort").indexOf(WARN) < 0);

  // The flag stays on the right row after client sort and text filter.
  run('currentSort="title_asc"; refreshView()');
  check("sort title A→Z: Bravo card still warns, Alpha and Charlie do not",
    (cardFor("Bravo") || "").indexOf(WARN) >= 0 && (cardFor("Alpha") || "x" + WARN).indexOf(WARN) < 0 &&
    (cardFor("Charlie") || "x" + WARN).indexOf(WARN) < 0);
  run('currentFilter="sepsis"');
  run('downloadCSV("search","s.csv")');
  const fcsv = csvRows(lastBlob());
  check("filter + sort: CSV has 2 rows, Alpha false then Bravo true (got " +
    JSON.stringify(fcsv.rows.map(r => [r.title, r.is_retracted])) + ")",
    fcsv.rows.length === 2 && fcsv.rows[0].title.indexOf("Alpha") === 0 && fcsv.rows[0].is_retracted === "false" &&
    fcsv.rows[1].title.indexOf("Bravo") === 0 && fcsv.rows[1].is_retracted === "true");

  // e. never a "not retracted" claim anywhere in the page
  check('e  index.html has no "not retracted" / "not been retracted"', !/not (been )?retracted/i.test(html));

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall retracted checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
