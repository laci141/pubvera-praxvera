// Year list test: the To Year list runs up to the current year + 1 (the same
// upper bound the backend accepts, main.go maxYear), and the default To Year
// is the current year. The current year is never typed in: the page computes
// it at load, and this test computes it the same way.
//
// Run: node tools/years_test.js
//
// initYears lives inline in index.html; this test slices it out and executes
// it in a vm sandbox with a minimal <select> shim. It runs once with the real
// clock and again with a faked Date for other years, so a hard-coded year in
// the page fails whatever year the test runs in.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const START = "    // Year dropdowns init";
const END = "    initYears();\n";
const start = html.indexOf(START);
const end = html.indexOf(END, start);
if (start < 0 || end < 0) {
  console.error("FAIL: could not locate initYears in index.html");
  process.exit(1);
}
const section = html.slice(start, end + END.length);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// ── <select> shim: like the browser, setting .value to a value no option has
// leaves the select with value "" ──
function makeSelect() {
  const sel = { options: [], _value: "" };
  sel.appendChild = o => { sel.options.push(o); if (sel.options.length === 1) sel._value = o.value; };
  Object.defineProperty(sel, "value", {
    get() { return sel._value; },
    set(v) { const o = sel.options.find(x => x.value === String(v)); sel._value = o ? o.value : ""; } });
  return sel;
}
class Option { constructor(text, value) { this.text = String(text); this.value = String(value); } }

// Runs initYears with the given Date and returns both selects.
function load(DateImpl) {
  const els = { fromYearSelect: makeSelect(), toYearSelect: makeSelect() };
  const sandbox = { Date: DateImpl, Option, document: { getElementById: id => els[id] } };
  vm.createContext(sandbox);
  vm.runInContext(section, sandbox, { filename: "index.html#year-init" });
  return els;
}
// A Date whose current year is `year` (everything else as the real Date).
function fakeDate(year) {
  return class extends Date {
    constructor(...a) { if (a.length === 0) { super(); this.setFullYear(year); } else super(...a); }
  };
}

function suite(tag, DateImpl) {
  const CY = new DateImpl().getFullYear();
  const { fromYearSelect: from, toYearSelect: to } = load(DateImpl);
  const vals = to.options.map(o => o.value);
  const last = vals[vals.length - 1];
  check(tag + " a  last To Year option is CY + 1 = " + (CY + 1) + " (got " + JSON.stringify(last) + ")", last === String(CY + 1));
  check(tag + " b  default To Year is CY = " + CY + " (got " + JSON.stringify(to.value) + ")", to.value === String(CY));
  const over = vals.filter(v => Number(v) > CY + 1);
  check(tag + " c  no To Year option above CY + 1 (got " + JSON.stringify(over) + ")", vals.length > 0 && over.length === 0);
  check(tag + " d  From Year list starts at 1990 and matches the To Year list (got " +
    JSON.stringify([from.options[0] && from.options[0].value, from.options.length, to.options.length]) + ")",
    from.options.length > 0 && from.options[0].value === "1990" && from.options.map(o => o.value).join() === vals.join());
  check(tag + " e  default From Year stays 2014 (got " + JSON.stringify(from.value) + ")", from.value === "2014");
  check(tag + " f  options ascend by 1 and label equals value",
    to.options.every((o, i) => o.text === o.value && (i === 0 || Number(o.value) === Number(vals[i - 1]) + 1)));
}

const REAL = new Date().getFullYear();
suite("[real clock " + REAL + "]", Date);
for (const y of [REAL - 2, REAL + 1, REAL + 4]) suite("[faked clock " + y + "]", fakeDate(y));

console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
