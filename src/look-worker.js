/* Look's background worker: recognition (src/look-engine.js) off the page's thread, so the page
 * stays responsive and shows progress. The page sends:
 *   {type: 'init', look, catalogUrl, base}
 *   {type: 'shot', shot, width, height, buffer (RGBA, transferred), lines, map, k?}
 *   {type: 'analyze', id, shot, region}
 * and gets back {id, type: 'progress', stage, done, total, found} then {id, type: 'done', result}
 * or {id, type: 'error', message}. The last few shots are kept (a second look reuses the
 * detector's boxes).
 */
(function(){
  if(typeof importScripts!=='function'||typeof document!=='undefined')return;   // only inside the worker
  let engine=null;const shots=new Map();
  self.onmessage=async e=>{
    const m=e.data||{};
    if(m.type==='init'){engine=MapleLookEngine.create({look:m.look,catalogUrl:m.catalogUrl,base:m.base});return;}
    if(m.type==='shot'){
      shots.set(m.shot,{image:new ImageData(new Uint8ClampedArray(m.buffer),m.width,m.height),lines:m.lines||[],map:m.map||null,k:m.k});
      while(shots.size>3)shots.delete(shots.keys().next().value);
      return;
    }
    if(m.type==='analyze'){
      const s=shots.get(m.shot);
      if(!engine||!s){self.postMessage({id:m.id,type:'error',message:'The screenshot is no longer here.'});return;}
      try{
        const result=await engine.analyze(s,m.region||null,p=>self.postMessage({id:m.id,type:'progress',...p}));
        self.postMessage({id:m.id,type:'done',result});
      }catch(err){self.postMessage({id:m.id,type:'error',message:String(err?.message||err).slice(0,200)});}
    }
  };
})();
