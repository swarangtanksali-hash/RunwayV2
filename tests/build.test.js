// The shared file must carry the tested engine byte-for-byte. Fails if src/ changed without `node build.js`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { render, MARKER, OUT, ENGINE } = require('../build.js');

test('path-to-1m.html is up to date with src/', () => {
  assert.ok(fs.existsSync(OUT), 'path-to-1m.html missing: run node build.js');
  assert.equal(fs.readFileSync(OUT, 'utf8'), render(), 'path-to-1m.html is stale: run node build.js');
});

test('path-to-1m.html contains the tested engine verbatim, exactly once', () => {
  const html = fs.readFileSync(OUT, 'utf8');
  const engine = fs.readFileSync(ENGINE, 'utf8');
  assert.equal(html.split(engine).length - 1, 1);
  assert.ok(!html.includes(MARKER));
});

test('page has no storage, eval or extra network calls', () => {
  const html = fs.readFileSync(OUT, 'utf8');
  for (const bad of ['localStorage', 'sessionStorage', 'indexedDB', 'eval(', 'new Function', 'fetch(', 'XMLHttpRequest']) {
    assert.ok(!html.includes(bad), 'found ' + bad);
  }
  const srcs = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(srcs, ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js']);
});
