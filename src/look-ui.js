/* The phone's Look view: a screenshot of the game from the computer, zoomed on your character,
 * with a box you move by dragging the picture (pinch or the corner handle to resize).
 * "Identify box" finds what is in the box, "Around me" what is on the whole screen; each thing
 * found is marked on the picture and listed, and opens its page in the search.
 *
 * It also answers looks marked on the computer (⌃⌥M / Ctrl+Alt+M on the game): the same
 * recognition on the marked box, sent back as a small card for the overlay.
 *
 * Recognition is src/look.js. Everything it compares against is a file on this site
 * (assets/look/, listed in DATA.look by scripts/build.py): the detector, every monster frame
 * and human NPC, every item's icon and thumbnail, the drops table. The first visit downloads
 * them all in the background (prefetch) into the phone's own cache, so a look never waits on
 * the network; a new release only downloads the files that changed (their names carry their
 * content's hash).
 */
(function(scope){
  const CACHE='maple-atlas-look';
  // One loader for Look's files: the phone's own cache, else the site (and then kept).
  async function lookFile(path){
    const url=new URL(path,location.href).href;let cache=null;
    try{cache=await caches.open(CACHE);const hit=await cache.match(url);if(hit)return hit;}catch(_){}
    const r=await fetch(url,{credentials:'same-origin'});if(!r.ok)throw Error('Could not load '+path+'.');
    try{await cache?.put(url,r.clone());}catch(_){}
    return r;
  }
  function create({root,maps,quests=[],look=null,catalogUrl,sourceCommit,request,answer,liveMap,openEntity,connected,esc,icon,icons=()=>{}}){
    const $=s=>root.querySelector(s),dialog=$('#mc-look-dialog'),stage=$('#mc-look-stage'),canvas=$('#mc-look-canvas'),box=$('#mc-look-box'),status=$('#mc-look-status'),results=$('#mc-look-results');
    const mapOf=id=>maps.find(m=>m.id===String(id));
    let shot=null,view={s:1,tx:0,ty:0},boxSize={w:.62,h:.5},found=[],shotPlayers=[],seq=0,waiting=null,busy=false;
    const base=look?.base||'./assets/look/',file=name=>base+name;
    const RUNTIME='./vendor/ort/ort-wasm-simd-threaded.wasm';

    // ---- Downloading once, in the background ----
    let fetched=null;
    // Every Look file into the phone's cache (each once), then the ones no longer listed are dropped.
    function prefetch(){
      if(!look?.files?.length)return Promise.resolve(false);
      fetched??=(async()=>{
        try{await navigator.storage?.persist?.();}catch(_){}
        const wanted=[...look.files.map(f=>new URL(file(f),location.href).href),new URL(RUNTIME,location.href).href];
        let done=0;
        for(const url of wanted){await lookFile(url).catch(()=>null);prefetchState={done:++done,total:wanted.length};}
        try{const cache=await caches.open(CACHE),keep=new Set(wanted);for(const req of await cache.keys())if(!keep.has(req.url))await cache.delete(req);}catch(_){}
        return true;
      })().catch(()=>{fetched=null;return false;});
      return fetched;
    }
    let prefetchState={done:0,total:0};

    // ---- Data: the catalog (names), the reference set, items, drops ----
    let catalog=null,names=null;
    async function loadCatalog(){
      if(catalog)return catalog;
      const r=await fetch(catalogUrl);if(!r.ok)throw Error('The database did not load.');
      const data=await r.json();catalog={entities:data.entities||[],commit:data.sourceCommit||sourceCommit};
      catalog.by=new Map(catalog.entities.map(e=>[e.type+':'+e.id,e]));
      names=MapleLook.nameIndex(catalog.entities.filter(e=>['npc','monster','item','quest'].includes(e.type)));
      return catalog;
    }
    const spritePath=e=>e?.image&&catalog?catalog.commit+'/data/'+e.image:'';
    const spriteURL=e=>e?.image&&catalog?'https://cdn.jsdelivr.net/gh/ohmi69/osms_datamine_dashboard@'+spritePath(e):null;
    const json=name=>lookFile(file(name)).then(r=>r.json());
    async function canvasOf(name){
      const b=await createImageBitmap(await lookFile(file(name)).then(r=>r.blob())),c=document.createElement('canvas');c.width=b.width;c.height=b.height;
      const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(b,0,0);b.close?.();return x;
    }
    // A packed set of pictures (index + sheets) -> [{...entry, image}].
    async function sheet(name){
      const index=await json(name),sheets=await Promise.all(index.sheets.map(canvasOf));
      return index.sprites.map(s=>({...s,image:sheets[s.s].getImageData(s.x,s.y,s.w,s.h)}));
    }
    const once=f=>{let p=null;return ()=>(p??=f().catch(e=>{p=null;throw e;}));};
    const loadAtlas=once(async()=>(await sheet(look.atlas)).map(s=>({type:s.t,id:String(s.id),name:catalog?.by.get(s.t+':'+s.id)?.name||String(s.id),image:s.image})));
    const loadIcons=once(async()=>new Map((await sheet(look.icons)).map(s=>[String(s.id),s.image])));
    const loadRaw=once(async()=>new Map((await sheet(look.raw)).map(s=>[String(s.id),s.image])));
    const loadThumbs=once(async()=>{const meta=await json(look.thumbs),x=await canvasOf(meta.image);return {...meta,sheet:x.getImageData(0,0,x.canvas.width,x.canvas.height)};});
    // What each monster drops: {monster: [[item name, item id, rate %]]}.
    const loadDrops=once(()=>json(look.drops));
    // What can be on this map: its monsters (every frame), its NPCs, and its monsters' drops.
    const mapSets=new Map();
    function spritesFor(mapId){
      if(!mapSets.has(mapId))mapSets.set(mapId,(async()=>{
        const m=mapOf(mapId);if(!m)return Object.assign([],{drops:[]});
        const [atlas,drops,raw,icons]=await Promise.all([loadAtlas(),loadDrops(),loadRaw(),loadIcons()]);
        const ids=new Set([...(m.monsters||[]).map(x=>'monster:'+x.id),...(m.npcs||[]).map(x=>'npc:'+x.id)]);
        const list=atlas.filter(s=>ids.has(s.type+':'+s.id));
        const rows=(m.monsters||[]).flatMap(x=>(drops[x.name]||[]).map(([item,id,rate])=>({monster:x.name,item,id,rate})));
        for(const id of new Set(rows.map(r=>r.id).filter(Boolean))){const image=raw.get(String(id))||icons.get(String(id));if(image)list.push({type:'item',id:String(id),name:catalog.by.get('item:'+id)?.name||String(id),image});}
        list.drops=rows;
        return list;
      })().catch(e=>{mapSets.delete(mapId);throw e;}));
      return mapSets.get(mapId);
    }

    // ---- Recognition ----
    // The game's scale in the screenshot: the minimap title strip is 45 game px tall.
    function scaleOf(image){
      // Measured in the top-left corner, where the game keeps the minimap (as the apps read it).
      try{
        const w=Math.round(image.width*.45),h=Math.round(image.height*.76),data=new Uint8ClampedArray(w*h*4);
        for(let y=0;y<h;y++)data.set(image.data.subarray(y*image.width*4,y*image.width*4+w*4),y*w*4);
        const band=MapleMinimapPosition.findTitleBand({width:w,height:h,data},{frameHeight:image.height});
        const k=band?band.h/45:0,guess=image.width/MapleLook.GAME_WIDTH;
        if(k>guess*.6&&k<guess*1.6)return k;
      }catch(_){}
      return image.width/MapleLook.GAME_WIDTH;
    }
    // The trained detector finds things; the map's sprites, the reference set, the item icons and
    // the name tags name them. When the detector cannot run (an old browser) the map's sprites are
    // looked for directly.
    const detector=scope.MapleLookDetector&&look?.detector?MapleLookDetector.create({
      model:()=>lookFile(file(look.detector)).then(r=>r.arrayBuffer()),runtime:()=>lookFile(RUNTIME).then(r=>r.arrayBuffer()),minScore:.25}):null;
    // The namer (src/look-namer.js): which monster or pet a box holds when templates cannot tell.
    const namer=scope.MapleLookNamer&&look?.namer?MapleLookNamer.create({
      model:()=>lookFile(file(look.namer)).then(r=>r.arrayBuffer()),runtime:()=>lookFile(RUNTIME).then(r=>r.arrayBuffer()),classes:look.namerClasses||[]}):null;
    const namerEntry=({cls,p})=>{
      if(cls[0]==='m'){const id=cls.slice(1);return {type:'monster',id,name:catalog?.by.get('monster:'+id)?.name||id,p};}
      if(cls[0]==='p'){const id=cls.slice(1);return {type:'item',id,name:catalog?.by.get('item:'+id)?.name||id,pet:true,p};}
      return {type:'other',p};
    };
    async function analyze(s,region,onProgress){
      await loadCatalog();
      const mapId=s.map||liveMap();
      if(prefetchState.total&&prefetchState.done<prefetchState.total)onProgress?.('download');
      const sprites=mapId?await spritesFor(mapId):[];
      let r=null;
      if(detector)try{
        if(!s.detections){onProgress?.('detector');s.detections=await detector.detect(s.image);}
        if(namer)try{for(const d of s.detections)if((d.cls==='monster'||d.cls==='pet')&&!d.names)d.names=(await namer.name(s.image,d.box)).map(namerEntry);}
        catch(e){console.warn('Look namer:',e);}
        const [allSprites,icons,th]=await Promise.all([loadAtlas(),loadIcons(),s.detections.some(d=>d.cls==='item')?loadThumbs():null]);
        const ground=await loadRaw().then(m=>new Set(m.keys())).catch(()=>null);
        r=MapleLook.identify({image:s.image,detections:s.detections,lines:s.lines,region,k:s.k,names,sprites,allSprites,thumbs:th,groundItems:ground,
          itemIcon:id=>icons.get(String(id))||null,itemName:id=>catalog.by.get('item:'+id)?.name||id});
        r.method='detector';
      }catch(e){console.warn('Look detector:',e);}
      r??={...MapleLook.analyze({image:s.image,lines:s.lines,region,k:s.k,names,sprites}),method:'sprites'};
      const summary=MapleLook.summary(r.found);let n=0;for(const f of summary)if(!(f.via==='name'&&f.ui))f.n=++n;
      // Each thing on the picture carries its row's number.
      for(const f of r.found){const s=summary.find(x=>x.type===f.type&&x.id===f.id);f.n=s?.n;}
      return {...r,mapId,drops:sprites.drops||[],summary};
    }
    // One line or two about a thing found, for the list and the overlay card.
    function describe(f,ctx){
      const e=catalog.by.get(f.type+':'+f.id)||{},here=mapOf(ctx.mapId);
      const pct=v=>v==null?'':v>=10?Math.round(v)+'%':v>=1?v.toFixed(1)+'%':v.toFixed(2)+'%';
      if(f.type==='monster'){
        const spawns=(here?.monsters||[]).find(x=>String(x.id)===f.id)?.spawns;
        const top=ctx.drops.filter(d=>d.monster===f.name&&d.rate!=null).sort((a,b)=>b.rate-a.rate).slice(0,3);
        return {detail:['Lv '+(e.level??'?'),e.hp!=null?e.hp.toLocaleString()+' HP':'',e.exp!=null?e.exp+' EXP':'',spawns?spawns+' spawns here':''].filter(Boolean).join(' · '),
          extra:top.length?'Drops '+top.map(d=>d.item+' '+pct(d.rate)).join(', '):''};
      }
      if(f.type==='npc'){
        const given=quests.filter(q=>q.npc===f.name).map(q=>q.name).slice(0,2);
        return {detail:'NPC'+(here&&(here.npcs||[]).some(x=>String(x.id)===f.id)?' on '+here.name:''),extra:given.length?'Quests: '+given.join(', '):''};
      }
      if(f.type==='item'&&e.category==='Pet'){
        const price=e.cashShop?.price;
        return {detail:['Pet',price?price.toLocaleString()+' NX in the Cash Shop':''].filter(Boolean).join(' · '),extra:String(e.description||'').split(/(?<=[.!?])\s/)[0]||''};
      }
      if(f.type==='item'){
        const by=ctx.drops.filter(d=>d.item===f.name&&d.rate!=null).sort((a,b)=>b.rate-a.rate).slice(0,2);
        return {detail:[e.category||'Item',e.sell?'sells for '+e.sell.toLocaleString()+' mesos':''].filter(Boolean).join(' · '),extra:by.length?'Dropped here by '+by.map(d=>d.monster+' '+pct(d.rate)).join(', '):''};
      }
      return {detail:{quest:'Quest',map:'Map'}[f.type]||'',extra:''};
    }
    function card(r,title){
      const items=r.summary.slice(0,6).map(f=>{const d=describe(f,r);return {t:f.type,n:f.name,i:spritePath(catalog.by.get(f.type+':'+f.id)),d:d.detail,e:d.extra,c:f.count};});
      const m=mapOf(r.mapId);
      return {title,note:items.length?(m?'On '+m.name:''):'Nothing from the database found here'+(m?' on '+m.name:'')+'.',items};
    }

    // ---- The screenshot from the computer ----
    async function decode(value){
      const bytes=Uint8Array.from(atob(value.jpeg),c=>c.charCodeAt(0));
      const bmp=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'})),c=document.createElement('canvas');
      c.width=bmp.width;c.height=bmp.height;const x=c.getContext('2d');x.drawImage(bmp,0,0);
      const image=x.getImageData(0,0,c.width,c.height),k=scaleOf(image);
      return {bitmap:bmp,image,k,lines:value.lines||[],map:value.map,player:MapleLook.findPlayer(value.lines||[],{w:image.width,h:image.height})};
    }
    async function received(value){
      if(value.req.startsWith('c')){void markedOnComputer(value);return;}
      if(!waiting||value.req!==waiting)return;
      waiting=null;
      if(value.error){say(value.error);return;}
      try{shot=await decode(value);}catch(_){say('The screenshot could not be read.');return;}
      found=[];shotPlayers=[];results.innerHTML='';box.hidden=false;centre();draw();
      void identify();
    }
    // A look marked on the computer: recognize the box, answer with a card.
    async function markedOnComputer(value){
      if(value.error)return;
      try{
        const s=await decode(value),m=value.mark||{x:0,y:0,w:1,h:1},whole=m.w>.98&&m.h>.98;
        const region=whole?null:{x:m.x*s.image.width,y:m.y*s.image.height,w:m.w*s.image.width,h:m.h*s.image.height};
        const r=await analyze(s,region);
        const reply=card(r,whole?'Around you':'In the box');if(scope.MapleLookDebug)scope.MapleLookDebug.lastCard=reply;answer(value.req,reply);
        if(dialog.open){shot=s;found=r.found;shotPlayers=r.players||[];box.hidden=!region;if(region){centre(region);draw();}else fitAll();list(r,(region?'In the box':'On the whole screen')+' (marked on the computer)');say((whole?'Around you':'In the box')+' (marked on the computer)');}
      }catch(e){answer(value.req,{title:'Look',note:'Could not look: '+String(e.message||e).slice(0,60),items:[]});}
    }

    // ---- View: pan, pinch, the box ----
    function size(){const r=stage.getBoundingClientRect(),d=devicePixelRatio||1,w=Math.round(r.width*d),h=Math.round(r.height*d);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;draw();}return r;}
    function boxRect(){const r=stage.getBoundingClientRect(),w=r.width*boxSize.w,h=r.height*boxSize.h;return {x:(r.width-w)/2,y:(r.height-h)/2,w,h};}
    function placeBox(){const b=boxRect();Object.assign(box.style,{left:b.x+'px',top:b.y+'px',width:b.w+'px',height:b.h+'px'});}
    // Your character in the middle with about 560 game px of the world around it (or a region).
    function centre(region){
      if(!shot)return;const r=size(),p=region?{x:region.x+region.w/2,y:region.y+region.h/2}:shot.player,span=region?Math.max(region.w/boxSize.w,region.h*r.width/r.height/boxSize.h):560*shot.k;
      view.s=Math.max(r.width/shot.image.width,Math.min(8,r.width/span));view.tx=r.width/2-p.x*view.s;view.ty=r.height/2-p.y*view.s;clamp();placeBox();
    }
    // The whole screenshot in view (after Around me, so every mark shows).
    function fitAll(){const r=size();view.s=Math.min(r.width/shot.image.width,r.height/shot.image.height);view.tx=(r.width-shot.image.width*view.s)/2;view.ty=(r.height-shot.image.height*view.s)/2;draw();}
    function clamp(){const r=stage.getBoundingClientRect(),w=shot.image.width*view.s,h=shot.image.height*view.s;view.tx=Math.min(r.width*.5,Math.max(r.width*.5-w,view.tx));view.ty=Math.min(r.height*.5,Math.max(r.height*.5-h,view.ty));}
    const colors={monster:'#ff6b6b',npc:'#4dabf7',item:'#ffd43b',quest:'#a9e34b'};
    function draw(){
      if(!shot)return;const d=devicePixelRatio||1,x=canvas.getContext('2d');
      x.setTransform(1,0,0,1,0,0);x.fillStyle='#111';x.fillRect(0,0,canvas.width,canvas.height);
      x.setTransform(view.s*d,0,0,view.s*d,view.tx*d,view.ty*d);x.imageSmoothingEnabled=view.s<2;x.drawImage(shot.bitmap,0,0);
      x.lineWidth=2.5/view.s;x.font=(13/view.s)+'px system-ui, sans-serif';
      const tag=(b,label,color,fill='rgba(0,0,0,.72)')=>{const tw=x.measureText(label).width+8/view.s;x.fillStyle=fill;x.fillRect(b.x,b.y-18/view.s,tw,17/view.s);x.fillStyle=color;x.fillText(label,b.x+4/view.s,b.y-5/view.s);};
      for(const f of found){if(f.via==='name'&&f.ui)continue;x.strokeStyle=colors[f.type]||'#fff';x.strokeRect(f.box.x,f.box.y,f.box.w,f.box.h);tag(f.box,(f.n?f.n+' · ':'')+f.name,'#fff');}
    }
    let pointers=new Map(),pinch=null,resizing=null;
    stage.addEventListener('pointerdown',e=>{if(!shot)return;if(box.hidden){box.hidden=false;placeBox();}stage.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(e.target.closest('.mc-look-handle'))resizing={x:e.clientX,y:e.clientY,w:boxSize.w,h:boxSize.h};
      if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),s:view.s,mx:(a.x+b.x)/2,my:(a.y+b.y)/2};}});
    stage.addEventListener('pointermove',e=>{
      const p=pointers.get(e.pointerId);if(!p||!shot)return;const r=stage.getBoundingClientRect();
      if(resizing){boxSize.w=Math.max(.15,Math.min(.95,resizing.w+(e.clientX-resizing.x)*2/r.width));boxSize.h=Math.max(.12,Math.min(.9,resizing.h+(e.clientY-resizing.y)*2/r.height));placeBox();p.x=e.clientX;p.y=e.clientY;return;}
      if(pointers.size===2&&pinch){p.x=e.clientX;p.y=e.clientY;const [a,b]=[...pointers.values()],dd=Math.hypot(a.x-b.x,a.y-b.y);zoomAt(pinch.s*dd/pinch.d,pinch.mx-r.left,pinch.my-r.top);return;}
      view.tx+=e.clientX-p.x;view.ty+=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;clamp();draw();});
    const up=e=>{pointers.delete(e.pointerId);if(pointers.size<2)pinch=null;if(!pointers.size)resizing=null;};
    stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',up);
    stage.addEventListener('wheel',e=>{if(!shot)return;e.preventDefault();const r=stage.getBoundingClientRect();zoomAt(view.s*Math.exp(-e.deltaY/400),e.clientX-r.left,e.clientY-r.top);},{passive:false});
    function zoomAt(s,mx,my){const r=stage.getBoundingClientRect(),min=r.width/shot.image.width*.9;s=Math.max(min,Math.min(8,s));const ix=(mx-view.tx)/view.s,iy=(my-view.ty)/view.s;view.s=s;view.tx=mx-ix*s;view.ty=my-iy*s;clamp();draw();}
    // The box in screenshot pixels.
    function regionOfBox(){const b=boxRect();return {x:(b.x-view.tx)/view.s,y:(b.y-view.ty)/view.s,w:b.w/view.s,h:b.h/view.s};}

    // ---- Results ----
    function say(text){status.textContent=text;}
    function list(r,heading=''){
      const m=mapOf(r.mapId),rows=r.summary.filter(f=>!(f.via==='name'&&f.ui)),ui=r.summary.filter(f=>f.via==='name'&&f.ui);
      const row=f=>{const e=catalog.by.get(f.type+':'+f.id),d=f.id==='?'?{detail:'Seen on the screen; not one of this map\'s '+(f.type==='item'?'drops':f.type==='npc'?'NPCs':'monsters'),extra:''}:describe(f,r),src=spriteURL(e);
        return '<button type="button" class="mc-look-row'+(f.id==='?'?' mc-look-unknown':'')+'" '+(f.id==='?'?'disabled ':'')+'data-type="'+esc(f.type)+'" data-name="'+esc(f.name)+'">'+(f.ui?'':'<span class="mc-look-num" style="--c:'+(colors[f.type]||'#999')+'">'+f.n+'</span>')+'<span class="mc-look-thumb" style="--c:'+(colors[f.type]||'#999')+'">'+(src?'<img src="'+esc(src)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':icon('search'))+'</span><span class="mc-look-text"><strong>'+esc(f.name)+(f.count>1?' ×'+f.count:'')+'</strong><small>'+esc(d.detail)+'</small>'+(d.extra?'<small class="mc-look-extra">'+esc(d.extra)+'</small>':'')+'</span>'+icon('chevron-right')+'</button>';};
      results.innerHTML=(heading?'<h3 class="mc-look-heading">'+esc(heading)+'</h3>':'')+(m?'<button type="button" class="mc-look-row mc-look-map" data-map="'+esc(m.id)+'"><span class="mc-look-thumb">'+icon('map')+'</span><span class="mc-look-text"><strong>'+esc(m.name)+'</strong><small>The map you are on'+(m.street?' · '+esc(m.street):'')+'</small></span>'+icon('chevron-right')+'</button>':'')
        +(rows.length?rows.map(row).join(''):'<p class="mc-look-empty">Nothing from the database found here. Move the box over a monster, an NPC or an item, or try Around me.</p>')

        +(ui.length?'<details class="mc-look-ui"><summary>Also in the game\'s windows ('+ui.length+')</summary>'+ui.map(row).join('')+'</details>':'');
      icons();
      results.querySelectorAll('[data-type]').forEach(b=>b.onclick=()=>openEntity(b.dataset.type,b.dataset.name));
      results.querySelectorAll('[data-map]').forEach(b=>b.onclick=()=>{dialog.close();openEntity('map',mapOf(b.dataset.map)?.name);});
    }
    async function run(region,label){
      if(!shot||busy)return;busy=true;$('#mc-look-identify').disabled=$('#mc-look-around').disabled=true;
      say(label+'…');
      try{
        const r=await analyze(shot,region,step=>say(step==='detector'?'Finding monsters, NPCs and items…':'Finishing the first download of Look\'s pictures ('+prefetchState.done+'/'+prefetchState.total+')…'));
        // Around me looks at the whole screen: the box is hidden until you move the picture again.
        found=r.found;shotPlayers=r.players||[];box.hidden=!region;if(!region)fitAll();else draw();list(r,region?'In the box':'On the whole screen');
        const n=r.summary.filter(f=>!(f.via==='name'&&f.ui)).length;
        say((region?'In the box: ':'On the whole screen: ')+(n?n+' found':'nothing from the database')+'.');
      }catch(e){say('Could not look: '+(e.message||e));}
      finally{busy=false;$('#mc-look-identify').disabled=$('#mc-look-around').disabled=false;}
    }
    const identify=()=>{if(box.hidden){box.hidden=false;placeBox();}return run(regionOfBox(),'Looking in the box');};
    const around=()=>run(null,'Looking around you');

    function take(){
      if(!connected()){say('Connect Maple Atlas Companion on your computer first: Look uses its screenshot of the game.');return;}
      seq++;waiting='p'+seq.toString(36)+Date.now().toString(36).slice(-4);
      if(!request(waiting)){waiting=null;say('The computer is not connected.');return;}
      say('Taking a screenshot of the game…');
      const mine=waiting;setTimeout(()=>{if(waiting===mine){waiting=null;say('No screenshot came from the computer. Is the game open there?');}},20000);
    }
    function open(){
      if(!dialog.open)dialog.showModal();
      requestAnimationFrame(()=>{size();placeBox();draw();});
      void loadCatalog().catch(()=>{});
      take();
    }
    $('#mc-look-identify').onclick=identify;$('#mc-look-around').onclick=around;$('#mc-look-retake').onclick=take;
    addEventListener('resize',()=>{if(dialog.open&&shot){size();placeBox();clamp();draw();}});
    // ?lookdebug: show a given screenshot as if the computer had sent it (for checking the view).
    if(/[?&]lookdebug\b/.test(location.search))scope.MapleLookDebug={show:value=>{if(!dialog.open)dialog.showModal();requestAnimationFrame(()=>{size();placeBox();draw();});waiting=value.req;void received(value);}};
    return {open,received,prefetch};
  }
  scope.MapleLookUI={create};
})(globalThis);
