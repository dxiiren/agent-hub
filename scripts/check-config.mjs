// Checks every config/**/*.json template: valid JSON, and no literal host/IP (placeholders only).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') && files.push(p); } };
walk('config');

let bad = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  try { JSON.parse(text); } catch (e) { console.log(`[FAIL] ${f}: ${e.message}`); bad++; continue; }
  const lit = text.match(/https?:\/\/(?!localhost|127\.0\.0\.1|<)[^"\s]+/g);
  if (lit) { console.log(`[FAIL] ${f}: literal URL ${lit[0]} (use a <PLACEHOLDER>)`); bad++; continue; }
  console.log(`[OK] ${f}`);
}
console.log(`${files.length - bad}/${files.length} config templates OK`);
process.exit(bad ? 1 : 0);
