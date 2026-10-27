// Production-only GLB packing: bit-exact geometry/animation, identical used texture pixels.
// Source files stay self-contained and unchanged for Blender, baking and rig contracts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { MeshoptEncoder } from 'meshoptimizer';
import { losslessJpeg } from './lossless-jpeg.mjs';
import { BOUNDS, repackCut, unpackMeshopt } from './cut-glb-pack.mjs';

// `quantize` (build default): vertex normals go to int8 normalized and skin weights to uint8 normalized with each vertex's weights
// still summing to exactly 255 — the two attributes the runtime never reads back as numbers. Positions, joints, UVs (they tile
// beyond 0..1 on the fighters), indices and animation stay bit-exact. KHR_mesh_quantization is declared for the int8 normals.
// `cut` (opt-in, the Minotaur cut GLB only, scripts/cut-glb-pack.mjs): the lossy path. Meshopt input is unpacked first; positions and
// UVs keep float32 but lose mantissa bits (EXPONENTIAL filter), normals go octahedral, rotation tracks QUATERNION, translations
// EXPONENTIAL, times exact. The error is measured and checked against BOUNDS before anything is returned.
/** @param {Uint8Array} raw @param {(bytes: Uint8Array, mime: string) => string | undefined} [externalImage] @param {{ quantize?: boolean, cut?: boolean }} [options] */
export async function optimizeGlb(raw, externalImage = () => undefined, { quantize = true, cut = false } = {}) {
 await MeshoptEncoder.ready;
 assert.equal(raw.readUInt32LE(0),0x46546c67,'Expected GLB');
 assert.equal(raw.readUInt32LE(4),2,'Expected GLB v2');
 const n=raw.readUInt32LE(12);let d=JSON.parse(raw.subarray(20,20+n)),bin=raw.subarray(28+n);
 if(cut)({d,bin}=await unpackMeshopt(d,bin));
 assert.equal(d.buffers.length,1,'Optimizer requires one embedded buffer');
 assert.ok(!d.extensionsUsed?.some(x=>['EXT_meshopt_compression','KHR_meshopt_compression','KHR_draco_mesh_compression'].includes(x)),'Source must be uncompressed');
 d.textures??=[];d.images??=[];   // a file with no textures (loot.glb: palette materials only) has neither array
 assert.ok(d.images.every(i=>i.bufferView!==undefined),'Textures must be embedded');
 // Offline equipment rollback document; the source GLB retains it for rebuilding.
 delete d.extras?.creatureWeaponBase;
 const preserveAll=d.extensionsUsed?.some(x=>['KHR_materials_variants','KHR_animation_pointer'].includes(x));
 const mats=new Set(d.meshes.flatMap(m=>m.primitives.map(p=>p.material)).filter(i=>i!==undefined)),textures=new Set(),images=new Set();
 if(preserveAll)d.materials.forEach((_,i)=>mats.add(i));
 const visitTextures=(o,fn)=>{if(!o||typeof o!=='object')return;for(const[k,v]of Object.entries(o)){if(k.endsWith('Texture')&&v?.index!==undefined)fn(v);else visitTextures(v,fn);}};
 for(const i of mats)visitTextures(d.materials[i],v=>textures.add(v.index));
 for(const i of textures){const t=d.textures[i];if(t.source!==undefined)images.add(t.source);for(const x of Object.values(t.extensions||{}))if(x.source!==undefined)images.add(x.source);}
 const select=(array,ids)=>{const map=new Map();const kept=array.filter((_,i)=>ids.has(i));let index=0;for(let i=0;i<array.length;i++)if(ids.has(i))map.set(i,index++);return {kept,map};};
 if(preserveAll){d.textures.forEach((_,i)=>textures.add(i));d.images.forEach((_,i)=>images.add(i));}
 const material=select(d.materials,mats),texture=select(d.textures,textures),image=select(d.images,images);
 const discardedViews=new Set(d.images.filter((_,i)=>!images.has(i)).map(i=>i.bufferView));
 for(const i of image.kept)discardedViews.delete(i.bufferView);
 for(const m of d.meshes)for(const p of m.primitives)if(p.material!==undefined)p.material=material.map.get(p.material);
 for(const m of material.kept)visitTextures(m,v=>v.index=texture.map.get(v.index));
 for(const t of texture.kept){if(t.source!==undefined)t.source=image.map.get(t.source);for(const x of Object.values(t.extensions||{}))if(x.source!==undefined)x.source=image.map.get(x.source);}
 d.materials=material.kept;d.textures=texture.kept;d.images=image.kept;
 const jpegViews=new Set(d.images.filter(i=>i.mimeType==='image/jpeg').map(i=>i.bufferView));
 for(const img of d.images){
  const v=d.bufferViews[img.bufferView],rawImage=bin.subarray(v.byteOffset||0,(v.byteOffset||0)+v.byteLength);
  const bytes=img.mimeType==='image/jpeg'?losslessJpeg(rawImage):rawImage;
  const uri=externalImage(bytes,img.mimeType);
  if(uri){assert.ok(!d.accessors.some(a=>a.bufferView===img.bufferView));discardedViews.add(img.bufferView);delete img.bufferView;img.uri=uri;}
 }
 const quantized=new Map();   // bufferView index → replacement bytes (stride 4)
 let prepared=new Map();   // cut mode: bufferView index → already meshopt-coded bytes (+ filter)
 if(cut){
  const r=await repackCut(d,bin);prepared=r.prepared;for(const i of r.dropped)discardedViews.add(i);
  assert.ok(r.report.positionError<BOUNDS.positionMetres,`cut pack: position error ${r.report.positionError}`);
  assert.ok(r.report.rotationError<BOUNDS.rotationRadians,`cut pack: rotation error ${r.report.rotationError}`);
 }
 else if(quantize){
  const targets=new Set(d.meshes.flatMap(m=>m.primitives.flatMap(p=>(p.targets||[]).flatMap(t=>Object.values(t)))));
  const semantics=new Map();for(const m of d.meshes)for(const p of m.primitives)for(const[s,ai]of Object.entries(p.attributes))semantics.set(ai,s.replace(/_\d+$/,''));
  for(const[ai,s]of semantics){
   const a=d.accessors[ai];if(targets.has(ai)||a.sparse||a.byteOffset||a.componentType!==5126)continue;
   if(!((s==='NORMAL'&&a.type==='VEC3')||(s==='WEIGHTS'&&a.type==='VEC4')))continue;
   assert.ok(!d.accessors.some((o,i)=>i!==ai&&o.bufferView===a.bufferView),'quantization needs one accessor per view');
   const v=d.bufferViews[a.bufferView],width=s==='NORMAL'?3:4,stride=v.byteStride||width*4,base=v.byteOffset||0,out=Buffer.alloc(a.count*4);
   for(let i=0;i<a.count;i++){
    const at=base+i*stride,x=bin.readFloatLE(at),y=bin.readFloatLE(at+4),z=bin.readFloatLE(at+8);
    if(s==='NORMAL'){const l=Math.hypot(x,y,z)||1;out.writeInt8(Math.max(-127,Math.min(127,Math.round(x/l*127))),i*4);out.writeInt8(Math.max(-127,Math.min(127,Math.round(y/l*127))),i*4+1);out.writeInt8(Math.max(-127,Math.min(127,Math.round(z/l*127))),i*4+2);}
    else{const w=[x,y,z,bin.readFloatLE(at+12)].map(c=>Math.max(0,Math.min(1,c))),q=w.map(c=>Math.round(c*255)),total=Math.round(w.reduce((n,c)=>n+c,0)*255);
     let diff=total-q.reduce((n,c)=>n+c,0);const order=[0,1,2,3].sort((p,r)=>w[r]-w[p]);for(const k of order){if(!diff)break;const next=Math.max(0,Math.min(255,q[k]+diff));diff-=next-q[k];q[k]=next;}
     for(let k=0;k<4;k++)out.writeUInt8(q[k],i*4+k);}
   }
   a.componentType=s==='NORMAL'?5120:5121;a.normalized=true;delete a.min;delete a.max;
   quantized.set(a.bufferView,out);
  }
  if(quantized.size){d.extensionsUsed=[...new Set([...(d.extensionsUsed||[]),'KHR_mesh_quantization'])];d.extensionsRequired=[...new Set([...(d.extensionsRequired||[]),'KHR_mesh_quantization'])];}
 }
 const chunks=[],views=[],viewMap=new Map(),packedBytes=new Map(),packedViews=new Map();let offset=0,fallback=0;
 const append=bytes=>{const key=createHash('sha256').update(bytes).digest('hex');if(packedBytes.has(key))return packedBytes.get(key);const at=offset;packedBytes.set(key,at);chunks.push(bytes);offset+=bytes.length;const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}return at;};
 for(const [i,v]of d.bufferViews.entries()){
  if(discardedViews.has(i))continue;
  if(prepared.has(i)){
   const p=prepared.get(i),next={...v,buffer:1,byteOffset:0,extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:append(Buffer.from(p.enc)),byteLength:p.enc.length,byteStride:p.stride,count:p.count,mode:p.mode,filter:p.filter}}};
   fallback=Math.max(fallback,v.byteLength);viewMap.set(i,views.length);views.push(next);continue;
  }
  let bytes=quantized.get(i)||bin.subarray(v.byteOffset||0,(v.byteOffset||0)+v.byteLength);const a=d.accessors.find(a=>a.bufferView===i);
  if(jpegViews.has(i))bytes=losslessJpeg(bytes);
  let encoded;
  const width=a&&{SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[a.type],stride=quantized.has(i)?4:a&&(v.byteStride||width*({5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}[a.componentType]));
  const mode=v.target===34963?'INDICES':'ATTRIBUTES';
  if(a&&(mode==='INDICES'?[2,4].includes(stride):stride%4===0&&stride<=256)){
   encoded=MeshoptEncoder.encodeGltfBuffer(bytes,bytes.length/stride,stride,mode);
   if(gzipSync(encoded).length>=gzipSync(bytes).length)encoded=undefined;
  }
  const next={...v,byteLength:bytes.length};if(quantized.has(i))next.byteStride=4;
  if(encoded){next.buffer=1;next.byteOffset=0;next.extensions={EXT_meshopt_compression:{buffer:0,byteOffset:append(Buffer.from(encoded)),byteLength:encoded.length,byteStride:stride,count:bytes.length/stride,mode,filter:'NONE'}};fallback=Math.max(fallback,bytes.length);}
  else {next.buffer=0;next.byteOffset=append(bytes);}
  const key=JSON.stringify(next);if(!packedViews.has(key)){packedViews.set(key,views.length);views.push(next);}
  viewMap.set(i,packedViews.get(key));
 }
 const remap=o=>{if(!o||typeof o!=='object')return;for(const[k,v]of Object.entries(o))if(k==='bufferView')o[k]=viewMap.get(v);else remap(v);};
 for(const a of d.accessors)remap(a);for(const image of d.images)remap(image);
 d.bufferViews=views;d.buffers=[{byteLength:offset},{byteLength:fallback,extensions:{EXT_meshopt_compression:{fallback:true}}}];
 d.extensionsUsed=[...new Set([...(d.extensionsUsed||[]),'EXT_meshopt_compression'])];d.extensionsRequired=[...new Set([...(d.extensionsRequired||[]),'EXT_meshopt_compression'])];
 let json=Buffer.from(JSON.stringify(d));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);const binary=Buffer.concat(chunks),out=Buffer.alloc(28+json.length+binary.length);
 out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(json.length,12);out.writeUInt32LE(0x4e4f534a,16);json.copy(out,20);out.writeUInt32LE(binary.length,20+json.length);out.writeUInt32LE(0x004e4942,24+json.length);binary.copy(out,28+json.length);
 return out;
}
