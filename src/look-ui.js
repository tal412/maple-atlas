/* The phone's Look view: a screenshot of the game from the computer, zoomed on your character,
 * with a box you move by dragging the picture (pinch or the corner handle to resize).
 * "Identify box" finds what is in the box, "Around me" what is on the whole screen; each thing
 * found is marked on the picture and listed, and opens its page in the search.
 *
 * It also answers looks marked on the computer (⌃⌥M / Ctrl+Alt+M on the game): the same
 * recognition on the marked box, sent back as a small card for the overlay.
 *
 * Recognition is src/look.js; sprites come from maplestory.io (every animation frame of
 * monsters and NPCs, and items' dropped icons), else the datamine picture.
 */
(function(scope){
  const API='https://maplestory.io/api/MCW/1/';
  function create({root,maps,quests=[],catalogUrl,sourceCommit,request,answer,liveMap,openEntity,drops,connected,esc,icon,icons=()=>{}}){
    const $=s=>root.querySelector(s),dialog=$('#mc-look-dialog'),stage=$('#mc-look-stage'),canvas=$('#mc-look-canvas'),box=$('#mc-look-box'),status=$('#mc-look-status'),results=$('#mc-look-results');
    const mapOf=id=>maps.find(m=>m.id===String(id));
    let shot=null,view={s:1,tx:0,ty:0},boxSize={w:.62,h:.5},found=[],shotPlayers=[],seq=0,waiting=null,busy=false;

    // ---- Data: the catalog (names), sprites, drops ----
    let catalog=null,names=null;
    async function loadCatalog(){
      if(catalog)return catalog;
      const r=await fetch(catalogUrl);if(!r.ok)throw Error('The database did not load.');
      const data=await r.json();catalog={entities:data.entities||[],commit:data.sourceCommit||sourceCommit};
      catalog.by=new Map(catalog.entities.map(e=>[e.type+':'+e.id,e]));
      catalog.itemByName=new Map();for(const e of catalog.entities)if(e.type==='item'&&!catalog.itemByName.has(e.name.toLowerCase()))catalog.itemByName.set(e.name.toLowerCase(),e);
      names=MapleLook.nameIndex(catalog.entities.filter(e=>['npc','monster','item','quest'].includes(e.type)));
      return catalog;
    }
    const spritePath=e=>e?.image&&catalog?catalog.commit+'/data/'+e.image:'';
    const spriteURL=e=>e?.image&&catalog?'https://cdn.jsdelivr.net/gh/ohmi69/osms_datamine_dashboard@'+spritePath(e):null;
    // Images as ImageData, fetched two at a time and retried when the server is busy.
    const images=new Map();let active=0;const queue=[];
    const slot=()=>new Promise(res=>{if(active<2){active++;res();}else queue.push(res);});
    const free=()=>{const next=queue.shift();if(next)next();else active--;};
    async function fetchRetry(url,as){
      await slot();
      try{for(let i=0;i<3;i++){const r=await fetch(url,{mode:'cors',credentials:'omit'}).catch(()=>null);if(r?.ok)return as==='json'?await r.json():await r.blob();if(r&&r.status!==503&&r.status!==429)return null;await new Promise(res=>setTimeout(res,500*(i+1)));}return null;}
      finally{free();}
    }
    function imageData(url){
      if(!url)return Promise.resolve(null);
      if(!images.has(url))images.set(url,(async()=>{
        const blob=await fetchRetry(url,'blob');if(!blob)return null;
        try{const bmp=await createImageBitmap(blob),c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;const x=c.getContext('2d');x.drawImage(bmp,0,0);bmp.close?.();return x.getImageData(0,0,c.width,c.height);}catch(_){return null;}
      })());
      return images.get(url);
    }
    // Every useful frame of a monster or NPC (a few of each pose), else its datamine picture.
    const frameLists=new Map();
    function frames(kind,e){
      const key=kind+':'+e.id;
      if(!frameLists.has(key))frameLists.set(key,(async()=>{
        const rec=await fetchRetry(API+kind+'/'+e.id,'json'),books=rec?.framebooks||{},urls=[];
        const poses=kind==='mob'?['stand','move','jump','hit1']:Object.keys(books).slice(0,2);
        for(const pose of poses)for(let i=0;i<Math.min(books[pose]||0,kind==='mob'?4:2);i++)urls.push(API+kind+'/'+e.id+'/render/'+pose+'/'+i);
        const got=(await Promise.all(urls.slice(0,12).map(imageData))).filter(Boolean);
        if(got.length)return got;
        const own=await imageData(spriteURL(e));return own?[own]:[];
      })());
      return frameLists.get(key);
    }
    // What can be on this map: its monsters (all frames), its NPCs, and what its monsters drop.
    const mapSets=new Map();
    function spritesFor(mapId,onProgress){
      if(!mapSets.has(mapId))mapSets.set(mapId,(async()=>{
        const m=mapOf(mapId),list=[];if(!m)return list;
        const mobs=(m.monsters||[]).map(x=>catalog.by.get('monster:'+x.id)||{id:String(x.id),name:x.name,type:'monster'});
        const npcs=(m.npcs||[]).map(x=>catalog.by.get('npc:'+x.id)||{id:String(x.id),name:x.name,type:'npc'});
        let done=0;const total=mobs.length+npcs.length;
        for(const [kind,type,group] of [['mob','monster',mobs],['npc','npc',npcs]])await Promise.all(group.map(async e=>{
          for(const image of await frames(kind,e))list.push({type,id:String(e.id),name:e.name,image});
          onProgress?.(++done,total);
        }));
        let dropRows=[];try{dropRows=await drops((m.monsters||[]).map(x=>x.name));}catch(_){}
        const items=[...new Set(dropRows.map(r=>r.item))].map(n=>catalog.itemByName.get(String(n).toLowerCase())).filter(Boolean).slice(0,40);
        await Promise.all(items.map(async e=>{const image=await imageData(API+'item/'+e.id+'/iconRaw')||await imageData(spriteURL(e));if(image)list.push({type:'item',id:String(e.id),name:e.name,image});}));
        list.drops=dropRows;
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
    async function analyze(s,region,onProgress){
      await loadCatalog();
      const mapId=s.map||liveMap();
      const sprites=mapId?await spritesFor(mapId,onProgress):[];
      const r=MapleLook.analyze({image:s.image,lines:s.lines,region,k:s.k,names,sprites});
      const summary=MapleLook.summary(r.found);summary.forEach((f,i)=>f.n=i+1);
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
      // Players (yourself and others) are only labelled: they are not in the database.
      for(const p of shotPlayers){x.strokeStyle='rgba(255,255,255,.55)';x.setLineDash([4/view.s,3/view.s]);x.strokeRect(p.box.x-2/view.s,p.box.y-2/view.s,p.box.w+4/view.s,p.box.h+4/view.s);x.setLineDash([]);tag(p.box,p.you?'You':'Player','#ddd','rgba(60,60,60,.8)');}
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
      const row=f=>{const e=catalog.by.get(f.type+':'+f.id),d=describe(f,r),src=spriteURL(e);
        return '<button type="button" class="mc-look-row" data-type="'+esc(f.type)+'" data-name="'+esc(f.name)+'">'+(f.ui?'':'<span class="mc-look-num" style="--c:'+(colors[f.type]||'#999')+'">'+f.n+'</span>')+'<span class="mc-look-thumb" style="--c:'+(colors[f.type]||'#999')+'">'+(src?'<img src="'+esc(src)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':icon('search'))+'</span><span class="mc-look-text"><strong>'+esc(f.name)+(f.count>1?' ×'+f.count:'')+'</strong><small>'+esc(d.detail)+'</small>'+(d.extra?'<small class="mc-look-extra">'+esc(d.extra)+'</small>':'')+'</span>'+icon('chevron-right')+'</button>';};
      results.innerHTML=(heading?'<h3 class="mc-look-heading">'+esc(heading)+'</h3>':'')+(m?'<button type="button" class="mc-look-row mc-look-map" data-map="'+esc(m.id)+'"><span class="mc-look-thumb">'+icon('map')+'</span><span class="mc-look-text"><strong>'+esc(m.name)+'</strong><small>The map you are on'+(m.street?' · '+esc(m.street):'')+'</small></span>'+icon('chevron-right')+'</button>':'')
        +(rows.length?rows.map(row).join(''):'<p class="mc-look-empty">Nothing from the database found here. Move the box over a monster, an NPC or an item, or try Around me.</p>')
        +(r.players?.length?'<p class="mc-look-players">'+icon('users')+'<span>Players and pets (not in the database): '+r.players.map(p=>esc(p.you?'you ('+p.name+')':p.name)).join(', ')+'</span></p>':'')
        +(ui.length?'<details class="mc-look-ui"><summary>Also in the game\'s windows ('+ui.length+')</summary>'+ui.map(row).join('')+'</details>':'');
      icons();
      results.querySelectorAll('[data-type]').forEach(b=>b.onclick=()=>openEntity(b.dataset.type,b.dataset.name));
      results.querySelectorAll('[data-map]').forEach(b=>b.onclick=()=>{dialog.close();openEntity('map',mapOf(b.dataset.map)?.name);});
    }
    async function run(region,label){
      if(!shot||busy)return;busy=true;$('#mc-look-identify').disabled=$('#mc-look-around').disabled=true;
      say(label+'…');
      try{
        const r=await analyze(shot,region,(done,total)=>say('Getting this map\'s monsters and NPCs ('+done+'/'+total+')…'));
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
    return {open,received};
  }
  scope.MapleLookUI={create};
})(globalThis);
