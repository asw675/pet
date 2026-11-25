import type { ResolvedPack, ResolvedPackVariant } from '../../shared/resolve-character-pack';
import type { ModelGeometry } from './geometry';
import { modelToCss } from './geometry';

type CubismVariant = Extract<ResolvedPackVariant, { renderer: 'cubism' }>;

interface CoreCanvasInfo {
  readonly CanvasWidth: number;
  readonly CanvasHeight: number;
  readonly CanvasOriginX?: number;
  readonly CanvasOriginY?: number;
  readonly PixelsPerUnit: number;
}
interface FrameworkModel {
  getModel(): { readonly canvasinfo: CoreCanvasInfo; readonly parameters: { readonly ids: readonly string[] } };
  getParameterCount(): number;
  getParameterValueByIndex(index: number): number;
  getParameterMaximumValue(index: number): number;
  getParameterMinimumValue(index: number): number;
  getDrawableCount(): number;
  getDrawableVertexCount(index: number): number;
  setParameterValueByIndex(index: number, value: number, weight?: number): void;
  loadParameters(): void;
  saveParameters(): void;
  update(): void;
}
interface Moc {
  createModel(): FrameworkModel | null;
  deleteModel(model: FrameworkModel): void;
  release(): void;
}
interface Matrix {
  getArray(): Float32Array;
}
interface SdkRenderer {
  initialize(model: FrameworkModel): void;
  startUp(gl: WebGL2RenderingContext): void;
  bindTexture(index: number, texture: WebGLTexture): void;
  setIsPremultipliedAlpha(value: boolean): void;
  setRenderTargetSize(width: number, height: number): void;
  setMvpMatrix(matrix: Matrix): void;
  setRenderState(framebuffer: WebGLFramebuffer | null, viewport: number[]): void;
  loadShaders(path: string): void;
  drawModel(path: string): void;
  release(): void;
}
interface Physics {
  evaluate(model: FrameworkModel, seconds: number): void;
  release(): void;
}
interface Pose {
  updateParameters(model: FrameworkModel, seconds: number): void;
}
interface Motion {
  getLoopDuration(): number;
  setLoop(loop: boolean): void;
  setFadeInTime(seconds: number): void;
  setFadeOutTime(seconds: number): void;
  setWeight(weight: number): void;
  release(): void;
}
interface MotionManager {
  startMotionPriority(motion: Motion, autoDelete: boolean, priority: number): unknown;
  updateMotion(model: FrameworkModel, seconds: number): boolean;
  stopAllMotions(): void;
  release(): void;
}
interface ExpressionManager {
  startMotion(motion: Motion, autoDelete: boolean): unknown;
  updateMotion(model: FrameworkModel, seconds: number): boolean;
  stopAllMotions(): void;
  release(): void;
}

/** The small structural surface used from a developer-supplied Cubism Web R5
 * SDK. No SDK type file or implementation is a repository dependency. */
export interface CubismSdkBindings {
  readonly framework: {
    isStarted(): boolean;
    isInitialized(): boolean;
    startUp(): boolean;
    initialize(): void;
  };
  readonly moc: { create(bytes: ArrayBuffer, checkConsistency: true): Moc | null };
  readonly Renderer: new (width: number, height: number) => SdkRenderer;
  readonly Matrix: new () => Matrix;
  readonly shaders: { getInstance(): {
    getShader(gl: WebGL2RenderingContext): { _isShaderLoaded: boolean; release(): void } | undefined;
    readonly _shaderMap: Map<WebGL2RenderingContext, unknown>;
  } };
  readonly physics: { create(bytes: ArrayBuffer, length: number): Physics | null };
  readonly pose: { create(bytes: ArrayBuffer, length: number): Pose | null };
  readonly motion: { create(bytes: ArrayBuffer, size: number, finish: undefined, begin: undefined, checkConsistency: true): Motion | null };
  readonly MotionManager: new () => MotionManager;
  readonly expression: { create(bytes: ArrayBuffer, length: number): Motion | null };
  readonly ExpressionManager: new () => ExpressionManager;
}

export interface CubismFrame {
  readonly seconds: number;
  readonly dt: number;
  readonly look: { readonly x: number; readonly y: number };
  readonly mouth: number;
  readonly sleep: boolean;
  readonly tap?: { readonly area: 'head' | 'body'; readonly strength: number };
  readonly still: boolean;
}
export interface CubismSession {
  draw(geometry: ModelGeometry, width: number, height: number, frame: CubismFrame): void;
  play(group: string, loop: boolean): number | null;
  stopMotions(): void;
  expression(name: string, weight: number): void;
  destroy(): void;
}
export interface CubismRuntime {
  load(gl: WebGL2RenderingContext, pack: ResolvedPack, variant: CubismVariant, signal: AbortSignal): Promise<CubismSession>;
}

function guarded(callback: () => void): void { try { callback(); } catch { /* independent cleanup */ } }

function bytes(pack: ResolvedPack, path: string): ArrayBuffer {
  const data = pack.readAsset(path);
  if (!data) throw new Error('Missing verified Cubism resource');
  return data.buffer;
}

function waitForShaders(check: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const until = performance.now() + 5000;
    const poll = () => {
      try {
        signal.throwIfAborted();
        if (check()) resolve();
        else if (performance.now() >= until) reject(new Error('Cubism shader initialization timed out'));
        else setTimeout(poll, 32);
      } catch (error) { reject(error); }
    };
    poll();
  });
}

function loadTexture(gl: WebGL2RenderingContext, bitmap: ImageBitmap): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Cubism texture allocation failed');
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}

function fitMatrix(matrix: Matrix, info: CoreCanvasInfo, geometry: ModelGeometry): void {
  const { w, h } = geometry.logicalSize;
  const origin = modelToCss(geometry, {
    x: w * (info.CanvasOriginX ?? info.CanvasWidth / 2) / info.CanvasWidth,
    y: h * (info.CanvasOriginY ?? info.CanvasHeight / 2) / info.CanvasHeight,
  });
  const values = matrix.getArray();
  values[0] = 2 * geometry.scale * geometry.facing * w * info.PixelsPerUnit / info.CanvasWidth / geometry.viewport.w;
  values[5] = 2 * geometry.scale * h * info.PixelsPerUnit / info.CanvasHeight / geometry.viewport.h;
  values[12] = 2 * origin.x / geometry.viewport.w - 1;
  values[13] = 1 - 2 * origin.y / geometry.viewport.h;
}

function visibleAlpha(gl: WebGL2RenderingContext, width: number, height: number): boolean {
  // First-frame sanity check only. Check sparse rows to bound GPU readback.
  const row = new Uint8Array(width * 4);
  const step = Math.max(1, Math.floor(height / 16));
  for (let y = Math.floor(step / 2); y < height; y += step) {
    gl.readPixels(0, y, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
    for (let x = 3; x < row.length; x += 4) if (row[x]! > 8) return true;
  }
  return false;
}

export function createCubismRuntime(sdk: CubismSdkBindings, shaderPath: string): CubismRuntime {
  if (!sdk.framework.isStarted() && !sdk.framework.startUp()) throw new Error('Cubism Framework startup failed');
  if (!sdk.framework.isInitialized()) sdk.framework.initialize();
  return {
    async load(gl, pack, variant, signal) {
      signal.throwIfAborted();
      const textures: WebGLTexture[] = [];
      let moc: Moc | null = null, model: FrameworkModel | null = null, renderer: SdkRenderer | undefined;
      let physics: Physics | null = null, pose: Pose | null = null;
      let motionManager: MotionManager | undefined, expressionManager: ExpressionManager | undefined;
      let disposed = false;
      const destroy = () => {
        if (disposed) return;
        disposed = true;
        guarded(() => motionManager?.release());
        guarded(() => expressionManager?.release());
        guarded(() => physics?.release());
        guarded(() => renderer?.release());
        for (const texture of textures) guarded(() => gl.deleteTexture(texture));
        if (moc && model) guarded(() => moc!.deleteModel(model!));
        guarded(() => moc?.release());
        const shaders = sdk.shaders.getInstance();
        guarded(() => shaders.getShader(gl)?.release());
        // R5 owns each shader through a per-context map. Drop just this slot.
        guarded(() => { shaders._shaderMap.delete(gl); });
      };
      signal.addEventListener('abort', destroy, { once: true });
      try {
        moc = sdk.moc.create(bytes(pack, variant.model.moc), true);
        if (!moc) throw new Error('Cubism rejected corrupt or incompatible MOC3');
        const activeModel = model = moc.createModel();
        if (!activeModel) throw new Error('Cubism model creation failed');
        const info = activeModel.getModel().canvasinfo;
        if (![info.CanvasWidth, info.CanvasHeight, info.PixelsPerUnit].every(value => Number.isFinite(value) && value > 0)
          || !Number.isSafeInteger(activeModel.getParameterCount()) || activeModel.getParameterCount() < 0
          || activeModel.getParameterCount() > 2048) {
          throw new Error('Invalid Cubism model size');
        }
        const drawables = activeModel.getDrawableCount();
        if (!Number.isSafeInteger(drawables) || drawables < 1 || drawables > 1024) throw new Error('Invalid Cubism drawable count');
        let vertices = 0;
        for (let i = 0; i < drawables; i++) {
          const count = activeModel.getDrawableVertexCount(i);
          if (!Number.isSafeInteger(count) || count < 0 || count > 65_535) throw new Error('Invalid Cubism drawable vertices');
          vertices += count;
        }
        if (!Number.isSafeInteger(vertices) || vertices < 3 || vertices > 250_000) throw new Error('Invalid Cubism vertex budget');
        const r = renderer = new sdk.Renderer(gl.drawingBufferWidth, gl.drawingBufferHeight);
        r.initialize(activeModel);
        r.startUp(gl);
        r.setIsPremultipliedAlpha(true);
        for (const item of variant.textures) {
          const bitmap = await createImageBitmap(new Blob([bytes(pack, item.path)], { type: 'image/png' }),
            { premultiplyAlpha: 'premultiply' });
          try {
            signal.throwIfAborted();
            if (bitmap.width !== item.size.w || bitmap.height !== item.size.h) throw new Error('Cubism texture dimensions differ');
            const texture = loadTexture(gl, bitmap);
            textures.push(texture);
            r.bindTexture(textures.length - 1, texture);
          } finally { bitmap.close(); }
        }
        if (variant.model.physics) {
          const resource = bytes(pack, variant.model.physics);
          physics = sdk.physics.create(resource, resource.byteLength);
        }
        if (variant.model.pose) {
          const resource = bytes(pack, variant.model.pose);
          pose = sdk.pose.create(resource, resource.byteLength);
        }
        const motions = motionManager = new sdk.MotionManager();
        const expressions = expressionManager = new sdk.ExpressionManager();
        activeModel.saveParameters();
        r.loadShaders(shaderPath);
        await waitForShaders(() => !gl.isContextLost() && sdk.shaders.getInstance().getShader(gl)?._isShaderLoaded === true, signal);
        const matrix = new sdk.Matrix();
        const parameterIds = new Map(activeModel.getModel().parameters.ids.map((name, index) => [name, index]));
        const set = (id: string, value: number, additive = false) => {
          const index = parameterIds.get(id);
          if (index === undefined) return;
          const low = activeModel.getParameterMinimumValue(index), high = activeModel.getParameterMaximumValue(index);
          const next = additive ? value + activeModel.getParameterValueByIndex(index) : value;
          activeModel.setParameterValueByIndex(index, Math.max(low, Math.min(high, next)));
        };
        const eyeIds = variant.model.eyeBlink.length ? variant.model.eyeBlink : ['ParamEyeLOpen', 'ParamEyeROpen'];
        const mouthIds = variant.model.lipSync.length ? variant.model.lipSync : ['ParamMouthOpenY'];
        let ready = false;
        return {
          draw(geometry, width, height, frame) {
            if (disposed || gl.isContextLost()) throw new Error('Cubism surface unavailable');
            activeModel.loadParameters();
            const authoredMotion = !frame.still && motions.updateMotion(activeModel, frame.dt);
            const blink = Math.abs(frame.seconds % 4.6 - 4.1) / 0.10;
            if (!authoredMotion || frame.sleep) {
              const eyes = frame.sleep ? 0 : frame.still ? 1 : Math.min(1, blink);
              for (const id of eyeIds) set(id, eyes);
            }
            if (!frame.still) {
              set('ParamBreath', 0.5 + Math.sin(frame.seconds * 1.7) * 0.45);
              // Gaze layers over authored motion and leaves its base pose in control.
              const sway = authoredMotion ? 0 : 1;
              set('ParamAngleX', frame.look.x * 18 + sway * Math.sin(frame.seconds * 1.05) * 2, true);
              set('ParamAngleY', frame.look.y * 12 + sway * Math.sin(frame.seconds * 0.8) * 1.5, true);
              set('ParamAngleZ', sway * Math.sin(frame.seconds * 0.7) * 2.5, true);
              if (frame.tap) {
                const strength = frame.tap.strength;
                if (frame.tap.area === 'head') set('ParamAngleY', -8 * strength, true);
                else {
                  set('ParamBodyAngleX', 6 * strength, true);
                  set('ParamAngleZ', -5 * strength, true);
                }
                set('ParamMouthForm', 0.65 * strength, true);
              }
              set('ParamEyeBallX', frame.look.x);
              set('ParamEyeBallY', frame.look.y);
              expressions.updateMotion(activeModel, frame.dt);
              if (frame.dt > 0) physics?.evaluate(activeModel, frame.dt);
              if (frame.dt > 0) pose?.updateParameters(activeModel, frame.dt);
            }
            for (const id of mouthIds) set(id, frame.still ? 0 : frame.mouth);
            activeModel.update();
            fitMatrix(matrix, info, geometry);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            r.setRenderTargetSize(width, height);
            r.setRenderState(null, [0, 0, width, height]);
            r.setMvpMatrix(matrix);
            r.drawModel(shaderPath);
            if (!ready) {
              ready = visibleAlpha(gl, width, height);
              if (!ready) throw new Error('Cubism did not draw visible pixels');
            }
          },
          play(group, loop) {
            if (disposed) return null;
            const file = variant.model.motions[group]?.[0];
            if (!file) return null;
            const resource = bytes(pack, file.path);
            const motion = sdk.motion.create(resource, resource.byteLength, undefined, undefined, true);
            if (!motion) return null;
            const duration = motion.getLoopDuration();
            if (!Number.isFinite(duration) || duration <= 0 || duration > 60) { motion.release(); return null; }
            motions.stopAllMotions();
            if (file.fadeInTime !== undefined && file.fadeInTime >= 0) motion.setFadeInTime(file.fadeInTime);
            if (file.fadeOutTime !== undefined && file.fadeOutTime >= 0) motion.setFadeOutTime(file.fadeOutTime);
            motion.setLoop(loop);
            motions.startMotionPriority(motion, true, 1);
            return duration;
          },
          stopMotions() { if (!disposed) motions.stopAllMotions(); },
          expression(name, weight) {
            if (disposed) return;
            const path = variant.model.expressions[name];
            if (!path) return;
            const resource = bytes(pack, path);
            const motion = sdk.expression.create(resource, resource.byteLength);
            if (motion) { motion.setWeight(weight); expressions.startMotion(motion, true); }
          },
          destroy,
        };
      } catch (error) { destroy(); throw error; }
      finally { signal.removeEventListener('abort', destroy); }
    },
  };
}
