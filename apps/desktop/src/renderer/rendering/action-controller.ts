import type { Activity } from '@pet-desktop/contracts';
import type { ActionRequest, ActionResult } from './contract';

export interface AnimationClip {
  readonly frames: readonly { readonly durationMs: number }[];
}

export interface PlaybackFrame {
  readonly semanticId: string;
  readonly clipId: string;
  readonly frameIndex: number;
  readonly elapsedInFrameMs: number;
  readonly requestId: string | null;
  readonly loop: boolean;
}

interface ClipTimeline {
  readonly ends: readonly number[];
  readonly lengthMs: number;
}

interface PlaybackState {
  readonly semanticId: string;
  readonly clipId: string;
  readonly timeline: ClipTimeline;
  readonly loop: boolean;
  elapsedMs: number;
}

interface ActivePlayback extends PlaybackState {
  readonly requestId: string;
  readonly priority: number;
  readonly endStatus: 'completed' | 'unsupported';
  readonly settle: (result: ActionResult) => void;
}

// This only de-duplicates recent visual requests. It is not the persistent
// domain command idempotency registry. Delayed completion callbacks cannot
// control any playback: all state transitions happen synchronously here.
const RECENT_REQUEST_LIMIT = 1024;

const activitySemantics: Readonly<Record<Activity, string>> = {
  IDLE: 'idle', WALK: 'walk', DRAG: 'drag', INTERACT: 'happy', CHAT: 'talk',
  EAT: 'eat', REST: 'sleep', SLEEP: 'sleep', CELEBRATE: 'celebrate',
};

/** Map a read-only domain projection into a visual semantic, without writing it. */
export function semanticIdForActivity(activity: Activity | null): string {
  return activity === null ? 'idle' : activitySemantics[activity];
}

function result(requestId: string, status: ActionResult['status']): ActionResult {
  return { requestId, status };
}

function compileTimeline(clip: AnimationClip): ClipTimeline {
  if (!Array.isArray(clip.frames) || clip.frames.length === 0) throw new RangeError('Animation clip requires frames');
  const ends: number[] = [];
  let lengthMs = 0;
  for (const frame of clip.frames) {
    if (!Number.isSafeInteger(frame.durationMs) || frame.durationMs <= 0
      || !Number.isSafeInteger(lengthMs + frame.durationMs)) {
      throw new RangeError('Invalid animation frame duration');
    }
    lengthMs += frame.durationMs;
    ends.push(lengthMs);
  }
  return { ends, lengthMs };
}

function findFrame(state: PlaybackState): { frameIndex: number; elapsedInFrameMs: number } {
  // First exclusive end greater than the elapsed time. This remains bounded
  // even with long clips or very large ticks and avoids per-frame stepping.
  const { ends } = state.timeline;
  let lo = 0;
  let hi = ends.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (state.elapsedMs < ends[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return { frameIndex: lo, elapsedInFrameMs: state.elapsedMs - (lo > 0 ? ends[lo - 1]! : 0) };
}

function advanceLoop(state: PlaybackState, dtSeconds: number): void {
  const lengthMs = state.timeline.lengthMs;
  // Avoid overflowing dtSeconds * 1000 for an exceptionally delayed tick.
  const deltaMs = dtSeconds <= Number.MAX_SAFE_INTEGER / 1000
    ? (dtSeconds * 1000) % lengthMs : (dtSeconds % (lengthMs / 1000)) * 1000 % lengthMs;
  // The wrap-first form also avoids overflowing the addition for defensive
  // callers constructing extremely long timelines outside the pack schema.
  const remainingMs = lengthMs - state.elapsedMs;
  state.elapsedMs = deltaMs < remainingMs ? state.elapsedMs + deltaMs : deltaMs - remainingMs;
}

function validRequest(request: ActionRequest): boolean {
  return typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 128
    && typeof request.semanticId === 'string' && request.semanticId.length > 0
    && typeof request.loop === 'boolean' && Number.isSafeInteger(request.priority) && request.priority >= 0
    && Number.isFinite(request.blendMs) && request.blendMs >= 0;
}

/** Pure, per-renderer visual scheduler. Base loops continue independently of
 * one-shot overrides; there is no wall clock, SDK, DOM, timer or business write. */
export class ActionController {
  private readonly clips = new Map<string, ClipTimeline>();
  private readonly actionMap: ReadonlyMap<string, string>;
  private readonly recent = new Map<string, Promise<ActionResult>>();
  private base: PlaybackState;
  private active: ActivePlayback | undefined;
  private paused = false;
  private destroyed = false;

  constructor(clips: Readonly<Record<string, AnimationClip>>, actionMap: Readonly<Record<string, string>>) {
    for (const [clipId, clip] of Object.entries(clips)) this.clips.set(clipId, compileTimeline(clip));
    const actions = new Map(Object.entries(actionMap));
    if (!actions.has('idle')) throw new RangeError('Idle animation is required');
    for (const clipId of actions.values()) {
      if (!this.clips.has(clipId)) throw new RangeError('Action references an unknown clip');
    }
    this.actionMap = actions;
    this.base = this.makeState('idle', true);
  }

  get current(): PlaybackFrame | null {
    if (this.destroyed) return null;
    const state = this.active ?? this.base;
    return {
      semanticId: state.semanticId,
      clipId: state.clipId,
      ...findFrame(state),
      requestId: this.active?.requestId ?? null,
      loop: state.loop,
    };
  }

  setBaseAction(semanticId: string): void {
    if (this.destroyed) return;
    const resolved = this.actionMap.has(semanticId) ? semanticId : 'idle';
    if (this.base.semanticId !== resolved) this.base = this.makeState(resolved, true);
  }

  play(request: ActionRequest): Promise<ActionResult> {
    if (this.destroyed || !validRequest(request)) return Promise.resolve(result(request.requestId, 'failed'));
    const duplicate = this.recent.get(request.requestId);
    if (duplicate !== undefined) return duplicate;
    if (this.active !== undefined && request.priority < this.active.priority) {
      return this.remember(request.requestId, Promise.resolve(result(request.requestId, 'interrupted')));
    }

    // Same priority uses newest request; a lower priority never steals the
    // animation. Missing clips play a bounded idle fallback and report
    // unsupported rather than pretend the requested animation was performed.
    this.finishActive('interrupted');
    const supported = this.actionMap.has(request.semanticId);
    const state = this.makeState(supported ? request.semanticId : 'idle', supported && request.loop);
    let settle!: (value: ActionResult) => void;
    const promise = new Promise<ActionResult>((resolve) => { settle = resolve; });
    this.active = {
      ...state,
      requestId: request.requestId,
      priority: request.priority,
      endStatus: supported ? 'completed' : 'unsupported',
      settle,
    };
    // blendMs remains part of the cross-adapter contract; the frame timeline
    // deliberately does not pretend to interpolate/cross-fade sprite poses.
    return this.remember(request.requestId, promise);
  }

  /** Cancel only this identity. Stale cancellations cannot end another action. */
  cancel(requestId: string): boolean {
    if (this.active?.requestId !== requestId) return false;
    this.finishActive('interrupted');
    return true;
  }

  setPaused(paused: boolean): void {
    if (!this.destroyed) this.paused = paused;
  }

  tick(dtSeconds: number): void {
    if (this.destroyed || this.paused || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const active = this.active;
    if (active === undefined) {
      advanceLoop(this.base, dtSeconds);
      return;
    }
    if (active.loop) {
      advanceLoop(active, dtSeconds);
      return;
    }
    const remainingMs = active.timeline.lengthMs - active.elapsedMs;
    if (dtSeconds < remainingMs / 1000 && active.elapsedMs + dtSeconds * 1000 < active.timeline.lengthMs) {
      active.elapsedMs += dtSeconds * 1000;
      return;
    }
    const remainderSeconds = Math.max(0, dtSeconds - remainingMs / 1000);
    this.finishActive(active.endStatus);
    advanceLoop(this.base, remainderSeconds);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.finishActive('interrupted');
    this.recent.clear();
    this.clips.clear();
  }

  private makeState(semanticId: string, loop: boolean): PlaybackState {
    const clipId = this.actionMap.get(semanticId)!;
    return { semanticId, clipId, timeline: this.clips.get(clipId)!, elapsedMs: 0, loop };
  }

  private finishActive(status: ActionResult['status']): void {
    const active = this.active;
    if (active === undefined) return;
    // Clear the state before resolving. The Promise cannot restore the old action.
    this.active = undefined;
    active.settle(result(active.requestId, status));
  }

  private remember(requestId: string, promise: Promise<ActionResult>): Promise<ActionResult> {
    this.recent.set(requestId, promise);
    if (this.recent.size > RECENT_REQUEST_LIMIT) {
      for (const oldest of this.recent.keys()) {
        if (oldest !== this.active?.requestId) {
          this.recent.delete(oldest);
          break;
        }
      }
    }
    return promise;
  }
}
