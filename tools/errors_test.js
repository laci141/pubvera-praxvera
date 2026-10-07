// Error message test: errorMessageFor returns the message without "Error: ";
// errorHTML adds that prefix as before. A JSON "error" string wins for every
// status; else a 4xx plain body is shown (trimmed, max 200 chars, escaped);
// else "HTTP <status>". A From Year later than To Year is refused client side,
// before any request is sent.
//
// Run: node tools/errors_test.js
//
// The helpers and doSearch live inline in index.html; this test slices the
// script section out (same slice as tools/export_test.js) and executes it in a
// vm sandbox with a minimal DOM shim.
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
let fetchCalls = 0;
let fakeStatus = 200, fakeBody = "", fakeHeaders = {};
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, RegExp, Error, parseInt, isNaN,
  alert: m => { throw new Error("unexpected alert: " + m); },
  window: {},
  fetch: async () => {
    fetchCalls++;
    return { ok: fakeStatus < 400, status: fakeStatus, text: async () => fakeBody,
             headers: { get: n => (n in fakeHeaders ? fakeHeaders[n] : null) },
             json: async () => ({ total: 0, page: 1, articles: [] }) };
  },
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
vm.runInContext(section, sandbox, { filename: "index.html#search-section" });
const run = code => vm.runInContext(code, sandbox);
const has = name => run("typeof " + name) === "function";

// Runs a search against a fake API answering status/body; returns what was rendered.
async function search(status, body, from, to) {
  fakeStatus = status; fakeBody = body; fetchCalls = 0;
  byId("queryInput").value = "sepsis";
  byId("fromYearSelect").value = String(from === undefined ? 2014 : from);
  byId("toYearSelect").value = String(to === undefined ? 2026 : to);
  byId("perPageSlider").value = "50";
  byId("sortSelect").value = "cited";
  await run("doSearch()");
  return byId("resultArea").innerHTML;
}

(async () => {
  // Content assertions also require a non-empty expected value.
  const eq = (label, got, want) => check(label + " (got " + JSON.stringify(got) + ")", want !== "" && got === want);
  const box = text => '<div class="error-box">Error: ' + text + '</div>';

  check("1  errorMessageFor is defined", has("errorMessageFor"));
  if (has("errorMessageFor")) {
    const m = (s, b) => sandbox.errorMessageFor(s, b);
    eq("2  400 + plain text -> that text", m(400, "from_year must not be greater than to_year"), "from_year must not be greater than to_year");
    eq("2  400 + text is trimmed", m(400, "  bad year \n"), "bad year");
    eq("3  400 + JSON error -> the field", m(400, '{"error":"x"}'), "x");
    eq("3  400 + JSON error is trimmed", m(400, '{"error":"  paging limit is 10000 "}'), "paging limit is 10000");
    eq("3  400 + JSON without string error -> plain body", m(400, '{"error":5}'), '{"error":5}');
    eq("4  413 + plain text -> that text", m(413, "request body too large"), "request body too large");
    const long = m(400, "x".repeat(500));
    eq("5  4xx 500-char body -> exactly 200 chars", long, "x".repeat(200));
    const longJson = m(400, JSON.stringify({ error: "y".repeat(500) }));
    eq("5  4xx 500-char JSON error -> exactly 200 chars", longJson, "y".repeat(200));
    eq("6  500 + JSON error -> that text (old behaviour)", m(500, '{"error":"upstream failed"}'), "upstream failed");
    eq("7  500 + plain text -> HTTP 500", m(500, "stack trace secret"), "HTTP 500");
    eq("8  400 + empty body -> HTTP 400", m(400, ""), "HTTP 400");
    eq("8  422 + whitespace body -> HTTP 422", m(422, " \n\t "), "HTTP 422");
    eq("8  400 + undefined body -> HTTP 400", m(400, undefined), "HTTP 400");
    eq("8  400 + JSON with blank error -> trimmed body", m(400, '{"error":"   "}'), '{"error":"   "}');
  }

  // Through the real doSearch -> httpError -> errorHTML path.
  const plain = await search(400, "from_year must not be greater than to_year");
  eq("9  rendered 400 plain text", plain, box("from_year must not be greater than to_year"));
  const json = await search(400, '{"error":"x"}');
  eq("9  rendered 400 JSON", json, box("x"));
  const five = await search(500, "boom");
  eq("10 rendered 500 plain text", five, box("HTTP 500"));
  const fiveJson = await search(500, '{"error":"upstream failed"}');
  eq("10 rendered 500 JSON", fiveJson, box("upstream failed"));
  const empty = await search(400, "  ");
  eq("11 rendered 400 empty body", empty, box("HTTP 400"));
  const xss = await search(400, "<script>alert(1)</script>");
  check("12 <script> body is shown escaped", xss.length > 0 && xss.indexOf("&lt;script&gt;alert(1)&lt;/script&gt;") >= 0);
  check("12 no raw <script> tag in the markup", xss.length > 0 && xss.indexOf("<script") < 0);

  // Retry-After on the 503 card (from the OpenAlex 429 mapping, PR #18).
  check("17 retryAfterSeconds is defined", has("retryAfterSeconds"));
  if (has("retryAfterSeconds")) {
    const r = v => sandbox.retryAfterSeconds(v);
    eq("18 '12' -> 12", r("12"), 12);
    eq("18 '1' -> 1", r("1"), 1);
    eq("18 '300' -> 300", r("300"), 300);
    for (const v of ["0", "301", "", null, "abc", "12.5", " 12", "Wed, 21 Oct 2026 07:28:00 GMT"])
      check("18 " + JSON.stringify(v) + " -> 0", r(v) === 0);
  }
  const OLD503 = '<div class="errcard"><h4>Temporarily unavailable</h4>' +
    '<p>The service is temporarily unavailable. Please try again in a moment.</p></div>';
  fakeHeaders = { "Retry-After": "12" };
  const ra12 = await search(503, '{"error":"OpenAlex rate limit reached — try again in 12 seconds"}');
  check("19 503 + Retry-After 12 -> title", ra12.length > 0 && ra12.indexOf("Temporarily unavailable") >= 0);
  check("19 503 + Retry-After 12 -> 'Try again in 12 seconds.'", ra12.length > 0 && ra12.indexOf("Try again in 12 seconds.") >= 0);
  fakeHeaders = { "Retry-After": "1" };
  const ra1 = await search(503, "");
  check("20 503 + Retry-After 1 -> 'Try again in 1 second.'", ra1.length > 0 && ra1.indexOf("Try again in 1 second.") >= 0);
  check("20 503 + Retry-After 1 -> not plural", ra1.indexOf("1 seconds") < 0);
  fakeHeaders = {};
  const ra0 = await search(503, "");
  eq("21 503 without Retry-After -> old card", ra0, OLD503);
  check("21 503 without Retry-After -> no 'Try again in'", ra0.length > 0 && ra0.indexOf("Try again in") < 0);
  fakeHeaders = { "Retry-After": "301" };
  eq("21 503 + invalid Retry-After -> old card", await search(503, ""), OLD503);
  fakeHeaders = { "Retry-After": "12" };
  eq("22 rendered 502 JSON error unchanged", await search(502, '{"error":"bad gateway"}'), box("bad gateway"));
  fakeHeaders = {};

  // yearRangeError, direct.
  check("13 yearRangeError is defined", has("yearRangeError"));
  const MSG = "From Year must not be later than To Year.";
  if (has("yearRangeError")) {
    const y = (a, b) => sandbox.yearRangeError(a, b);
    eq("14 ('2020','2010') blocked", y("2020", "2010"), MSG);
    eq("14 (2020,2010) blocked", y(2020, 2010), MSG);
    check("14 ('999','2010') NOT blocked", y("999", "2010") === "");
    check("14 (2010,2020) not blocked", y(2010, 2020) === "");
    check("14 (0,2010) not blocked", y(0, 2010) === "");
    check("14 ('',2010) not blocked", y("", 2010) === "");
    check("14 (2020,0) not blocked", y(2020, 0) === "");
  }

  // Through doSearch.
  const bad = await search(200, "", 2020, 2010);
  check("15 from > to -> request not sent", fetchCalls === 0);
  check("15 from > to -> exact message", bad.length > 0 && bad.indexOf(MSG) >= 0);
  await search(200, "", 2010, 2020);
  check("16 from < to -> request sent", fetchCalls === 1);
  await search(200, "", 2015, 2015);
  check("16 from = to -> request sent", fetchCalls === 1);
  await search(200, "", 0, 2020);
  check("16 from unset (0) -> request sent", fetchCalls === 1);
  await search(200, "", 2020, 0);
  check("16 to unset (0) -> request sent", fetchCalls === 1);
  await search(200, "", "", 2010);
  check("16 from empty -> request sent", fetchCalls === 1);

  console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nall checks passed");
  process.exit(failed ? 1 : 0);
})();
