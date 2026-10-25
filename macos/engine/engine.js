/* Maple Atlas Companion matching engine, shared by the Mac app (hidden web view)
 * and the Windows app (its local window). It reuses the website's matcher (OpenCV
 * ORB + local index in a worker) and short observation history, reads only minimap
 * references, and finds the player's dot (src/minimap-position.js). Frames never
 * leave the computer. Needs visual-client.js, visual-tracker.js and
 * minimap-position.js loaded first. */
(function(){
  const notify=message=>{try{window.webkit?.messageHandlers?.atlas?.postMessage(message);}catch(_){}window.dispatchEvent(new CustomEvent('atlas-engine',{detail:message}));};
  const vision=MapleVisualClient.create({onProgress:message=>notify({type:'progress',message})});
  const tracker=MapleVisualTracker.create(),canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
  const dotCanvas=document.createElement('canvas'),dotContext=dotCanvas.getContext('2d',{willReadFrequently:true});
  let names=new Map(),busy=false,marks=null,scaleMemory=[],loading=null;
  // Scene references are ignored; "strong" is recomputed with the matcher's own rule.
  function minimapOnly(result){
    const candidates=(result.candidates||[]).filter(c=>c.kind==='minimap'),best=candidates[0],runner=candidates[1];
    const strong=!!best&&best.inliers>=18&&best.ratio>=.55&&(!runner||best.score>=runner.score*1.65&&best.score-runner.score>=8);
    return {...result,candidates,strong};
  }
  function ready(){
    loading??=(async()=>{
      const catalog=await vision.ready();
      names=new Map(catalog.maps.map(m=>[String(m.id),m.name]));
      marks=await fetch('./data/portal-marks.json').then(r=>r.ok?r.json():{}).catch(()=>({}));
      notify({type:'progress',message:'Map matcher ready · '+catalog.maps.length+' maps'});
      return {maps:catalog.maps.map(m=>({id:String(m.id),name:m.name}))};
    })().catch(e=>{loading=null;throw e;});
    return loading;
  }
  // Draws `source` (or its `crop`, in source pixels) at most 960 px on the long side.
  // Returns the scale applied, so a frame height in source pixels can follow it.
  function draw(target,ctx,source,crop){
    const w=crop?crop.w:source.videoWidth||source.width,h=crop?crop.h:source.videoHeight||source.height;
    const scale=Math.min(1,960/Math.max(w,h));
    target.width=Math.max(16,Math.round(w*scale));target.height=Math.max(16,Math.round(h*scale));
    if(crop)ctx.drawImage(source,crop.x,crop.y,crop.w,crop.h,0,0,target.width,target.height);else ctx.drawImage(source,0,0,target.width,target.height);
    return scale;
  }
  // Your dot's position in map coordinates (the portal data's frame), or why it is unknown.
  function position(id,pixels,frameHeight){
    const points=(marks?.[id]||[]).map(([x,y])=>({x,y}));
    const found=MapleMinimapPosition.locate(pixels,points,{frameHeight,memory:scaleMemory});
    scaleMemory=found.memory;
    return Number.isFinite(found.x)?{x:found.x,y:found.y}:{reason:found.reason};
  }
  // One matcher reading. frameHeight: the full game window height in source pixels.
  async function readFrame(source,crop,frameHeight){
    if(busy)throw Error('A frame is already being matched.');
    busy=true;const started=performance.now();
    try{
      await ready();
      const scale=draw(canvas,context,source,crop);
      // The matcher takes ownership of its pixel buffer, so the dot search gets its own copy.
      const pixels=context.getImageData(0,0,canvas.width,canvas.height);
      const result=minimapOnly(await vision.match(context.getImageData(0,0,canvas.width,canvas.height)));
      const observation=tracker.read(result),match=observation.match,elapsed=Math.round(performance.now()-started);
      if(!match)return {phase:'searching',text:'Reading the minimap… Keep the in-game minimap visible inside the box.',elapsed};
      const name=names.get(String(match.id))||'Map '+match.id;
      const base={id:String(match.id),name,inliers:match.inliers,kind:'minimap',confidence:Math.min(100,Math.round(match.ratio*100)),elapsed};
      if(observation.phase==='confirmed'){
        const where=position(String(match.id),pixels,Math.round((frameHeight||canvas.height/scale)*scale));
        return {...base,phase:'confirmed',position:where.reason?null:where,positionNote:where.reason||null,text:name+' · '+match.inliers+' aligned landmarks'+(where.reason?'':' · you are on the map')};
      }
      return {...base,phase:'candidate',text:'Checking the minimap… Keep it visible to confirm the map.'};
    }finally{busy=false;}
  }
  // Fast path: only the player's dot on a map the matcher already confirmed. A pixel
  // scan with no landmark matching, cheap enough for several readings a second.
  async function locateFrame(source,crop,frameHeight,id){
    await ready();
    const scale=draw(dotCanvas,dotContext,source,crop);
    const where=position(String(id),dotContext.getImageData(0,0,dotCanvas.width,dotCanvas.height),Math.round((frameHeight||dotCanvas.height/scale)*scale));
    return where.reason?{position:null,positionNote:where.reason}:{position:where,positionNote:null};
  }
  const bitmapOf=async dataURL=>createImageBitmap(await (await fetch(dataURL)).blob());
  // Data-URL entry points used by the Mac app (frameHeight in that image's pixels).
  async function read(dataURL,frameHeight){const bitmap=await bitmapOf(dataURL);try{return await readFrame(bitmap,null,frameHeight);}finally{bitmap.close();}}
  async function locate(dataURL,frameHeight,id){const bitmap=await bitmapOf(dataURL);try{return await locateFrame(bitmap,null,frameHeight,id);}finally{bitmap.close();}}
  window.atlasEngine={ready,read,locate,readFrame,locateFrame,reset:()=>tracker.reset()};
})();
