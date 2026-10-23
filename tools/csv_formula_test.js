'use strict';
// Loads the REAL toCSV() source out of index.html and checks the CSV
// formula-injection guard. Plain node, no dependencies.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function toCSV(');
if (start < 0) { console.log('FAIL: toCSV not found in index.html'); process.exit(1); }
const endMatch = /\r?\n    \}\r?\n/.exec(html.slice(start));
if (!endMatch) { console.log('FAIL: end of toCSV not found'); process.exit(1); }
const src = html.slice(start, start + endMatch.index + endMatch[0].length);
const toCSV = new Function(src + '\nreturn toCSV;')();

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failed++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// Minimal RFC 4180 parser.
function parse(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
    else f += c;
  }
  row.push(f); rows.push(row);
  return rows;
}

// Cell value as a spreadsheet would see it: rows[0]=sep=, rows[1]=header, rows[2]=data.
function firstData(value) {
  return parse(toCSV([{ A: value }]).replace(/^\uFEFF/, ''))[2][0];
}

function prefixed(label, list) {
  list.forEach(function (s) {
    const got = firstData(s);
    check(label + ' prefixed ' + JSON.stringify(s), got === "'" + s, 'got ' + JSON.stringify(got));
  });
}

// a) classic formula starters, tab and CR
prefixed('a)', ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1', '\r=1']);
// b) leading space / newline before the starter
prefixed('b)', [' =1+1', '\n=1+1']);
// c) full-width starters
prefixed('c)', ['\uFF1D1+1', '\uFF0B1+1', '\uFF0D1+1', '\uFF20SUM(A1)']);

// d) numbers and strictly numeric strings unchanged
[5, -33, '-5', '3.14', '-0.5'].forEach(function (v) {
  const got = firstData(v);
  check('d) unchanged ' + JSON.stringify(v), got === String(v), 'got ' + JSON.stringify(got));
});

// e) ordinary text unchanged
['Smith J', 'a=b', ' plain'].forEach(function (s) {
  const got = firstData(s);
  check('e) unchanged ' + JSON.stringify(s), got === s, 'got ' + JSON.stringify(got));
});

// f) prefixed AND RFC 4180 quoted
['=1,2', '=a"b'].forEach(function (s) {
  const raw = toCSV([{ A: s }]);
  const expect = '"\'' + s.replace(/"/g, '""') + '"';
  check('f) quoted ' + JSON.stringify(s), raw.endsWith('\r\n' + expect), 'tail ' + JSON.stringify(raw.slice(-12)));
  check('f) round-trip ' + JSON.stringify(s), firstData(s) === "'" + s, 'got ' + JSON.stringify(firstData(s)));
});

// g) BOM + sep=, booleans and null
(function () {
  const out = toCSV([{ A: true, B: false, C: null }]);
  check('g) BOM then sep=,', out.charCodeAt(0) === 0xFEFF && out.slice(1).split('\r\n')[0] === 'sep=,');
  const p = parse(out.slice(1));
  check('g) true/false/null -> Yes/""/""', JSON.stringify(p[2]) === '["Yes","",""]', 'got ' + JSON.stringify(p[2]));
})();

process.exit(failed ? 1 : 0);
