import { preview } from 'virtual:pet-desktop-cubism-sdk';
import { createCubismRuntime, type CubismRuntime } from './cubism-runtime';

let initial: Promise<CubismRuntime> | undefined;

export function loadLocalCubismPreview(): Promise<CubismRuntime> {
  if (!preview) return Promise.reject(new Error('Local Cubism SDK preview is not configured'));
  if (!initial) {
    const settings = preview;
    initial = installCore(settings.core).then(settings.load)
      .then(sdk => createCubismRuntime(sdk, settings.shaders));
  }
  return initial;
}

function installCore(source: string): Promise<void> {
  // The route and its bytes are chosen by the local preview plugin, never from
  // a model path. Keep the packaged CSP and normal renderer isolation intact.
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    const settle = (error?: Error) => {
      clearTimeout(timer);
      script.remove();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => settle(new Error('Local Cubism Core load timed out')), 5000);
    script.addEventListener('load', () => {
      // The classic SDK script publishes one global, which its official
      // Framework needs while importing the model and renderer modules.
      const api = (globalThis as { Live2DCubismCore?: {
        Version?: { csmGetVersion?(): number };
      } }).Live2DCubismCore;
      const start = performance.now();
      const ready = () => {
        try {
          if (api?.Version?.csmGetVersion?.()) { settle(); return; }
        } catch { /* WebAssembly may still be initializing. */ }
        if (performance.now() - start < 3000) setTimeout(ready, 32);
        else settle(new Error('Local Cubism Core did not initialize'));
      };
      ready();
    }, { once: true });
    script.addEventListener('error', () => settle(new Error('Local Cubism Core could not load')), { once: true });
    document.head.append(script);
  });
}
