import type { VoiceProviderStatus, VoiceSessionConfig } from '@pet-desktop/contracts/voice';
import type { VoiceProfileRecord, VoiceProfileSaveAuthorization } from '../../../../../packages/app-service/src/voice-profile-storage.js';
import { installedVoiceOptionsSchema, voiceSettingsErrorCodeSchema, voiceSettingsRequestSchema, voiceSettingsResultMatchesRequest, voiceSettingsResultSchema } from '../../shared/voice-settings-ipc';
import type { InstalledVoiceOption, VoiceSettingsErrorCode, VoiceSettingsRequest, VoiceSettingsResult } from '../../shared/voice-settings-ipc';
import type { InstalledSystemVoice } from './local-voice-provider';
import { LocalVoiceProviderError } from './local-voice-provider';

export interface VoiceSettingsAuthority {
  get(petId: string): VoiceProfileRecord | null;
  save(petId: string, config: VoiceSessionConfig, expectedRevision: number, at: number, authorization?: VoiceProfileSaveAuthorization): VoiceProfileRecord;
  reset(petId: string, expectedRevision: number, at: number): VoiceProfileRecord;
}
export interface VoiceSettingsProvider {
  readonly isBusy: boolean;
  status(providerId: 'WINDOWS_SYSTEM_SPEECH'): VoiceProviderStatus;
  listSystemVoiceOptions(signal: AbortSignal): Promise<InstalledSystemVoice[]>;
}
export interface VoiceSettingsServiceOptions {
  readonly authority: VoiceSettingsAuthority;
  /** Share the same real provider instance as VoiceService. It owns the
   * process gate; this coordinator never starts a second provider or process. */
  readonly providers: VoiceSettingsProvider;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

function error(code: VoiceSettingsErrorCode, petId?: string): VoiceSettingsResult {
  return { ok: false, kind: 'error', code, ...(petId === undefined ? {} : { petId }) };
}
class SettingsError extends Error { constructor(readonly code: VoiceSettingsErrorCode) { super(code); } }
function errorCode(cause: unknown): VoiceSettingsErrorCode {
  if (cause instanceof SettingsError) return cause.code;
  if (cause instanceof LocalVoiceProviderError) return cause.code === 'timeout' ? 'TIMEOUT' : 'UNAVAILABLE';
  // Storage uses stable closed error codes. Never expose its exception text.
  const code = cause !== null && typeof cause === 'object' && 'code' in cause ? voiceSettingsErrorCodeSchema.safeParse(cause.code) : null;
  return code?.success ? code.data : 'UNAVAILABLE';
}
function changedVoice(before: VoiceSessionConfig, after: VoiceSessionConfig): boolean {
  return after.tts.mode === 'LOCAL' && (before.tts.mode !== 'LOCAL' || before.tts.voice.providerId !== after.tts.voice.providerId
    || before.tts.voice.voiceId !== after.tts.voice.voiceId || before.tts.voice.locale !== after.tts.voice.locale);
}

/** Boundary for voice settings queries. Every authority callback is a short
 * synchronous repository scope. Enumerating actual installed voices happens
 * before writing, outside the transaction, and save is CAS checked afterward. */
export class VoiceSettingsService {
  private readonly timeoutMs: number;
  private closed = false;
  private enumeration: AbortController | null = null;
  constructor(private readonly options: VoiceSettingsServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) throw new RangeError('Invalid voice settings deadline');
  }

  async handle(raw: unknown): Promise<VoiceSettingsResult> {
    const parsed = voiceSettingsRequestSchema.safeParse(raw);
    if (!parsed.success) return error('INVALID_REQUEST');
    const request = parsed.data;
    if (this.closed) return error('UNAVAILABLE', request.petId);
    try {
      const result = await this.execute(request);
      const safe = voiceSettingsResultSchema.safeParse(result);
      return safe.success && voiceSettingsResultMatchesRequest(request, safe.data) ? safe.data : error('UNAVAILABLE', request.petId);
    } catch (cause) { return error(errorCode(cause), request.petId); }
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.enumeration?.abort(new SettingsError('UNAVAILABLE'));
    // Shared provider belongs to VoiceService and outer utility lifecycle.
  }
  private current(petId: string): VoiceProfileRecord {
    if (this.closed) throw new SettingsError('UNAVAILABLE');
    const profile = this.options.authority.get(petId);
    if (!profile) throw new SettingsError('NOT_FOUND');
    if (profile.petId !== petId) throw new SettingsError('UNAVAILABLE');
    return profile;
  }
  private async execute(request: VoiceSettingsRequest): Promise<VoiceSettingsResult> {
    const current = this.current(request.petId), authority = this.options.authority;
    if (request.kind === 'get') return { ok: true, kind: 'profile', profile: current };
    if (request.kind === 'listVoices') {
      const voices = await this.listVoices();
      this.current(request.petId); // do not project a stale pet after async enumeration
      return { ok: true, kind: 'voices', petId: request.petId, ...voices };
    }
    if (current.revision !== request.expectedRevision) return error('REVISION_CONFLICT', request.petId);
    if (request.kind === 'reset') return { ok: true, kind: 'profile', profile: authority.reset(request.petId, request.expectedRevision, this.options.now()) };
    // Future cloud adapters/consent flows must be independently implemented;
    // a renderer-provided consent ref is not authority to enable networking.
    if (request.config.stt.mode === 'CLOUD' || request.config.tts.mode === 'CLOUD') return error('UNSUPPORTED', request.petId);
    let authorization: VoiceProfileSaveAuthorization | undefined;
    if (changedVoice(current.config, request.config)) {
      const listed = await this.listVoices();
      if (listed.health === 'UNAVAILABLE') return error('UNAVAILABLE', request.petId);
      if (request.config.tts.mode !== 'LOCAL') return error('INVALID_REQUEST', request.petId);
      const selected = request.config.tts.voice;
      if (!listed.voices.some(item => item.ref.providerId === selected.providerId && item.ref.voiceId === selected.voiceId && item.ref.locale === selected.locale)) {
        return error('VOICE_NOT_ENUMERATED', request.petId);
      }
      authorization = { installedVoices: listed.voices.map(item => item.ref) };
      // A concurrent reset/setting edit must not be lost while awaiting the
      // system enumeration. Storage independently enforces the same CAS.
      if (this.current(request.petId).revision !== request.expectedRevision) return error('REVISION_CONFLICT', request.petId);
    }
    if (this.closed) return error('UNAVAILABLE', request.petId);
    return { ok: true, kind: 'profile', profile: authority.save(request.petId, request.config, request.expectedRevision, this.options.now(), authorization) };
  }

  private async listVoices(): Promise<{ voices: InstalledVoiceOption[]; health: 'READY' | 'UNCONFIGURED' | 'UNAVAILABLE' }> {
    if (this.closed) throw new SettingsError('UNAVAILABLE');
    if (this.enumeration || this.options.providers.isBusy) throw new SettingsError('BUSY');
    const controller = new AbortController();
    this.enumeration = controller;
    const timer = setTimeout(() => controller.abort(new SettingsError('TIMEOUT')), this.timeoutMs);
    let raw: Promise<InstalledSystemVoice[]>;
    try { raw = Promise.resolve(this.options.providers.listSystemVoiceOptions(controller.signal)); }
    catch (cause) { raw = Promise.reject(cause); }
    // Retain the physical operation gate even after a client timeout until
    // the real task settles. Abort prevents persistence from late results.
    const release = () => { if (this.enumeration === controller) this.enumeration = null; };
    const tracked = raw.then(value => { release(); return value; }, cause => { release(); throw cause; });
    try {
      const values = await new Promise<InstalledSystemVoice[]>((resolve, reject) => {
        let done = false;
        const finish = (action: () => void) => {
          if (done) return; done = true; controller.signal.removeEventListener('abort', aborted); action();
        };
        const aborted = () => finish(() => reject(controller.signal.reason));
        controller.signal.addEventListener('abort', aborted, { once: true });
        void tracked.then(value => finish(() => resolve(value)), cause => finish(() => reject(cause)));
        if (controller.signal.aborted) aborted();
      });
      const parsed = installedVoiceOptionsSchema.safeParse(values);
      if (!parsed.success || this.closed) throw new SettingsError('UNAVAILABLE');
      return { voices: parsed.data, health: parsed.data.length > 0 ? 'READY' : 'UNCONFIGURED' };
    } catch (cause) {
      if (cause instanceof LocalVoiceProviderError && cause.code === 'unavailable') return { voices: [], health: 'UNAVAILABLE' };
      throw cause;
    } finally { clearTimeout(timer); }
  }
}
