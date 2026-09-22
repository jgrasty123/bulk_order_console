/* Stamp a content hash onto every local CSS/JS link in the HTML.
 *
 * Without this, a browser can hold an old stylesheet against new markup —
 * which shows up as an unstyled page for anyone who visited before a
 * deploy, while incognito looks fine. Changing the URL whenever the file
 * changes makes that impossible.
 *
 * Run: npm run stamp   (also runs as part of npm test)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = ['index.html', 'status.html', 'admin/index.html'];
const ref = /(href|src)="(\/assets\/[\w./-]+\.(?:css|js))(?:\?v=\w+)?"/g;

let changed = 0;
for (const page of pages) {
  const path = join(root, page);
  if (!existsSync(path)) continue;
  const before = readFileSync(path, 'utf8');
  const after = before.replace(ref, (whole, attr, file) => {
    const asset = join(root, file.replace(/^\//, ''));
    if (!existsSync(asset)) return whole;
    const v = createHash('sha1').update(readFileSync(asset)).digest('hex').slice(0, 8);
    return `${attr}="${file}?v=${v}"`;
  });
  if (after !== before) { writeFileSync(path, after); changed++; }
}
console.log(changed ? `stamped ${changed} page(s)` : 'assets already stamped');
