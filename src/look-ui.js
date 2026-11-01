/* The phone's Look view: a screenshot of the game from the computer, zoomed on your character,
 * with a box you move by dragging the picture (pinch or the corner handle to resize).
 *
 * As soon as a screenshot arrives, the whole screen is recognized once in the background
 * (src/look-worker.js runs src/look-engine.js off the page's thread), with its progress shown
 * and what is named listed as it goes. "Identify box" lists what is in the box, and moving the
 * box updates the list at once (it only filters); "Around me" lists the whole screen. Each thing
 * is outlined on the picture in its row's colour (no text over the game); tapping a row or an
 * outline highlights where it is, and the arrow opens its page in the search.
 *
 * It also answers looks marked on the computer (⌃⌥M / Ctrl+Alt+M on the game): the same
 * recognition on the marked box, its progress shown on the computer's card, then a small card.
 *
 * Everything Look compares against is a file on this site (assets/look/, listed in DATA.look by
 * scripts/build.py), downloaded once in the background into the phone's own cache (prefetch).
 */
(function(scope){
  // The worker's code, put here by scripts/build.py (the page is one file).
  const WORKER_SOURCE=__LOOK_WORKER_SOURCE__;
  function create({root,maps,quests=[],look=null,catalogUrl,sourceCommit,request,answer,progress=()=>{},liveMap,openEntity,connected,esc,icon,icons=()=>{}}){
    const $=s=>root.querySelector(s),dialog=$('#mc-look-dialog'),stage=$('#mc-look-stage'),canvas=$('#mc-look-canvas'),box=$('#mc-look-box'),status=$('#mc-look-status'),results=$('#mc-look-results'),bar=$('#mc-look-progress');
    const mapOf=id=>maps.find(m=>m.id===String(id));
    const engine=scope.MapleLookEngine?MapleLookEngine.create({look,catalogUrl}):null;

    // ---- Recognition, in the worker (or in the page when workers are not available) ----
    let worker=null,jobs=new Map(),jobSeq=0,shotSeq=0;
    function startWorker(){
      if(worker!==null||typeof Worker==='undefined'||!WORKER_SOURCE)return worker;
      try{
        const url=URL.createObjectURL(new Blob([WORKER_SOURCE],{type:'text/javascript'}));
        worker=new Worker(url);
        worker.onmessage=e=>{const m=e.data,j=jobs.get(m.id);if(!j)return;if(m.type==='progress')j.onProgress?.(m);else{jobs.delete(m.id);m.type==='done'?j.resolve(m.result):j.reject(Error(m.message));}};
        worker.onerror=e=>{console.warn('Look worker:',e.message);for(const j of jobs.values())j.reject(Error('Look stopped: '+(e.message||'worker error')));jobs.clear();worker=false;};
        worker.postMessage({type:'init',look,catalogUrl:new URL(catalogUrl,location.href).href,base:location.href});
      }catch(e){console.warn('Look worker:',e);worker=false;}
      return worker;
    }
    // What the worker needs of a map: its monsters and NPCs.
    const mapInfo=id=>{const m=mapOf(id);return m?{id:m.id,name:m.name,monsters:(m.monsters||[]).map(x=>({id:String(x.id),name:x.name})),npcs:(m.npcs||[]).map(x=>({id:String(x.id)}))}:null;};
    // Hand a screenshot to the worker (its pixels move there); returns its id.
    function sendShot(s){
      const id=++shotSeq,w=startWorker(),map=mapInfo(s.map||liveMap());
      if(w){const buf=s.image.data.buffer;w.postMessage({type:'shot',shot:id,width:s.image.width,height:s.image.height,buffer:buf,lines:s.lines,map},[buf]);}
      else s.local={image:s.image,lines:s.lines,map};
      s.id=id;return id;
    }
    function analyze(s,region,onProgress){
      const w=startWorker();
      if(w)return new Promise((resolve,reject)=>{const id=++jobSeq;jobs.set(id,{resolve,reject,onProgress});w.postMessage({type:'analyze',id,shot:s.id,region});});
      if(!engine)return Promise.reject(Error('Look is not available in this browser.'));
      return engine.analyze(s.local,region,onProgress);
    }
    function prefetch(){return engine?engine.prefetch():Promise.resolve(false);}

    // ---- The catalog, for the list ----
    let catalog=null;
    async function loadCatalog(){
      if(catalog)return catalog;
      const r=await fetch(catalogUrl);if(!r.ok)throw Error('The database did not load.');
      const data=await r.json();catalog={entities:data.entities||[],commit:data.sourceCommit||sourceCommit};
      catalog.by=new Map(catalog.entities.map(e=>[e.type+':'+e.id,e]));
      return catalog;
    }
    const spritePath=e=>e?.image&&catalog?catalog.commit+'/data/'+e.image:'';
    const spriteURL=e=>e?.image&&catalog?'https://cdn.jsdelivr.net/gh/ohmi69/osms_datamine_dashboard@'+spritePath(e):null;
    // One line or two about a thing found, for the list and the overlay card.
    function describe(f,ctx){
      const e=catalog.by.get(f.type+':'+f.id)||{},here=mapOf(ctx.mapId);
      const pct=v=>v==null?'':v>=10?Math.round(v)+'%':v>=1?v.toFixed(1)+'%':v.toFixed(2)+'%';
      if(f.type==='monster'){
        const spawns=(here?.monsters||[]).find(x=>String(x.id)===f.id)?.spawns;
        const top=(ctx.drops||[]).filter(d=>d.monster===f.name&&d.rate!=null).sort((a,b)=>b.rate-a.rate).slice(0,3);
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
        const by=(ctx.drops||[]).filter(d=>d.item===f.name&&d.rate!=null).sort((a,b)=>b.rate-a.rate).slice(0,2);
        return {detail:[e.category||'Item',e.sell?'sells for '+e.sell.toLocaleString()+' mesos':''].filter(Boolean).join(' · '),extra:by.length?'Dropped here by '+by.map(d=>d.monster+' '+pct(d.rate)).join(', '):''};
      }
      return {detail:{quest:'Quest',map:'Map'}[f.type]||'',extra:''};
    }
    function card(r,title){
      const items=r.summary.filter(f=>!(f.via==='name'&&f.ui)).slice(0,6).map(f=>{const d=describe(f,r);return {t:f.type,n:f.name,i:spritePath(catalog.by.get(f.type+':'+f.id)),d:d.detail,e:d.extra,c:f.count};});
      const m=mapOf(r.mapId);
      return {title,note:items.length?(m?'On '+m.name:''):'Nothing from the database found here'+(m?' on '+m.name:'')+'.',items};
    }
    // What a stage of the work is called, for the phone and the computer's card.
    function stageText(p){
      if(p.stage==='download')return 'Finishing the first download of Look ('+p.done+'/'+p.total+')…';
      if(p.stage==='detector')return 'Finding monsters, NPCs and items…';
      if(p.stage==='naming')return 'Naming '+(p.done+1)+' of '+p.total+'…';
      if(p.stage==='items')return 'Checking '+(p.done+1)+' of '+p.total+'…';
      return 'Looking…';
    }

    // ---- The screenshot from the computer ----
    let shot=null,view={s:1,tx:0,ty:0},boxSize={w:.62,h:.5},mode='box',all=null,partial=[],busy=false,selected=null,seq=0,waiting=null;
    async function decode(value){
      const bytes=Uint8Array.from(atob(value.jpeg),c=>c.charCodeAt(0));
      const bmp=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'})),c=document.createElement('canvas');
      c.width=bmp.width;c.height=bmp.height;const x=c.getContext('2d');x.drawImage(bmp,0,0);
      const image=x.getImageData(0,0,c.width,c.height);
      return {bitmap:bmp,image,w:image.width,h:image.height,lines:value.lines||[],map:value.map,player:MapleLook.findPlayer(value.lines||[],{w:image.width,h:image.height})};
    }
    async function received(value){
      if(value.req.startsWith('c')){void markedOnComputer(value);return;}
      if(!waiting||value.req!==waiting)return;
      waiting=null;
      if(value.error){bar.hidden=true;say(value.error);return;}
      let s;try{s=await decode(value);}catch(_){bar.hidden=true;say('The screenshot could not be read.');return;}
      shot=s;all=null;partial=[];selected=null;mode='box';results.innerHTML='';box.hidden=false;frame();centre();draw();
      sendShot(s);void recognize(s);
    }
    // The whole screen, once per screenshot, in the background; the list fills in as it goes.
    async function recognize(s){
      busy=true;setBusy();say('Looking…');void loadCatalog().catch(()=>{});
      try{
        const r=await analyze(s,null,p=>{if(shot!==s)return;showProgress(p);if(p.found?.length){partial=p.found;refresh();}});
        if(shot!==s)return;
        await loadCatalog().catch(()=>{});all=r;partial=[];
      }catch(e){if(shot===s)say('Could not look: '+(e.message||e));}
      finally{if(shot===s){busy=false;setBusy();showProgress(null);refresh(true);}}
    }
    // A look marked on the computer: recognize the box, its progress on the computer's card.
    async function markedOnComputer(value){
      if(value.error)return;
      try{
        const s=await decode(value),m=value.mark||{x:0,y:0,w:1,h:1},whole=m.w>.98&&m.h>.98;
        const region=whole?null:{x:m.x*s.w,y:m.y*s.h,w:m.w*s.w,h:m.h*s.h};
        sendShot(s);let last=0;
        progress(value.req,'Looking…');
        const r=await analyze(s,region,p=>{const t=Date.now();if(t-last>250){last=t;progress(value.req,stageText(p));}});
        await loadCatalog();
        const reply=card(r,whole?'Around you':'In the box');if(scope.MapleLookDebug)scope.MapleLookDebug.lastCard=reply;answer(value.req,reply);
        if(dialog.open){shot=s;all=r;partial=[];selected=null;mode=region?'box':'around';box.hidden=!region;frame();if(region)centre(region);else fitAll();setBusy();refresh(true);}
      }catch(e){answer(value.req,{title:'Look',note:'Could not look: '+String(e.message||e).slice(0,60),items:[]});}
    }

    // ---- View: pan, pinch, the box ----
    function size(){const r=stage.getBoundingClientRect(),d=devicePixelRatio||1,w=Math.round(r.width*d),h=Math.round(r.height*d);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;draw();}return r;}
    function boxRect(){const r=stage.getBoundingClientRect(),w=r.width*boxSize.w,h=r.height*boxSize.h;return {x:(r.width-w)/2,y:(r.height-h)/2,w,h};}
    function placeBox(){const b=boxRect();Object.assign(box.style,{left:b.x+'px',top:b.y+'px',width:b.w+'px',height:b.h+'px'});}
    // Your character in the middle with about 560 game px of the world around it (or a region).
    function centre(region){
      if(!shot)return;const r=size(),k=shot.w/1366,p=region?{x:region.x+region.w/2,y:region.y+region.h/2}:shot.player,span=region?Math.max(region.w/boxSize.w,region.h*r.width/r.height/boxSize.h):560*k;
      view.s=Math.max(r.width/shot.w,Math.min(8,r.width/span));view.tx=r.width/2-p.x*view.s;view.ty=r.height/2-p.y*view.s;clamp();placeBox();
    }
    // The whole screenshot in view (Around me, so every outline shows).
    function fitAll(){const r=size();view.s=Math.min(r.width/shot.w,r.height/shot.h);view.tx=(r.width-shot.w*view.s)/2;view.ty=(r.height-shot.h*view.s)/2;draw();}
    function clamp(){const r=stage.getBoundingClientRect(),w=shot.w*view.s,h=shot.h*view.s;view.tx=Math.min(r.width*.5,Math.max(r.width*.5-w,view.tx));view.ty=Math.min(r.height*.5,Math.max(r.height*.5-h,view.ty));}
    // The box in screenshot pixels.
    function regionOfBox(){const b=boxRect();return {x:(b.x-view.tx)/view.s,y:(b.y-view.ty)/view.s,w:b.w/view.s,h:b.h/view.s};}
    // A colour per row of the list; the same colour outlines it on the picture.
    const PALETTE=['#ff6b6b','#ffd43b','#69db7c','#4dabf7','#da77f2','#ff922b','#3bc9db','#f783ac','#a9e34b','#9775fa','#ffa94d','#63e6be'];
    let rows=[];   // the list as shown: [{key, color, things: [found]}]
    const keyOf=f=>f.type+':'+f.id;
    function draw(){
      if(!shot)return;const d=devicePixelRatio||1,x=canvas.getContext('2d');
      x.setTransform(1,0,0,1,0,0);x.fillStyle='#111';x.fillRect(0,0,canvas.width,canvas.height);
      x.setTransform(view.s*d,0,0,view.s*d,view.tx*d,view.ty*d);x.imageSmoothingEnabled=view.s<2;x.drawImage(shot.bitmap,0,0);
      const pick=selected&&rows.find(r=>r.key===selected);
      // With a row picked, the rest of the picture is darkened around its outlines.
      if(pick){
        x.save();x.fillStyle='rgba(0,0,0,.55)';x.beginPath();x.rect(0,0,shot.w,shot.h);
        for(const f of pick.things){const p=6/view.s;x.rect(f.box.x+f.box.w+p,f.box.y-p,-(f.box.w+2*p),f.box.h+2*p);}
        x.fill('evenodd');x.restore();
      }
      for(const r of rows)for(const f of r.things){
        const on=pick===r;if(pick&&!on)continue;
        x.strokeStyle=r.color;x.lineWidth=(on?4:2.5)/view.s;
        if(on){x.shadowColor=r.color;x.shadowBlur=12;}
        const p=(on?5:2)/view.s;x.beginPath();if(x.roundRect)x.roundRect(f.box.x-p,f.box.y-p,f.box.w+2*p,f.box.h+2*p,6/view.s);else x.rect(f.box.x-p,f.box.y-p,f.box.w+2*p,f.box.h+2*p);x.stroke();x.shadowBlur=0;
      }
      if(busy)scan(x);
    }
    // While looking: a soft band sweeping down the picture.
    let sweepFrame=0;
    function scan(x){
      const y=((performance.now()/1600)%1)*shot.h,g=x.createLinearGradient(0,y-60,0,y+8);
      g.addColorStop(0,'rgba(77,171,247,0)');g.addColorStop(1,'rgba(77,171,247,.35)');
      x.fillStyle=g;x.fillRect(0,y-60,shot.w,68);
    }
    function animate(){cancelAnimationFrame(sweepFrame);if(!busy||!dialog.open)return;draw();sweepFrame=requestAnimationFrame(animate);}
    let pointers=new Map(),pinch=null,resizing=null,tap=null;
    stage.addEventListener('pointerdown',e=>{if(!shot)return;stage.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      tap=pointers.size===1?{x:e.clientX,y:e.clientY,t:performance.now()}:null;
      if(e.target.closest('.mc-look-handle'))resizing={x:e.clientX,y:e.clientY,w:boxSize.w,h:boxSize.h};
      if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),s:view.s,mx:(a.x+b.x)/2,my:(a.y+b.y)/2};}});
    stage.addEventListener('pointermove',e=>{
      const p=pointers.get(e.pointerId);if(!p||!shot)return;const r=stage.getBoundingClientRect();
      if(tap&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)>8)tap=null;
      if(tap)return;
      // Moving the picture after Around me goes back to the box.
      if(mode==='around'){mode='box';box.hidden=false;frame();placeBox();setBusy();}
      if(resizing){boxSize.w=Math.max(.15,Math.min(.95,resizing.w+(e.clientX-resizing.x)*2/r.width));boxSize.h=Math.max(.12,Math.min(.9,resizing.h+(e.clientY-resizing.y)*2/r.height));placeBox();p.x=e.clientX;p.y=e.clientY;moved();return;}
      if(pointers.size===2&&pinch){p.x=e.clientX;p.y=e.clientY;const [a,b]=[...pointers.values()],dd=Math.hypot(a.x-b.x,a.y-b.y);zoomAt(pinch.s*dd/pinch.d,pinch.mx-r.left,pinch.my-r.top);return;}
      view.tx+=e.clientX-p.x;view.ty+=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;clamp();draw();moved();});
    const up=e=>{
      // A tap on an outline picks its row (a tap elsewhere clears it).
      if(tap&&pointers.size===1&&!resizing&&performance.now()-tap.t<400){const r=stage.getBoundingClientRect(),ix=(e.clientX-r.left-view.tx)/view.s,iy=(e.clientY-r.top-view.ty)/view.s;
        const hit=rows.find(row=>row.things.some(f=>ix>=f.box.x-6&&ix<=f.box.x+f.box.w+6&&iy>=f.box.y-6&&iy<=f.box.y+f.box.h+6));select(hit?.key||null,true);}
      pointers.delete(e.pointerId);if(pointers.size<2)pinch=null;if(!pointers.size){resizing=null;tap=null;}};
    stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',e=>{tap=null;up(e);});
    stage.addEventListener('wheel',e=>{if(!shot)return;e.preventDefault();const r=stage.getBoundingClientRect();zoomAt(view.s*Math.exp(-e.deltaY/400),e.clientX-r.left,e.clientY-r.top);},{passive:false});
    function zoomAt(s,mx,my){const r=stage.getBoundingClientRect(),min=r.width/shot.w*.9;s=Math.max(min,Math.min(8,s));const ix=(mx-view.tx)/view.s,iy=(my-view.ty)/view.s;view.s=s;view.tx=mx-ix*s;view.ty=my-iy*s;clamp();draw();moved();}
    // The box moved: the list follows at once (once per frame).
    let movedFrame=0;function moved(){if(mode!=='box'||movedFrame)return;movedFrame=requestAnimationFrame(()=>{movedFrame=0;refresh();});}

    // ---- Results ----
    function say(text){status.textContent=text;}
    function setBusy(){
      for(const b of [$('#mc-look-identify'),$('#mc-look-around')])b.classList.toggle('mc-look-working',busy&&(b.id==='mc-look-around'?mode==='around':mode==='box'));
      $('#mc-look-identify').setAttribute('aria-pressed',String(mode==='box'));$('#mc-look-around').setAttribute('aria-pressed',String(mode==='around'));
      stage.classList.toggle('mc-look-busy',busy);if(busy)animate();else draw();
    }
    function showProgress(p){
      if(!p){bar.hidden=true;bar.classList.remove('mc-look-indeterminate');return;}
      bar.hidden=false;const fill=bar.firstElementChild,part=p.total?Math.min(1,(p.done+1)/p.total):0;
      // Finding is one step of unknown length; naming and checking are counted.
      bar.classList.toggle('mc-look-indeterminate',!p.total);
      fill.style.width=p.total?Math.round((p.stage==='naming'?part*.5:p.stage==='items'?.5+part*.5:part)*100)+'%':'';
      if(busy&&!(p.found?.length))say(stageText(p));
    }
    // What the list shows: in the box (by each thing's middle) or the whole screen.
    function current(){
      const src=all?all.found:partial,region=mode==='box'&&!box.hidden?regionOfBox():null;
      const inside=f=>!region||(f.box.x+f.box.w/2>=region.x&&f.box.x+f.box.w/2<=region.x+region.w&&f.box.y+f.box.h/2>=region.y&&f.box.y+f.box.h/2<=region.y+region.h);
      return src.filter(inside);
    }
    let lastKey='';
    function refresh(force){
      if(!shot)return;
      const found=current(),summary=MapleLook.summary(found),things=summary.filter(f=>!(f.via==='name'&&f.ui)),ui=summary.filter(f=>f.via==='name'&&f.ui);
      rows=things.map((f,i)=>({key:keyOf(f),color:PALETTE[i%PALETTE.length],things:found.filter(x=>keyOf(x)===keyOf(f)&&!(x.via==='name'&&x.ui))}));
      if(selected&&!rows.some(r=>r.key===selected))selected=null;
      draw();
      const where=mode==='box'?'In the box: ':'On the whole screen: ';
      if(busy){if(things.length)say(where+things.length+' found so far…');}
      else say(where+(things.length?things.length+' found':'nothing from the database')+'.');
      // The list is rebuilt only when what it shows changed (moving the box stays smooth).
      const key=mode+'|'+rows.map(r=>r.key+'×'+r.things.length).join(',')+'|'+ui.map(keyOf).join(',')+'|'+(catalog?1:0)+'|'+busy;
      if(!force&&key===lastKey){mark();return;}lastKey=key;
      list(things,ui,mode==='box'?'In the box':'On the whole screen');
    }
    function list(things,ui,heading){
      const ctx={mapId:all?.mapId||shot?.map||liveMap(),drops:all?.drops||[]},m=mapOf(ctx.mapId);
      const row=(f,i,inWindows)=>{
        const e=catalog?.by.get(f.type+':'+f.id),d=catalog?describe(f,ctx):{detail:'',extra:''},src=spriteURL(e),color=inWindows?'#868e96':rows[i]?.color||'#868e96';
        return '<div class="mc-look-row'+(inWindows?' mc-look-plain':'')+'" style="--c:'+color+'"'+(inWindows?'':' data-key="'+esc(keyOf(f))+'"')+'>'
          +'<button type="button" class="mc-look-pick" '+(inWindows?'data-open="1" ':'')+'data-type="'+esc(f.type)+'" data-name="'+esc(f.name)+'" aria-label="'+esc(inWindows?'Open '+f.name:'Show '+f.name+' on the picture')+'">'
          +(inWindows?'':'<span class="mc-look-num">'+(i+1)+'</span>')
          +'<span class="mc-look-thumb">'+(src?'<img src="'+esc(src)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':icon('search'))+'</span>'
          +'<span class="mc-look-text"><strong>'+esc(f.name)+(f.count>1?' ×'+f.count:'')+'</strong><small>'+esc(d.detail)+'</small>'+(d.extra?'<small class="mc-look-extra">'+esc(d.extra)+'</small>':'')+'</span></button>'
          +'<button type="button" class="mc-look-open" data-type="'+esc(f.type)+'" data-name="'+esc(f.name)+'" aria-label="Open '+esc(f.name)+'">'+icon('chevron-right')+'</button></div>';
      };
      results.innerHTML=(heading?'<h3 class="mc-look-heading">'+esc(heading)+'</h3>':'')
        +(m?'<div class="mc-look-row mc-look-map"><button type="button" class="mc-look-pick" data-map="'+esc(m.id)+'"><span class="mc-look-thumb">'+icon('map')+'</span><span class="mc-look-text"><strong>'+esc(m.name)+'</strong><small>The map you are on'+(m.street?' · '+esc(m.street):'')+'</small></span></button><button type="button" class="mc-look-open" data-map="'+esc(m.id)+'" aria-label="Open '+esc(m.name)+'">'+icon('chevron-right')+'</button></div>':'')
        +(things.length?things.map((f,i)=>row(f,i,false)).join(''):busy?'':'<p class="mc-look-empty">Nothing from the database found here. Move the box over a monster, an NPC or an item, or try Around me.</p>')
        +(ui.length?'<details class="mc-look-ui"><summary>Also in the game\'s windows ('+ui.length+')</summary>'+ui.map(f=>row(f,0,true)).join('')+'</details>':'');
      icons();
      results.querySelectorAll('.mc-look-open[data-type],[data-open][data-type]').forEach(b=>b.onclick=()=>openEntity(b.dataset.type,b.dataset.name));
      results.querySelectorAll('[data-map]').forEach(b=>b.onclick=()=>{dialog.close();openEntity('map',mapOf(b.dataset.map)?.name);});
      // Tapping a row shows where it is on the picture; tapping it again opens its page.
      results.querySelectorAll('.mc-look-pick:not([data-open]):not([data-map])').forEach(b=>b.onclick=()=>{const k=b.closest('[data-key]').dataset.key;if(selected===k)openEntity(b.dataset.type,b.dataset.name);else select(k,false);});
      mark();
    }
    function mark(){results.querySelectorAll('[data-key]').forEach(r=>r.classList.toggle('mc-look-selected',r.dataset.key===selected));}
    function select(key,fromPicture){
      selected=key;mark();draw();
      if(key&&fromPicture)results.querySelector('[data-key="'+CSS.escape(key)+'"]')?.scrollIntoView({block:'nearest',behavior:'smooth'});
      if(key&&!fromPicture)stage.scrollIntoView({block:'nearest',behavior:'smooth'});
    }
    // Around me: the picture as tall as the screenshot needs (no empty bands); the box view
    // gets its taller frame back.
    function frame(){stage.style.height=mode==='around'&&shot?Math.max(200,Math.round(stage.getBoundingClientRect().width*shot.h/shot.w))+'px':'';size();}
    function identify(){if(!shot)return;mode='box';frame();if(box.hidden){box.hidden=false;}placeBox();selected=null;setBusy();refresh(true);}
    function around(){if(!shot)return;mode='around';box.hidden=true;selected=null;frame();fitAll();setBusy();refresh(true);}

    function take(){
      if(!connected()){say('Connect Maple Atlas Companion on your computer first: Look uses its screenshot of the game.');return;}
      seq++;waiting='p'+seq.toString(36)+Date.now().toString(36).slice(-4);
      if(!request(waiting)){waiting=null;say('The computer is not connected.');return;}
      say('Taking a screenshot of the game…');bar.hidden=false;bar.classList.add('mc-look-indeterminate');
      const mine=waiting;setTimeout(()=>{if(waiting===mine){waiting=null;bar.hidden=true;say('No screenshot came from the computer. Is the game open there?');}},20000);
    }
    function open(){
      if(!dialog.open)dialog.showModal();
      requestAnimationFrame(()=>{size();placeBox();draw();});
      void loadCatalog().catch(()=>{});startWorker();
      take();
    }
    $('#mc-look-identify').onclick=identify;$('#mc-look-around').onclick=around;$('#mc-look-retake').onclick=take;
    addEventListener('resize',()=>{if(dialog.open&&shot){size();placeBox();clamp();draw();}});
    // ?lookdebug: show a given screenshot as if the computer had sent it (for checking the view).
    if(/[?&]lookdebug\b/.test(location.search))scope.MapleLookDebug={show:value=>{if(!dialog.open)dialog.showModal();requestAnimationFrame(()=>{size();placeBox();draw();});waiting=value.req;void received(value);},
      state:()=>({busy,mode,done:!!all,found:(all?.found||partial).length,rows:rows.map(r=>({key:r.key,n:r.things.length})),selected})};
    return {open,received,prefetch};
  }
  scope.MapleLookUI={create};
})(globalThis);
