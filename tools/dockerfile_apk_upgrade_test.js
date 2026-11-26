// Dockerfile apk upgrade test (OpenSSL 3.5.9-r1 and zlib, by name).
//
// Run: node tools/dockerfile_apk_upgrade_test.js [path/to/Dockerfile]
//
// Grype (--only-fixed --fail-on high) reported libcrypto3 and libssl3
// 3.5.9-r0 as vulnerable; the fix is 3.5.9-r1. This static check reads the
// Dockerfile and asserts, on the final stage only (after the last FROM,
// comment lines skipped):
//   (a) exactly one line contains "apk upgrade";
//   (b) that line has --no-cache, zlib, libcrypto3 and libssl3;
//   (c) no "apk upgrade" without a package name;
//   (d) the final stage has a USER line;
//   (e) the apk upgrade line comes before the USER line.
"use strict";
const fs = require("fs");
const path = require("path");

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const file = process.argv[2] || path.join(__dirname, "..", "Dockerfile");
let src = fs.readFileSync(file, "utf8");
if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
src = src.split(CR + LF).join(LF).split(CR).join(LF);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const lines = src.split(LF);
let lastFrom = -1;
lines.forEach((l, i) => {
  if (l.trim().toUpperCase().startsWith("FROM ")) lastFrom = i;
});
if (lastFrom < 0) {
  console.error("FAIL: no FROM line in " + file + " - refusing to pass silently");
  process.exit(1);
}

const stage = lines.slice(lastFrom + 1).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
const upgradeIdx = [];
stage.forEach((l, i) => {
  if (l.includes("apk upgrade")) upgradeIdx.push(i);
});
const userIdx = stage.findIndex((l) => l.startsWith("USER "));

check("(a) exactly one apk upgrade line in the final stage (found " + upgradeIdx.length + ")", upgradeIdx.length === 1);
const line = upgradeIdx.length ? stage[upgradeIdx[0]] : "";
const words = line.split(" ").filter((w) => w !== "");
for (const want of ["--no-cache", "zlib", "libcrypto3", "libssl3"]) {
  check("(b) apk upgrade line names " + want, words.includes(want));
}

// Words after each "apk upgrade" up to && or ; must include a non-option word.
function bareUpgrades(l) {
  let bare = 0;
  const parts = l.split("apk upgrade");
  for (let p = 1; p < parts.length; p++) {
    const seg = parts[p].split("&&")[0].split(";")[0];
    const names = seg.split(" ").filter((w) => w !== "" && !w.startsWith("-"));
    if (names.length === 0) bare++;
  }
  return bare;
}
const bare = stage.reduce((n, l) => n + bareUpgrades(l), 0);
check("(c) no apk upgrade without a package name (found " + bare + ")", bare === 0);
check("(d) the final stage has a USER line", userIdx >= 0);
check("(e) apk upgrade line is before USER (upgrade at " + upgradeIdx[0] + ", USER at " + userIdx + ")", upgradeIdx.length === 1 && userIdx > upgradeIdx[0]);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all Dockerfile apk upgrade checks pass");
