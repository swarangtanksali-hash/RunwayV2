// Builds the single shareable file path-to-1m.html from src/page.html + src/engine.js.
// Usage: node build.js   (no dependencies; reads and writes only inside this repo)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const MARKER = '/*__ENGINE_JS__*/';
const TEMPLATE = path.join(ROOT, 'src', 'page.html');
const ENGINE = path.join(ROOT, 'src', 'engine.js');
const OUT = path.join(ROOT, 'path-to-1m.html');

function render() {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const engine = fs.readFileSync(ENGINE, 'utf8');
  const count = template.split(MARKER).length - 1;
  if (count !== 1) throw new Error(`expected exactly one ${MARKER} in src/page.html, found ${count}`);
  if (engine.includes('</script')) throw new Error('engine.js must not contain "</script"');
  return template.replace(MARKER, () => engine);
}

if (require.main === module) {
  fs.writeFileSync(OUT, render(), 'utf8');
  console.log('Wrote path-to-1m.html');
}

module.exports = { render, MARKER, OUT, ENGINE };
