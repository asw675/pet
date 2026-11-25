import { assetPathSchema } from '@pet-desktop/contracts';
import { z } from 'zod';

const localName = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_. -]+$/u)
  .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const label = z.string().min(1).max(80).refine(value => value.trim().length > 0
  && !/\p{Cc}/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value));
const relativeAsset = z.string().min(1).max(220)
  .refine(path => assetPathSchema.safeParse(`assets/${path}`).success);
const moc = relativeAsset.refine(path => path.endsWith('.moc3'));
const texture = relativeAsset.refine(path => path.endsWith('.png'));
const json = (suffix: string) => relativeAsset.refine(path => path.endsWith(suffix));
const fade = z.number().min(-1).max(60).optional();
const jsonArray = (limit: number) => z.array(z.unknown()).max(limit);
const count = (limit: number) => z.int().min(0).max(limit);

const physicsSchema = z.object({
  Version: z.literal(3),
  Meta: z.object({
    PhysicsSettingCount: count(128), TotalInputCount: count(1024), TotalOutputCount: count(1024),
    VertexCount: count(2048), Fps: z.number().min(0).max(240).optional(),
  }),
  PhysicsSettings: z.array(z.object({
    Input: jsonArray(64),
    Output: z.array(z.object({ VertexIndex: count(127) })).max(64),
    Vertices: jsonArray(128).min(1),
  })).max(128),
});

const motionMetaSchema = z.object({
  Version: z.literal(3),
  Meta: z.object({
    Duration: z.number().positive().max(60), Fps: z.number().positive().max(240),
    CurveCount: count(2048), TotalSegmentCount: count(32768), TotalPointCount: count(65536),
    UserDataCount: count(1024).optional(), TotalUserDataSize: count(1024 * 1024).optional(),
  }),
  Curves: z.array(z.object({ Segments: z.array(z.number()).min(2).max(32768) })).max(2048),
  UserData: jsonArray(1024).optional(),
});

const settingsSchema = z.strictObject({
  Version: z.literal(3),
  FileReferences: z.strictObject({
    Moc: moc,
    Textures: z.array(texture).min(1).max(16),
    Physics: json('.physics3.json').optional(),
    Pose: json('.pose3.json').optional(),
    DisplayInfo: json('.cdi3.json').optional(),
    UserData: json('.userdata3.json').optional(),
    Expressions: z.array(z.strictObject({ Name: label, File: json('.exp3.json') })).max(32).optional(),
    Motions: z.record(localName, z.array(z.strictObject({
      File: json('.motion3.json'),
      FadeInTime: fade,
      FadeOutTime: fade,
    })).min(1).max(16)).refine(groups => Object.keys(groups).length <= 32).optional(),
  }),
  Groups: z.array(z.strictObject({
    Target: z.enum(['Parameter', 'Part', 'PartOpacity']),
    Name: localName,
    Ids: z.array(localName).max(32),
  })).max(16).optional(),
  HitAreas: z.array(z.strictObject({ Id: localName, Name: label })).max(32).optional(),
  Layout: z.record(localName, z.number().min(-100).max(100)).refine(layout => Object.keys(layout).length <= 16).optional(),
});

export interface CubismMotionFile { readonly path: string; readonly fadeInTime?: number; readonly fadeOutTime?: number }
export interface CubismModelSettings {
  readonly moc: string;
  readonly textures: readonly string[];
  readonly physics?: string;
  readonly pose?: string;
  readonly expressions: Readonly<Record<string, string>>;
  readonly motions: Readonly<Record<string, readonly CubismMotionFile[]>>;
  readonly eyeBlink: readonly string[];
  readonly lipSync: readonly string[];
  readonly dependencies: readonly string[];
}

/** Project only the official declarative model3 subset. No model can supply a
 * URL, script, external sound, path outside the pack or runtime settings. */
export function parseCubismModelSettings(entry: string, bytes: Uint8Array): CubismModelSettings {
  if (bytes.byteLength > 128 * 1024) throw new Error('Cubism settings exceed limit');
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  const parsed = settingsSchema.parse(raw);
  const base = entry.slice(0, entry.lastIndexOf('/') + 1);
  const references = parsed.FileReferences;
  const path = (value: string) => assetPathSchema.parse(base + value);
  const textures = references.Textures.map(path);
  if (new Set(textures).size !== textures.length) throw new Error('Duplicate Cubism textures');
  const expressions: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const expression of references.Expressions ?? []) {
    if (Object.hasOwn(expressions, expression.Name)) throw new Error('Duplicate Cubism expression');
    expressions[expression.Name] = path(expression.File);
  }
  const motions: Record<string, CubismMotionFile[]> = Object.create(null) as Record<string, CubismMotionFile[]>;
  for (const [name, files] of Object.entries(references.Motions ?? {})) {
    motions[name] = files.map(file => ({
      path: path(file.File),
      ...(file.FadeInTime === undefined ? {} : { fadeInTime: file.FadeInTime }),
      ...(file.FadeOutTime === undefined ? {} : { fadeOutTime: file.FadeOutTime }),
    }));
  }
  const motionPaths = Object.values(motions).flatMap(group => group.map(file => file.path));
  if (motionPaths.length > 64) throw new Error('Cubism motion file limit exceeded');
  const parameterGroup = (name: string): string[] => parsed.Groups?.find(group => group.Target === 'Parameter' && group.Name === name)?.Ids ?? [];
  const optionalPaths = [references.Physics, references.Pose, references.DisplayInfo, references.UserData]
    .filter(value => value !== undefined).map(path);
  return {
    moc: path(references.Moc),
    textures,
    ...(references.Physics ? { physics: path(references.Physics) } : {}),
    ...(references.Pose ? { pose: path(references.Pose) } : {}),
    expressions,
    motions,
    eyeBlink: parameterGroup('EyeBlink'),
    lipSync: parameterGroup('LipSync'),
    dependencies: [...new Set([path(references.Moc), ...textures, ...optionalPaths, ...Object.values(expressions), ...motionPaths])],
  };
}

/** Check sizes and allocation counters before any optional file enters the SDK. */
export function validateCubismMetadata(path: string, bytes: Uint8Array): void {
  if (bytes.byteLength > 1024 * 1024) throw new Error('Cubism metadata exceeds limit');
  const root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  const remaining: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let seen = 0;
  while (remaining.length) {
    const { value, depth } = remaining.pop()!;
    if (++seen > 160_000 || depth > 24) throw new Error('Cubism metadata structure exceeds limit');
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e8)) throw new Error('Invalid Cubism metadata number');
    if (typeof value === 'string' && value.length > 8192) throw new Error('Cubism metadata string exceeds limit');
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid Cubism metadata field');
        remaining.push({ value: child, depth: depth + 1 });
      }
    }
  }
  if (path.endsWith('.physics3.json')) {
    const { Meta, PhysicsSettings } = physicsSchema.parse(root);
    let inputs = 0, outputs = 0, vertices = 0;
    for (const setting of PhysicsSettings) {
      inputs += setting.Input.length;
      outputs += setting.Output.length;
      vertices += setting.Vertices.length;
      if (setting.Output.some(output => output.VertexIndex >= setting.Vertices.length)) throw new Error('Invalid Cubism physics vertex');
    }
    if (Meta.PhysicsSettingCount !== PhysicsSettings.length || Meta.TotalInputCount !== inputs
      || Meta.TotalOutputCount !== outputs || Meta.VertexCount !== vertices) throw new Error('Invalid Cubism physics counts');
  } else if (path.endsWith('.motion3.json')) {
    const { Meta, Curves, UserData } = motionMetaSchema.parse(root);
    if (Meta.CurveCount !== Curves.length || (Meta.UserDataCount ?? 0) !== (UserData?.length ?? 0)) {
      throw new Error('Invalid Cubism motion counts');
    }
    let segments = 0, points = Curves.length;
    for (const curve of Curves) {
      for (let i = 2; i < curve.Segments.length;) {
        const kind = curve.Segments[i];
        if (kind !== 0 && kind !== 1 && kind !== 2 && kind !== 3) throw new Error('Invalid Cubism motion segment');
        const added = kind === 1 ? 3 : 1;
        i += 1 + 2 * added;
        if (i > curve.Segments.length) throw new Error('Truncated Cubism motion segment');
        segments++;
        points += added;
      }
    }
    if (Meta.TotalSegmentCount !== segments || Meta.TotalPointCount !== points) throw new Error('Invalid Cubism motion segment counts');
  } else if (path.endsWith('.exp3.json')) {
    z.object({ Parameters: jsonArray(256) }).parse(root);
  } else if (path.endsWith('.pose3.json')) {
    z.object({ Groups: z.array(z.array(z.object({ Link: jsonArray(64).optional() })).min(1).max(64)).max(128) }).parse(root);
  }
}
