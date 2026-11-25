// Form labels: the five search-panel labels name their control via for=, and the range slider has a 24px
// hit area (44px on coarse pointers).
//
// Run: node tools/form_labels_test.js [path-to-html]   (default: ../index.html)
//
// Source check (index.html read as text). This is NOT a browser test: the accessibility tree is not measured here.
"use strict";
const fs = require("fs");
const path = require("path");

const file = process.argv[2] || path.join(__dirname, "..", "index.html");
const src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }
function refuse(msg) { console.log("REFUSE  " + msg); process.exit(1); }

const ids = ["queryInput", "fromYearSelect", "toYearSelect", "sortSelect", "perPageSlider"];
for (const id of ids) {
  const fors = (src.match(/<label[^>]*>/g) || []).filter(l => l.includes(' for="' + id + '"')).length;
  const els = src.split(' id="' + id + '"').length - 1;
  check("L " + id + ": label for= count " + fors + " (want 1), element id count " + els + " (want 1)", fors === 1 && els === 1);
}

const pStart = src.indexOf('<div class="search-panel">');
const pEnd = src.indexOf('id="searchBtn"', pStart);
if (pStart < 0 || pEnd < 0) refuse("anchor missing: search-panel ... searchBtn");
const labels = src.slice(pStart, pEnd).match(/<label\b[^>]*>/g) || [];
const bare = labels.filter(l => !/\bfor="[^"]+"/.test(l));
check("P search panel labels (" + labels.length + ") all have for= (missing " + bare.length + ")", labels.length === 5 && bare.length === 0);

const styleOpen = /<style\b[^>]*>/.exec(src);
const styleEnd = src.indexOf("</style>");
if (!styleOpen || styleEnd < 0) refuse("anchor missing: <style> ... </style>");
const style = src.slice(styleOpen.index + styleOpen[0].length, styleEnd).replace(/\/\*[^]*?\*\//g, "");
const flat = style.replace(/\s+/g, "");
check("S1 input[type=\"range\"] rule has width:100%, accent-color and height:24px",
  flat.includes('input[type="range"]{width:100%;accent-color:#3b82f6;height:24px;}'));
check("S2 @media (pointer: coarse) { input[type=\"range\"] { height: 44px; } } right after it",
  flat.includes('input[type="range"]{width:100%;accent-color:#3b82f6;height:24px;}@media(pointer:coarse){input[type="range"]{height:44px;}}'));

if (total === 0) refuse("zero checks ran");
console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
