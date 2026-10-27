/* Maple Atlas Companion engine, shared by the Mac app (hidden web view) and the Windows app
 * (its local window). It reads the map name shown in the in-game minimap's header ("Victoria
 * Road" / "Henesys", src/map-name.js) with on-device text recognition (ocr/, Apache-2.0),
 * finds the player's dot on the minimap below it (src/minimap-position.js, which also uses
 * that strip to find the minimap window), and reads the
 * game's Quest Helper panel (src/quest-helper.js). Frames never leave the computer. The
 * player keeps the map name shown (the minimap's + button). Needs map-name.js,
 * minimap-position.js, quest-helper.js and ocr/tesseract.min.js loaded first. */
(function(){
  const notify=message=>{try{window.webkit?.messageHandlers?.atlas?.postMessage(message);}catch(_){}window.dispatchEvent(new CustomEvent('atlas-engine',{detail:message}));};
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
  const dotCanvas=document.createElement('canvas'),dotContext=dotCanvas.getContext('2d',{willReadFrequently:true});
  const nameCanvas=document.createElement('canvas'),nameContext=nameCanvas.getContext('2d',{willReadFrequently:true});
  let maps=[],names=new Map(),busy=false,marks=null,neighbors={},scaleMemory=[],loading=null,lastMap=null;
  // The last name reading: the strip's place in the box (0-1) and what it said.
  let seen=null;
  const SHOW_NAME='Show the map name: press + on the in-game minimap until its name appears (for example "Victoria Road · Henesys"), and keep the whole minimap with its name inside the box.';
  function ready(){
    loading??=(async()=>{
      maps=await fetch('./data/map-names.json').then(r=>{if(!r.ok)throw Error('map list missing');return r.json();});
      names=new Map(maps.map(m=>[String(m.id),m.name]));
      marks=await fetch('./data/portal-marks.json').then(r=>r.ok?r.json():{}).catch(()=>({}));
      neighbors=await fetch('./data/map-neighbors.json').then(r=>r.ok?r.json():{}).catch(()=>({}));
      notify({type:'progress',message:'Map names ready · '+maps.length+' maps'});
      return {maps:maps.map(m=>({id:String(m.id),name:m.name}))};
    })().catch(e=>{loading=null;throw e;});
    return loading;
  }
  // Draws `source` (or its `crop`, in source pixels) at most `limit` px on the long side.
  // Returns the scale applied, so a frame height in source pixels can follow it.
  function draw(target,ctx,source,crop,limit=960){
    const w=crop?crop.w:source.videoWidth||source.width,h=crop?crop.h:source.videoHeight||source.height;
    const scale=Math.min(1,limit/Math.max(w,h));
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
  // Of several maps with the very same name and street, the one you were on or one next to it.
  function pick(found){
    const ids=found.ids?.length?found.ids:[found.id];
    if(ids.length===1)return ids[0];
    if(lastMap&&ids.includes(lastMap))return lastMap;
    const near=lastMap?ids.find(id=>(neighbors[lastMap]||[]).includes(id)):null;
    return near||ids[0];
  }
  // Reads the map name from the strip; again only when the strip looks different, or every 20 s.
  async function readName(image){
    const strip=MapleMapName.find(image);
    if(!strip)return null;
    const zoom=Math.max(1,Math.min(4,150/strip.h));
    nameCanvas.width=Math.round(strip.w*zoom);nameCanvas.height=Math.round(strip.h*zoom);
    nameContext.imageSmoothingEnabled=true;nameContext.imageSmoothingQuality='high';
    nameContext.drawImage(canvas,strip.x,strip.y,strip.w,strip.h,0,0,nameCanvas.width,nameCanvas.height);
    const raw=nameContext.getImageData(0,0,nameCanvas.width,nameCanvas.height),emblem=MapleMapName.emblemEnd(raw);
    let pixels=MapleMapName.ink(raw);
    const signature=MapleMapName.signature(pixels);
    const box={x:strip.x/canvas.width,y:strip.y/canvas.height,w:strip.w/canvas.width,h:strip.h/canvas.height};
    if(seen?.found&&!MapleMapName.changed(signature,seen.signature)&&performance.now()-seen.at<20000)return {...seen,strip:box,fresh:false};
    pixels=MapleMapName.blankLeft(pixels,emblem);   // the area emblem
    nameContext.putImageData(pixels,0,0);
    const worker=await reader(),{data}=await worker.recognize(nameCanvas),text=String(data.text||'').trim();
    const found=MapleMapName.match(text,maps);
    return {strip:box,signature,at:performance.now(),text,found,fresh:true};
  }
  // One reading. frameHeight: the full game window height in source pixels.
  async function readFrame(source,crop,frameHeight){
    if(busy)throw Error('A frame is already being read.');
    busy=true;const started=performance.now();
    try{
      await ready();
      const scale=draw(canvas,context,source,crop);
      const reading=await readName(context.getImageData(0,0,canvas.width,canvas.height)),elapsed=()=>Math.round(performance.now()-started);
      if(!reading){seen=null;return {phase:'searching',text:SHOW_NAME,elapsed:elapsed()};}
      const previous=seen;seen=reading;
      if(!reading.found)return {phase:'searching',text:'Reading the map name… Keep the minimap and its name inside the box.',read:reading.text?.slice(0,80)||'',elapsed:elapsed()};
      const id=pick(reading.found),name=names.get(id)||reading.found.name;
      // A clear reading counts at once; a weaker one when the next reading agrees.
      const agreed=previous?.found&&pick(previous.found)===id;
      const base={id,name,kind:'name',confidence:Math.round(reading.found.score*100),street:reading.found.street,elapsed:elapsed()};
      if(reading.found.score>=.85||agreed){
        lastMap=id;
        const where=position(id,context.getImageData(0,0,canvas.width,canvas.height),Math.round((frameHeight||canvas.height/scale)*scale));
        return {...base,phase:'confirmed',position:where.reason?null:where,positionNote:where.reason||null,text:name+(reading.found.street?' · '+reading.found.street:'')+(where.reason?'':' · you are on the map'),elapsed:elapsed()};
      }
      return {...base,phase:'candidate',text:'Reading the map name… '+name+'?'};
    }finally{busy=false;}
  }
  // Fast path: only the player's dot on a map already read. A pixel scan with no text
  // recognition, cheap enough for several readings a second.
  async function locateFrame(source,crop,frameHeight,id){
    await ready();
    const scale=draw(dotCanvas,dotContext,source,crop);
    const where=position(String(id),dotContext.getImageData(0,0,dotCanvas.width,dotCanvas.height),Math.round((frameHeight||dotCanvas.height/scale)*scale));
    return where.reason?{position:null,positionNote:where.reason}:{position:where,positionNote:null};
  }
  // ---- Quest Helper ----
  // Text recognition runs in its own worker (shared with the map name), loaded on first use.
  let ocr=null,questBusy=false,questSeen=null;
  const questCanvas=document.createElement('canvas'),questContext=questCanvas.getContext('2d',{willReadFrequently:true});
  const textCanvas=document.createElement('canvas'),textContext=textCanvas.getContext('2d',{willReadFrequently:true});
  function reader(){
    ocr??=Tesseract.createWorker('eng',1,{workerPath:'./ocr/worker.min.js',corePath:'./ocr/tesseract-core-simd-lstm.wasm.js',langPath:'./ocr/lang',workerBlobURL:false,gzip:true})
      .then(async worker=>{await worker.setParameters({tessedit_pageseg_mode:'6',preserve_interword_spaces:'1'});return worker;})
      .catch(e=>{ocr=null;throw e;});
    return ocr;
  }
  // A second reader that knows only digits and "/", for the "have / need" counts: the
  // general reader sometimes reads the slash as an extra digit ("2 / 10" as "21 / 10").
  let digits=null;
  function digitReader(){
    digits??=Tesseract.createWorker('eng',1,{workerPath:'./ocr/worker.min.js',corePath:'./ocr/tesseract-core-simd-lstm.wasm.js',langPath:'./ocr/lang',workerBlobURL:false,gzip:true})
      .then(async worker=>{await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'0123456789/'});return worker;})
      .catch(e=>{digits=null;throw e;});
    return digits;
  }
  // Rebuilds the panel text with every count line's numbers read again by the digits reader.
  // Returns null when the layout is missing, so the plain text is used.
  async function recheckCounts(data,image){
    const lines=(data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
    if(!lines.length)return null;
    const out=[];
    for(const line of lines){
      const plain=String(line.text||'').trim(),span=MapleQuestHelper.countSpan(line.words);
      if(!span){out.push(plain);continue;}
      const pad=Math.max(3,Math.round((span.box.y1-span.box.y0)*.25));
      const rectangle={left:Math.max(0,span.box.x0-pad),top:Math.max(0,span.box.y0-pad),width:Math.min(image.width,span.box.x1+pad)-Math.max(0,span.box.x0-pad),height:Math.min(image.height,span.box.y1+pad)-Math.max(0,span.box.y0-pad)};
      // The general reader's slash, minus any digit drawn on top of it; only without a slash
      // the digits-only reader decides.
      let c=MapleQuestHelper.countsFromBoxes(span.lead);
      if(!c)try{const {data:d}=await (await digitReader()).recognize(image,{rectangle});c=MapleQuestHelper.counts(d.text);}catch(_){}
      out.push(c?c.have+' / '+c.need+' '+span.rest:plain);
    }
    return out.join('\n');
  }
  // Reads the tracked quests from `source` (its `crop`: the top-right part of the game
  // window). Returns {visible, quests (MapleQuestHelper.pack form), changed, text}.
  // The panel is read again only when it looks different, or every 30 s.
  // opts.marked: the player drew a box around the Quest Helper. Then the panel is looked for
  // inside it, and when it is not found by its colours the whole box is read.
  async function readQuestsFrame(source,crop,opts={}){
    if(questBusy)throw Error('The quest panel is already being read.');
    questBusy=true;const started=performance.now();
    try{
      const w=crop?crop.w:source.videoWidth||source.width,h=crop?crop.h:source.videoHeight||source.height,scale=Math.min(1,1600/Math.max(w,h));
      questCanvas.width=Math.max(16,Math.round(w*scale));questCanvas.height=Math.max(16,Math.round(h*scale));
      if(crop)questContext.drawImage(source,crop.x,crop.y,crop.w,crop.h,0,0,questCanvas.width,questCanvas.height);else questContext.drawImage(source,0,0,questCanvas.width,questCanvas.height);
      const image=questContext.getImageData(0,0,questCanvas.width,questCanvas.height);
      // About 10.5 AUTO-button widths across the panel body: the zoom the reader is tuned for.
      const panel=MapleQuestHelper.find(image)||(opts.marked?{x:0,y:0,w:questCanvas.width,h:questCanvas.height,button:questCanvas.width/10.5}:null);
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
      const worker=await reader(),{data}=await worker.recognize(textCanvas,{},{text:true,blocks:true});
      const text=await recheckCounts(data,textCanvas)||String(data.text||'').trim();
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
  async function readQuests(dataURL,opts={}){const bitmap=await bitmapOf(dataURL);try{return await readQuestsFrame(bitmap,null,opts);}finally{bitmap.close();}}
  // The panel text of a prepared (inked) canvas, counts read twice. For tests and diagnostics.
  async function readQuestText(image){const {data}=await (await reader()).recognize(image,{},{text:true,blocks:true});return {first:String(data.text||'').trim(),text:await recheckCounts(data,image)||String(data.text||'').trim()};}
  window.atlasEngine={readQuestText,ready,read,locate,readQuests,readFrame,locateFrame,readQuestsFrame,reset:()=>{seen=null;lastMap=null;scaleMemory=[];}};
})();
