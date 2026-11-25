import type { HostActionResult } from '../../shared/protocol';

/** Serializes native input intents. A reply for an old pointer position may
 * never restore that position as the current intent or report its failure. */
export function createInteractionLease(
  request: (interactive: boolean) => Promise<HostActionResult>,
  onResult: (ok: boolean) => void,
) {
  let desired = false;
  let intentVersion = 0;
  let lastRequested: boolean | null = null;
  let inFlight = false;

  async function pump(renew: boolean): Promise<void> {
    if (inFlight || (lastRequested === desired && !(desired && renew))) return;
    const requested = desired;
    const version = intentVersion;
    inFlight = true;
    let ok = false;
    try {
      ok = (await request(requested)).ok;
    } catch {
      // Treat a transport rejection as an unavailable native input update.
    } finally {
      inFlight = false;
      if (version === intentVersion) {
        // Failed updates aren't repeated for every mousemove, but true leases
        // are renewed by the periodic hit checker while the pointer is valid.
        lastRequested = requested;
        onResult(ok);
      } else {
        // The old native request may have succeeded. Send the latest intent
        // again even if it matches the last request from before the race.
        lastRequested = null;
        void pump(false);
      }
    }
  }

  function set(interactive: boolean, renew = false): void {
    if (desired !== interactive) {
      desired = interactive;
      intentVersion += 1;
    }
    void pump(renew);
  }

  function reset(): void {
    desired = false;
    intentVersion += 1;
    lastRequested = null;
    void pump(false);
  }

  return { set, reset };
}
