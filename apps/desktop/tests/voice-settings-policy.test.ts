import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '@pet-desktop/contracts/voice';
import { installedVoiceOptionSchema, voiceSettingsResultMatchesRequest, voiceSettingsResultSchema } from '../src/shared/voice-settings-ipc';
import type { VoiceSettingsRequest } from '../src/shared/voice-settings-ipc';
import { toVoiceProfileDraft, voiceDraftConfig } from '../src/renderer/shared/voice-settings-policy';
const option = installedVoiceOptionSchema.parse({ ref:{providerId:'WINDOWS_SYSTEM_SPEECH',voiceId:`sapi-${'a'.repeat(64)}`,locale:'zh-CN'},displayName:'实际枚举声音测试'}); // test-only actual shape
const draft = toVoiceProfileDraft(DEFAULT_LOCAL_VOICE_CONFIG);
describe('local voice settings form policy',()=>{
  it('default voice settings do not invent voices or assume models installed',()=>{
    expect(draft).toMatchObject({voiceId:'',modelId:'MULTILINGUAL_BASE',muted:false,volume:1});
    expect(voiceDraftConfig(draft,[])).toEqual(DEFAULT_LOCAL_VOICE_CONFIG);
  });
  it('selected voice is always exact installed provider ref + user rate',()=>{
    expect(voiceDraftConfig({...draft,voiceId:option.ref.voiceId,rate:1.2},[option])).toMatchObject({tts:{mode:'LOCAL',voice:{...option.ref,rate:1.2}}});
    expect(voiceDraftConfig({...draft,voiceId:option.ref.voiceId},[])).toBeUndefined();
    expect(voiceDraftConfig({...draft,voiceId:'imaginary-voice'},[option])).toBeUndefined();
  });
  it('updates supported local STT model, locale, muted volume and recording bound',()=>{
    const config=voiceDraftConfig({...draft,modelId:'MULTILINGUAL_SMALL',locale:'zh-CN',volume:.45,muted:true,maxRecordingMs:10000},[]);
    expect(config).toMatchObject({stt:{mode:'LOCAL',providerId:'WHISPER_CPP',modelId:'MULTILINGUAL_SMALL',locale:'zh-CN'},muted:true,volume:.45,maxRecordingMs:10000});
    expect(toVoiceProfileDraft(config!)).toMatchObject({modelId:'MULTILINGUAL_SMALL',locale:'zh-CN',muted:true,volume:.45});
  });
  it.each([{locale:'../../arbitrary-path'},{volume:2},{volume:-.1},{maxRecordingMs:30001},{maxRecordingMs:99},{maxRecordingMs:1000.5}])('rejects invalid bounded local settings %j',edit=>{
    expect(voiceDraftConfig({...draft,...edit},[])).toBeUndefined();
  });
  it('does not permit out-of-range selected voice rate or malformed enumeration',()=>{
    expect(voiceDraftConfig({...draft,voiceId:option.ref.voiceId,rate:2.1},[option])).toBeUndefined();
    expect(voiceDraftConfig({...draft,voiceId:option.ref.voiceId},[option,option])).toBeUndefined();
  });
  it('revision/role + returned config must exactly match explicit local write',()=>{
    const config=voiceDraftConfig({...draft,muted:true},[])!;
    const request:VoiceSettingsRequest={kind:'save',petId:'star',expectedRevision:2,config};
    const actual=voiceSettingsResultSchema.parse({ok:true,kind:'profile',profile:{petId:'star',revision:3,updatedAt:100,config}});
    expect(voiceSettingsResultMatchesRequest(request,actual)).toBe(true);
    expect(voiceSettingsResultMatchesRequest({...request,petId:'ranger'},actual)).toBe(false);
    expect(voiceSettingsResultMatchesRequest({...request,expectedRevision:4},actual)).toBe(false);
    expect(voiceSettingsResultMatchesRequest({...request,config:DEFAULT_LOCAL_VOICE_CONFIG},actual)).toBe(false);
  });
});
