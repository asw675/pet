import { describe,it,expect,vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceClient } from '../src/main/service-client.ts';
import { FeatureClient } from '../src/main/feature-client.ts';
import { startUtilityTransport } from '../src/app-service/transport.ts';
import { openPersistentService } from '../src/app-service/database.ts';
import { UtilityCredentialBroker } from '../src/app-service/feature-router.ts';
import { SCHEMA_VERSION } from '@pet-desktop/app-service';

const config={providerId:'mock-one',endpointKind:'MOCK',privacyBoundary:'MOCK',baseUrl:null,modelId:'mock',credentialRef:null,
  capabilities:{streamText:true,nativeStructured:false,jsonMode:false,usage:false,embeddings:false},maxContextTokens:8000,maxOutputTokens:400,timeoutMs:30000};
const identity={petId:'pet-a',conversationId:'conv-a',requestId:'turn-a'};
const request=(id,method,payload)=>({requestId:id,intent:{method,payload}});
function inProcessChild(path,resources){
  const listeners={message:[],exit:[]};let utility;
  const child={on(event,listener){listeners[event].push(listener);},postMessage(message){queueMicrotask(()=>utility?.receive(message));},kill(){utility?.abort();return true;}};
  queueMicrotask(()=>{utility=startUtilityTransport({args:[path],start:db=>{
      return openPersistentService(db,(filename,readOnly)=>new DatabaseSync(filename,readOnly?{readOnly:true}:{}),{resourcesDirectory:resources});
    },
    send:message=>queueMicrotask(()=>listeners.message.forEach(listener=>listener(message))),exit:code=>queueMicrotask(()=>listeners.exit.forEach(listener=>listener(code)))});});
  return child;
}
describe('feature transport over the single durable utility writer',()=>{
  it('schedules an opted-in greeting from a committed return, honors quiet hours, and does not redeliver after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-proactive-transport-'));
    const path = join(dir, 'test.sqlite3');
    const startedAt = Date.UTC(2026, 7, 20, 10);
    const create = () => new ServiceClient({ spawn: () => inProcessChild(path, dir), startupTimeoutMs: 5000, maxRestarts: 0 });
    let client;
    const send = (id, method, payload) => client.requestProactive(request(id, method, payload));
    const snapshot = id => client.request({ schemaVersion: 1, requestId: id, method: 'snapshot/get', payload: {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    try {
      client = create();
      client.start();
      await vi.waitFor(() => expect(client.getStatus().stage).toBe('READY'));
      const initial = await snapshot('proactive-initial');
      const petId = initial.snapshot.primaryPetId;
      const other = initial.snapshot.pets.find(pet => pet.petId !== petId).petId;
      const settings = await send('proactive-read', 'settings/get', { petId });
      expect(settings).toMatchObject({ ok: true, data: { enabled: false, revision: 0 } });
      const save = await client.requestAi(request('proactive-mock', 'provider/save', { config, expectedRevision: null }));
      expect(save.ok).toBe(true);
      expect(await client.requestAi(request('proactive-assign', 'provider/assign', {
        petId, providerId: config.providerId, providerRevision: save.data.revision, allowCloudContext: false,
      }))).toMatchObject({ ok: true });
      expect(await send('proactive-enable', 'settings/set', {
        petId, expectedRevision: 0, enabled: true, useLocalAi: true, quietHours: { startMinute: 0, endMinute: 23 * 60 + 59 },
      })).toMatchObject({ ok: true, data: { revision: 1 } });
      const departed = await client.request({ schemaVersion: 1, requestId: 'proactive-trip', method: 'command/dispatch', payload: {
        command: { commandId: 'proactive-trip-send', issuedAt: startedAt, type: 'TRIP_START', payload: { petId, routeId: 'morning-dew-meadow' } },
      } });
      expect(departed).toMatchObject({ ok: true });
      let back;
      for (let minute = 17; minute <= 50; minute++) {
        vi.setSystemTime(startedAt + minute * 60_000);
        back = (await snapshot(`proactive-return-${minute}`)).snapshot.pets.find(pet => pet.petId === petId);
        if (back.activity === 'IDLE') break;
      }
      expect(back).toMatchObject({ activity: 'IDLE', trip: { status: 'SETTLED' } });
      const pushes = [];
      client.subscribeProactive(event => pushes.push(event));
      client.setProactiveHost(petId);
      const list = { petId, offset: 0, limit: 10, filter: 'UNREAD' };
      expect(await send('proactive-quiet', 'notices/list', list)).toMatchObject({ ok: true, data: { rows: [] } });
      expect(pushes).toHaveLength(0);
      expect(await send('proactive-allow', 'settings/set', {
        petId, expectedRevision: 1, enabled: true, useLocalAi: true, quietHours: null,
      })).toMatchObject({ ok: true, data: { revision: 2 } });
      client.setProactiveHost(other);
      expect(await send('proactive-wrong-pet', 'notices/list', list)).toMatchObject({ ok: true, data: { rows: [] } });
      client.setProactiveHost(petId);
      await vi.waitFor(() => expect(pushes).toHaveLength(1));
      expect(pushes[0].notice).toMatchObject({ petId, trigger: 'RETURNED', sourceKey: `return:${back.trip.tripId}`, responseKind: 'MOCK' });
      const { noticeId } = pushes[0].notice;
      await client.stop();
      client = create();
      client.start();
      await vi.waitFor(() => expect(client.getStatus().stage).toBe('READY'));
      client.subscribeProactive(event => pushes.push(event));
      client.setProactiveHost(petId);
      expect((await send('proactive-restarted', 'notices/list', list)).data.rows.map(row => row.noticeId)).toEqual([noticeId]);
      expect(pushes).toHaveLength(1);
      expect(await send('proactive-foreign-ack', 'notice/acknowledge', { petId: other, noticeId })).toMatchObject({ ok: true, data: { changed: false } });
      expect(await send('proactive-ack', 'notice/acknowledge', { petId, noticeId })).toMatchObject({ ok: true, data: { changed: true } });
      expect(await send('proactive-read-after', 'notices/list', list)).toMatchObject({ ok: true, data: { rows: [] } });
    } finally {
      await client?.stop();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('actual mock conversation completes through Main and utility routers and survives a writer restart',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'pet-feature-transport-'));const path=join(dir,'test.sqlite3');
    let client;
    try{
      const create=()=>new ServiceClient({spawn:()=>inProcessChild(path,dir),startupTimeoutMs:5000,maxRestarts:0});
      client=create();client.start();await vi.waitFor(()=>expect(client.getStatus().stage).toBe('READY'),{timeout:5000});
      const snapshot=await client.request({schemaVersion:1,requestId:'snap-one',method:'snapshot/get',payload:{}});expect(snapshot.ok).toBe(true);
      const petId=snapshot.snapshot.pets[0].petId, other=snapshot.snapshot.pets[1].petId;
      const save=await client.requestAi(request('setup','provider/save',{config,expectedRevision:null}));expect(save.ok).toBe(true);
      expect(await client.requestAi(request('assign','provider/assign',{petId,providerId:config.providerId,providerRevision:save.data.revision,allowCloudContext:false}))).toMatchObject({ok:true});
      const created=await client.requestAi(request('conv','conversation/create',{petId,title:'真实会话'}));expect(created.ok).toBe(true);
      const conversationId=created.data.conversationId;const events=[];const detach=client.subscribeChat(event=>events.push(event));
      const started=await client.requestAi(request('send','chat/start',{petId,conversationId,requestId:'user-turn',trigger:'USER',userText:'今天怎么样？'}));
      expect(started).toMatchObject({ok:true,data:{petId,conversationId,requestId:'user-turn'}});
      await vi.waitFor(()=>expect(events.at(-1)?.kind).toBe('final'),{timeout:5000});
      expect(events.every(event=>event.petId===petId&&event.conversationId===conversationId&&event.requestId==='user-turn')).toBe(true);
      const messages=await client.requestAi(request('read','messages/list',{petId,conversationId,offset:0,limit:10}));
      expect(messages.ok).toBe(true);expect(messages.data.rows).toHaveLength(2);
      expect(messages.data.rows.some(row=>row.role==='ASSISTANT'&&row.status==='COMPLETED'&&row.text.includes('本地模拟回复'))).toBe(true);
      const stolen=await client.requestAi(request('cross','messages/list',{petId:other,conversationId,offset:0,limit:10}));
      if(stolen.ok)expect(stolen.data.rows).toEqual([]);
      const voice=await client.requestVoice({kind:'status',scope:{petId,conversationId},probe:true});
      expect(voice).toMatchObject({ok:true,kind:'status',status:{canBegin:false,stt:{health:'UNAVAILABLE'}}});
      const profile=await client.requestVoiceSettings({kind:'get',petId});
      expect(profile).toMatchObject({ok:true,kind:'profile',profile:{petId,revision:0,config:{muted:false}}});
      const muted=await client.requestVoiceSettings({kind:'save',petId,expectedRevision:0,config:{...profile.profile.config,muted:true}});
      expect(muted).toMatchObject({ok:true,kind:'profile',profile:{petId,revision:1,config:{muted:true}}});
      const workspace=await client.requestWorkspace(request('workspace-one','workspace/manage',{intent:{method:'workspace/list',payload:{}}}));
      expect(workspace).toMatchObject({ok:true,data:{actions:[],routines:[],history:[],settings:{enabled:false}}});
      const optedIn=await client.requestWorkspace(request('workspace-opt-in','workspace/manage',{intent:{method:'recommendation/settings',payload:{expectedRevision:workspace.data.revision,settings:{...workspace.data.settings,enabled:true},clearHistory:false}}}));
      expect(optedIn).toMatchObject({ok:true,data:{settings:{enabled:true}}});
      const preferences = await client.requestHost({ kind: 'save', edit: { expectedRevision: 0, scalePercent: 125, reducedMotion: true } });
      expect(preferences).toMatchObject({ kind: 'preferences', result: { ok: true, preferences: { revision: 1,
        values: { scalePercent: 125, reducedMotion: true, hotkeysEnabled: true } } } });
      expect(await client.requestHost({ kind: 'save', edit: { expectedRevision: 0, scalePercent: 150, reducedMotion: false } }))
        .toEqual({ kind: 'preferences', result: { ok: false, code: 'REVISION_CONFLICT' } });
      const anchor = { role: 'pet', petId, displayId: -8, offsetX: 170, offsetY: 490,
        x: -1430, y: 490, width: 325, height: 369, displayScale1000: 1500, observedAt: 10 };
      expect(await client.requestHost({ kind: 'save-window-anchor', anchor })).toEqual({
        kind: 'save-window-anchor', result: { ok: true },
      });
      expect(await client.requestHost({ kind: 'save-window-anchor', anchor: { ...anchor, observedAt: 9 } })).toEqual({
        kind: 'save-window-anchor', result: { ok: false, code: 'SERVICE_UNAVAILABLE' },
      });
      expect(await client.requestHost({ kind: 'backup', destination: join(realpathSync.native(dir), 'synthetic-export.sqlite3') }))
        .toEqual({ kind: 'backup', result: { ok: true, schemaVersion: SCHEMA_VERSION } });
      detach();await client.stop();client=create();client.start();await vi.waitFor(()=>expect(client.getStatus().stage).toBe('READY'),{timeout:5000});
      expect(await client.requestAi(request('read-new-gen','messages/list',{petId,conversationId,offset:0,limit:10}))).toEqual({...messages,requestId:'read-new-gen'});
      expect(await client.requestVoiceSettings({kind:'get',petId})).toEqual(muted);
      expect(await client.requestHost({ kind: 'preferences' })).toEqual(preferences);
      expect(await client.requestHost({ kind: 'window-anchors' })).toEqual({ kind: 'window-anchors', result: { ok: true, anchors: [anchor] } });
      expect(await client.requestWorkspace(request('workspace-new-gen','workspace/manage',{intent:{method:'workspace/list',payload:{}}}))).toEqual({...optedIn,requestId:'workspace-new-gen'});
    }finally{await client?.stop();rmSync(dir,{recursive:true,force:true});}
  },20_000);
  it('does not serve a credential to a wrong, cancelled or old-generation job',async()=>{
    const sent=[],events=[],credential=vi.fn(async()=> 'synthetic-key-only');const fault=vi.fn();
    const client=new FeatureClient({post:message=>sent.push(message),onChat:event=>events.push(event),credential,fault});
    const pending=client.requestAi(request('start','chat/start',{...identity,trigger:'USER',userText:'hello'}));
    client.receive({kind:'credential-lookup',lookup:{lookupId:'wrong',providerId:'p1',credentialRef:'credential:key',identity:{...identity,petId:'other'}}});
    expect(credential).not.toHaveBeenCalled();
    client.receive({kind:'credential-lookup',lookup:{lookupId:'correct',providerId:'p1',credentialRef:'credential:key',identity}});
    await vi.waitFor(()=>expect(sent.at(-1)).toEqual({kind:'credential-reply',reply:{lookupId:'correct',secret:'synthetic-key-only'}}));
    expect(events).toEqual([]);client.revokeDocument();
    client.receive({kind:'credential-lookup',lookup:{lookupId:'late',providerId:'p1',credentialRef:'credential:key',identity}});
    expect(credential).toHaveBeenCalledTimes(1);
    client.close();expect(await pending).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});expect(fault).not.toHaveBeenCalled();
  });
  it('matches credential broker lookup identity and aborts late replies',async()=>{
    const sent=[];const broker=new UtilityCredentialBroker(message=>sent.push(message));const controller=new AbortController();
    const pending=broker.resolveCredential('p1','credential:key',controller.signal,identity);
    const lookup=sent[0].lookup;expect(lookup.identity).toEqual(identity);
    broker.receive({lookupId:'unrelated',secret:'synthetic-wrong'});controller.abort();
    expect(await pending).toBeNull();broker.receive({lookupId:lookup.lookupId,secret:'synthetic-late'});broker.close();
    expect(await broker.resolveCredential('p1','credential:key',new AbortController().signal,identity)).toBeNull();
  });
});
