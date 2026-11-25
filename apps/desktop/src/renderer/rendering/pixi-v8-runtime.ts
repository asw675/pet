import type { AuthoredMouthPatch } from './authored-mouth';
import type { ModelGeometry, Size } from './geometry';
import { VERSION, WebGLRenderer, Container, Sprite, ImageSource, Texture, Rectangle } from 'pixi.js';

export const PINNED_PIXI_VERSION = '8.23.0';
export type PixelRect = readonly [number, number, number, number];
export interface PixiFrame { readonly rect: PixelRect; readonly mouth?: AuthoredMouthPatch }
export type PixiContextEvent = 'context-lost' | 'context-restored';
export interface PixiAtlasResource { destroy(): void }
export interface PixiSurface {
  /** Physical buffer, never the CSS hit-test coordinate system. */
  resize(size: Size): void;
  createResource(bitmap: ImageBitmap): PixiAtlasResource;
  draw(resource: PixiAtlasResource, frame: PixiFrame, geometry: ModelGeometry): void;
  clear(): void;
  destroy(): void;
}
export interface PixiRuntime {
  createSurface(canvas: HTMLCanvasElement, onContextEvent: (event: PixiContextEvent) => void): Promise<PixiSurface>;
}

// Runtime calls now compile against the exact installed 8.23.0 types, not
// handwritten imitations. Only tests supply alternate constructor bindings.
type PixiV8Sdk = Pick<typeof import('pixi.js'), 'VERSION' | 'WebGLRenderer' | 'Container' | 'Sprite' | 'ImageSource' | 'Texture' | 'Rectangle'>;
const builtinSdk: PixiV8Sdk = { VERSION, WebGLRenderer, Container, Sprite, ImageSource, Texture, Rectangle };
function checkedSdk(raw: unknown): PixiV8Sdk {
  if (typeof raw !== 'object' || raw === null) throw new Error('Pixi SDK unavailable');
  const sdk = raw as Record<string, unknown>;
  if (sdk.VERSION !== PINNED_PIXI_VERSION || ['WebGLRenderer', 'Container', 'Sprite', 'ImageSource', 'Texture', 'Rectangle']
    .some(key => typeof sdk[key] !== 'function')) throw new Error('Unsupported Pixi SDK version or APIs');
  return raw as PixiV8Sdk;
}
function safely(action: () => void): void { try { action(); } catch { /* finish all independent owner cleanup */ } }

/** Real SDK calls only, deliberately no autoDetectRenderer (which may pick
 * Canvas or WebGPU), Assets URL loader, global texture cache, or Application
 * ticker. The pet shell owns the animation/visibility clock. */
export function createPixiV8Runtime(raw: unknown = builtinSdk): PixiRuntime {
  const sdk = checkedSdk(raw);
  return {
    async createSurface(canvas, notify) {
      const renderer = new sdk.WebGLRenderer();
      let root: Container | undefined, base: Sprite | undefined, mouth: Sprite | undefined;
      let disposed = false, lost = false;
      let physical: Size = { w: 1, h: 1 };
      const resources = new Map<PixiAtlasResource, { texture(rect: PixelRect): Texture }>();
      const onLost = (event: Event) => { if (!disposed) { event.preventDefault(); lost = true; safely(() => notify('context-lost')); } };
      const onRestored = () => { if (!disposed) { lost = false; safely(() => notify('context-restored')); } };
      canvas.addEventListener('webglcontextlost', onLost);
      canvas.addEventListener('webglcontextrestored', onRestored);
      function dispose(): void {
        if (disposed) return;
        disposed = true;
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        // Root does not own textures; destroy every resource exactly once.
        for (const resource of [...resources.keys()]) resource.destroy();
        if (base) safely(() => base!.destroy(false));
        if (mouth) safely(() => mouth!.destroy(false));
        if (root) safely(() => root!.destroy({ children: false, texture: false, textureSource: false }));
        safely(() => renderer.destroy({ removeView: false, releaseGlobalResources: false }));
      }
      try {
        await renderer.init({ canvas, width: 1, height: 1, resolution: 1, autoDensity: false, backgroundAlpha: 0,
          backgroundColor: 0, antialias: false, powerPreference: 'low-power', clearBeforeRender: true });
        if (renderer.canvas !== canvas || lost || renderer.gl.isContextLost()) throw new Error('Pixi WebGL surface unavailable');
        root = new sdk.Container();
        root.eventMode = 'none'; // pure CSS/manual hit policy remains authoritative for visuals
        base = new sdk.Sprite(); mouth = new sdk.Sprite();
        base.visible = false; mouth.visible = false;
        root.addChild(base); root.addChild(mouth);
      } catch (error) { dispose(); throw error; }
      const ensure = () => {
        if (disposed || lost || renderer.gl.isContextLost()) throw new Error('Pixi WebGL surface unavailable');
      };
      function render(): void { ensure(); renderer.render({ container: root!, clear: true }); ensure(); }
      const surface: PixiSurface = {
        resize(size) {
          ensure();
          if (!Number.isSafeInteger(size.w) || !Number.isSafeInteger(size.h) || size.w < 1 || size.h < 1
            || size.w > 4096 || size.h > 4096 || size.w * size.h > 4 * 1024 * 1024) throw new RangeError('Pixi backing buffer limit');
          if (size.w === physical.w && size.h === physical.h) return;
          // Use exact rounded physical sizes (resolution=1); root derives
          // the CSS→physical ratio, avoiding a rounding/DPI hit-test mismatch.
          renderer.resize(size.w, size.h, 1);
          physical = { ...size };
        },
        createResource(bitmap) {
          ensure();
          if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1
            || bitmap.width > 2048 || bitmap.height > 2048) throw new RangeError('Invalid Pixi atlas bitmap');
          const source = new sdk.ImageSource({ resource: bitmap, resolution: 1, alphaMode: 'premultiplied-alpha', autoGenerateMipmaps: false });
          const textures = new Map<string, Texture>();
          const resource: PixiAtlasResource = {
            destroy() {
              if (!resources.delete(resource)) return;
              for (const texture of textures.values()) safely(() => texture.destroy(false));
              textures.clear(); safely(() => source.destroy());
              // Bitmap ownership stays with PixiRenderer, not this wrapper.
            },
          };
          resources.set(resource, {
            texture(rect) {
              const [x, y, w, h] = rect;
              if (!rect.every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > bitmap.width || y + h > bitmap.height)
                throw new RangeError('Texture frame outside verified atlas');
              const key = rect.join(':');
              let texture = textures.get(key);
              if (!texture) {
                texture = new sdk.Texture({ source, frame: new sdk.Rectangle(x, y, w, h) });
              }
              // Bound frame-view objects even for large valid atlases. Never
              // evict textures currently bound to either visible sprite or
              // the newly returned view; all share one image resource.
              textures.delete(key); textures.set(key, texture);
              if (textures.size > 128) {
                for (const [oldKey, oldTexture] of textures) {
                  if (oldTexture === texture || oldTexture === base!.texture || oldTexture === mouth!.texture) continue;
                  textures.delete(oldKey); safely(() => oldTexture.destroy(false)); break;
                }
              }
              return texture;
            },
          });
          return resource;
        },
        draw(resource, frame, geometry) {
          ensure();
          const atlas = resources.get(resource);
          if (!atlas) throw new Error('Pixi resource does not belong to this surface');
          const rx = physical.w / geometry.viewport.w, ry = physical.h / geometry.viewport.h;
          const parameters = [rx, ry, geometry.anchorCss.x, geometry.anchorCss.y, geometry.modelAnchor.x, geometry.modelAnchor.y, geometry.scale];
          if (parameters.some(value => !Number.isFinite(value)) || rx <= 0 || ry <= 0 || geometry.scale <= 0) throw new RangeError('Invalid Pixi model geometry');
          root!.position.set(geometry.anchorCss.x * rx, geometry.anchorCss.y * ry);
          root!.scale.set(geometry.scale * geometry.facing * rx, geometry.scale * ry);
          root!.pivot.set(geometry.modelAnchor.x, geometry.modelAnchor.y);
          base!.texture = atlas.texture(frame.rect);
          base!.x = 0; base!.y = 0; base!.width = geometry.logicalSize.w; base!.height = geometry.logicalSize.h; base!.visible = true;
          if (frame.mouth) {
            const [x, y, w, h] = frame.mouth.destination;
            mouth!.texture = atlas.texture(frame.mouth.source);
            mouth!.x = x; mouth!.y = y; mouth!.width = w; mouth!.height = h; mouth!.visible = true;
          } else mouth!.visible = false;
          render();
        },
        clear() { ensure(); base!.visible = false; mouth!.visible = false; render(); },
        destroy: dispose,
      };
      return surface;
    },
  };
}
