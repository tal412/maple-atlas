/* Look's recognition engine: loads Look's files (the phone's own cache first, see prefetch),
 * runs the detector (src/look-detector.js) and the namer (src/look-namer.js) and names what
 * they find (src/look.js). It runs in a background worker (src/look-worker.js), so the page
 * stays responsive and can show progress; the page falls back to running it itself.
 *
 * create({look, catalogUrl, base}) -> {prefetch(onProgress), analyze(shot, region, onProgress)}
 * shot: {image: ImageData, lines, map: {id, name, monsters: [{id, name}], npcs: [{id}]}, k?}
 * onProgress({stage: 'download'|'detector'|'naming'|'items', done, total, found}).
 * The result is plain data (it crosses from the worker): found, players, player, k, method,
 * mapId, drops (this map's drop rows), summary (each thing once, numbered).
 */
(function(scope){
  const CACHE='maple-atlas-look';
  const canvas=(w,h)=>typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(w,h):Object.assign(document.createElement('canvas'),{width:w,height:h});
  function create({look,catalogUrl,base=scope.location?.href}={}){
    const abs=p=>new URL(p,base).href,file=name=>abs((look?.base||'./assets/look/')+name);
    const RUNTIME=abs('./vendor/ort/ort-wasm-simd-threaded.wasm');
    // One loader for Look's files: the phone's own cache, else the site (and then kept).
    async function lookFile(url){
      let cache=null;
      try{cache=await caches.open(CACHE);const hit=await cache.match(url);if(hit)return hit;}catch(_){}
      const r=await fetch(url,{credentials:'same-origin'});if(!r.ok)throw Error('Could not load '+url.split('/').pop()+'.');
      try{await cache?.put(url,r.clone());}catch(_){}
      return r;
    }
    // Every Look file into the phone's cache (each once), then the ones no longer listed dropped.
    let fetched=null,state={done:0,total:0};
    function prefetch(onProgress){
      if(!look?.files?.length)return Promise.resolve(false);
      fetched??=(async()=>{
        try{await scope.navigator?.storage?.persist?.();}catch(_){}
        const wanted=[...look.files.map(file),RUNTIME];
        state={done:0,total:wanted.length};
        for(const url of wanted){await lookFile(url).catch(()=>null);state={done:state.done+1,total:wanted.length};onProgress?.(state);}
        try{const c=await caches.open(CACHE),keep=new Set(wanted);for(const req of await c.keys())if(!keep.has(req.url))await c.delete(req);}catch(_){}
        return true;
      })().catch(()=>{fetched=null;return false;});
      return fetched;
    }

    // ---- Data: the catalog (names), the reference set, items, drops ----
    let catalog=null,names=null;
    async function loadCatalog(){
      if(catalog)return catalog;
      const r=await fetch(abs(catalogUrl));if(!r.ok)throw Error('The database did not load.');
      const data=await r.json();catalog={by:new Map((data.entities||[]).map(e=>[e.type+':'+e.id,e]))};
      names=MapleLook.nameIndex((data.entities||[]).filter(e=>['npc','monster','item','quest'].includes(e.type)));
      return catalog;
    }
    const nameOf=(type,id)=>catalog?.by.get(type+':'+id)?.name||String(id);
    const json=name=>lookFile(file(name)).then(r=>r.json());
    async function pixels(name){
      const b=await createImageBitmap(await lookFile(file(name)).then(r=>r.blob())),c=canvas(b.width,b.height),x=c.getContext('2d',{willReadFrequently:true});
      x.drawImage(b,0,0);b.close?.();return x.getImageData(0,0,c.width,c.height);
    }
    // A packed set of pictures (index + sheets) -> [{...entry, image}].
    async function sheet(name){
      const index=await json(name),sheets=await Promise.all(index.sheets.map(pixels));
      return index.sprites.map(s=>({...s,image:crop(sheets[s.s],s.x,s.y,s.w,s.h)}));
    }
    function crop(img,x0,y0,w,h){
      const data=new Uint8ClampedArray(w*h*4);
      for(let y=0;y<h;y++)data.set(img.data.subarray(((y0+y)*img.width+x0)*4,((y0+y)*img.width+x0+w)*4),y*w*4);
      return {width:w,height:h,data};
    }
    const once=f=>{let p=null;return ()=>(p??=f().catch(e=>{p=null;throw e;}));};
    const loadAtlas=once(async()=>{await loadCatalog();return (await sheet(look.atlas)).map(s=>({type:s.t,id:String(s.id),name:s.t==='pet'?nameOf('item',s.id):nameOf(s.t,s.id),image:s.image}));});
    const loadIcons=once(async()=>new Map((await sheet(look.icons)).map(s=>[String(s.id),s.image])));
    const loadRaw=once(async()=>new Map((await sheet(look.raw)).map(s=>[String(s.id),s.image])));
    const loadThumbs=once(async()=>{const meta=await json(look.thumbs);return {...meta,sheet:await pixels(meta.image)};});
    // What each monster drops: {monster: [[item name, item id, rate %]]}.
    const loadDrops=once(()=>json(look.drops));
    // What can be on this map: its monsters (every frame), its NPCs, and its monsters' drops.
    const mapSets=new Map();
    function spritesFor(m){
      if(!m)return Promise.resolve(Object.assign([],{drops:[]}));
      if(!mapSets.has(m.id))mapSets.set(m.id,(async()=>{
        const [atlas,drops,raw,icons]=await Promise.all([loadAtlas(),loadDrops(),loadRaw(),loadIcons()]);
        const ids=new Set([...(m.monsters||[]).map(x=>'monster:'+x.id),...(m.npcs||[]).map(x=>'npc:'+x.id)]);
        const list=atlas.filter(s=>ids.has(s.type+':'+s.id));
        const rows=(m.monsters||[]).flatMap(x=>(drops[x.name]||[]).map(([item,id,rate])=>({monster:x.name,item,id,rate})));
        for(const id of new Set(rows.map(r=>r.id).filter(Boolean))){const image=raw.get(String(id))||icons.get(String(id));if(image)list.push({type:'item',id:String(id),name:nameOf('item',id),image});}
        list.drops=rows;
        return list;
      })().catch(e=>{mapSets.delete(m.id);throw e;}));
      return mapSets.get(m.id);
    }

    // ---- Recognition ----
    // The game's scale in the screenshot: the minimap title strip is 45 game px tall, measured
    // in the top-left corner, where the game keeps the minimap (as the apps read it).
    function scaleOf(image){
      try{
        const w=Math.round(image.width*.45),h=Math.round(image.height*.76),data=new Uint8ClampedArray(w*h*4);
        for(let y=0;y<h;y++)data.set(image.data.subarray(y*image.width*4,y*image.width*4+w*4),y*w*4);
        const band=MapleMinimapPosition.findTitleBand({width:w,height:h,data},{frameHeight:image.height});
        const k=band?band.h/45:0,guess=image.width/MapleLook.GAME_WIDTH;
        if(k>guess*.6&&k<guess*1.6)return k;
      }catch(_){}
      return image.width/MapleLook.GAME_WIDTH;
    }
    const bytes=url=>()=>lookFile(url).then(r=>r.arrayBuffer());
    const detector=scope.MapleLookDetector&&look?.detector?MapleLookDetector.create({model:bytes(file(look.detector)),runtime:bytes(RUNTIME),minScore:.25,base}):null;
    const namer=scope.MapleLookNamer&&look?.namer?MapleLookNamer.create({model:bytes(file(look.namer)),runtime:bytes(RUNTIME),classes:look.namerClasses||[]}):null;
    // The item namer (every item's icon): its top answers become candidates, each checked
    // against the item's full icon (src/look.js).
    const itemClasses=once(()=>json(look.itemClasses));
    const itemNamerClasses=[];   // filled from look.itemClasses before the first use
    const itemNamer=scope.MapleLookNamer&&look?.itemNamer&&look?.itemClasses?MapleLookNamer.create({model:bytes(file(look.itemNamer)),runtime:bytes(RUNTIME),size:64,top:5,classes:itemNamerClasses}):null;
    const namerEntry=({cls,p})=>{
      if(cls[0]==='m'){const id=cls.slice(1);return {type:'monster',id,name:nameOf('monster',id),p};}
      if(cls[0]==='p'){const id=cls.slice(1);return {type:'item',id,name:nameOf('item',id),pet:true,p};}
      return {type:'other',p};
    };
    // The detector finds things; the map's sprites, the namer, the reference set, the item icons
    // and the name tags name them. Without the detector (an old browser) the map's sprites are
    // looked for directly. Detections are kept on the shot (a second look reuses them).
    async function analyze(s,region,onProgress){
      const say=(stage,done=0,total=0,found=[])=>onProgress?.({stage,done,total,found});
      await loadCatalog();
      s.k??=scaleOf(s.image);
      if(state.total&&state.done<state.total)say('download',state.done,state.total);
      const sprites=await spritesFor(s.map);
      let r=null;
      if(detector)try{
        if(!s.detections){say('detector');s.detections=await detector.detect(s.image);}
        const named=s.detections.filter(d=>(d.cls==='monster'||d.cls==='pet')&&!d.names);
        if(namer)try{let i=0;for(const d of named){say('naming',i++,named.length);d.names=(await namer.name(s.image,d.box)).map(namerEntry);}}
        catch(e){console.warn('Look namer:',e);}
        const things=s.detections.filter(d=>d.cls==='item'&&!d.items);
        if(itemNamer&&things.length)try{if(!itemNamerClasses.length)itemNamerClasses.push(...await itemClasses());let i=0;for(const d of things){say('naming',i++,things.length);d.items=(await itemNamer.name(s.image,d.box)).map(x=>({id:x.cls.slice(1),p:x.p}));}}
        catch(e){console.warn('Look item namer:',e);}
        const [allSprites,icons,th]=await Promise.all([loadAtlas(),loadIcons(),s.detections.some(d=>d.cls==='item')?loadThumbs():null]);
        const ground=await loadRaw().then(m=>new Set(m.keys())).catch(()=>null);
        let last=0;
        r=MapleLook.identify({image:s.image,detections:s.detections,lines:s.lines,region,k:s.k,names,sprites,allSprites,thumbs:th,groundItems:ground,
          itemIcon:id=>icons.get(String(id))||null,itemName:id=>nameOf('item',id),
          // At most every 120 ms: what is named so far, so the page shows it as it goes.
          onProgress:(done,total,found)=>{const t=Date.now();if(t-last>120){last=t;say('items',done,total,found.filter(f=>!f.ui).map(plain));}}});
        r.method='detector';
      }catch(e){console.warn('Look detector:',e);}
      r??={...MapleLook.analyze({image:s.image,lines:s.lines,region,k:s.k,names,sprites}),method:'sprites'};
      const summary=MapleLook.summary(r.found).map(plain);let n=0;for(const f of summary)if(!(f.via==='name'&&f.ui))f.n=++n;
      const found=r.found.map(plain);for(const f of found){const x=summary.find(y=>y.type===f.type&&y.id===f.id);f.n=x?.n;}
      return {found,players:(r.players||[]).map(p=>({name:p.name,box:p.box,you:p.you})),player:r.player,k:r.k??s.k,method:r.method,mapId:s.map?.id||null,drops:sprites.drops||[],summary};
    }
    // A found thing as plain data (no pictures), to cross to the page.
    const plain=f=>({type:f.type,id:String(f.id),name:f.name,box:f.box&&{x:f.box.x,y:f.box.y,w:f.box.w,h:f.box.h},via:f.via,score:f.score,ui:!!f.ui,pet:!!f.pet,count:f.count});
    return {prefetch,analyze,lookFile,loadCatalog,state:()=>state};
  }
  const api={create};
  scope.MapleLookEngine=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof self!=='undefined'?self:globalThis);
