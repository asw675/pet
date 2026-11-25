import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '@pet-desktop/contracts/voice';
import { AI_STATE_MIGRATION_SQL, AiStateStorage } from '../src/ai-state-storage.ts';
import { VOICE_PROFILE_MIGRATION_SQL, VoiceProfileStorage } from '../src/voice-profile-storage.ts';

const voiceA = { providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: `sapi-${'a'.repeat(64)}`, locale: 'zh-CN' };
const voiceB = { providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: `sapi-${'b'.repeat(64)}`, locale: 'en-US' };
const local = { ...DEFAULT_LOCAL_VOICE_CONFIG, stt: { ...DEFAULT_LOCAL_VOICE_CONFIG.stt, locale: 'zh-CN' },
  tts: { mode: 'LOCAL', voice: { ...voiceA, rate: 1.2 } }, volume: .65, muted: false, maxRecordingMs: 10000 };
const cloud = { ...DEFAULT_LOCAL_VOICE_CONFIG,
  stt: { mode: 'CLOUD', providerId: 'OPENAI_TRANSCRIPTION', consent: { scope: 'STT_AUDIO', authorizationId: 'consent:audio-a' }, locale: 'zh-CN' },
  tts: { mode: 'CLOUD', voice: { providerId: 'AZURE_NEURAL_TTS', voiceId: 'voice-id', locale: 'zh-CN' }, consent: { scope: 'TTS_TEXT', authorizationId: 'consent:text-a' } } };
const cloudAuthorization = { sttCloudConsent: { petId: 'pet-a', providerId: 'OPENAI_TRANSCRIPTION', scope: 'STT_AUDIO', authorizationId: 'consent:audio-a' },
  ttsCloudConsent: { petId: 'pet-a', providerId: 'AZURE_NEURAL_TTS', scope: 'TTS_TEXT', authorizationId: 'consent:text-a' } };
const mock = { providerId: 'provider-mock', endpointKind: 'MOCK', privacyBoundary: 'MOCK', baseUrl: null, modelId: 'mock', credentialRef: null,
  capabilities: { streamText: true, nativeStructured: true, jsonMode: true, usage: false, embeddings: false }, maxContextTokens: 8000, maxOutputTokens: 400, timeoutMs: 30000 };
const job = (requestId = 'turn-1', petId = 'pet-a', conversationId = `conv-${petId}`) => ({ requestId, petId, conversationId, turnId: `voice-${requestId}`, generation: 1 });
function begin(requestId = 'turn-1', petId = 'pet-a', trigger = 'USER') {
  const characterId = 'star-singer', { conversationId } = job(requestId, petId), now = 1000;
  const turn = { requestId, petId, conversationId, trigger, personaRevision: 1, snapshotRevision: 3, deadline: now + 30000,
    ...(trigger === 'USER' ? { userText: '语音提交内容', userMessageId: `user-${requestId}` } : { userText: null, userMessageId: null }),
    context: { persona: { personaId: `persona-${characterId}`, characterId, revision: 1, displayName: '角色', background: '原创角色', personality: { summary: '温柔', traits: [], likes: [], speechStyle: '温柔' }, languageTag: 'zh-CN', allowedMotionIds: ['idle', 'talk'] },
      game: { petId, characterId, nickname: '角色', petRevision: 1, presence: 'HOME', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL', moodScore: 50, healthPoints: 100, energy: 90, bond: 0, level: 1, xp: 0, trip: null, recentEvents: [] },
      recentMessages: [], authorizedMemories: [], historySummary: null } };
  return { turn, providerId: mock.providerId, providerRevision: 1, assistantMessageId: `assistant-${requestId}`, startedAt: now };
}
function finish(requestId = 'turn-1', petId = 'pet-a', kind = 'COMPLETED') {
  const { conversationId } = job(requestId, petId), identity = { requestId, petId, conversationId, completedAt: 1010, kind };
  if (kind === 'FAILED') return { ...identity, error: { code: 'NETWORK', message: 'network', retryable: true } };
  if (kind === 'CANCELLED') return { ...identity, reason: 'USER' };
  return { ...identity, reply: { text: '真正提交的助手回复', emotion: 'calm', motionIntent: 'talk', actionProposals: [], memoryCandidates: [] },
    usage: null, proposals: [], memoryCandidates: [] };
}
function wrap(db) {
  let active = false;
  const tx = action => {
    db.exec('BEGIN IMMEDIATE'); active = true;
    const profiles = new VoiceProfileStorage(db, () => active), ai = new AiStateStorage(db, () => active);
    try {
      const result = action(profiles, ai);
      if (result && typeof result.then === 'function') throw new Error('No async transaction in test');
      active = false; db.exec('COMMIT'); return result;
    } catch (error) { active = false; db.exec('ROLLBACK'); throw error; }
  };
  return { db, tx };
}
function prepare(db) {
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE pets(pet_id TEXT PRIMARY KEY) STRICT; INSERT INTO pets VALUES('pet-a'),('pet-b');
    CREATE TABLE wallet(coins INTEGER NOT NULL) STRICT; INSERT INTO wallet VALUES(21);`);
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(AI_STATE_MIGRATION_SQL); db.exec(VOICE_PROFILE_MIGRATION_SQL); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  const f = wrap(db);
  f.tx((_p, ai) => {
    ai.saveProviderConfig(mock, null, 0);
    for (const petId of ['pet-a', 'pet-b']) {
      ai.setPetProviderAssignment({ petId, providerId: mock.providerId, providerRevision: 1, consentRef: null, assignedAt: 0 });
      ai.createConversation({ petId, conversationId: `conv-${petId}`, title: '聊天', createdAt: 0, updatedAt: 0 });
    }
  });
  return f;
}
function withMemory(action) { const db = new DatabaseSync(':memory:'); try { return action(prepare(db)); } finally { db.close(); } }

describe('Durable per-pet voice profile on single scoped SQLite writer', () => {
  it('adds only voice settings and reads a cloned explicit default without pretending an installed voice or writing a row', () => withMemory(f => {
    f.tx(p => {
      const defaults = p.get('pet-a'); expect(defaults).toEqual({ petId: 'pet-a', revision: 0, updatedAt: null, config: DEFAULT_LOCAL_VOICE_CONFIG });
      defaults.config.volume = 0; expect(p.get('pet-a').config.volume).toBe(1); expect(p.get('unknown')).toBeNull();
      expect(p.reset('pet-a', 0, 10).revision).toBe(0);
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM voice_profiles').get().n).toBe(0);
    expect(f.db.prepare('SELECT coins FROM wallet').get().coins).toBe(21);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }));
  it('requires actual enumerated exact local provider/id/locale for the first selection or changing voices', () => withMemory(f => {
    f.tx(p => {
      expect(() => p.save('pet-a', local, 0, 10)).toThrow(/voice not enumerated/);
      expect(() => p.save('pet-a', local, 0, 10, { installedVoices: [voiceB] })).toThrow(/voice not enumerated/);
      expect(() => p.save('pet-a', local, 0, 10, { installedVoices: [{ ...voiceA, locale: 'en-US' }] })).toThrow(/voice not enumerated/);
      const saved = p.save('pet-a', local, 0, 10, { installedVoices: [voiceA, voiceB] });
      expect(saved).toEqual({ petId: 'pet-a', config: local, revision: 1, updatedAt: 10 });
      const selectedB = { ...local, tts: { mode: 'LOCAL', voice: voiceB } };
      expect(() => p.save('pet-a', selectedB, 1, 20)).toThrow(/voice not enumerated/);
      expect(p.save('pet-a', selectedB, 1, 20, { installedVoices: [voiceB] }).config.tts.voice).toEqual(voiceB);
      expect(p.get('pet-b').config).toEqual(DEFAULT_LOCAL_VOICE_CONFIG);
    });
  }));
  it('permits mute, rate, language and volume edits on a previously validated choice but not substituting guessed voices', () => withMemory(f => {
    f.tx(p => {
      p.save('pet-a', local, 0, 10, { installedVoices: [voiceA] });
      const changes = { ...local, muted: true, volume: .25, stt: { ...local.stt, locale: 'en-US' }, tts: { ...local.tts, voice: { ...local.tts.voice, rate: .8 } } };
      expect(p.save('pet-a', changes, 1, 11)).toMatchObject({ revision: 2, config: changes });
      const guess = { ...changes, tts: { ...changes.tts, voice: { ...voiceA, locale: 'en-US' } } };
      expect(() => p.save('pet-a', guess, 2, 20)).toThrow(/voice not enumerated/);
      expect(() => p.save('pet-a', { ...changes, tts: { mode: 'LOCAL', voice: { ...voiceA, voiceId: 'default-mandarin' } } }, 2, 20)).toThrow(/invalid profile/);
    });
  }));
  it('retains monotonic revision across reset; rejects stale save/reset and regressing clock', () => withMemory(f => {
    f.tx(p => {
      const first = p.save('pet-a', { ...DEFAULT_LOCAL_VOICE_CONFIG, volume: .5 }, 0, 10);
      expect(first.revision).toBe(1);
      expect(p.save('pet-a', first.config, 1, 15)).toEqual(first); // true no-op
      expect(() => p.save('pet-a', first.config, 0, 20)).toThrow(/revision conflict/);
      expect(() => p.reset('pet-a', 1, 9)).toThrow(/revision conflict/);
      expect(p.reset('pet-a', 1, 20)).toMatchObject({ revision: 2, updatedAt: 20, config: DEFAULT_LOCAL_VOICE_CONFIG });
      expect(() => p.save('pet-a', first.config, 0, 30)).toThrow(/revision conflict/);
      expect(() => p.reset('pet-a', 1, 30)).toThrow(/revision conflict/);
    });
    expect(f.db.prepare('SELECT revision FROM voice_profiles WHERE pet_id=?').get('pet-a').revision).toBe(2);
    expect(() => f.db.prepare('DELETE FROM voice_profiles WHERE pet_id=?').run('pet-a')).toThrow(/monotonic revision/);
    expect(() => f.db.prepare('UPDATE voice_profiles SET revision=5 WHERE pet_id=?').run('pet-a')).toThrow(/monotonic/);
  }));
  it('rejects non-owned/invalid target, unknown schema fields, raw audio/path/secrets, invalid numeric values', () => withMemory(f => {
    f.tx(p => {
      expect(() => p.save('unknown', local, 0, 10, { installedVoices: [voiceA] })).toThrow(/not found/);
      for (const invalid of [
        { ...local, rawAudio: 'mic content' }, { ...local, stt: { ...local.stt, modelPath: 'private-path' } },
        { ...local, tts: { ...local.tts, voice: { ...voiceA, apiKey: 'private-key' } } },
        { ...local, maxRecordingMs: 30001 }, { ...local, muted: 1 }, { ...local, volume: NaN }, { ...local, tts: { mode: 'LOCAL', voice: { ...voiceA, rate: 3 } } },
      ]) expect(() => p.save('pet-a', invalid, 0, 10, { installedVoices: [voiceA] })).toThrow(/invalid profile/);
      expect(() => p.save('pet-a', local, -1, 10, { installedVoices: [voiceA] })).toThrow(/invalid profile/);
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM voice_profiles').get().n).toBe(0);
  }));
  it('requires separately confirmed cloud audio/text scope, pet and exact provider; retains explicit chosen cloud mode only', () => withMemory(f => {
    f.tx(p => {
      expect(() => p.save('pet-a', cloud, 0, 10)).toThrow(/consent required/);
      expect(() => p.save('pet-a', cloud, 0, 10, { sttCloudConsent: cloudAuthorization.sttCloudConsent })).toThrow(/consent required/);
      expect(() => p.save('pet-b', cloud, 0, 10, cloudAuthorization)).toThrow(/consent required/);
      expect(() => p.save('pet-a', cloud, 0, 10, { ...cloudAuthorization, ttsCloudConsent: { ...cloudAuthorization.ttsCloudConsent, scope: 'STT_AUDIO' } })).toThrow(/consent required/);
      expect(p.save('pet-a', cloud, 0, 10, cloudAuthorization).config).toEqual(cloud);
      const changed = { ...cloud, stt: { ...cloud.stt, providerId: 'AZURE_FAST_TRANSCRIPTION' } };
      expect(() => p.save('pet-a', changed, 1, 20, cloudAuthorization)).toThrow(/consent required/);
      expect(() => p.save('pet-a', { ...cloud, tts: { ...cloud.tts, consent: { scope: 'TTS_TEXT', authorizationId: cloud.stt.consent.authorizationId } } }, 1, 20)).toThrow(/consent required/);
      expect(p.save('pet-a', { ...cloud, volume: .3 }, 1, 20).config.stt.mode).toBe('CLOUD');
      expect(p.reset('pet-a', 2, 30).config).toEqual(DEFAULT_LOCAL_VOICE_CONFIG);
      // A revoked previous reference cannot become valid by restoring old config alone.
      expect(() => p.save('pet-a', cloud, 3, 40)).toThrow(/consent required/);
    });
  }));
  it('scopes all persistence and read ports to active transaction; rollback preserves revision and config', () => withMemory(f => {
    let escaped;
    f.tx(p => { escaped = p; p.save('pet-a', local, 0, 10, { installedVoices: [voiceA] }); });
    expect(() => escaped.get('pet-a')).toThrow(/inactive/);
    expect(() => escaped.readConfig({ petId: 'pet-a', conversationId: 'conv-pet-a' })).toThrow(/inactive/);
    expect(() => f.tx(p => { p.reset('pet-a', 1, 20); throw new Error('rollback'); })).toThrow(/rollback/);
    f.tx(p => expect(p.get('pet-a')).toMatchObject({ revision: 1, config: local }));
  }));
  it('persists strict config and revision through real database reopen; no saved audio or secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pet-voice-profiles-'));
    const path = join(directory, 'profile.sqlite'); let db;
    try {
      db = new DatabaseSync(path); let f = prepare(db);
      f.tx(p => p.save('pet-a', local, 0, 10, { installedVoices: [voiceA] }));
      db.close(); db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); f = wrap(db);
      f.tx(p => expect(p.get('pet-a')).toEqual({ petId: 'pet-a', config: local, revision: 1, updatedAt: 10 }));
      const raw = db.prepare('SELECT config_json FROM voice_profiles').get().config_json;
      expect(JSON.parse(raw)).toEqual(local); expect(raw).not.toMatch(/audioBytes|transcript|apiKey|credential|modelPath/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db?.close(); rmSync(directory, { force: true, recursive: true }); }
  });
  it('fails closed on corrupt stored JSON schema instead of inventing defaults or overwriting data', () => withMemory(f => {
    f.db.prepare('INSERT INTO voice_profiles VALUES(?,?,?,?)').run('pet-a', '{"stt":"damaged"}', 1, 10);
    expect(() => f.tx(p => p.get('pet-a'))).toThrow(/invalid profile/);
    expect(() => f.tx(p => p.reset('pet-a', 1, 11))).toThrow(/invalid profile/);
    expect(f.db.prepare('SELECT revision FROM voice_profiles').get().revision).toBe(1);
  }));
});

describe('Voice profile authority projection and exact committed reply retrieval', () => {
  it('validates linked pet/conversation and returns only the pet’s durable voice settings revision', () => withMemory(f => {
    f.tx(p => {
      p.save('pet-a', local, 0, 10, { installedVoices: [voiceA] });
      expect(p.readConfig({ petId: 'pet-a', conversationId: 'conv-pet-a' })).toEqual({ configRevision: 1, config: local });
      expect(p.readConfig({ petId: 'pet-b', conversationId: 'conv-pet-b' })).toEqual({ configRevision: 0, config: DEFAULT_LOCAL_VOICE_CONFIG });
      expect(p.readConfig({ petId: 'pet-a', conversationId: 'conv-pet-b' })).toBeNull();
      expect(p.readConfig({ petId: 'fake', conversationId: 'conv-pet-a' })).toBeNull();
    });
  }));
  it('exposes only exact committed, non-redacted USER assistant message; never pending text, wrong identity or unknown request', () => withMemory(f => {
    f.tx((p, ai) => {
      ai.beginTurn(begin()); expect(p.completedAssistantText(job())).toBeNull();
      expect(ai.finishTurn(finish())).toBe(true);
      expect(p.completedAssistantText(job())).toEqual({ petId: 'pet-a', conversationId: 'conv-pet-a', requestId: 'turn-1', text: '真正提交的助手回复' });
      expect(p.completedAssistantText(job('turn-1', 'pet-b'))).toBeNull();
      expect(p.completedAssistantText(job('turn-1', 'pet-a', 'conv-pet-b'))).toBeNull();
      expect(p.completedAssistantText(job('unknown'))).toBeNull();
      expect(p.completedAssistantText({ ...job(), text: 'renderer spoof' })).toBeNull();
      expect(p.completedAssistantText({ ...job(), requestId: undefined })).toBeNull();
      expect(ai.deleteMessage('pet-a', 'conv-pet-a', 'assistant-turn-1', 1020)).toBe(true);
      expect(p.completedAssistantText(job())).toBeNull();
    });
  }));
  it('does not synthesize failed, canceled or proactive turns even if request identity matches', () => withMemory(f => {
    f.tx((p, ai) => {
      ai.beginTurn(begin('failed')); expect(ai.finishTurn(finish('failed', 'pet-a', 'FAILED'))).toBe(true);
      ai.beginTurn(begin('canceled')); expect(ai.finishTurn(finish('canceled', 'pet-a', 'CANCELLED'))).toBe(true);
      expect(p.completedAssistantText(job('failed'))).toBeNull(); expect(p.completedAssistantText(job('canceled'))).toBeNull();
      ai.beginTurn(begin('proactive', 'pet-a', 'PROACTIVE')); expect(ai.finishTurn(finish('proactive'))).toBe(true);
      expect(p.completedAssistantText(job('proactive'))).toBeNull();
    });
  }));
});
