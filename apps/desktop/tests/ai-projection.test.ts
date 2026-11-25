/// <reference path="../src/renderer/env.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, computed, nextTick, ref } from 'vue';
import { createPinia } from 'pinia';
import type { PetSnapshot } from '@pet-desktop/contracts';
import { appSnapshotSchema } from '@pet-desktop/contracts';
import type { ChatMessage, ChatStreamEvent } from '@pet-desktop/contracts/ai';
import type { AiIntent, AiResult, ChatIdentity } from '../src/shared/ai-ipc';
import { aiResultSchema } from '../src/shared/ai-ipc';
import { useAppStore } from '../src/renderer/shared/store';
import { useAiProjection, useAiQuery } from '../src/renderer/control-center/useAiProjection';
import { useAiConfirmation } from '../src/renderer/control-center/useAiConfirmation';
type Host = { parent:Host|null; children:Host[]; text:string };
const node=(text=''):Host=>({parent:null,children:[],text});
const renderer=createRenderer<Host,Host>({createElement:node,createText:node,createComment:node,
  insert(child,parent){child.parent=parent;parent.children.push(child);},remove(child){if(child.parent)child.parent.children=child.parent.children.filter(x=>x!==child);child.parent=null;},
  setText(child,text){child.text=text;},setElementText(child,text){child.text=text;},parentNode:child=>child.parent,nextSibling:()=>null,patchProp:()=>{}});
const pet=(petId:string,characterId:string):PetSnapshot=>({petId,characterId,nickname:petId,presence:'HOME',activity:'IDLE',mood:'CALM',healthStatus:'NORMAL',
  visibility:'HIDDEN',moodScore:80,healthPoints:100,energy:80,bond:10,level:2,xp:100,revision:1});
const snapshot=appSnapshotSchema.parse({revision:7,primaryPetId:'star',walletCoins:10,doNotDisturb:false,pausedRender:false,pets:[pet('star','star-singer'),pet('ranger','fluffy-ranger')]});
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function tick(){await nextTick();await Promise.resolve();await nextTick();}
const initial:ChatIdentity={petId:'star',conversationId:'conv-star',requestId:'request-1'};
const reply={text:'真实最终回复',emotion:'happy' as const,motionIntent:null,actionProposals:[],memoryCandidates:[]};
const final=(identity=initial,sequence=0):ChatStreamEvent=>({...identity,sequence,kind:'final',reply,usage:null});
const delta=(text:string, identity=initial, sequence=0):ChatStreamEvent=>({...identity,sequence,kind:'textDelta',delta:text});
const result=(method:AiIntent['method'],data:unknown):AiResult=>aiResultSchema.parse({ok:true,requestId:'transport',method,data});
const err=(method:AiIntent['method']):AiResult=>aiResultSchema.parse({ok:false,requestId:'transport',method,error:{code:'NETWORK',message:'do not display raw',retryable:true}});
function harness() {
  const requests:Array<{intent:AiIntent;resolve:(value:AiResult)=>void;reject:(error:unknown)=>void}>=[];
  const listeners=new Set<(event:ChatStreamEvent)=>void>();
  const subscribeChatEvents=vi.fn((listener:(event:ChatStreamEvent)=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};});
  const aiRequest=vi.fn((intent:AiIntent)=>{const next=deferred<AiResult>();requests.push({intent,resolve:next.resolve,reject:next.reject});return next.promise;});
  vi.stubGlobal('window',{petDesktop:{role:'control-center',aiRequest,subscribeChatEvents}});
  const pinia=createPinia(), store=useAppStore(pinia);
  store.serviceStatus={stage:'READY',generation:1};store.snapshot=snapshot;store.liveSnapshot=true;
  const offset=ref(0);let context!:ReturnType<typeof useAiProjection>, page!:ReturnType<typeof useAiQuery<'conversations/list'>>, confirmation!:ReturnType<typeof useAiConfirmation>;
  const app=renderer.createApp({setup(){
    context=useAiProjection();page=useAiQuery(context,'conversations/list',computed(()=>context.petId.value?{method:'conversations/list',payload:{petId:context.petId.value,offset:offset.value,limit:2}}:undefined));
    confirmation=useAiConfirmation(context);return ()=>null;
  }});app.use(pinia);app.mount(node());
  let unmounted=false;const unmount=()=>{if(!unmounted)app.unmount();unmounted=true;};cleanups.push(unmount);
  const emit=(event:ChatStreamEvent)=>{for(const listener of listeners)listener(event);};
  const find=(method:AiIntent['method'])=>requests.filter(request=>request.intent.method===method);
  return {store,offset,context,page,confirmation,requests,find,listeners,emit,unmount};
}
function list(request:{intent:AiIntent;resolve:(value:AiResult)=>void},rows=[] as Array<{petId:string;conversationId:string;title:string;createdAt:number;updatedAt:number}>){
  request.resolve(result('conversations/list',{...request.intent.payload,rows}));
}
describe('actual Vue/Pinia AI query and stream ownership',()=>{
  it('scopes queries to selected pet; late old page cannot replace new pet',async()=>{
    const h=harness();expect(h.context.petId.value).toBe('star');expect(h.find('conversations/list')).toHaveLength(1);
    const old=h.find('conversations/list')[0]!;
    h.context.selectPet('ranger');await tick();
    const newer=h.find('conversations/list').at(-1)!;expect(newer.intent.payload).toMatchObject({petId:'ranger'});
    list(newer,[{petId:'ranger',conversationId:'ranger-conv',title:'独立会话',createdAt:1,updatedAt:2}]);await tick();
    list(old,[{petId:'star',conversationId:'star-conv',title:'旧角色',createdAt:1,updatedAt:2}]);await tick();
    expect(h.page.data.value?.rows.map(row=>row.petId)).toEqual(['ranger']);
  });
  it('clears synchronous query availability on pagination and rejects mismatch',async()=>{
    const h=harness();list(h.find('conversations/list')[0]!);await tick();expect(h.page.data.value).not.toBeNull();
    h.offset.value=2;expect(h.page.data.value).toBeNull();await tick();
    const recent=h.find('conversations/list').at(-1)!;recent.resolve(result('conversations/list',{petId:'star',offset:0,limit:2,rows:[]}));await tick();
    expect(h.page.error.value).not.toBeNull();expect(h.page.data.value).toBeNull();
  });
  it('listening begins before a chat/start acknowledgment, including an immediate final',async()=>{
    const h=harness();h.context.selectConversation(initial.conversationId);
    const start=h.context.startChat('你好',initial);expect(h.context.chatting.value).toBe(true);
    const request=h.find('chat/start')[0]!;h.emit(final());
    expect(h.context.chatting.value).toBe(false);expect(h.context.active.value?.terminal).toBe('final');
    request.resolve(result('chat/start',initial));expect(await start).toBe(true);
    expect(h.context.active.value?.text).toBe('');expect(h.context.refreshSignal.value).toBeGreaterThan(0);
  });
  it('accepts only exact identity deltas and admits no second stream while current pending',async()=>{
    const h=harness();h.context.selectConversation(initial.conversationId);
    const start=h.context.startChat('你好',initial);
    expect(await h.context.startChat('duplicate send',{...initial,requestId:'request-2'})).toBe(false);
    h.emit(delta('其他角色',{...initial,petId:'ranger'}));expect(h.context.active.value?.text).toBe('');
    h.emit(delta('你好'));expect(h.context.active.value?.text).toBe('你好');
    h.find('chat/start')[0]!.resolve(result('chat/start',initial));expect(await start).toBe(true);
    h.emit(final(initial,1));expect(h.context.chatting.value).toBe(false);expect(h.context.active.value?.text).toBe('');
    expect(h.find('chat/start')).toHaveLength(1);
  });
  it('rejects voice override from a different pet or conversation before invoking service',async()=>{
    const h=harness();h.context.selectConversation(initial.conversationId);
    expect(await h.context.startChat('语音',{...initial,petId:'ranger'})).toBe(false);
    expect(await h.context.startChat('语音',{...initial,conversationId:'other'})).toBe(false);
    expect(h.find('chat/start')).toHaveLength(0);
  });
  it('switching pet drops the old stream and exact late start receives only old-identity cancellation',async()=>{
    const h=harness();h.context.selectConversation(initial.conversationId);const start=h.context.startChat('旧角色输入',initial);
    h.context.selectPet('ranger');h.context.selectConversation('conv-ranger');
    expect(h.context.active.value).toBeNull();h.emit(delta('旧角色内容'));expect(h.context.active.value).toBeNull();
    h.find('chat/start')[0]!.resolve(result('chat/start',initial));expect(await start).toBe(false);await tick();
    expect(h.find('chat/cancel').every(call=>JSON.stringify(call.intent.payload)===JSON.stringify({...initial,reason:'USER'}))).toBe(true);
    expect(h.find('chat/cancel').length).toBeGreaterThan(0);
    expect(h.context.petId.value).toBe('ranger');expect(h.context.conversationId.value).toBe('conv-ranger');
  });
  it('restart rejects old-generation late acknowledgment without issuing cancellation against new service',async()=>{
    const h=harness();h.context.selectConversation(initial.conversationId);const start=h.context.startChat('旧服务',initial);
    h.store.liveSnapshot=false;h.store.serviceStatus={stage:'RESTARTING',generation:2};await tick();
    h.store.serviceStatus={stage:'READY',generation:2};h.store.liveSnapshot=true;await tick();
    h.find('chat/start')[0]!.resolve(result('chat/start',initial));expect(await start).toBe(false);
    h.emit(final());expect(h.context.active.value).toBeNull();
    expect(h.find('chat/cancel')).toHaveLength(0);
    expect(h.context.conversationId.value).toBe('');
  });
  it('explicit cancel is exact and does not invent transcript; terminal or durable query recovers missing notification',async()=>{
    const h=harness();h.context.selectConversation(initial.conversationId);
    const start=h.context.startChat('取消我',initial);h.find('chat/start')[0]!.resolve(result('chat/start',initial));await start;
    const cancel=h.context.cancelChat();expect(h.context.cancelPending.value).toBe(true);
    expect(h.find('chat/cancel')[0]!.intent.payload).toEqual({...initial,reason:'USER'});
    h.find('chat/cancel')[0]!.resolve(result('chat/cancel',{changed:true}));await cancel;
    expect(h.context.chatting.value).toBe(true);expect(h.context.active.value?.terminal).toBeNull();
    const persisted:ChatMessage={...initial,messageId:'assistant-1',role:'ASSISTANT',status:'CANCELLED',text:'',createdAt:1};
    h.context.reconcileHistory([{...persisted,requestId:'another-request'}]);expect(h.context.chatting.value).toBe(true);
    h.context.reconcileHistory([persisted]);expect(h.context.chatting.value).toBe(false);expect(h.context.active.value?.terminal).toBe('cancelled');
  });
  it('start failure has sanitized feedback, never automatically retries or inserts local message',async()=>{
    const h=harness();h.context.selectConversation(initial.conversationId);const start=h.context.startChat('网络故障',initial);
    h.find('chat/start')[0]!.resolve(err('chat/start'));expect(await start).toBe(false);
    expect(h.context.chatError.value).toContain('连接失败');expect(h.context.chatError.value).not.toContain('raw');
    expect(h.context.active.value?.terminal).toBe('error');expect(h.context.active.value?.text).toBe('');
    await tick();expect(h.find('chat/start')).toHaveLength(1);
  });
  it('unmount drops old query and stream listener; no old result affects current scope',async()=>{
    const h=harness(), old=h.find('conversations/list')[0]!;
    h.unmount();expect(h.listeners.size).toBe(0);list(old);await tick();
    h.emit(final());expect(h.page.data.value).toBeNull();expect(h.context.active.value).toBeNull();
  });
});
describe('explicit renderer confirmation gate',()=>{
  function action(current:()=>boolean,perform:()=>Promise<boolean>){return{title:'核对',detail:['精确对象'],warning:'不可自动',confirmLabel:'确认',current,perform};}
  it('merely opening quote never invokes a mutation; explicit commit consumes once',async()=>{
    const h=harness(),perform=vi.fn(async()=>true);
    h.confirmation.begin(action(()=>true,perform));expect(perform).not.toHaveBeenCalled();
    await h.confirmation.commit();expect(perform).toHaveBeenCalledTimes(1);expect(h.confirmation.quote.value).toBeNull();
    await h.confirmation.commit();expect(perform).toHaveBeenCalledTimes(1);
  });
  it('invalid source fingerprint blocks commit even when originally presented',async()=>{
    const h=harness(),valid=ref(true),perform=vi.fn(async()=>true);
    h.confirmation.begin(action(()=>valid.value,perform));valid.value=false;await h.confirmation.commit();
    expect(perform).not.toHaveBeenCalled();expect(h.confirmation.confirmable.value).toBe(false);
  });
  it('failed mutation is not automatically retried, even with repeat click',async()=>{
    const h=harness(),perform=vi.fn(async()=>false);h.confirmation.begin(action(()=>true,perform));
    await h.confirmation.commit();expect(h.confirmation.attempted.value).toBe(true);expect(h.confirmation.error.value).not.toBeNull();
    await h.confirmation.commit();expect(perform).toHaveBeenCalledTimes(1);
  });
  it('explicit scope change dismisses displayed consent and rejects late completion',async()=>{
    const h=harness(),work=deferred<boolean>(),perform=vi.fn(()=>work.promise);
    h.confirmation.begin(action(()=>true,perform));const task=h.confirmation.commit();
    h.context.selectPet('ranger');expect(h.confirmation.quote.value).toBeNull();work.resolve(true);await task;
    expect(h.context.refreshSignal.value).toBe(0);expect(h.confirmation.quote.value).toBeNull();
  });
});
