import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '@pet-desktop/contracts/voice';
import type { VoiceProviderStatus, VoiceSessionConfig } from '@pet-desktop/contracts/voice';
import type { VoiceProfileRecord, VoiceProfileSaveAuthorization } from '../../../packages/app-service/src/voice-profile-storage.js';
import { LocalVoiceProviderError } from '../src/app-service/voice/local-voice-provider';
import { VoiceSettingsService } from '../src/app-service/voice/voice-settings-service';
import type { VoiceSettingsProvider } from '../src/app-service/voice/voice-settings-service';
import { voiceSettingsRequestSchema, voiceSettingsResultMatchesRequest, voiceSettingsResultSchema } from '../src/shared/voice-settings-ipc';

const petId = 'pet-a';
const option = { ref: { providerId: 'WINDOWS_SYSTEM_SPEECH' as const, voiceId: `sapi-${'a'.repeat(64)}`, locale: 'zh-CN' }, displayName: '真实枚举音色' };
const other = { ref: { providerId: 'WINDOWS_SYSTEM_SPEECH' as const, voiceId: `sapi-${'b'.repeat(64)}`, locale: 'en-US' }, displayName: 'Other voice' };
const local: VoiceSessionConfig = { ...DEFAULT_LOCAL_VOICE_CONFIG, tts: { mode: 'LOCAL', voice: { ...option.ref, rate: 1.2 } } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function harness(timeoutMs = 500) {
  let profile: VoiceProfileRecord | null = { petId, config: { ...DEFAULT_LOCAL_VOICE_CONFIG }, revision: 0, updatedAt: null };
  let busy = false;
  const get = vi.fn((id: string) => id === petId ? profile : null);
  const save = vi.fn((id: string, config: VoiceSessionConfig, expectedRevision: number, at: number, _authorization?: VoiceProfileSaveAuthorization): VoiceProfileRecord => {
    if (id !== petId || !profile || profile.revision !== expectedRevision) throw { code: 'REVISION_CONFLICT' };
    if (JSON.stringify(profile.config) === JSON.stringify(config)) return profile;
    profile = { petId, config, revision: expectedRevision + 1, updatedAt: at }; return profile;
  });
  const reset = vi.fn((id: string, expectedRevision: number, at: number) => save(id, DEFAULT_LOCAL_VOICE_CONFIG, expectedRevision, at));
  const options = vi.fn<VoiceSettingsProvider['listSystemVoiceOptions']>(async () => [option, other]);
  const status = vi.fn((): VoiceProviderStatus => ({ providerId: 'WINDOWS_SYSTEM_SPEECH', requiresNetwork: false, health: 'READY', capabilities: ['TTS'] }));
  const service = new VoiceSettingsService({ authority: { get, save, reset }, providers: { get isBusy() { return busy; }, listSystemVoiceOptions: options, status }, now: () => 200, timeoutMs });
  return { service, get, save, reset, options, setBusy: (value: boolean) => { busy = value; }, setProfile: (value: VoiceProfileRecord | null) => { profile = value; },
    profile: () => profile, list: () => service.handle({ kind: 'listVoices', petId }),
    select: (config = local, expectedRevision = 0) => service.handle({ kind: 'save', petId, config, expectedRevision }) };
}
afterEach(() => vi.useRealTimers());

describe('Voice settings service with trusted enumeration and strict CAS', () => {
  it('gets a real authority projection and refuses unowned scope before provider work', async () => {
    const h = harness();
    await expect(h.service.handle({ kind: 'get', petId })).resolves.toEqual({ ok: true, kind: 'profile', profile: h.profile() });
    await expect(h.service.handle({ kind: 'listVoices', petId: 'other-pet' })).resolves.toMatchObject({ code: 'NOT_FOUND', petId: 'other-pet' });
    expect(h.options).not.toHaveBeenCalled();
  });
  it('lists exact real installed provider identities with display labels, no fabricated default', async () => {
    const h = harness(); await expect(h.list()).resolves.toEqual({ ok: true, kind: 'voices', petId, voices: [option, other], health: 'READY' });
    h.options.mockResolvedValueOnce([]); await expect(h.list()).resolves.toMatchObject({ health: 'UNCONFIGURED', voices: [] });
    h.options.mockRejectedValueOnce(new LocalVoiceProviderError('unavailable')); await expect(h.list()).resolves.toMatchObject({ health: 'UNAVAILABLE', voices: [] });
    expect(h.save).not.toHaveBeenCalled();
  });
  it('rejects missing, forged or mismatched local voice selection; only provider results supply storage authorization', async () => {
    const h = harness(); h.options.mockResolvedValueOnce([other]);
    await expect(h.select()).resolves.toMatchObject({ code: 'VOICE_NOT_ENUMERATED' });
    await expect(h.service.handle({ kind: 'save', petId, config: local, expectedRevision: 0, authorization: { installedVoices: [option.ref] } })).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(h.select({ ...local, tts: { mode: 'LOCAL', voice: { ...option.ref, locale: 'en-US' } } })).resolves.toMatchObject({ code: 'VOICE_NOT_ENUMERATED' });
    expect(h.save).not.toHaveBeenCalled();
    await expect(h.select()).resolves.toMatchObject({ kind: 'profile', profile: { revision: 1, config: local } });
    expect(h.save).toHaveBeenCalledExactlyOnceWith(petId, local, 0, 200, { installedVoices: [option.ref, other.ref] });
  });
  it('permits mute/rate/locale/volume edits without implicitly choosing a replacement unavailable voice', async () => {
    const h = harness(); await h.select(); h.options.mockRejectedValue(new LocalVoiceProviderError('unavailable'));
    const config: VoiceSessionConfig = { ...local, muted: true, volume: .2, stt: { mode: 'LOCAL', providerId: 'WHISPER_CPP', modelId: 'MULTILINGUAL_SMALL', locale: 'en-US' },
      tts: { mode: 'LOCAL', voice: { ...option.ref, rate: .8 } } };
    await expect(h.select(config, 1)).resolves.toMatchObject({ profile: { revision: 2, config } });
    expect(h.options).toHaveBeenCalledTimes(1); expect(h.save).toHaveBeenLastCalledWith(petId, config, 1, 200, undefined);
  });
  it('does not allow cloud provider configurations or raw auth/key/path fields', async () => {
    const h = harness();
    await expect(h.select({ ...local, stt: { mode: 'CLOUD', providerId: 'OPENAI_TRANSCRIPTION', consent: { scope: 'STT_AUDIO', authorizationId: 'claimed-consent' } } })).resolves.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(h.select({ ...local, tts: { mode: 'CLOUD', voice: { providerId: 'AZURE_NEURAL_TTS', voiceId: 'azure', locale: 'zh-CN' }, consent: { scope: 'TTS_TEXT', authorizationId: 'text' } } })).resolves.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(h.service.handle({ kind: 'save', petId, config: { ...local, key: 'secret' }, expectedRevision: 0 })).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.options).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it('checks expected revision before and after delayed voice enumeration, never stale-overwrites newer settings', async () => {
    const h = harness(); await expect(h.select(local, 1)).resolves.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(h.options).not.toHaveBeenCalled();
    const delayed = deferred<(typeof option)[]>(); h.options.mockReturnValueOnce(delayed.promise);
    const pending = h.select(); await settle();
    h.setProfile({ petId, config: { ...DEFAULT_LOCAL_VOICE_CONFIG, muted: true }, revision: 1, updatedAt: 100 });
    delayed.resolve([option]); await expect(pending).resolves.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(h.save).not.toHaveBeenCalled();
  });
  it('never writes after pet disappears or service shuts down during enumeration', async () => {
    for (const dispose of [false, true]) {
      const h = harness(), delayed = deferred<(typeof option)[]>(); h.options.mockReturnValueOnce(delayed.promise);
      const pending = h.select(); await settle();
      if (dispose) h.service.dispose(); else h.setProfile(null);
      delayed.resolve([option]); await expect(pending).resolves.toMatchObject({ code: dispose ? 'UNAVAILABLE' : 'NOT_FOUND' });
      expect(h.save).not.toHaveBeenCalled();
    }
  });
  it('bounds enumeration timeout, retains in-flight busy gate until actual provider settles', async () => {
    vi.useFakeTimers(); const h = harness(100), late = deferred<(typeof option)[]>(); h.options.mockReturnValueOnce(late.promise);
    const pending = h.select(); await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ code: 'TIMEOUT' });
    expect(h.options.mock.calls[0]?.[0].aborted).toBe(true);
    await expect(h.list()).resolves.toMatchObject({ code: 'BUSY' });
    late.resolve([option]); await settle(); await expect(h.list()).resolves.toMatchObject({ health: 'READY' }); expect(h.save).not.toHaveBeenCalled();
  });
  it('shares active provider gate and does not launch another helper during STT/TTS', async () => {
    const h = harness(); h.setBusy(true); await expect(h.list()).resolves.toMatchObject({ code: 'BUSY' });
    await expect(h.select()).resolves.toMatchObject({ code: 'BUSY' }); expect(h.options).not.toHaveBeenCalled();
  });
  it('rejects malformed/duplicate provider results, never stores guessed voice metadata', async () => {
    const h = harness(); h.options.mockResolvedValueOnce([option, option]); await expect(h.list()).resolves.toMatchObject({ code: 'UNAVAILABLE' });
    h.options.mockResolvedValueOnce([{ ...option, displayName: 'embedded\u0000' }]); await expect(h.select()).resolves.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.save).not.toHaveBeenCalled();
  });
  it('reset explicitly restores default at checked revision and rejects stale profile responses', async () => {
    const h = harness(); await h.select();
    await expect(h.service.handle({ kind: 'reset', petId, expectedRevision: 0 })).resolves.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(h.service.handle({ kind: 'reset', petId, expectedRevision: 1 })).resolves.toMatchObject({ profile: { revision: 2, config: DEFAULT_LOCAL_VOICE_CONFIG } });
    const request = voiceSettingsRequestSchema.parse({ kind: 'save', petId, expectedRevision: 1, config: local });
    const response = voiceSettingsResultSchema.parse({ ok: true, kind: 'profile', profile: h.profile() });
    expect(voiceSettingsResultMatchesRequest(request, response)).toBe(false);
    expect(voiceSettingsResultSchema.safeParse({ ok: true, kind: 'voices', petId, health: 'UNAVAILABLE', voices: [option] }).success).toBe(false);
  });
});
