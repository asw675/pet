import { voiceSessionConfigSchema } from '@pet-desktop/contracts/voice';
import type { VoiceSessionConfig } from '@pet-desktop/contracts/voice';
import type { InstalledVoiceOption } from '../../shared/voice-settings-ipc';
import { installedVoiceOptionsSchema } from '../../shared/voice-settings-ipc';
export interface VoiceProfileDraft {
  modelId: 'MULTILINGUAL_BASE' | 'MULTILINGUAL_SMALL';
  locale: string;
  voiceId: string;
  volume: number;
  rate: number;
  muted: boolean;
  maxRecordingMs: number;
}
export function toVoiceProfileDraft(config: VoiceSessionConfig): VoiceProfileDraft {
  return {
    modelId: config.stt.mode === 'LOCAL' ? config.stt.modelId : 'MULTILINGUAL_BASE',
    locale: config.stt.locale ?? '', voiceId: config.tts.mode === 'LOCAL' ? config.tts.voice.voiceId : '',
    rate: config.tts.mode === 'LOCAL' ? config.tts.voice.rate ?? 1 : 1,
    volume: config.volume, muted: config.muted, maxRecordingMs: config.maxRecordingMs,
  };
}
/** A voice dropdown key locates an actual installed option. No editable
 * provider/token path or fabricated default voice crosses into a config. */
export function voiceDraftConfig(draft: VoiceProfileDraft, actual: readonly InstalledVoiceOption[]): VoiceSessionConfig | undefined {
  const checked = installedVoiceOptionsSchema.safeParse(actual);
  if (!checked.success) return undefined;
  const installed = draft.voiceId ? checked.data.find(option => option.ref.voiceId === draft.voiceId) : undefined;
  if (draft.voiceId && !installed) return undefined;
  const result = voiceSessionConfigSchema.safeParse({
    stt: { mode: 'LOCAL', providerId: 'WHISPER_CPP', modelId: draft.modelId, ...(draft.locale.trim() ? { locale: draft.locale.trim() } : {}) },
    tts: installed ? { mode: 'LOCAL', voice: { ...installed.ref, rate: draft.rate } } : { mode: 'DISABLED' },
    muted: draft.muted, volume: draft.volume, maxRecordingMs: draft.maxRecordingMs,
  });
  return result.success ? result.data : undefined;
}
