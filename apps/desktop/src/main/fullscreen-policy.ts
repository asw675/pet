export type FullscreenSample = { readonly kind: 'clear' | 'unknown' | 'global' | 'unavailable' }
  | { readonly kind: 'display'; readonly x: number; readonly y: number };

export type FullscreenState = { readonly kind: 'clear' | 'unknown' | 'global' }
  | { readonly kind: 'display'; readonly displayId: number };

const clear = Object.freeze({ kind: 'clear' } as const);
const sameState = (first: FullscreenState, second: FullscreenState): boolean => first.kind === second.kind
  && (first.kind !== 'display' || (second.kind === 'display' && first.displayId === second.displayId));

export function fullscreenHides(state: FullscreenState, displayId: number): boolean {
  return state.kind === 'global' || (state.kind === 'display' && state.displayId === displayId);
}

export function fullscreenQuiets(state: FullscreenState, displayId: number): boolean {
  return state.kind === 'unknown' || fullscreenHides(state, displayId);
}

interface FullscreenMonitorOptions {
  sample(signal: AbortSignal): Promise<FullscreenSample>;
  displayForPoint(point: { x: number; y: number }): number | undefined;
  onChange(state: FullscreenState): void;
  stopProbe(): void;
}

/** Two consecutive observations avoid toggling on foreground transitions.
 * Polling does not queue overlapping native calls or keep the app alive. */
export class ForegroundFullscreenMonitor {
  private current: FullscreenState = clear;
  private candidate: FullscreenState = clear;
  private confirmations = 0;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: FullscreenMonitorOptions) {}

  get state(): FullscreenState { return this.current; }

  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.tick(controller);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.options.stopProbe();
    this.candidate = clear;
    this.confirmations = 0;
    this.update(clear);
  }

  private update(state: FullscreenState): void {
    if (sameState(this.current, state)) return;
    this.current = state;
    this.options.onChange(state);
  }

  private async tick(controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const result: FullscreenSample = await this.options.sample(signal).catch(() => ({ kind: 'unavailable' }));
    if (signal.aborted || this.controller !== controller) return;
    let state: FullscreenState;
    if (result.kind === 'display') {
      const displayId = this.options.displayForPoint(result);
      state = displayId === undefined ? { kind: 'unknown' } : { kind: 'display', displayId };
    } else {
      // A missing or failed probe leaves manual DND usable. An observed but
      // unknown foreground quiets interruptions without globally hiding pets.
      state = { kind: result.kind === 'unavailable' ? 'clear' : result.kind };
    }
    if (!sameState(state, this.candidate)) {
      this.candidate = state;
      this.confirmations = 1;
    } else if (this.confirmations < 2) {
      this.confirmations++;
      if (this.confirmations === 2) this.update(state);
    }
    if (signal.aborted) return;
    this.timer = setTimeout(() => { void this.tick(controller); }, 400);
    this.timer.unref();
  }
}
