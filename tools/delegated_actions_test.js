// Delegated data-action listeners test (CSP phase 0).
//
// Run: node tools/delegated_actions_test.js
//
// The static markup and the HTML built in JS strings carry data-action="..."
// (plus data-q/data-from/data-to, data-idx, data-dir) instead of inline on*=
// handlers, and one delegated listener per event type (click, change, input)
// on document acts on them. no_inline_handlers_test.js proves the handlers are
// gone; this proves the replacement works:
//   T3 every data-action value used in index.html has a branch in the
//      delegated listeners, and every branch is used by at least one
//      data-action;
//   T4 the delegated block is cut out of index.html and driven in a vm sandbox
//      with fake elements whose data-* attributes are read from the real
//      markup; prefill, expandAbs and pubveraSignIn are the real functions,
//      the rest are spies.
// A listener block or markup tag that cannot be found is a FAIL, never a
// silent pass.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const raw = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
// HTML comments are blanked character by character so line numbers still match.
const html = raw.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, " "));
const lineOf = i => html.slice(0, i).split("\n").length;

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// The block runs from its marker comment to the end of the classic script, and
// the marker must occur exactly once.
const MARK = "    // ── Delegated data-action listeners";
const at = [];
for (let i = html.indexOf(MARK); i >= 0; i = html.indexOf(MARK, i + 1)) at.push(i);
let block = "", blockLine = 0;
if (at.length === 1) {
  const end = html.indexOf("\n  </script>", at[0]);
  if (end > at[0]) { block = html.slice(at[0], end); blockLine = lineOf(at[0]); }
}
check("T3/T4 delegated listener block found exactly once (found " + at.length +
  (blockLine ? ", L" + blockLine : "") + ")", at.length === 1 && block !== "");

// ── T3: data-action values vs handler branches ──
const branches = [...new Set([...block.matchAll(/\ba\s*===\s*(["'])([^"']*)\1/g)].map(m => m[2]))];
// JS line comments document, they do not use.
const used = new Map();
const dynamic = [];
html.split("\n").forEach((ln, i) => {
  if (/^\s*\/\//.test(ln)) return;
  for (const m of ln.matchAll(/data-action\s*=\s*\\?["']([^"'\\]*)/g)) {
    if (!/^[A-Za-z][\w-]*$/.test(m[1])) { dynamic.push("L" + (i + 1) + ": " + m[0]); continue; }
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(i + 1);
  }
});
console.log("      branches in delegated listeners: " + (branches.join(", ") || "(none)"));
console.log("      data-action values used:         " +
  ([...used].map(([v, ls]) => v + " (L" + ls.join(",L") + ")").join(", ") || "(none)"));
const missing = [...used.keys()].filter(v => !branches.includes(v));
const dead = branches.filter(v => !used.has(v));
check("T3 delegated listeners have at least one branch (found " + branches.length + ")", branches.length > 0);
check("T3 index.html uses at least one data-action (found " + used.size + ")", used.size > 0);
check("T3 every data-action has a handler branch (missing: " + (missing.join(", ") || "none") + ")", missing.length === 0);
check("T3 every handler branch is used by a data-action (dead: " + (dead.join(", ") || "none") + ")", dead.length === 0);
check("T3 every data-action value is a literal (non-literal: " + dynamic.length + ")", dynamic.length === 0);
for (const d of dynamic) console.log("      " + d);

// ── Markup: the tags the cases click, with their data-* read from index.html ──
const tags = re => [...html.matchAll(re)];
function dataset(tag) {
  const ds = {};
  for (const m of tag.matchAll(/\sdata-([a-z][a-z0-9-]*)\s*=\s*"([^"]*)"/g))
    ds[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2];
  return ds;
}
const chips = tags(/<div class="chip"[^>]*>([^<]*)<\/div>/g);
const searchBtn = tags(/<button[^>]*id="searchBtn"[^>]*>/g);
const typeSel = tags(/<select[^>]*id="typeFilter"[^>]*>/g);
const sortSel = tags(/<select[^>]*id="sortResults"[^>]*>/g);
const expandBtn = tags(/<button class="expand-btn"[^>]*>/g);
const citeBtn = tags(/<button class="cite-btn"[^>]*>/g);
const pager = tags(/<button class="dl"[^\n]*?>(← Previous|Next →)<\/button>/g);
const signInBtn = tags(/<button[^>]*class="search-btn"[^>]*>Sign in with Google<\/button>/g);
const slider = tags(/<input[^>]*id="perPageSlider"[^>]*>/g);
const prevTag = (pager.find(m => m[1] === "← Previous") || [""])[0];
const nextTag = (pager.find(m => m[1] === "Next →") || [""])[0];
check("T3 pager keeps its disabled conditions (Previous on page 1, Next on the last page)",
  pager.length === 2 && /"\s+\$\{currentPage <= 1 \? 'disabled' : ''\}>/.test(prevTag) &&
  /"\s+\$\{currentPage >= totalPages \? 'disabled' : ''\}>/.test(nextTag));

// The real functions that are easy to run in a sandbox.
const fnSrc = name => {
  const m = new RegExp("^    function " + name + "\\([^)]*\\) \\{\\n[\\s\\S]*?\\n    \\}$", "m").exec(html);
  return m ? m[0] : "";
};
const realSrc = ["prefill", "expandAbs", "pubveraSignIn"].map(fnSrc);
check("T4 real prefill, expandAbs and pubveraSignIn found in index.html", realSrc.every(s => s !== ""));

// A fresh sandbox per case: one broken branch cannot leak into the next case.
function harness() {
  const calls = [];
  const spy = name => (...a) => { calls.push([name, ...a]); };
  const els = {
    queryInput: { value: "" },
    fromYearSelect: { value: "" },
    toYearSelect: { value: "" },
    perPageVal: { textContent: "20" },
  };
  const L = {};
  const sb = {
    document: {
      getElementById: id => els[id] || null,
      addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); },
    },
    window: { pubveraAuth: { signIn: () => calls.push(["pubveraAuth.signIn"]) } },
    doSearch: spy("doSearch"),
    applyTypeFilter: spy("applyTypeFilter"),
    applySort: spy("applySort"),
    copyBibtex: spy("copyBibtex"),
    pageNav: spy("pageNav"),
  };
  vm.createContext(sb);
  vm.runInContext(realSrc.join("\n"), sb);
  // Record the calls to the real functions, then run them.
  for (const name of ["prefill", "expandAbs", "pubveraSignIn"]) {
    const real = sb[name];
    sb[name] = (...a) => { calls.push([name, ...a]); return real(...a); };
  }
  vm.runInContext(block, sb);
  const fire = (type, e) => (L[type] || []).forEach(f => f(e));
  // The click target is the node inside the element; closest() walks up to it.
  const click = el => fire("click", { target: { closest: s => (s === "[data-action]" ? el : null) } });
  return { calls, els, L, fire, click };
}
function tcase(label, fn) {
  let ok = false, why = "";
  try { ok = fn(harness()); } catch (e) { why = " (threw: " + e.message + ")"; }
  check("T4 " + label + why, ok === true);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const untouched = els => els.queryInput.value === "" && els.fromYearSelect.value === "" &&
  els.toYearSelect.value === "" && els.perPageVal.textContent === "20";
const button = tag => ({ dataset: dataset(tag), style: {}, closest: () => null });

tcase("block registers exactly one click, one change and one input listener on document", h =>
  same(Object.keys(h.L).sort(), ["change", "click", "input"]) &&
  h.L.click.length === 1 && h.L.change.length === 1 && h.L.input.length === 1);

// The three chips and the arguments their old onclick passed.
const CHIPS = [["CAR-T 2014", "cancer", 2014, 2014], ["Glioblastoma 2005", "glioblastoma", 2005, 2005],
  ["COVID 2020", "covid", 2020, 2020]];
check("T4 exactly 3 chips in the markup (found " + chips.length + ")", chips.length === 3);
for (const [text, q, f, t] of CHIPS) {
  tcase("chip \"" + text + "\" -> prefill('" + q + "', " + f + ", " + t + ") with numbers, fields set, doSearch()", h => {
    const chip = chips.find(m => m[1] === text);
    h.click(button(chip[0]));
    return same(h.calls, [["prefill", q, f, t], ["doSearch"]]) &&
      typeof h.calls[0][2] === "number" && typeof h.calls[0][3] === "number" &&
      h.els.queryInput.value === q && h.els.fromYearSelect.value === f && h.els.toYearSelect.value === t;
  });
}
tcase("#searchBtn -> doSearch() with no arguments", h => {
  h.click(button(searchBtn.length === 1 ? searchBtn[0][0] : ""));
  return same(h.calls, [["doSearch"]]) && untouched(h.els);
});
tcase("change on #typeFilter -> applyTypeFilter()", h => {
  h.fire("change", { target: { id: "typeFilter", dataset: dataset(typeSel.length === 1 ? typeSel[0][0] : "") } });
  return same(h.calls, [["applyTypeFilter"]]);
});
tcase("change on #sortResults -> applySort()", h => {
  h.fire("change", { target: { id: "sortResults", dataset: dataset(sortSel.length === 1 ? sortSel[0][0] : "") } });
  return same(h.calls, [["applySort"]]);
});
tcase("click on #sortResults (a change action) calls nothing", h => {
  h.click(button(sortSel.length === 1 ? sortSel[0][0] : ""));
  return same(h.calls, []);
});
tcase("change on a select without data-action (#sortSelect) does nothing", h => {
  h.fire("change", { target: { id: "sortSelect", dataset: {} } });
  return same(h.calls, []) && untouched(h.els);
});
tcase("...read more -> expandAbs(matched button): abstract uncollapsed, button hidden", h => {
  const removed = [];
  const abs = { classList: { remove: c => removed.push(c) } };
  const btn = button(expandBtn.length === 1 ? expandBtn[0][0] : "");
  btn.closest = s => (s === ".article-abstract" ? abs : null);
  h.click(btn);
  return h.calls.length === 1 && h.calls[0][0] === "expandAbs" && h.calls[0][1] === btn &&
    h.calls[0].length === 2 && same(removed, ["collapsed"]) && btn.style.display === "none";
});
tcase("Cite (template data-idx=${idx}, idx 3) -> copyBibtex(3, matched button) with a number", h => {
  const btn = button(citeBtn.length === 1 ? citeBtn[0][0].replace("${idx}", "3") : "");
  h.click(btn);
  return h.calls.length === 1 && h.calls[0][0] === "copyBibtex" && h.calls[0][1] === 3 &&
    h.calls[0][2] === btn && h.calls[0].length === 3;
});
tcase("← Previous -> pageNav(-1) with a number", h => {
  h.click(button(prevTag));
  return same(h.calls, [["pageNav", -1]]);
});
tcase("Next → -> pageNav(1) with a number", h => {
  h.click(button(nextTag));
  return same(h.calls, [["pageNav", 1]]);
});
tcase("401 card Sign in with Google -> pubveraSignIn() -> pubveraAuth.signIn()", h => {
  h.click(button(signInBtn.length === 1 ? signInBtn[0][0] : ""));
  return same(h.calls, [["pubveraSignIn"], ["pubveraAuth.signIn"]]) && untouched(h.els);
});
tcase("input on #perPageSlider -> #perPageVal shows the value", h => {
  h.fire("input", { target: { id: "perPageSlider", value: "55", dataset: {} } });
  return slider.length === 1 && h.els.perPageVal.textContent === "55" && same(h.calls, []);
});
tcase("click outside any [data-action] (closest -> null) does nothing", h => {
  h.click(null);
  return same(h.calls, []) && untouched(h.els);
});
tcase("unknown data-action does nothing", h => {
  h.click({ dataset: { action: "nope" }, style: {}, closest: () => null });
  h.fire("change", { target: { id: "x", dataset: { action: "nope" } } });
  return same(h.calls, []) && untouched(h.els);
});
tcase("input on another field (.qfilter) leaves #perPageVal alone", h => {
  h.fire("input", { target: { id: "", className: "qfilter", value: "zzz", dataset: {} } });
  return h.els.perPageVal.textContent === "20" && same(h.calls, []);
});

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
