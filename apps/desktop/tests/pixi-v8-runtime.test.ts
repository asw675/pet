import { describe, expect, it, vi } from 'vitest';
import { createPixiV8Runtime, PINNED_PIXI_VERSION } from '../src/renderer/rendering/pixi-v8-runtime';
import type { PixiFrame } from '../src/renderer/rendering/pixi-v8-runtime';
import { calculateModelGeometry } from '../src/renderer/rendering/geometry';

/** Interface-level SDK test double only. This does not run WebGL or claim
 * PixiJS is installed; every asserted call maps to pinned v8 API. */
function bindings(options:{initFailure?:boolean;canvasMismatch?:boolean;initialLost?:boolean}={}){
  const renderers:Renderer[]=[],roots:Container[]=[],sprites:Sprite[]=[],sources:Source[]=[],textures:Texture[]=[];
  class Canvas extends EventTarget { width=1;height=1; }
  class Renderer {
    canvas?:Canvas;
    lost=options.initialLost??false;
    gl={isContextLost:()=>this.lost};
    init=vi.fn(async(settings:{canvas:Canvas})=>{this.canvas=options.canvasMismatch?new Canvas():settings.canvas;if(options.initFailure)throw Error('init failed');});
    resize=vi.fn((_w:number,_h:number,_res:number)=>{});
    render=vi.fn((_options:unknown)=>{});
    destroy=vi.fn((_options:unknown)=>{});
    constructor(){renderers.push(this);}
  }
  class Container {
    position={set:vi.fn()};scale={set:vi.fn()};pivot={set:vi.fn()};eventMode='';
    addChild=vi.fn((_sprite:Sprite)=>{});
    destroy=vi.fn((_options:unknown)=>{});
    constructor(){roots.push(this);}
  }
  class Sprite {
    texture:Texture|null=null;visible=true;x=0;y=0;width=0;height=0;destroy=vi.fn((_options:unknown)=>{});
    constructor(){sprites.push(this);}
  }
  class Source {
    destroy=vi.fn();
    constructor(readonly options:unknown){sources.push(this);}
  }
  class Rectangle { constructor(readonly x:number,readonly y:number,readonly width:number,readonly height:number){} }
  class Texture{
    destroy=vi.fn((_destroySource:unknown)=>{});
    constructor(readonly input:{source:Source;frame:Rectangle}){textures.push(this);}
  }
  return {sdk:{VERSION:PINNED_PIXI_VERSION, WebGLRenderer:Renderer, Container, Sprite, ImageSource:Source, Texture, Rectangle},
    canvas:new Canvas() as unknown as HTMLCanvasElement,renderers,roots,sprites,sources,textures};
}
const image=(w=256,h=256)=>({width:w,height:h,close:vi.fn()} as unknown as ImageBitmap);
const geom=calculateModelGeometry({w:100,h:80},{w:128,h:128},{x:.5,y:1},{x:3,y:-7,scale:1,facing:-1})!;
const frame:PixiFrame={rect:[0,0,128,128]};
async function create(){
  const b=bindings(),notify=vi.fn();
  const surface=await createPixiV8Runtime(b.sdk).createSurface(b.canvas,notify);
  return {...b,surface,notify};
}
describe('pinned Pixi 8.23.0 SDK binding contract',()=>{
  it('rejects incompatible version or incomplete SDK instead of hidden renderer substitution',()=>{
    const b=bindings();
    expect(()=>createPixiV8Runtime({...b.sdk,VERSION:'6.5.10'})).toThrow('Unsupported Pixi');
    expect(()=>createPixiV8Runtime({...b.sdk,VERSION:'8.22.0'})).toThrow('Unsupported Pixi');
    expect(()=>createPixiV8Runtime({...b.sdk,ImageSource:undefined})).toThrow('Unsupported Pixi');
    expect(()=>createPixiV8Runtime(null)).toThrow('unavailable');
  });
  it('constructs only standalone WebGLRenderer, with transparent buffer and no DOM remove/ticker',async()=>{
    const h=await create();
    expect(h.renderers).toHaveLength(1);expect(h.roots).toHaveLength(1);expect(h.sprites).toHaveLength(2);
    expect(h.renderers[0]!.init).toHaveBeenCalledExactlyOnceWith({canvas:h.canvas,width:1,height:1,resolution:1,autoDensity:false,
      backgroundAlpha:0,backgroundColor:0,antialias:false,powerPreference:'low-power',clearBeforeRender:true});
    expect(h.roots[0]!.eventMode).toBe('none');
    expect(h.roots[0]!.addChild.mock.calls).toEqual([[h.sprites[0]],[h.sprites[1]]]);
    h.surface.destroy();h.surface.destroy();
    expect(h.renderers[0]!.destroy).toHaveBeenCalledExactlyOnceWith({removeView:false,releaseGlobalResources:false});
    expect(h.sprites.every(sprite=>sprite.destroy.mock.calls.length===1)).toBe(true);
  });
  it('premultiplied ImageBitmap source owns shared texture views and exact physical anchor transform',async()=>{
    const h=await create(),bitmap=image();
    h.surface.resize({w:151,h:119});
    expect(h.renderers[0]!.resize).toHaveBeenCalledExactlyOnceWith(151,119,1);
    const atlas=h.surface.createResource(bitmap);
    h.surface.draw(atlas,frame,geom);
    expect(h.sources[0]!.options).toEqual({resource:bitmap,resolution:1,alphaMode:'premultiplied-alpha',autoGenerateMipmaps:false});
    expect(h.textures[0]!.input.source).toBe(h.sources[0]);
    expect(h.textures[0]!.input.frame).toMatchObject({x:0,y:0,width:128,height:128});
    expect(h.roots[0]!.position.set).toHaveBeenLastCalledWith(geom.anchorCss.x*151/100,geom.anchorCss.y*119/80);
    expect(h.roots[0]!.scale.set).toHaveBeenLastCalledWith(geom.scale*geom.facing*151/100,geom.scale*119/80);
    expect(h.roots[0]!.pivot.set).toHaveBeenLastCalledWith(geom.modelAnchor.x,geom.modelAnchor.y);
    expect(h.sprites[0]).toMatchObject({texture:h.textures[0],width:128,height:128,x:0,y:0,visible:true});
    expect(h.sprites[1]!.visible).toBe(false);
    expect(h.renderers[0]!.render).toHaveBeenLastCalledWith({container:h.roots[0],clear:true});
    h.surface.destroy();expect(bitmap.close).not.toHaveBeenCalled(); // adapter owns decoded resource
  });
  it('authored mouth overlay is another bounded texture rect at original model position, not a drawn generic mouth',async()=>{
    const h=await create(),atlas=h.surface.createResource(image());
    h.surface.draw(atlas,{...frame,mouth:{source:[135,66,10,11],destination:[59,66,10,11],level:2}},geom);
    expect(h.textures).toHaveLength(2);expect(h.textures[1]!.input.source).toBe(h.sources[0]);
    expect(h.textures[1]!.input.frame).toMatchObject({x:135,y:66,width:10,height:11});
    expect(h.sprites[1]).toMatchObject({x:59,y:66,width:10,height:11,visible:true});
    h.surface.draw(atlas,frame,geom);expect(h.sprites[1]!.visible).toBe(false);expect(h.textures).toHaveLength(2);
    h.surface.clear();expect(h.sprites.every(sprite=>!sprite.visible)).toBe(true);h.surface.destroy();
  });
  it('reuses frame views and bounds LRU to 128 without destroying active sprite texture',async()=>{
    const h=await create(),atlas=h.surface.createResource(image());
    h.surface.draw(atlas,{rect:[0,0,1,1]},geom);h.surface.draw(atlas,{rect:[0,0,1,1]},geom);expect(h.textures).toHaveLength(1);
    for(let x=1;x<150;x++)h.surface.draw(atlas,{rect:[x,0,1,1]},geom);
    const live=h.textures.filter(texture=>texture.destroy.mock.calls.length===0);
    expect(live).toHaveLength(128);expect(live).toContain(h.sprites[0]!.texture);
    atlas.destroy();atlas.destroy();expect(h.textures.every(texture=>texture.destroy.mock.calls.length===1)).toBe(true);
    expect(h.textures.every(texture=>texture.destroy.mock.lastCall?.[0]===false)).toBe(true);
    expect(h.sources[0]!.destroy).toHaveBeenCalledTimes(1);h.surface.destroy();
  });
  it('rejects out-of-bounds frames and foreign/destroyed resources',async()=>{
    const h=await create(),other=await create(),atlas=h.surface.createResource(image());
    for(const rect of [[-1,0,128,128],[128,0,129,128],[0,0,0,128],[0.1,0,128,128]] as const)
      expect(()=>h.surface.draw(atlas,{rect},geom)).toThrow('outside verified');
    expect(()=>other.surface.draw(atlas,frame,geom)).toThrow('does not belong');
    atlas.destroy();expect(()=>h.surface.draw(atlas,frame,geom)).toThrow('does not belong');
    expect(()=>h.surface.createResource(image(2049,128))).toThrow('Invalid Pixi atlas');
    h.surface.destroy();other.surface.destroy();
  });
  it('guards backing allocations and skips unchanged resize',async()=>{
    const h=await create();
    h.surface.resize({w:512,h:256});h.surface.resize({w:512,h:256});
    expect(h.renderers[0]!.resize).toHaveBeenCalledTimes(1);
    for(const size of [{w:0,h:1},{w:4097,h:1},{w:4096,h:4096},{w:1.5,h:8}])
      expect(()=>h.surface.resize(size)).toThrow('buffer limit');
    h.surface.destroy();
  });
  it('notifies actual context loss, prevents default and rejects draw until restored',async()=>{
    const h=await create(),atlas=h.surface.createResource(image());
    const event=new Event('webglcontextlost',{cancelable:true});
    h.canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);expect(h.notify).toHaveBeenCalledExactlyOnceWith('context-lost');
    expect(()=>h.surface.draw(atlas,frame,geom)).toThrow('unavailable');
    h.canvas.dispatchEvent(new Event('webglcontextrestored'));expect(h.notify).toHaveBeenLastCalledWith('context-restored');
    h.surface.draw(atlas,frame,geom);
    h.surface.destroy();h.canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));expect(h.notify).toHaveBeenCalledTimes(2);
  });
  it.each([{initFailure:true},{canvasMismatch:true},{initialLost:true}])('init failure releases renderer and listener %j',async options=>{
    const h=bindings(options),notify=vi.fn();
    await expect(createPixiV8Runtime(h.sdk).createSurface(h.canvas,notify)).rejects.toThrow();
    expect(h.renderers[0]!.destroy).toHaveBeenCalledTimes(1);
    h.canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));expect(notify).not.toHaveBeenCalled();
  });
});
