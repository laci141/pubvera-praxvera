// Result toolbar (.meta-row): count text + controls + Export menu wrap with a gap; the flex-basis that keeps the
// count text wide is desktop-only; long DOIs/URLs/titles may break anywhere so nothing pushes the page sideways.
//
// Run: node tools/toolbar_wrap_test.js
//
// CSS-source check (index.html read as text). This is NOT a layout test: scrollWidth at 343/360 px is
// verified with Playwright.
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
function check(name, ok) { total++; console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }
const style = src.slice(src.indexOf("<style"), src.indexOf("</style>")).replace(/\/\*[^]*?\*\//g, "");

// Bodies of every @media block whose head matches headRe (brace-matched), plus the CSS left without them.
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
// Raw declarations of every rule whose selector list contains `sel`, joined with ";".
function decls(css, sel) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(",").map(s => s.trim()).includes(sel)).map(m => m[2]).join(";");
}
const flat = d => d.replace(/\s+/g, "");
function basis(d) {
  const b = d.match(/(?:^|[;\s])flex:\s*[\d.]+\s+[\d.]+\s+([\d.]+)px/) || d.match(/flex-basis:\s*([\d.]+)px/);
  return b ? parseFloat(b[1]) : 0;
}

const wide = mediaSplit(style, /@media\s*\(\s*min-width:\s*769px\s*\)\s*\{/);
const base = mediaSplit(wide.rest, /@media[^{]*\{/).rest;
const narrow = mediaSplit(style, /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/).bodies.join("\n");
const wideCss = wide.bodies.join("\n");

const row = flat(decls(base, ".meta-row"));
check("W1 .meta-row has display:flex, flex-wrap:wrap and a gap",
  /display:flex/.test(row) && /flex-wrap:wrap/.test(row) && /(^|;)gap:/.test(row));
const wb = basis(decls(wideCss, ".meta")), bb = basis(decls(base, ".meta")), nb = basis(decls(narrow, ".meta"));
check("W2 .meta flex-basis >= 240px inside @media (min-width:769px) (" + wb + "px)", wb >= 240);
check("W3 no .meta flex-basis in the base rules or in @media (max-width:768px) (" + bb + "px, " + nb + "px)", bb === 0 && nb === 0);
const meta = flat(decls(base, ".meta")), group = flat(decls(base, ".dl-group"));
check("W4 .meta and .dl-group may shrink: min-width:0 on both, .dl-group max-width:100% and no flex-shrink:0",
  /min-width:0/.test(meta) && /min-width:0/.test(group) && /max-width:100%/.test(group) && !/flex-shrink:0/.test(group));
const wrapSel = [".article-title", ".article-link", ".article-authors", ".meta", ".results-header", ".article-abstract"];
const noWrap = wrapSel.filter(s => !/overflow-wrap:anywhere/.test(flat(decls(base, s))));
check("W5 long titles/DOIs/URLs/authors/count text get overflow-wrap:anywhere (missing: " + (noWrap.join(",") || "none") + ")",
  noWrap.length === 0);
// An implicit auto grid column grows to unbreakable content; minmax(0,1fr) keeps cards inside the viewport.
check("W6 base .articles-grid has grid-template-columns:minmax(0,1fr)",
  /(^|;)grid-template-columns:minmax\(0,1fr\)(;|$)/.test(flat(decls(base, ".articles-grid"))));
const wrapRules = [...base.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /overflow-wrap:anywhere/.test(flat(m[2])));
check("W7 .article-abstract is in the overflow-wrap:anywhere selector list",
  wrapRules.some(m => m[1].split(",").map(s => s.trim()).includes(".article-abstract")));

console.log(`\n${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
