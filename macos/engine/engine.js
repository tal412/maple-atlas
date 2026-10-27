/* Maple Atlas Companion matching engine, shared by the Mac app (hidden web view)
 * and the Windows app (its local window). It reuses the website's matcher (OpenCV
 * ORB + local index in a worker) and short observation history, reads only minimap
 * references, and finds the player's dot (src/minimap-position.js). Frames never
 * leave the computer. It also reads the game's Quest Helper panel (top right) with
 * on-device text recognition (ocr/, Apache-2.0). Needs visual-client.js,
 * visual-tracker.js, minimap-position.js, quest-helper.js and ocr/tesseract.min.js
 * loaded first. */
(function(){
  const notify=message=>{try{window.webkit?.messageHandlers?.atlas?.postMessage(message);}catch(_){}window.dispatchEvent(new CustomEvent('atlas-engine',{detail:message}));};
  const vision=MapleVisualClient.create({onProgress:message=>notify({type:'progress',message})});
  const tracker=MapleVisualTracker.create(),canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
  const dotCanvas=document.createElement('canvas'),dotContext=dotCanvas.getContext('2d',{willReadFrequently:true});
  let names=new Map(),busy=false,marks=null,neighbors={},scaleMemory=[],loading=null,lastMap=null;
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
      neighbors=await fetch('./data/map-neighbors.json').then(r=>r.ok?r.json():{}).catch(()=>({}));
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
      // Minimap references only, more of them, and always the last map and the maps next to it:
      // a tall or dark map's partial minimap can rank low on the quick vote alone.
      const prefer=lastMap?[lastMap,...(neighbors[lastMap]||[])]:null;
      const result=minimapOnly(await vision.match(context.getImageData(0,0,canvas.width,canvas.height),{kinds:['minimap'],limit:40,prefer}));
      const observation=tracker.read(result),match=observation.match,elapsed=Math.round(performance.now()-started);
      if(!match)return {phase:'searching',text:'Reading the minimap… Keep the in-game minimap visible inside the box.',elapsed};
      const name=names.get(String(match.id))||'Map '+match.id;
      const base={id:String(match.id),name,inliers:match.inliers,kind:'minimap',confidence:Math.min(100,Math.round(match.ratio*100)),elapsed};
      if(observation.phase==='confirmed'){
        lastMap=String(match.id);
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
  // ---- Quest Helper ----
  // Text recognition runs in its own worker, loaded the first time the panel is seen.
  let ocr=null,questBusy=false,questSeen=null;
  const questCanvas=document.createElement('canvas'),questContext=questCanvas.getContext('2d',{willReadFrequently:true});
  const textCanvas=document.createElement('canvas'),textContext=textCanvas.getContext('2d',{willReadFrequently:true});
  function reader(){
    ocr??=Tesseract.createWorker('eng',1,{workerPath:'./ocr/worker.min.js',corePath:'./ocr/tesseract-core-simd-lstm.wasm.js',langPath:'./ocr/lang',workerBlobURL:false,gzip:true})
      .then(async worker=>{await worker.setParameters({tessedit_pageseg_mode:'6',preserve_interword_spaces:'1'});return worker;})
      .catch(e=>{ocr=null;throw e;});
    return ocr;
  }
  // Reads the tracked quests from `source` (its `crop`: the top-right part of the game
  // window). Returns {visible, quests (MapleQuestHelper.pack form), changed, text}.
  // The panel is read again only when it looks different, or every 30 s.
  async function readQuestsFrame(source,crop){
    if(questBusy)throw Error('The quest panel is already being read.');
    questBusy=true;const started=performance.now();
    try{
      const w=crop?crop.w:source.videoWidth||source.width,h=crop?crop.h:source.videoHeight||source.height,scale=Math.min(1,1600/Math.max(w,h));
      questCanvas.width=Math.max(16,Math.round(w*scale));questCanvas.height=Math.max(16,Math.round(h*scale));
      if(crop)questContext.drawImage(source,crop.x,crop.y,crop.w,crop.h,0,0,questCanvas.width,questCanvas.height);else questContext.drawImage(source,0,0,questCanvas.width,questCanvas.height);
      const image=questContext.getImageData(0,0,questCanvas.width,questCanvas.height),panel=MapleQuestHelper.find(image);
      if(!panel){questSeen=null;return {visible:false,quests:[],changed:true,elapsed:Math.round(performance.now()-started)};}
      const body=questContext.getImageData(panel.x,panel.y,panel.w,panel.h),signature=MapleQuestHelper.signature(body);
      if(questSeen&&!MapleQuestHelper.changed(signature,questSeen.signature)&&performance.now()-questSeen.at<30000)
        return {visible:true,quests:questSeen.quests,changed:false,elapsed:Math.round(performance.now()-started)};
      // Enlarge so the AUTO button is about 90 px wide, the size the reader is tuned for.
      const zoom=Math.max(1,Math.min(4,90/panel.button));
      textCanvas.width=Math.round(panel.w*zoom);textCanvas.height=Math.round(panel.h*zoom);
      textContext.imageSmoothingEnabled=true;textContext.imageSmoothingQuality='high';
      textContext.drawImage(questCanvas,panel.x,panel.y,panel.w,panel.h,0,0,textCanvas.width,textCanvas.height);
      const pixels=MapleQuestHelper.inkDark(textContext.getImageData(0,0,textCanvas.width,textCanvas.height),75);
      textContext.putImageData(pixels,0,0);
      const worker=await reader(),{data}=await worker.recognize(textCanvas),text=String(data.text||'').trim();
      const quests=MapleQuestHelper.pack(MapleQuestHelper.parse(text));
      const changed=JSON.stringify(quests)!==JSON.stringify(questSeen?.quests);
      questSeen={signature,at:performance.now(),quests};
      return {visible:true,quests,changed,text:text.slice(0,600),elapsed:Math.round(performance.now()-started)};
    }finally{questBusy=false;}
  }
  const bitmapOf=async dataURL=>createImageBitmap(await (await fetch(dataURL)).blob());
  // Data-URL entry points used by the Mac app (frameHeight in that image's pixels).
  async function read(dataURL,frameHeight){const bitmap=await bitmapOf(dataURL);try{return await readFrame(bitmap,null,frameHeight);}finally{bitmap.close();}}
  async function locate(dataURL,frameHeight,id){const bitmap=await bitmapOf(dataURL);try{return await locateFrame(bitmap,null,frameHeight,id);}finally{bitmap.close();}}
  async function readQuests(dataURL){const bitmap=await bitmapOf(dataURL);try{return await readQuestsFrame(bitmap,null);}finally{bitmap.close();}}
  window.atlasEngine={ready,read,locate,readQuests,readFrame,locateFrame,readQuestsFrame,reset:()=>{tracker.reset();lastMap=null;}};
})();
