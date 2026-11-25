import { describe, expect, it } from 'vitest';
import {
  assetPathSchema,
  characterPackLimits,
  characterPackManifestJsonSchema,
  characterPackManifestSchema,
  packVersionSchema,
  spriteAtlasJsonSchema,
  spriteAtlasSchema,
  validateSpriteAtlas,
  type CharacterPackManifest,
  type SpriteAtlas,
} from '../src/index.js';

const digest = '0'.repeat(64);
const file = (path: string, bytes = 32) => ({ path, bytes, sha256: digest });
function manifest(): CharacterPackManifest {
  return {
    schemaVersion: 1,
    characterId: 'star-singer',
    packVersion: '1.0.0',
    minAppVersion: '0.0.0',
    displayName: { 'zh-CN': '星咏', 'en-US': 'Star Singer' },
    thumbnail: 'assets/card.png',
    variants: [
      { id: 'sprite', renderer: 'sprite', entry: 'assets/atlas.json' },
      { id: 'still', renderer: 'static', entry: 'assets/idle.png' },
    ],
    anchor: { x: 0.5, y: 1 },
    logicalSize: { w: 128, h: 128 },
    hitRegions: [{ id: 'head', rect: [0.2, 0.1, 0.6, 0.4] }],
    actions: {
      idle: { sprite: 'idle', still: 'idle' },
      'tap.head': { sprite: 'happy' },
    },
    lipSync: { sprite: { mode: 'frames', clips: ['mouth.0', 'mouth.1', 'mouth.2'] } },
    cgIds: ['star-singer.intro'],
    license: { owner: 'Pet Desktop', reference: 'original-poc-fixture' },
    files: [file('assets/card.png'), file('assets/atlas.json'), file('assets/idle.png'), file('assets/atlas.png')],
  };
}

const frame = (x = 0, y = 0): { rect: [number, number, number, number]; durationMs: number } => ({
  rect: [x, y, 128, 128], durationMs: 120,
});
function atlas(): SpriteAtlas {
  return {
    schemaVersion: 1,
    image: 'assets/atlas.png',
    size: { w: 384, h: 256 },
    clips: {
      idle: { frames: [frame(), frame(128)] },
      happy: { frames: [frame(256)] },
      'mouth.0': { frames: [frame(0, 128)] },
      'mouth.1': { frames: [frame(128, 128)] },
      'mouth.2': { frames: [frame(256, 128)] },
    },
  };
}

describe('canonical resource paths and versions', () => {
  it.each(['assets/idle.png', 'assets/atlas.json', 'assets/images/card-1.webp', 'assets/model/foo.model3.json', 'assets/model/avatar.vrm'])('accepts canonical path %s', (path) => {
    expect(assetPathSchema.safeParse(path).success).toBe(true);
  });

  it.each([
    '../secret.png', 'assets/../secret.png', 'assets/./idle.png', 'assets//idle.png',
    '/assets/idle.png', 'C:/assets/idle.png', 'assets/a\\idle.png',
    'https://host/asset.png', 'file:///assets/idle.png', 'data:image/png;base64,AAAA',
    'assets/idle.png?download', 'assets/idle.png#frag', 'assets/%2e%2e/idle.png',
    'Assets/idle.png', 'assets/IDLE.PNG', 'assets/foo./idle.png', 'assets/idle.png.', 'assets/idle.png ',
    'assets/idle.png:payload', 'assets/con.png', 'assets/nul/idle.png', 'assets/aux.data.png',
    'assets/com1/idle.png', 'assets/lpt9.png', 'assets/script.js', 'assets/index.html',
    'assets/image.svg', 'assets/payload.exe', 'assets/program.dll', 'assets/idle',
  ])('rejects noncanonical, unsafe or unsupported path %s', (path) => {
    expect(assetPathSchema.safeParse(path).success).toBe(false);
  });

  it.each(['0.0.0', '1.0.2', '65535.65535.65535'])('accepts a bounded stable release version %s', (version) => {
    expect(packVersionSchema.safeParse(version).success).toBe(true);
  });

  it.each(['1', '1.0', '1.0.0-alpha', '1.0.0+build', '-1.0.0', '01.0.0', '70000.0.0', '0.1000000.0'])('rejects invalid version %s', (version) => {
    expect(packVersionSchema.safeParse(version).success).toBe(false);
  });
});

describe('character resource pack manifest', () => {
  it('validates a complete sprite + static pack', () => {
    const input = manifest();
    expect(characterPackManifestSchema.parse(input)).toEqual(input);
  });

  it('provides generated structural JSON Schemas', () => {
    const manifestJson = characterPackManifestJsonSchema();
    const atlasJson = spriteAtlasJsonSchema();
    expect(manifestJson).toMatchObject({ type: 'object', additionalProperties: false });
    expect(atlasJson).toMatchObject({ type: 'object', additionalProperties: false });
    expect(manifestJson).toHaveProperty('properties.schemaVersion.const', 1);
    expect(atlasJson).toHaveProperty('properties.clips');
  });

  it.each([
    { schemaVersion: 2 }, { characterId: 'Star-Singer' }, { displayName: { en: 'Only English' } },
    { displayName: { 'zh-CN': '   ' } }, { displayName: { 'zh-CN': '星咏', 'bad/locale': 'invalid' } },
    { license: { owner: 'Pet Desktop', reference: '' } }, { anchor: { x: -1, y: 1 } },
    { logicalSize: { w: 0, h: 128 } }, { logicalSize: { w: 2049, h: 128 } },
    { plugin: 'assets/script.js' }, { cgIds: ['star-singer.intro', 'star-singer.intro'] },
    { hitRegions: [] }, { hitRegions: [{ id: 'head', rect: [0.8, 0.3, 0.3, 0.4] }] },
    { hitRegions: [{ id: 'head', rect: [0.2, 0.3, 0, 0.4] }] },
    { hitRegions: [{ id: 'head', rect: [0.2, 0.3, 0.1, 0.4] }, { id: 'head', rect: [0.2, 0.1, 0.3, 0.4] }] },
  ])('rejects malformed manifest fields (%j)', (patch) => {
    expect(characterPackManifestSchema.safeParse({ ...manifest(), ...patch }).success).toBe(false);
  });

  it('rejects dangling entries, missing thumbnails, and duplicate paths/variants', () => {
    const input = manifest();
    expect(characterPackManifestSchema.safeParse({ ...input, thumbnail: 'assets/missing.png' }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, files: input.files.filter((asset) => asset.path !== 'assets/atlas.json') }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, files: [...input.files, file('assets/atlas.png')] }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, files: [...input.files, file('assets/Atlas.png')] }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, variants: [...input.variants, input.variants[0]] }).success).toBe(false);
    const changed = [...input.variants];
    changed[0] = { id: 'sprite', renderer: 'sprite', entry: 'assets/card.png' };
    expect(characterPackManifestSchema.safeParse({ ...input, variants: changed }).success).toBe(false);
  });

  it('requires idle for every variant and disallows nonexistent and prototype action keys', () => {
    const input = manifest();
    expect(characterPackManifestSchema.safeParse({ ...input, actions: { happy: { sprite: 'happy' } } }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, actions: { idle: { sprite: 'idle' } } }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, actions: { ...input.actions, walk: { missing: 'walk' } } }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, actions: { ...input.actions, walk: { still: 'walk' } } }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, actions: { ...input.actions, constructor: { sprite: 'idle' } } }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, actions: { ...input.actions, walk: {} } }).success).toBe(false);
  });

  it('rejects own prototype keys in raw JSON instead of dropping them', () => {
    const input = manifest();
    const prototypeRecord: unknown = JSON.parse('{"idle":{"sprite":"idle","still":"idle"},"__proto__":{"sprite":"idle"}}');
    expect(characterPackManifestSchema.safeParse({ ...input, actions: prototypeRecord }).success).toBe(false);
    const rootKey: unknown = JSON.parse(`${JSON.stringify(input).slice(0, -1)},"__proto__":{}}`);
    expect(characterPackManifestSchema.safeParse(rootKey).success).toBe(false);
  });

  it('requires a sprite variant and three distinct clips for framed lip-sync', () => {
    const input = manifest();
    const clips = ['mouth.0', 'mouth.1', 'mouth.2'];
    expect(characterPackManifestSchema.safeParse({ ...input, lipSync: { still: { mode: 'frames', clips } } }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, lipSync: { missing: { mode: 'frames', clips } } }).success).toBe(false);
    expect(characterPackManifestSchema.safeParse({ ...input, lipSync: { sprite: { mode: 'frames', clips: ['mouth.0', 'mouth.0', 'mouth.2'] } } }).success).toBe(false);
  });

  it('records future typed model entries without claiming adapters are available', () => {
    const input = manifest();
    const future = [
      { id: 'live2d', renderer: 'cubism', entry: 'assets/avatar.model3.json' },
      { id: 'three-d', renderer: 'vrm', entry: 'assets/avatar.vrm' },
      { id: 'rig', renderer: 'spine', entry: 'assets/avatar.skel' },
    ];
    const value = {
      ...input, variants: [...input.variants, ...future],
      actions: { idle: { ...input.actions.idle, live2d: 'idle', 'three-d': 'idle', rig: 'idle' } },
      files: [...input.files, ...future.map((variant) => file(variant.entry))],
    };
    expect(characterPackManifestSchema.safeParse(value).success).toBe(true);
  });

  it('checks positive sizes, per-file limits, total pack budget, and hash syntax', () => {
    const input = manifest();
    for (const badFile of [file('assets/extra.png', 0), file('assets/extra.png', characterPackLimits.fileBytes + 1), { ...file('assets/extra.png'), sha256: 'short' }]) {
      expect(characterPackManifestSchema.safeParse({ ...input, files: [...input.files, badFile] }).success).toBe(false);
    }
    const sized = input.files.map((entry) => ({ ...entry, bytes: characterPackLimits.fileBytes }));
    expect(characterPackManifestSchema.safeParse({ ...input, files: sized }).success).toBe(true);
    expect(characterPackManifestSchema.safeParse({ ...input, files: [...sized, file('assets/extra.png', 1)] }).success).toBe(false);
    const long = [...input.files, ...Array.from({ length: characterPackLimits.files }, (_, i) => file(`assets/extra-${i}.png`))];
    expect(characterPackManifestSchema.safeParse({ ...input, files: long }).success).toBe(false);
  });
});

describe('bounded untrimmed sprite atlas', () => {
  it('validates a complete atlas and action/viseme references', () => {
    const input = spriteAtlasSchema.parse(atlas());
    expect(input).toEqual(atlas());
    expect(() => validateSpriteAtlas(characterPackManifestSchema.parse(manifest()), 'sprite', input)).not.toThrow();
  });

  it.each([
    { schemaVersion: 2 }, { image: 'assets/atlas.json' }, { size: { w: 2049, h: 256 } }, { size: { w: 384, h: 0 } },
    { clips: {} }, { clips: { idle: { frames: [] } } }, { clips: { idle: { frames: [{ rect: [-1, 0, 128, 128], durationMs: 120 }] } } },
    { clips: { idle: { frames: [{ rect: [0, 0, 0, 128], durationMs: 120 }] } } },
    { clips: { idle: { frames: [{ rect: [300, 0, 128, 128], durationMs: 120 }] } } },
    { clips: { idle: { frames: [{ rect: [0, 0, 128, 128], durationMs: 0 }] } } },
    { clips: { idle: { frames: [{ rect: [0, 0, 128, 128], durationMs: 10001 }] } } },
    { clips: { idle: { frames: [{ rect: [0, 0, 128, 128], durationMs: 120, rotated: true }] } } },
    { clips: { idle: { frames: [{ rect: [0, 0, 128, 128], durationMs: 120, sourceSize: { w: 256, h: 256 } }] } } },
    { clips: { idle: { frames: [frame(), { rect: [128, 0, 64, 128], durationMs: 120 }] } } },
  ])('rejects malformed atlas fields (%j)', (patch) => {
    expect(spriteAtlasSchema.safeParse({ ...atlas(), ...patch }).success).toBe(false);
  });

  it('limits clips and frames per clip and overall', () => {
    expect(spriteAtlasSchema.safeParse({ ...atlas(), clips: { idle: { frames: Array.from({ length: 257 }, () => frame()) } } }).success).toBe(false);
    const clips = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`clip-${i}`, { frames: [frame()] }]));
    expect(spriteAtlasSchema.safeParse({ ...atlas(), clips }).success).toBe(false);
    const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`clip-${i}`, { frames: Array.from({ length: 256 }, () => frame()) }]));
    expect(spriteAtlasSchema.safeParse({ ...atlas(), clips: big }).success).toBe(false);
  });

  it('rejects raw prototype clip keys and does not call getters', () => {
    const input = atlas();
    const raw: unknown = JSON.parse('{"idle":{"frames":[{"rect":[0,0,128,128],"durationMs":120}]},"__proto__":{"frames":[{"rect":[0,0,128,128],"durationMs":120}]}}');
    expect(spriteAtlasSchema.safeParse({ ...input, clips: raw }).success).toBe(false);
    const getterInput = { ...input, get clips() { throw new Error('must not read this getter'); } };
    expect(spriteAtlasSchema.safeParse(getterInput).success).toBe(false);
  });

  it('rejects undeclared texture, wrong variant and missing semantic clips', () => {
    const validManifest = characterPackManifestSchema.parse(manifest());
    const validAtlas = spriteAtlasSchema.parse(atlas());
    expect(() => validateSpriteAtlas(validManifest, 'still', validAtlas)).toThrow('Unknown sprite variant');
    expect(() => validateSpriteAtlas(validManifest, 'sprite', { ...validAtlas, image: 'assets/undeclared.png' })).toThrow('Atlas image is undeclared');
    const { happy: _omitted, ...withoutHappy } = validAtlas.clips;
    expect(() => validateSpriteAtlas(validManifest, 'sprite', { ...validAtlas, clips: withoutHappy })).toThrow('Missing sprite action clip');
    const { 'mouth.0': _mouth, ...withoutLipSync } = validAtlas.clips;
    expect(() => validateSpriteAtlas(validManifest, 'sprite', { ...validAtlas, clips: withoutLipSync })).toThrow('Missing sprite lip-sync clip');
  });
});
