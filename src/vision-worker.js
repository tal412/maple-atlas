/* Runs in a dedicated worker; captured pixels never leave this device. */
let engine,initializing;
async function initialize(){
 if(initializing)return initializing;
 initializing=(async()=>{
  postMessage({type:'loading',message:'Loading the visual map catalog…'});
  const response=await fetch('./data/visual-index.json');if(!response.ok)throw Error('Map catalog unavailable. Connect once to download it.');const catalog=await response.json();
  if(catalog.schema!==1||!/^\.\/data\/visual-[a-f0-9]{16}\.bin$/.test(catalog.data)||catalog.bytes>60000000)throw Error('Invalid visual catalog.');
  postMessage({type:'loading',message:'Loading '+catalog.maps.length+' map references…'});
  const data=await fetch(catalog.data);if(!data.ok)throw Error('Visual map download failed. Retry while online.');const buffer=await data.arrayBuffer();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),n=>n.toString(16).padStart(2,'0')).join('');if(digest!==catalog.sha256)throw Error('Visual map download was incomplete. Reload and retry.');
  postMessage({type:'loading',message:'Preparing local visual matching…'});
  importScripts('./vendor/vision/opencv.js','./visual-matcher.js');
  const module=self.cv;const ready=module instanceof Promise?{cv:await module}:await new Promise(resolve=>{if(module.Mat)resolve({cv:module});else module.onRuntimeInitialized=()=>resolve({cv:module});});
  engine=MapleVisualMatcher.create(ready.cv,catalog,buffer);return catalog;
 })().catch(e=>{initializing=null;throw e;});return initializing;
}
self.onmessage=async event=>{
 const {type,id,image}=event.data||{};
 try{
  if(type==='init'){const catalog=await initialize();postMessage({type:'ready',id,maps:catalog.maps,unavailable:catalog.unavailable});}
  if(type==='match'){await initialize();const started=performance.now(),result=engine.match(image);postMessage({type:'result',id,result:{...result,elapsed:Math.round(performance.now()-started)}});}
 }catch(e){postMessage({type:'error',id,message:e?.message||'The image could not be matched.'});}
};
