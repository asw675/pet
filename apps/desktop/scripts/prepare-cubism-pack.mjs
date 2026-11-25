import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const maxFileBytes = 16 * 1024 * 1024;
const maxPackBytes = 64 * 1024 * 1024;
const baseline = new URL('../content-packs/star-singer-1.1.0/', import.meta.url);
const knownReferences = new Set(['Moc', 'Textures', 'Physics', 'Pose', 'DisplayInfo', 'UserData', 'Expressions', 'Motions']);
const semanticMotionNames = new Map([
  ['idle', 'idle'], ['walk', 'walk'], ['drag', 'drag'], ['taphead', 'tap.head'],
  ['happy', 'happy'], ['talk', 'talk'], ['eat', 'eat'], ['sleep', 'sleep'], ['celebrate', 'celebrate'],
]);

function under(root, path) {
  const location = relative(root, path);
  return location !== '..' && !location.startsWith('../') && !location.startsWith('..\\') && !isAbsolute(location);
}

async function sourceFile(root, name, suffix, max = maxFileBytes) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 220 || !name.toLowerCase().endsWith(suffix)
    || name.split('/').some(part => !part || part === '.' || part === '..' || /[\\:*?"<>|%\0]/u.test(part))) {
    throw new Error('Invalid Cubism export file reference');
  }
  const candidate = resolve(root, name);
  const actual = await realpath(candidate);
  const stat = await lstat(candidate);
  if (!under(root, actual) || !stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > max) {
    throw new Error('Cubism export reference is missing or outside bounds');
  }
  return readFile(actual);
}

async function prepare(modelPath, outputPath, version) {
  if (!/^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/u.test(version)
    || version.split('.').some(value => Number(value) > 65535) || version === '1.1.0') {
    throw new Error('Choose a new supported resource-pack version');
  }
  const modelDirectory = await realpath(dirname(modelPath));
  const model = JSON.parse(await sourceFile(modelDirectory, basename(modelPath), '.model3.json', 128 * 1024));
  const references = model.FileReferences;
  if (model.Version !== 3 || !references || typeof references !== 'object' || Array.isArray(references)
    || !Array.isArray(references.Textures) || references.Textures.length < 1 || references.Textures.length > 16
    || Object.keys(references).some(key => !knownReferences.has(key))) {
    throw new Error('Expected supported Cubism Model 3 export');
  }
  const manifest = JSON.parse(await readFile(new URL('manifest.json', baseline), 'utf8'));
  const files = new Map([['assets/portrait.png', await readFile(new URL('assets/portrait.png', baseline))]]);
  const copy = async (path, suffix, name) => {
    const target = 'live2d/' + name;
    files.set('assets/' + target, await sourceFile(modelDirectory, path, suffix, suffix.endsWith('.json') ? 1024 * 1024 : maxFileBytes));
    return target.slice('live2d/'.length);
  };
  const mapped = { Moc: await copy(references.Moc, '.moc3', 'star-singer.moc3'), Textures: [] };
  for (const [i, path] of references.Textures.entries()) {
    mapped.Textures.push(await copy(path, '.png', 'textures/texture-' + (i + 1) + '.png'));
  }
  for (const [key, suffix] of [['Physics', '.physics3.json'], ['Pose', '.pose3.json'],
    ['DisplayInfo', '.cdi3.json'], ['UserData', '.userdata3.json']]) {
    if (references[key] !== undefined) mapped[key] = await copy(references[key], suffix, 'star-singer' + suffix);
  }
  if (references.Expressions !== undefined) {
    if (!Array.isArray(references.Expressions) || references.Expressions.length > 32) throw new Error('Invalid expressions export');
    mapped.Expressions = [];
    for (const [i, expression] of references.Expressions.entries()) {
      mapped.Expressions.push({ Name: expression.Name, File: await copy(expression.File, '.exp3.json', 'expressions/exp-' + (i + 1) + '.exp3.json') });
    }
  }
  const actions = { idle: { still: 'idle', live2d: 'idle' } };
  if (references.Motions !== undefined) {
    if (typeof references.Motions !== 'object' || !references.Motions || Array.isArray(references.Motions)
      || Object.keys(references.Motions).length > 32) throw new Error('Invalid motions export');
    mapped.Motions = Object.create(null);
    let nextMotion = 1;
    for (const [group, motions] of Object.entries(references.Motions)) {
      if (!Array.isArray(motions) || motions.length < 1 || motions.length > 16) throw new Error('Invalid motion group');
      const normalized = group.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
      let targetGroup = /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(normalized) && !['constructor', 'prototype'].includes(normalized)
        ? normalized : 'motion-group-' + nextMotion;
      let suffix = 1;
      while (Object.hasOwn(mapped.Motions, targetGroup)) targetGroup = 'motion-group-' + nextMotion + '-' + suffix++;
      mapped.Motions[targetGroup] = [];
      for (const motion of motions) {
        if (motion.Sound || nextMotion > 64) throw new Error('Motion sound is unsupported or motion limit exceeded');
        const File = await copy(motion.File, '.motion3.json', 'motions/motion-' + nextMotion++ + '.motion3.json');
        mapped.Motions[targetGroup].push({ File,
          ...(motion.FadeInTime === undefined ? {} : { FadeInTime: motion.FadeInTime }),
          ...(motion.FadeOutTime === undefined ? {} : { FadeOutTime: motion.FadeOutTime }),
        });
      }
      const semantic = semanticMotionNames.get(group.replace(/[ ._-]/gu, '').toLowerCase());
      if (semantic) actions[semantic] = { ...actions[semantic], live2d: targetGroup };
    }
  }
  const entry = 'assets/live2d/star-singer.model3.json';
  files.set(entry, Buffer.from(JSON.stringify({ ...model, FileReferences: mapped }, null, 2)));
  let byteCount = 0;
  manifest.packVersion = version;
  manifest.variants.unshift({ id: 'live2d', renderer: 'cubism', entry });
  manifest.actions = actions;
  manifest.files = [...files].map(([path, data]) => {
    byteCount += data.length;
    return { path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
  if (byteCount > maxPackBytes) throw new Error('Cubism pack exceeds the package byte budget');
  const output = resolve(outputPath);
  await mkdir(output); // A version directory is never overwritten.
  for (const [path, data] of files) {
    const target = join(output, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return output;
}

const [model, output, version = '1.2.0', ...extra] = process.argv.slice(2);
if (!model || !output || extra.length > 0) {
  console.error('Usage: node ' + fileURLToPath(import.meta.url) + ' <model3.json> <new-pack-directory> [pack-version]');
  process.exitCode = 2;
} else {
  try { console.log(await prepare(resolve(model), output, version)); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
