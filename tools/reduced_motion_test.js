// prefers-reduced-motion: one @media (prefers-reduced-motion: reduce) block at the end of the <style> block turns
// off smooth scrolling, transitions and hover movement; the loading spinner stays animated (status indicator).
//
// Run: node tools/reduced_motion_test.js
//
// CSS-source check (index.html read as text). This is NOT a browser test: the computed styles under an
// emulated reduce-motion setting are not measured here.
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }
function refuse(msg) { console.log("REFUSE  " + msg); process.exit(1); }

// With or without a nonce attribute: the block starts after the opening tag.
const styleOpen = /<style\b[^>]*>/.exec(src);
const styleEnd = src.indexOf("</style>");
if (!styleOpen || styleEnd < 0 || styleEnd < styleOpen.index) refuse("anchor missing: <style> ... </style>");
// Comments are stripped so a mention in a comment never counts as a rule.
const style = src.slice(styleOpen.index + styleOpen[0].length, styleEnd).replace(/\/\*[^]*?\*\//g, "");
const flat = s => s.replace(/\s+/g, "");
const count = (s, re) => (s.match(new RegExp(re.source, "g")) || []).length;

// Brace-matched body of every reduce-motion block, and the index right after its closing brace.
const headRe = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;
const blocks = [];
let m;
while ((m = headRe.exec(style))) {
  let depth = 1, i = headRe.lastIndex;
  for (; i < style.length && depth; i++) depth += style[i] === "{" ? 1 : style[i] === "}" ? -1 : 0;
  blocks.push({ body: style.slice(headRe.lastIndex, i - 1), end: i, closed: depth === 0 });
  headRe.lastIndex = i;
}
const block = blocks.length === 1 ? blocks[0] : null;
const body = block ? flat(block.body) : "";
// The block is a sequence of plain rules; a rule matches when its flattened text is present.
const hasRule = r => block !== null && body.includes(flat(r));

check("R1 exactly one @media (prefers-reduced-motion: reduce), last in <style> (found " + blocks.length + ")",
  block !== null && block.closed && style.slice(block.end).trim() === "");
check("R2 block has html { scroll-behavior: auto; }", hasRule("html{scroll-behavior:auto;}"));
check("R3 block has *, *::before, *::after { transition: none !important; }",
  hasRule("*,*::before,*::after{transition:none!important;}"));
check("R4 block has .search-btn:hover, .article-card:hover { transform: none; }",
  hasRule(".search-btn:hover,.article-card:hover{transform:none;}"));
const ks = count(style, /@keyframes\s+spin\s*\{/), as = count(style, /animation:\s*spin\s+1s\s+linear\s+infinite/);
check("R5 block mentions neither .spinner nor spin; @keyframes spin (" + ks + ") and animation: spin 1s linear infinite (" +
  as + ") exist once each", !/spinner|spin/.test(block ? block.body : "") && ks === 1 && as === 1);
const sm = count(style, /html\s*\{\s*scroll-behavior:\s*smooth;\s*\}/);
check("R6 html { scroll-behavior: smooth; } exists once (" + sm + ")", sm === 1);
const wk = count(style, /-webkit-backdrop-filter\s*:/), un = count(style, /(^|[^-\w])backdrop-filter\s*:/);
check("R7 -webkit-backdrop-filter: (" + wk + ") equals backdrop-filter: (" + un + ")", wk === un && wk > 0);

if (total === 0) refuse("zero checks ran");
console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
