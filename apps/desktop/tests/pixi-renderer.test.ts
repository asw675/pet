import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadBuiltinPack } from '../src/renderer/asset-packs/builtin-registry';
import type { ResolvedPack } from '../src/renderer/asset-packs/resolve-pack';
import { AdaptiveRendererHost } from '../src/renderer/rendering/adaptive-renderer-host';
import { PixiRenderer } from '../src/renderer/rendering/pixi-renderer';
import type { PixiBitmapDecoder } from '../src/renderer/rendering/pixi-renderer';
import type { PixiAtlasResource, PixiContextEvent, PixiFrame, PixiRuntime } from '../src/renderer/rendering/pixi-v8-runtime';
import type { ActionRequest, RenderProfile } from '../src/renderer/rendering/contract';
import type { ModelGeometry, Size } from '../src/renderer/rendering/geometry';
import { modelToCss, calculateModelGeometry } from '../src/renderer/rendering/geometry';

let star: ResolvedPack, ranger: ResolvedPack, nova: ResolvedPack;
beforeAll(async () => { [star,ranger,nova] = await Promise.all([loadBuiltinPack('star-singer'),loadBuiltinPack('fluffy-ranger'),loadBuiltinPack('nova')]); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const profile:RenderProfile={maxFps:30,resolutionScale:1,reducedMotion:false};
const signal=()=>new AbortController().signal;
const action=(semanticId:string,requestId=semanticId):ActionRequest=>({semanticId,requestId,loop:false,priority:1,blendMs:0});
const bitmap=(w:number,h:number)=>{ const close=vi.fn(); return {value:{width:w,height:h,close} as ImageBitmap,close}; };
function decoder() {
  const images:ReturnType<typeof bitmap>[]=[];
  const decode:PixiBitmapDecoder=async bytes=>{
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const image=bitmap(view.getUint32(16),view.getUint32(20));images.push(image);return image.value;
  };
  return {decode,images};
}
function port(){
  const resources:Array<{ bitmap:ImageBitmap;destroy:ReturnType<typeof vi.fn> }>=[];
  let notify:(event:PixiContextEvent)=>void=()=>{};
  const surface={resize:vi.fn((_size:Size)=>{}),clear:vi.fn(),destroy:vi.fn(),
    createResource:vi.fn((image:ImageBitmap)=>{const resource={bitmap:image,destroy:vi.fn()};resources.push(resource);return resource;}),
    draw:vi.fn((_resource:PixiAtlasResource,_frame:PixiFrame,_geometry:ModelGeometry)=>{}),
  };
  const runtime:PixiRuntime={createSurface:vi.fn(async (_canvas,listener)=>{notify=listener;return surface;})};
  const canvas={} as HTMLCanvasElement;
  return {runtime,surface,resources,canvas,notify:(event:PixiContextEvent)=>notify(event)};
}
async function setup(decode:PixiBitmapDecoder, portImpl=port()){
  const onHealth=vi.fn();const renderer=new PixiRenderer({runtime:portImpl.runtime,decode,onHealth});
  await renderer.init(portImpl.canvas,profile);renderer.resize(128,128,1);
  return {renderer,onHealth,...portImpl};
}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function micro(){await Promise.resolve();await Promise.resolve();await Promise.resolve();}
describe('Pixi adapter over verified atlas and injected runtime',()=>{
  it('plays actual sprite frame rect/duration, pure semantic actions and latest base loop',async()=>{
    const d=decoder(),h=await setup(d.decode);
    await h.renderer.loadPack(star,signal());
    expect(h.renderer.activeCharacterId).toBe('star-singer');expect(h.renderer.activeVariant?.renderer).toBe('sprite');
    expect(h.surface.draw.mock.lastCall?.[1].rect).toEqual([0,0,128,128]);
    const draws=h.surface.draw.mock.calls.length;
    h.renderer.tick(.40);expect(h.surface.draw).toHaveBeenCalledTimes(draws);
    h.renderer.tick(.04);expect(h.surface.draw.mock.lastCall?.[1].rect).toEqual([128,0,128,128]);
    h.renderer.setBaseAction('sleep');expect(h.surface.draw.mock.lastCall?.[1].rect).toEqual([512,0,128,128]);
    const happy=h.renderer.play(action('happy'));h.renderer.tick(.13);
    expect(h.surface.draw.mock.lastCall?.[1].rect).toEqual([384,128,128,128]);
    h.renderer.setBaseAction('walk');h.renderer.tick(1);
    await expect(happy).resolves.toEqual({requestId:'happy',status:'completed'});
    expect(h.surface.draw.mock.lastCall?.[1].rect[1]).toBe(384);
    h.renderer.destroy();expect(d.images[0]!.close).toHaveBeenCalledTimes(1);expect(h.resources[0]!.destroy).toHaveBeenCalledTimes(1);
  });
  it('browser path decodes verified bytes as premultiplied PNG for declared texture alpha',async()=>{
    const actual=bitmap(768,512);const create=vi.fn(async (_blob:Blob,_options:ImageBitmapOptions)=>actual.value);
    vi.stubGlobal('createImageBitmap',create);
    const h=port(), renderer=new PixiRenderer({runtime:h.runtime});
    await renderer.init(h.canvas,profile);renderer.resize(128,128,1);await renderer.loadPack(star,signal());
    expect(create.mock.lastCall?.[0].type).toBe('image/png');
    expect(create.mock.lastCall?.[1]).toEqual({premultiplyAlpha:'premultiply'});
    expect(new Uint8Array(await create.mock.lastCall![0].arrayBuffer())).toEqual(star.readAsset('assets/atlas.png'));
    renderer.destroy();expect(actual.close).toHaveBeenCalledTimes(1);
  });
  it('falls back to actual verified static variant when animated decode fails or dimensions differ',async()=>{
    const wrong=bitmap(127,128),d=decoder();let count=0;
    const h=await setup(async (bytes,signal)=>++count===1?wrong.value:d.decode(bytes,signal));
    await h.renderer.loadPack(star,signal());
    expect(wrong.close).toHaveBeenCalledTimes(1);expect(h.renderer.activeVariant?.renderer).toBe('static');
    expect(h.surface.draw.mock.lastCall?.[1].rect).toEqual([0,0,128,128]);
    const unsupported=h.renderer.play(action('walk'));h.renderer.tick(1.1);
    await expect(unsupported).resolves.toEqual({requestId:'walk',status:'unsupported'});h.renderer.destroy();
  });
  it('failed A→B GPU candidate and static upload restore old valid visible frame',async()=>{
    const d=decoder(),h=await setup(d.decode);await h.renderer.loadPack(star,signal());
    const original=h.resources[0]!;
    h.surface.draw.mockImplementation((resource)=>{if(resource!==original)throw Error('candidate upload rejected');});
    await expect(h.renderer.loadPack(ranger,signal())).rejects.toThrow('No usable');
    expect(h.renderer.activeCharacterId).toBe('star-singer');expect(h.surface.draw.mock.lastCall?.[0]).toBe(original);
    expect(h.renderer.hasDrawnFrame).toBe(true);expect(h.onHealth).not.toHaveBeenCalled();
    expect(original.destroy).not.toHaveBeenCalled();expect(h.resources.slice(1).every(item=>item.destroy.mock.calls.length===1)).toBe(true);
    h.renderer.destroy();expect(original.destroy).toHaveBeenCalledTimes(1);
    expect(d.images.every(image=>image.close.mock.calls.length===1)).toBe(true);
  });
  it('an aborted decode rejects promptly; late bitmap never paints and closes',async()=>{
    const d=decoder(),late=deferred<ImageBitmap>(),delay=bitmap(768,512);let count=0;
    const h=await setup(async (bytes,signal)=>++count===2?late.promise:d.decode(bytes,signal));
    await h.renderer.loadPack(star,signal());const c=new AbortController();const pending=h.renderer.loadPack(ranger,c.signal);
    const rejection=expect(pending).rejects.toMatchObject({name:'AbortError'});
    await micro();c.abort();await rejection;late.resolve(delay.value);await micro();
    expect(delay.close).toHaveBeenCalledTimes(1);expect(h.renderer.activeCharacterId).toBe('star-singer');expect(h.resources).toHaveLength(1);
    h.renderer.destroy();
  });
  it('A→B→C supersession never lets delayed B touch C or close its resource',async()=>{
    const d=decoder(),late=deferred<ImageBitmap>(),delayed=bitmap(768,512);let count=0;
    const h=await setup(async(bytes,s)=>++count===2?late.promise:d.decode(bytes,s));
    await h.renderer.loadPack(star,signal());const oldAction=h.renderer.play(action('happy'));
    const b=h.renderer.loadPack(ranger,signal()),rejected=expect(b).rejects.toMatchObject({name:'AbortError'});await micro();
    await h.renderer.loadPack(nova,signal());await rejected;late.resolve(delayed.value);await micro();
    expect(h.renderer.activeCharacterId).toBe('nova');expect(delayed.close).toHaveBeenCalledTimes(1);
    expect(h.surface.draw.mock.lastCall?.[0]).toBe(h.resources[1]);expect(h.resources[1]!.destroy).not.toHaveBeenCalled();
    await expect(oldAction).resolves.toEqual({requestId:'happy',status:'interrupted'});h.renderer.destroy();
  });
  it('abort during synchronous candidate draw restores prior resource before returning',async()=>{
    const d=decoder(),h=await setup(d.decode);await h.renderer.loadPack(star,signal());const controller=new AbortController();
    const old=h.resources[0]!;
    h.surface.draw.mockImplementation(resource=>{if(resource!==old)controller.abort();});
    await expect(h.renderer.loadPack(ranger,controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(h.surface.draw.mock.lastCall?.[0]).toBe(old);expect(h.renderer.hasDrawnFrame).toBe(true);h.renderer.destroy();
  });
  it('DPR and resolutionScale affect physical buffer only; mirrored anchor hit test stays CSS-local',async()=>{
    const d=decoder(),h=await setup(d.decode);await h.renderer.loadPack(star,signal());
    h.renderer.resize(301,237,1.5);h.renderer.setQuality({maxFps:15,resolutionScale:.75,reducedMotion:false});
    expect(h.surface.resize.mock.lastCall?.[0]).toEqual({w:339,h:267});
    const pose={x:4,y:-7,scale:1.1,facing:-1 as const};h.renderer.setPose(pose);
    const g=calculateModelGeometry({w:301,h:237},star.manifest.logicalSize,star.manifest.anchor,pose)!;
    const head=star.manifest.hitRegions.find(item=>item.id==='head')!;
    const pt=modelToCss(g,{x:(head.rect[0]+head.rect[2]/2)*g.logicalSize.w,y:(head.rect[1]+head.rect[3]/2)*g.logicalSize.h});
    expect(h.surface.draw.mock.lastCall?.[2]).toEqual(g);expect(h.renderer.hitTest(pt.x,pt.y)).toEqual({id:'head'});
    h.renderer.resize(10000,10000,4);expect(h.renderer.hitTest(pt.x,pt.y)).toBeNull();expect(h.surface.resize.mock.lastCall?.[0]).toEqual({w:1,h:1});
    h.renderer.destroy();
  });
  it('paused ticks stop changes; reduced motion displays first clip frame but one-shot settles',async()=>{
    const d=decoder(),h=await setup(d.decode);await h.renderer.loadPack(star,signal());h.renderer.setPaused(true);
    const draws=h.surface.draw.mock.calls.length;h.renderer.tick(1);expect(h.surface.draw).toHaveBeenCalledTimes(draws);
    h.renderer.setPaused(false);h.renderer.setQuality({maxFps:15,resolutionScale:1,reducedMotion:true});
    const play=h.renderer.play(action('happy'));const first=h.surface.draw.mock.lastCall?.[1];h.renderer.tick(.2);
    expect(h.surface.draw.mock.lastCall?.[1]).toEqual(first);h.renderer.tick(2);await expect(play).resolves.toMatchObject({status:'completed'});
    h.renderer.destroy();
  });
  it('authored actual mouth sample patch only within verified pack; stale/cancelled generation cannot reopen',async()=>{
    const d=decoder(),h=await setup(d.decode);await h.renderer.loadPack(star,signal());
    h.renderer.setBaseAction('talk');expect(h.surface.draw.mock.lastCall?.[1].mouth?.level).toBe(0);
    h.renderer.setMouth({generation:3,atMs:10,open:.95});expect(h.surface.draw.mock.lastCall?.[1].mouth?.level).toBeGreaterThan(0);
    h.renderer.clearMouth();expect(h.surface.draw.mock.lastCall?.[1].mouth?.level).toBe(0);
    h.renderer.setMouth({generation:3,atMs:20,open:.95});expect(h.surface.draw.mock.lastCall?.[1].mouth?.level).toBe(0);
    h.renderer.setMouth({generation:4,atMs:1,open:.8});expect(h.surface.draw.mock.lastCall?.[1].mouth?.level).toBeGreaterThan(0);
    h.renderer.setPaused(true);expect(h.surface.draw.mock.lastCall?.[1].mouth?.level).toBe(0);h.renderer.destroy();
  });
  it('context loss releases current resource/action, fails closed hit testing, and requires explicit verified reload on restore',async()=>{
    const d=decoder(),h=await setup(d.decode);await h.renderer.loadPack(star,signal());
    const play=h.renderer.play(action('happy'));h.notify('context-lost');h.notify('context-lost');
    expect(h.onHealth).toHaveBeenCalledTimes(1);expect(h.onHealth).toHaveBeenCalledWith('context-lost');
    expect(h.renderer.activeCharacterId).toBeNull();expect(h.renderer.hitTest(64,64)).toBeNull();
    await expect(play).resolves.toMatchObject({status:'interrupted'});
    expect(h.resources[0]!.destroy).toHaveBeenCalledTimes(1);expect(d.images[0]!.close).toHaveBeenCalledTimes(1);
    await expect(h.renderer.loadPack(star,signal())).rejects.toThrow('unavailable');
    h.notify('context-restored');expect(h.onHealth).toHaveBeenLastCalledWith('context-restored');expect(h.renderer.hasDrawnFrame).toBe(false);
    await h.renderer.loadPack(star,signal());expect(h.renderer.hasDrawnFrame).toBe(true);
    expect(h.resources).toHaveLength(2);h.renderer.destroy();expect(h.surface.destroy).toHaveBeenCalledTimes(1);
  });
  it('reports render fault once, blocks interaction, then can recover actual draw without stale hit area',async()=>{
    const d=decoder(),h=await setup(d.decode);await h.renderer.loadPack(star,signal());
    h.surface.draw.mockImplementation(()=>{throw Error('GPU fault');});
    h.renderer.setPose({x:1,y:0,scale:1,facing:1});h.renderer.tick(.5);
    expect(h.onHealth.mock.calls).toEqual([['render-error']]);expect(h.renderer.hasDrawnFrame).toBe(false);
    expect(h.renderer.hitTest(64,64)).toBeNull();await expect(h.renderer.play(action('happy'))).resolves.toMatchObject({status:'failed'});
    h.surface.draw.mockImplementation(()=>{});h.renderer.tick(.5);expect(h.renderer.hasDrawnFrame).toBe(true);h.renderer.destroy();
  });
  it('destroy during initialization releases any later surface and ignores stale events',async()=>{
    const pending=deferred<ReturnType<typeof port>['surface']>(),p=port(),health=vi.fn();
    let event:(event:PixiContextEvent)=>void=()=>{};
    const runtime:PixiRuntime={createSurface:async(_canvas,notify)=>{event=notify;return pending.promise;}};
    const renderer=new PixiRenderer({runtime,onHealth:health});const init=renderer.init(p.canvas,profile),rejection=expect(init).rejects.toMatchObject({name:'AbortError'});
    await micro();renderer.destroy();await rejection;event('context-lost');pending.resolve(p.surface);await micro();
    expect(p.surface.destroy).toHaveBeenCalledTimes(1);expect(health).not.toHaveBeenCalled();
  });
  it('init timeout releases later resource; no permanently pending factory promise',async()=>{
    vi.useFakeTimers();const pending=deferred<ReturnType<typeof port>['surface']>(),p=port();
    const renderer=new PixiRenderer({runtime:{createSurface:()=>pending.promise},initTimeoutMs:10});
    const init=renderer.init(p.canvas,profile),rejection=expect(init).rejects.toMatchObject({name:'TimeoutError'});
    await vi.advanceTimersByTimeAsync(10);await rejection;pending.resolve(p.surface);await micro();
    expect(p.surface.destroy).toHaveBeenCalledTimes(1);renderer.destroy();
  });
});


describe('adaptive desktop render host', () => {
  function hostFixture(failGpu = false) {
    const gpu = port(), fallback = port(), onState = vi.fn();
    const surfaces: { show: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
    const host = new AdaptiveRendererHost({
      createSurface: () => {
        const surface = { canvas: {} as HTMLCanvasElement, show: vi.fn(), destroy: vi.fn() };
        surfaces.push(surface);
        return surface;
      },
      createRenderer: (backend, onHealth) => {
        if (backend === 'pixi-webgl' && failGpu) throw new Error('WebGL unavailable');
        return new PixiRenderer({ runtime: (backend === 'pixi-webgl' ? gpu : fallback).runtime, decode: decoder().decode, onHealth });
      },
      onState,
    });
    host.resize(128, 128, 1);
    return { host, gpu, surfaces, onState };
  }

  it('commits the fallback if WebGL init fails and blocks old-identity input while switching pets', async () => {
    const { host, surfaces, onState } = hostFixture(true);
    try {
      await host.loadPack(star, signal());
      expect(host.backend).toBe('canvas2d');
      expect(surfaces[0]?.destroy).toHaveBeenCalledOnce();
      expect(onState).toHaveBeenLastCalledWith({ characterId: 'star-singer', stage: 'ready', backend: 'canvas2d', hasFrame: true });
      host.invalidate('nova');
      expect(host.interactive).toBe(false);
      expect(host.hitTest(64, 64)).toBeNull();
      await host.loadPack(nova, signal());
      expect(host.activeCharacterId).toBe('nova');
      expect(host.interactive).toBe(true);
    } finally { host.destroy(); }
  });

  it('treats WebGL loss as non-interactive until a fallback draws, then restores the same pet', async () => {
    const { host, gpu } = hostFixture();
    try {
      await host.loadPack(star, signal());
      expect(host.backend).toBe('pixi-webgl');
      gpu.notify('context-lost');
      expect(host.interactive).toBe(false);
      await vi.waitFor(() => expect(host.backend).toBe('canvas2d'));
      gpu.notify('context-restored');
      await vi.waitFor(() => expect(host.backend).toBe('pixi-webgl'));
      expect(host.activeCharacterId).toBe('star-singer');
    } finally { host.destroy(); }
  });
});
