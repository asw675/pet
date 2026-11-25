import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppSnapshot } from '@pet-desktop/contracts';
import type { DesktopRole } from '../shared/protocol';

export interface Bounds { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** Electron's screen cursor and getBounds() both use DIP. Rectangles are half-open. */
export function isCursorInBounds(cursor: Point, bounds: Bounds): boolean {
  return cursor.x >= bounds.x && cursor.y >= bounds.y
    && cursor.x < bounds.x + bounds.width && cursor.y < bounds.y + bounds.height;
}

/** A renderer hit intent is temporary. Silence must restore click-through. */
export class InputLease {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline = 0;

  constructor(private readonly onExpired: () => void) {}

  get active(): boolean { return this.timer !== undefined && performance.now() < this.deadline; }

  renew(cursor: Point, bounds: Bounds): boolean {
    this.clear();
    if (!isCursorInBounds(cursor, bounds)) return false;
    this.deadline = performance.now() + 2_000;
    this.timer = setTimeout(() => {
      this.clear();
      this.onExpired();
    }, 2_000);
    return true;
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = 0;
  }
}

/** Bounds, offsets and work areas use Electron DIP, including negative coordinates. */
export function clampBounds(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width, height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
  };
}

export function visibleHomePetIds(snapshot: AppSnapshot): string[] {
  return snapshot.pets
    .filter((pet) => pet.presence === 'HOME' && pet.visibility === 'VISIBLE')
    .map((pet) => pet.petId);
}

export function rendererUrl(
  rendererDirectory: string,
  role: DesktopRole,
  devServerUrl?: string,
  petId?: string,
): string {
  let url: URL;
  if (devServerUrl !== undefined) {
    const base = new URL(devServerUrl);
    if (!['http:', 'https:'].includes(base.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.search || base.hash) {
      throw new Error('Invalid local development renderer URL');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    url = new URL(`${role}/index.html`, base);
  } else {
    url = pathToFileURL(join(rendererDirectory, role, 'index.html'));
  }
  if (role === 'pet' && petId !== undefined) url.searchParams.set('petId', petId);
  return url.href;
}
