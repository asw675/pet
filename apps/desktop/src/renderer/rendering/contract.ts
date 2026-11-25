import type { ResolvedPack } from '../asset-packs/resolve-pack';

/** A renderer-only profile; CSS coordinates stay independent of resolution. */
export interface RenderProfile {
  maxFps: 15 | 30;
  resolutionScale: number;
  reducedMotion: boolean;
}

export interface RenderPose {
  x: number;
  y: number;
  scale: number;
  facing: -1 | 1;
}

/** A visual request, never an authoritative game command. */
export interface ActionRequest {
  requestId: string;
  semanticId: string;
  loop: boolean;
  priority: number;
  blendMs: number;
}

export interface ActionResult {
  requestId: string;
  status: 'completed' | 'interrupted' | 'unsupported' | 'failed';
}

/** Relative to one playback generation's audio clock, not wall-clock time. */
export interface MouthSample {
  generation: number;
  open: number;
  viseme?: string;
  atMs: number;
}

export interface HitRegion {
  id: string;
}

/** V1.1 §17.3. Implementation and SDK objects belong to the adapter, not Pinia. */
export interface PetRenderer {
  init(canvas: HTMLCanvasElement, profile: RenderProfile): Promise<void>;
  loadPack(pack: ResolvedPack, signal: AbortSignal): Promise<void>;
  resize(wCss: number, hCss: number, dpr: number): void;
  setPose(pose: RenderPose): void;
  play(action: ActionRequest): Promise<ActionResult>;
  setExpression(id: string, weight: number): void;
  setMouth(sample: MouthSample): void;
  tick(dtSeconds: number): void;
  hitTest(xLocal: number, yLocal: number): HitRegion | null;
  setQuality(profile: RenderProfile): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}
