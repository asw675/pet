import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expected = [
  'out/main/index.cjs', 'out/main/app-service.cjs',
  'out/preload/pet.cjs', 'out/preload/control-center.cjs',
  'out/renderer/pet/index.html', 'out/renderer/control-center/index.html',
];
for (const file of expected) {
  const absolute = join(root, file);
  assert(existsSync(absolute) && statSync(absolute).isFile(), `Missing build entry: ${file}`);
}

const requires = (source) => [...source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2]);
for (const file of expected.slice(2, 4)) {
  const source = readFileSync(join(root, file), 'utf8');
  const imports = requires(source);
  assert(imports.includes('electron'), `${file} must connect through the Electron preload API`);
  // A sandboxed preload cannot require local output chunks or native modules.
  assert(imports.every((name) => name === 'electron'), `${file} is not a standalone sandbox-safe bundle`);
}

// Include local chunks reachable from each entry, not just entry-point text.
function reachableSource(entry) {
  const visited = new Set();
  const sources = [];
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    sources.push(source);
    for (const imported of requires(source)) {
      if (imported.startsWith('./') || imported.startsWith('../')) visit(resolve(dirname(path), imported));
    }
  }
  visit(join(root, entry));
  return sources.join('\n');
}
const main = reachableSource(expected[0]);
const worker = reachableSource(expected[1]);
assert(!requires(main).includes('better-sqlite3'), 'Main must not load the database driver');
assert(!main.includes('CREATE TABLE schema_migrations'), 'Main must not bundle the database implementation');
assert(requires(worker).includes('better-sqlite3'), 'Utility process must keep the native driver external');
assert(worker.includes('CREATE TABLE schema_migrations'), 'Utility process must bundle the application SQLite repository');

console.log('Build layout verified: independent Main, utility service, two sandboxed preloads and two renderer entries.');
