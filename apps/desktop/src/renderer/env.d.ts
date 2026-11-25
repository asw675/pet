import type { ControlCenterBridge, PetDesktopBridge } from '../shared/protocol';

declare global {
  interface Window {
    readonly petDesktop?: PetDesktopBridge | ControlCenterBridge;
  }
}

export {};
