import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeNativeArtifactPins } from './native-artifact-pins.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const release = process.argv[2] === undefined ? join(desktop, 'release') : resolve(process.argv[2]);
const unpacked = join(release, 'win-unpacked');
const resources = join(unpacked, 'resources');
const { version } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));

function verifyExecutable(path, x64) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(64);
    assert.equal(readSync(fd, header, 0, header.length, 0), header.length);
    assert.equal(header.readUInt16LE(0), 0x5a4d, `Missing MZ header in ${path}`);
    const pe = Buffer.alloc(6);
    assert.equal(readSync(fd, pe, 0, pe.length, header.readUInt32LE(60)), pe.length);
    assert.equal(pe.readUInt32LE(0), 0x4550, `Missing PE header in ${path}`);
    if (x64) assert.equal(pe.readUInt16LE(4), 0x8664, `Expected x64 PE in ${path}`);
  } finally {
    closeSync(fd);
  }
}

const pins = computeNativeArtifactPins(true);
const packaged = {
  whisperCliSha256: 'native/voice/win-x64/whisper-cli.exe',
  sapiHelperSha256: 'native/voice/win-x64/pet-desktop-sapi.exe',
  launchInspectorSha256: 'native/launch-inspect/launch-inspect.exe',
  fullscreenProbeSha256: 'native/fullscreen/fullscreen-probe.exe',
};
for (const [key, relative] of Object.entries(packaged)) {
  const filename = join(resources, relative);
  verifyExecutable(filename, true);
  assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), pins[key], `Native artifact bytes changed: ${relative}`);
}

verifyExecutable(join(release, `Pet-Desktop-${version}-win-x64.exe`), false);
verifyExecutable(join(unpacked, 'Pet Desktop.exe'), true);
assert(statSync(join(resources, 'native/voice/win-x64/whisper-LICENSE.txt')).size > 0, 'Whisper license is missing');
const builtin = join(desktop, 'src/renderer/asset-packs/builtin/star-singer');
const manifest = JSON.parse(readFileSync(join(builtin, 'manifest.json'), 'utf8'));
assert.equal(manifest.characterId, 'star-singer');
assert.equal(manifest.packVersion, '1.1.0');
const portrait = readFileSync(join(builtin, manifest.thumbnail));
const portraitDigest = createHash('sha256').update(portrait).digest('hex');
assert.equal(portraitDigest, manifest.files.find(file => file.path === manifest.thumbnail)?.sha256, 'Built-in portrait changed');
const archive = readFileSync(join(resources, 'app.asar'));
assert(archive.includes(portrait) && archive.includes(portraitDigest), 'Desktop and control center must bundle the new Star Singer');
assert(!archive.includes('332e062fa42e201514790222245b6bfac67659a467ec37b330c6187ecf113a3e'), 'Retired Star Singer atlas was packaged');
const nativeAddonRoot = join(resources, 'app.asar.unpacked');
const sqliteAddons = readdirSync(nativeAddonRoot, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name === 'better_sqlite3.node');
assert(sqliteAddons.length > 0, 'The packaged better-sqlite3 addon is missing');
for (const addon of sqliteAddons) verifyExecutable(join(addon.parentPath, addon.name), true);
console.log('Verified Windows installer, x64 runtime, built-in Star Singer, SQLite addon and helper digests.');
