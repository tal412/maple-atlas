(()=>{
  const root=document.getElementById('maple-atlas-concept');
  const $=s=>root.querySelector(s), $$=s=>[...root.querySelectorAll(s)];
  const DATA=__INLINE_MAP_DATA__;
  const mobile=matchMedia('(max-width:700px)');
  let hasInspected=false,noticeTimer=0;
  const maps=new Map(DATA.maps.map(m=>[String(m.id),m]));
  const spots=new Map(DATA.spots.map(s=>[String(s.id),s]));
  const get=id=>maps.get(String(id));
  const anchor=id=>spots.get(get(id)?.spot);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={from:'10000000',to:'10001000',selected:'10000012',panel:'place',category:'monsters',layer:'all',pick:false,level:18,status:{},zoom:1,dx:0,dy:0,route:[],routeActive:false,step:0,fitAll:false,focus:null,expanded:false};
  function restore(snapshot){
    const s=snapshot?.modelContent,p=snapshot?.privateContent||{};
    if(s?.preview!=='maple-atlas-data-v2')return false;
    const valid=new Set(DATA.quests.map(q=>q.id));
    state.status=Object.fromEntries(Object.entries(s.quests||{}).filter(([id,v])=>valid.has(id)&&['not-started','in-progress','completed','skipped'].includes(v)));
    state.routeActive=s.routeActive===true;
    state.level=Math.max(1,Math.min(100,Number(s.level)||18));
    for(const key of ['from','to']){const m=get(s[key+'Id'])||DATA.maps.find(m=>m.name===s[key]);if(m)state[key]=String(m.id);}
    if(get(p.selected))state.selected=String(p.selected);
    if(['place','route','progress'].includes(p.panel))state.panel=p.panel;
    if(['monsters','npcs','quests','connections'].includes(p.category))state.category=p.category;
    if(['all','quests','shops'].includes(p.layer))state.layer=p.layer;
    return true;
  }
  restore(window.openai?.widgetState);
  function save(){try{window.openai?.setWidgetState?.({modelContent:{preview:'maple-atlas-data-v2',fromId:state.from,toId:state.to,from:get(state.from)?.name,to:get(state.to)?.name,level:state.level,quests:state.status,routeActive:state.routeActive},privateContent:{selected:state.selected,panel:state.panel,category:state.category,layer:state.layer}})?.catch(()=>{$('#mc-status').textContent='Could not save progress in this browser. Your changes are still on this page.';});}catch(_){$('#mc-status').textContent='Browser storage is unavailable.';}}
  function icon(name){return '<i data-lucide="'+name+'" aria-hidden="true"></i>';}
  function sprite(kind,item){const src=DATA.sprites[kind]?.[String(item.id)];return src?'<span class="mc-sprite"><img src="'+esc(src)+'" alt="'+esc(item.name)+' game sprite" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>':'<span class="mc-sprite" aria-hidden="true"></span>';}
  function icons(){if(globalThis.lucide)lucide.createIcons({attrs:{width:18,height:18}});}
  const localMaps=MapleLocalMaps.create({root,get});
  const previewImages=MapleMapImages.previews({root,get});
  const questFlow=MapleQuestFlow.create(DATA.quests),expandedQuests=new Set();
  let questHistoryOpen=false;
  const currentQuests=()=>questFlow.current(state.status,state.level);
  function mapPreview(m,next){return '<button type="button" class="mc-map-preview" data-localmap="'+m.id+'" data-next="'+(next||'')+'" data-lazy="'+(state.panel==='route')+'" aria-label="View local map of '+esc(m.name)+'">'+(m.minimap?'<span class="mc-preview-media"><img alt="" hidden decoding="async" referrerpolicy="no-referrer"><span class="mc-preview-message" role="status">Loading preview…</span></span>':'')+'<span class="mc-preview-caption">'+icon('scan')+'<span>View local map<small>'+(next?'See the portal to your next stop':'Explore the original game map')+'</small></span></span></button>';}
  function find(text){const v=text.toLowerCase().trim();if(!v)return null;const exact=DATA.maps.filter(m=>m.name.toLowerCase()===v);if(exact.length===1)return exact[0];const matches=DATA.maps.filter(m=>m.name.toLowerCase().includes(v));return matches.length===1?matches[0]:null;}
  function plan(){
    state.routeActive=true;state.fitAll=false;state.focus=null;state.dx=0;state.dy=0;state.zoom=1;state.step=0;
    const queue=[[state.from]],seen=new Set();state.route=[];
    while(queue.length){const path=queue.shift(),last=path.at(-1);if(last===state.to){state.route=path;break;}if(seen.has(last))continue;seen.add(last);for(const edge of get(last)?.portals||[]){const id=String(edge.to);if(maps.has(id)&&!seen.has(id))queue.push([...path,id]);}}
  }
  function relevantQuests(m){
    const names=new Set(m.npcs.map(n=>n.name));const mobs=new Set(m.monsters.map(n=>Number(n.id)));
    return currentQuests().filter(q=>names.has(q.npc)||q.objectives.some(o=>o.type==='mob'&&mobs.has(Number(o.id)))).map(q=>({...q,here:names.has(q.npc)?'NPC association':'Hunt objective here'})).sort((a,b)=>Number(a.level>state.level)-Number(b.level>state.level)||a.level-b.level);
  }
  function questRows(qs,empty='No next quests here yet. Earlier steps may need completing elsewhere.'){return qs.map(q=>{
    const status=state.status[q.id]||'not-started';const reward=[q.exp?q.exp.toLocaleString()+' EXP':'',q.mesos?q.mesos.toLocaleString()+' mesos':''].filter(Boolean).join(' · ');
    const objectives=q.objectives.map(o=>'<div class="mc-quest-item">'+(['mob','item'].includes(o.type)?sprite(o.type==='mob'?'monster':'item',o):'')+'<span>'+(o.type==='quest'?'Complete '+esc(o.name):esc(o.name)+' × '+o.count)+'</span></div>').join('');
    const rewards=(q.items||[]).map(o=>'<div class="mc-quest-item">'+sprite('item',o)+'<span>'+esc(o.name)+' × '+o.count+(o.guaranteed?'':' <small>Possible reward</small>')+'</span></div>').join('');
    const label={'not-started':'Not started','in-progress':'In progress',completed:'Completed',skipped:'Skipped'}[status];
    return '<details class="mc-quest" data-quest-card="'+q.id+'"'+(expandedQuests.has(q.id)?' open':'')+'><summary class="mc-quest-heading">'+(q.npcId?sprite('npc',{id:q.npcId,name:q.npc}):'')+'<span class="mc-quest-copy"><strong>'+esc(q.name)+'</strong><small>'+esc(q.npc||'Quest record')+' · Lv. '+q.level+'+</small><small class="mc-quest-state">'+label+'</small></span>'+icon('chevron-down')+'</summary><div class="mc-quest-body"><small>'+esc(q.here||'Quest journal')+' · '+(q.level>state.level?'Requires level '+q.level:'Check remaining requirements in game')+'</small>'+(objectives?'<div class="mc-quest-objectives"><strong>Requirements</strong>'+objectives+'</div>':'')+((reward||rewards)?'<div class="mc-quest-rewards"><strong>Rewards'+(reward?' · '+reward:'')+'</strong>'+rewards+'</div>':'')+'<select aria-label="Progress for '+esc(q.name)+'" data-quest="'+q.id+'">'+[['not-started','Not started'],['in-progress','In progress'],['completed','Completed'],['skipped','Skipped']].map(([v,n])=>'<option value="'+v+'" '+(status===v?'selected':'')+'>'+n+'</option>').join('')+'</select></div></details>';
  }).join('')||'<div class="mc-empty">'+esc(empty)+'</div>';}
  function notice(message){clearTimeout(noticeTimer);$('#mc-map-notice').textContent=message;$('#mc-map-notice').hidden=false;noticeTimer=setTimeout(()=>{$('#mc-map-notice').hidden=true;},4500);}
  function mobileChrome(){
    const selected=get(state.selected),open=root.classList.contains('mc-sheet-open');
    $$('[data-mobile-panel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mobilePanel===state.panel)));
    $('#mc-sheet-handle').setAttribute('aria-expanded',String(open));
    $('#mc-sheet-handle').setAttribute('aria-label',open?'Collapse details':'Expand details');
    $('#mc-mobile-level').value=state.level;
    let title='Explore Victoria Island',subtitle='Tap a town · Pinch to zoom';
    if(state.panel==='route'&&state.routeActive){title=get(state.from).name+' → '+get(state.to).name;subtitle=(state.route.length?state.route.length-1:0)+' map changes · View directions';}
    else if(state.panel==='progress'){title='Your adventures';subtitle=Object.values(state.status).filter(s=>s==='completed').length+' quests completed · Level '+state.level;}
    else if(hasInspected){title=selected.name;subtitle=selected.npcs.length+' NPCs · '+selected.monsters.length+' monster types';}
    $('#mc-peek-title').textContent=title;$('#mc-peek-subtitle').textContent=subtitle;
  }
  function setSheet(open){root.classList.toggle('mc-sheet-open',open);$('#mc-sheet-toggle').textContent=open?'Map':'Details';$('#mc-sheet-toggle').setAttribute('aria-expanded',String(open));mobileChrome();}
  function toggleSheet(){setSheet(!root.classList.contains('mc-sheet-open'));detail();camera();}
  $('#mc-sheet-toggle').onclick=toggleSheet;$('#mc-sheet-handle').onclick=toggleSheet;
  let sheetTouch=null;
  $('#mc-sheet-handle').onpointerdown=e=>{sheetTouch=e.clientY;};
  $('#mc-sheet-handle').onpointerup=e=>{if(sheetTouch===null)return;const distance=e.clientY-sheetTouch;sheetTouch=null;if(Math.abs(distance)>25){e.preventDefault();setSheet(distance<0);detail();camera();$('#mc-sheet-handle').onclick=null;setTimeout(()=>{$('#mc-sheet-handle').onclick=toggleSheet;},0);}};
  function openRoute(){
    if(!mobile.matches){$('#mc-from').focus();return;}
    $('#mc-from').value=get(state.from).name;$('#mc-to').value=get(state.to).name;
    $('#mc-route-note').textContent='Set your current map and where you want to go.';
    $('#mc-clear-route').hidden=!state.routeActive;
    $('#mc-route-slot').append($('#mc-form'));$('#mc-route-dialog').showModal();
  }
  $('#mc-route-dialog').addEventListener('close',()=>$('#mc-route-home').append($('#mc-form')));
  function searchResults(){
    const query=$('#mc-search-input').value.trim().toLowerCase();
    const matches=DATA.maps.filter(m=>query?(m.name+' '+m.street).toLowerCase().includes(query):m.town).sort((a,b)=>Number(b.town)-Number(a.town)||a.name.localeCompare(b.name)).slice(0,20);
    $('#mc-search-results').innerHTML=matches.length?matches.map(m=>'<button type="button" class="mc-search-result" data-search-place="'+m.id+'">'+icon('map-pin')+'<span><strong>'+esc(m.name)+'</strong><small>'+esc(m.street)+' · '+(m.town?'Town':'Map')+'</small></span></button>').join(''):'<div class="mc-empty">No maps found. Try a city or a shorter name.</div>';
    $$('[data-search-place]').forEach(b=>b.onclick=()=>{$('#mc-search-dialog').close();inspect(b.dataset.searchPlace);});icons();
  }
  $('#mc-mobile-search').onclick=()=>{$('#mc-search-input').value='';searchResults();$('#mc-search-dialog').showModal();$('#mc-search-input').focus();};
  $('#mc-search-input').oninput=searchResults;
  $$('[data-close-dialog]').forEach(b=>b.onclick=()=>$('#'+b.dataset.closeDialog).close());
  function openProfile(){$('#mc-mobile-level').value=state.level;$('#mc-profile-dialog').showModal();}
  $('#mc-mobile-profile').onclick=openProfile;
  $('#mc-mobile-journal').onclick=()=>{$('#mc-profile-dialog').close();state.panel='progress';setSheet(true);detail();camera();save();};
  $('#mc-mobile-directions').onclick=openRoute;
  $('#mc-mobile-locate').onclick=()=>{const a=anchor(state.from);setSheet(false);if(a){state.focus=a.id;state.zoom=1;state.dx=0;state.dy=0;camera();notice('Starting at '+get(state.from).name+' · Set manually');}else{inspect(state.from);notice('This map has no reviewed atlas position.');}};
  $('#mc-clear-route').onclick=()=>{state.route=[];state.routeActive=false;state.panel='place';state.fitAll=true;state.focus=null;state.zoom=1.3;state.dx=0;state.dy=0;hasInspected=false;$('#mc-route-dialog').close();setSheet(false);render();save();};
  $$('[data-mobile-panel]').forEach(b=>b.onclick=()=>{
    if(b.dataset.mobilePanel==='route'&&!state.routeActive){openRoute();return;}
    state.panel=b.dataset.mobilePanel;
    if(state.panel==='place'){hasInspected=false;setSheet(false);}else setSheet(true);
    detail();camera();save();
  });
  mobile.addEventListener('change',()=>{if(!mobile.matches){for(const d of $$('.mc-mobile-dialog'))if(d.open)d.close();$('#mc-route-home').append($('#mc-form'));}detail();camera();});
  function detail(){
    $$('.mc-tabs button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.panel===state.panel)));
    const m=get(state.selected),box=$('#mc-detail');if(!m)return;
    if(mobile.matches&&state.panel==='place'&&!hasInspected){
      box.innerHTML='<div class="mc-eyebrow">Your world</div><h3>Explore Victoria Island</h3><div class="mc-secondary">Choose a town to see quests, NPCs and places.</div>'+DATA.maps.filter(p=>p.town&&anchor(p.id)).map(p=>'<button type="button" class="mc-search-result" data-inspect="'+p.id+'">'+icon('map-pin')+'<span><strong>'+esc(p.name)+'</strong><small>'+p.npcs.length+' NPCs · Explore town</small></span></button>').join('');
    }else if(state.panel==='route'){
      const n=state.route.length-1;
      box.innerHTML='<div class="mc-eyebrow">Your route</div><h3>'+esc(get(state.to).name)+'</h3><div class="mc-secondary">'+(n<0?'No recorded route found':n+' map changes · Fewest recorded portals')+'</div>'+(n>=0?'<ol class="mc-steplist">'+state.route.map((id,i)=>{
        const p=get(id),next=state.route[i+1],edge=p.portals.find(e=>String(e.to)===next),badge=i===0?'A':i===n?'B':i;
        return '<li'+(i===state.step?' aria-current="step"':'')+'><span class="mc-step-badge">'+badge+'</span><button type="button" data-inspect="'+id+'" class="mc-step-name">'+esc(p.name)+'</button><p>'+esc(edge?MapleLocalMaps.instruction(edge,get(next)?.name):'You have arrived.')+'</p>'+mapPreview(p,next)+'</li>';
      }).join('')+'</ol><button type="button" class="mc-primary cursor-interaction" id="mc-step">'+(state.step>=n?'Restart route':'I reached the next map')+'</button><div class="mc-secondary" style="margin-top:10px">Manual position · '+esc(get(state.route[state.step]).name)+'</div>':'<div class="mc-empty">Try a different start. Some scripted destinations are not included in this snapshot.</div>');
      box.insertAdjacentHTML('afterbegin','<button type="button" id="mc-edit-route" class="mc-edit-route">Change route</button>');
      $('#mc-edit-route').onclick=openRoute;
      if($('#mc-step'))$('#mc-step').onclick=()=>{state.step=state.step>=n?0:state.step+1;state.selected=state.route[state.step];render();save();};
    }else if(state.panel==='progress'){
      const tracked=DATA.quests.filter(q=>state.status[q.id]);
      const next=questFlow.journal(state.status,state.level);
      const history=tracked.filter(q=>['completed','skipped'].includes(state.status[q.id]));
      box.innerHTML='<div class="mc-eyebrow">Your character</div><h3>Quest journal</h3><div class="mc-secondary">'+Object.values(state.status).filter(x=>x==='completed').length+' completed · One next quest per NPC</div><div id="mc-journal-storage" class="mc-datahint" role="status">'+esc($('#mc-save-status').textContent)+'</div>'+questRows(next,'No next quests for your tracked NPCs. Explore the map, or review your history below.')+(history.length?'<details class="mc-quest-history"'+(questHistoryOpen?' open':'')+'><summary>Completed & skipped <span>'+history.length+'</span>'+icon('chevron-down')+'</summary><p>Review a quest or change its status.</p>'+questRows(history)+'</details>':'');
    }else{
      const a=anchor(m.id),members=a?a.members.map(get).filter(Boolean):[];
      const categories=[['monsters','Monsters'],['npcs','NPCs'],['quests','Quests'],['connections','Places']];
      box.innerHTML='<div class="mc-eyebrow">'+esc(m.street)+' · '+(m.town?'Town':'Field')+'</div><h3>'+esc(m.name)+'</h3><div class="mc-secondary">'+m.npcs.length+' NPCs · '+m.monsters.length+' monster types · '+m.portals.length+' recorded exits</div><div class="mc-placeactions"><button type="button" id="mc-go" class="mc-primary cursor-interaction">Directions</button><button type="button" id="mc-start" class="cursor-interaction">Start here</button></div>'+mapPreview(m)+(!a?'<div class="mc-datahint">Atlas position not reviewed. Use the connections below.</div>':a.schematic?'<div class="mc-datahint">◇ Schematic position · Portal connections are recorded; this point is placed to explain the forest path.</div>':'')+'<div class="mc-category">'+categories.map(([c,n])=>'<button type="button" class="cursor-interaction" data-category="'+c+'" aria-pressed="'+(c===state.category)+'">'+n+'</button>').join('')+'</div><div id="mc-items"></div>';
      const items=$('#mc-items');
      if(state.category==='monsters')items.innerHTML=m.monsters.length?m.monsters.map(mon=>'<div class="mc-row">'+sprite('monster',mon)+'<div><strong>'+esc(mon.name)+'</strong><small>Level '+mon.level+' · '+mon.exp+' EXP</small><small>'+mon.spawns+' recorded spawn points</small></div></div>').join('')+'<div class="mc-datahint">Spawn points are map data, not live monsters.</div>':'<div class="mc-empty">No monster placements recorded in this map.</div>';
      if(state.category==='npcs')items.innerHTML=m.npcs.length?m.npcs.map(n=>'<div class="mc-row">'+sprite('npc',n)+'<div><strong>'+esc(n.name)+'</strong><small>'+DATA.quests.filter(q=>q.npc===n.name).length+' quest associations</small></div></div>').join(''):'<div class="mc-empty">No NPCs recorded in '+esc(m.name)+'.</div>';
      if(state.category==='quests')items.innerHTML=questRows(relevantQuests(m));
      if(state.category==='connections'){
        items.innerHTML='<div class="mc-eyebrow">Direct exits</div>'+m.portals.map(e=>'<div class="mc-row"><div><strong>'+esc(get(e.to)?.name||e.to)+'</strong><small>'+esc(MapleLocalMaps.instruction(e))+'</small></div><button type="button" class="cursor-interaction" data-inspect="'+e.to+'">Open</button></div>').join('');
        if(members.length>1)items.innerHTML+='<button type="button" id="mc-expand" class="cursor-interaction mc-expand">'+(state.expanded?'Hide':'Expand')+' '+members.length+' maps in this location</button><div id="mc-memberlist" '+(state.expanded?'':'hidden')+'>'+members.map(p=>'<div class="mc-row"><div><strong>'+esc(p.name)+'</strong><small>'+p.npcs.length+' NPCs · '+p.monsters.length+' monster types</small></div><button type="button" class="cursor-interaction" data-inspect="'+p.id+'">Open</button></div>').join('')+'</div>';
        items.innerHTML+='<div class="mc-datahint">Shop interiors are linked here. Shop inventory and prices need separate verification.</div>';
        if($('#mc-expand'))$('#mc-expand').onclick=()=>{state.expanded=!state.expanded;detail();};
      }
      items.innerHTML+='<a class="mc-source" href="https://osmsdataexplorer.com/?tab=maps&id='+String(m.id).padStart(9,'0')+'" target="_blank" rel="noopener">Map '+m.id+' · Source data ↗</a>';
      $('#mc-go').onclick=()=>{state.to=String(m.id);$('#mc-to').value=m.name;if(mobile.matches){openRoute();return;}state.panel='route';setSheet(true);plan();render();save();};
      $('#mc-start').onclick=()=>setStart(m);
      $$('[data-category]').forEach(b=>b.onclick=()=>{state.category=b.dataset.category;detail();save();});
    }
    $$('[data-localmap]').forEach(b=>b.onclick=()=>localMaps.open(b.dataset.localmap,b.dataset.next));
    previewImages.refresh();
    $$('[data-inspect]').forEach(b=>b.onclick=()=>inspect(b.dataset.inspect));
    $$('[data-quest-card]').forEach(d=>d.ontoggle=()=>{if(!d.isConnected)return;if(d.open)expandedQuests.add(d.dataset.questCard);else expandedQuests.delete(d.dataset.questCard);});
    const history=$('.mc-quest-history');if(history)history.ontoggle=()=>{if(history.isConnected)questHistoryOpen=history.open;};
    $$('[data-quest]').forEach(s=>s.onchange=()=>{state.status[s.dataset.quest]=s.value;if(['completed','skipped'].includes(s.value))expandedQuests.delete(s.dataset.quest);$('#mc-status').textContent='Progress updated · Change the status anytime to undo.';detail();markers();save();});mobileChrome();icons();
  }
  function inspect(id){if(!get(id))return;hasInspected=true;state.selected=String(id);state.panel='place';state.expanded=false;if(mobile.matches){const a=anchor(id);if(a){state.focus=a.id;state.dx=0;state.dy=0;state.zoom=1;}}setSheet(true);detail();markers();save();}
  function setStart(m){const picking=state.pick;state.from=String(m.id);$('#mc-from').value=m.name;$('#mc-status').textContent='Starting at '+m.name+' · Set manually';state.pick=false;$('#mc-pickstart').textContent='Pick start on map';if(state.routeActive)plan();render();save();if(mobile.matches){if(picking)openRoute();else notice('Starting at '+m.name);}}
  function markers(){
    const routeSpots=new Set(state.route.map(id=>get(id)?.spot));const selectedSpot=get(state.selected)?.spot;
    $('#mc-markers').innerHTML=DATA.spots.map(s=>{
      const m=get(s.primary),routeIndex=state.route.findIndex(id=>get(id)?.spot===s.id),isFrom=get(state.from)?.spot===s.id,isTo=get(state.to)?.spot===s.id;
      const relevant=state.layer==='quests'?new Set(s.members.map(get).filter(Boolean).flatMap(relevantQuests).filter(q=>q.level<=state.level&&state.status[q.id]!=='completed').map(q=>q.id)).size:state.layer==='shops'?m.portals.map(e=>get(e.to)).filter(x=>x&&/shop|store|market/i.test(x.name)).length:0;
      const selected=s.id===selectedSpot&&(!mobile.matches||hasInspected||state.routeActive),isRoute=routeSpots.has(s.id),town=s.kind==='town';
      return '<button type="button" class="mc-place cursor-interaction" data-spot="'+s.id+'" data-selected="'+selected+'" data-route="'+isRoute+'" data-town="'+town+'" data-schematic="'+Boolean(s.schematic)+'" data-endpoint="'+(isRoute&&(isFrom||isTo))+'" aria-label="Inspect '+esc(s.label)+(s.schematic?' · Schematic position':'')+'" data-tooltip="'+esc(s.label)+(s.schematic?' · Schematic position':'')+'"><span class="mc-dot">'+(isRoute?(isFrom?'A':isTo?'B':routeIndex):'')+'</span><span class="mc-tag">'+(s.schematic?'◇ ':'')+esc(s.label)+'</span>'+(state.layer!=='all'&&relevant?'<span class="mc-badge">'+relevant+'</span>':'')+'</button>';
    }).join('');
    $$('[data-spot]').forEach(b=>{b.onclick=()=>{const s=spots.get(b.dataset.spot);if(state.pick)setStart(get(s.primary));else inspect(s.primary);};b.ondblclick=()=>{const s=spots.get(b.dataset.spot);state.focus=s.id;state.zoom=Math.min(2.5,state.zoom*1.35);state.category='connections';state.expanded=true;detail();camera();};});camera();
  }
  let width=1024,height=670,scale=1,ox=0,oy=0,gestures=null,zoomAnchor=null,wheelTimer=0,cameraFrame=0;
  const labelPlanner=MapleLabelLayout.create();
  function queueCamera(){if(!cameraFrame)cameraFrame=requestAnimationFrame(()=>{cameraFrame=0;camera();});}
  function placeLabels(points,narrow,left){
    const mapRect=$('#mc-map').getBoundingClientRect();
    const minX=narrow?8:left+8,maxX=width-8,minY=narrow?$('.mc-maptools').getBoundingClientRect().bottom-mapRect.top+12:70,maxY=narrow?Math.max(minY+32,$('.mc-panel').getBoundingClientRect().top-mapRect.top-12):height-80;
    const moving=Boolean(gestures?.moving||wheelTimer);
    const blocked=moving?[]:$$('.mc-mobile-searchbar,.mc-mobile-mapactions,.mc-mobile-nav,.mc-maptools,.mc-zooms,.mc-mapfooter,.mc-routeform,.mc-tabs,.mc-detail,.mc-sheet-handle').filter(e=>e.offsetWidth&&e.offsetHeight).map(e=>{const r=e.getBoundingClientRect();return{x:r.left-mapRect.left,y:r.top-mapRect.top,w:r.width,h:r.height};});
    const route=$('#mc-route'),samples=[],total=!moving&&route.getAttribute('d')?.trim()?route.getTotalLength():0;
    if(total>0)for(let d=0;d<=total;d+=10/scale){const p=route.getPointAtLength(d);samples.push({x:ox+p.x*scale,y:oy+p.y*scale,w:0,h:0});}
    const measured=points.map(p=>{const tag=p.b.querySelector('.mc-tag');tag.style.maxWidth=Math.min(240,maxX-minX)+'px';return{...p,id:p.b.dataset.spot,label:p.b.dataset.selected==='true'||p.b.dataset.town==='true',selected:p.b.dataset.selected==='true',w:tag.offsetWidth,h:tag.offsetHeight};});
    const layouts=labelPlanner.layout({points:measured,bounds:{left:minX,right:maxX,top:minY,bottom:maxY},blocked,route:samples,moving});
    measured.forEach(p=>{
      const layout=layouts.get(p.id),shown=p.label&&Boolean(layout?.visible),tag=p.b.querySelector('.mc-tag');
      p.b.classList.toggle('mc-showlabel',shown);
      if(shown){tag.style.left=layout.dx+22+'px';tag.style.top=layout.dy+22+'px';}
      // Clip only once the marker AND its attached label have left the viewport.
      const markerVisible=p.x+22>=0&&p.x-22<=width&&p.y+22>=0&&p.y-22<=height;
      const labelVisible=shown&&p.x+layout.dx+layout.w>=0&&p.x+layout.dx<=width&&p.y+layout.dy+layout.h>=0&&p.y+layout.dy<=height;
      p.b.hidden=!markerVisible&&!labelVisible;
    });
  }
  function routePath(){let d='',last=null;for(const id of state.route){const a=anchor(id);if(!a){last=null;continue;}if(last&&a.id===anchor(last)?.id){last=id;continue;}if(last){let segment=DATA.artRoutes?.[last+':'+id];if(!segment){const reverse=DATA.artRoutes?.[id+':'+last];if(reverse){const p=reverse.match(/-?\d+(?:\.\d+)?/g).map(Number);segment='M'+p[6]+' '+p[7]+'C'+p[4]+' '+p[5]+' '+p[2]+' '+p[3]+' '+p[0]+' '+p[1];}}d+=segment?' '+segment.slice(segment.indexOf('C')):' M'+a.x+' '+a.y;}else d+=' M'+a.x+' '+a.y;last=id;}return d;}
  function camera(){
    const el=$('#mc-map');width=el.clientWidth;height=el.clientHeight;const narrow=width<700,left=narrow?0:320,availableW=width-left;
    let mapTop=70,mapBottom=height-84;
    $('.mc-maptools').style.top='';$('.mc-zooms').style.top='';
    if(narrow){const bounds=el.getBoundingClientRect();mapTop=$('.mc-maptools').getBoundingClientRect().bottom-bounds.top+16;mapBottom=Math.max(mapTop+80,$('.mc-panel').getBoundingClientRect().top-bounds.top-16);}
    const routePoints=state.route.map(anchor).filter(Boolean),a=spots.get(state.focus);
    if(a){scale=(narrow?width/600:Math.min(availableW/700,height/600))*state.zoom;ox=left+availableW/2-a.x*scale+state.dx;oy=(narrow?(mapTop+mapBottom)/2:height/2)-a.y*scale+state.dy;}
    else if(state.fitAll||!routePoints.length){scale=Math.min((availableW-25)/1458,(narrow?mapBottom-mapTop:height-90)/1079)*state.zoom;ox=left+(availableW-1458*scale)/2+state.dx;oy=(narrow?mapTop+(mapBottom-mapTop-1079*scale)/2:(height-1079*scale)/2)+state.dy;}
    else if(narrow){const xs=routePoints.map(p=>p.x),ys=routePoints.map(p=>p.y),top=mapTop,bottom=mapBottom,cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;scale=Math.min((width-64)/(Math.max(...xs)-Math.min(...xs)+40),(bottom-top-20)/(Math.max(...ys)-Math.min(...ys)+40))*state.zoom;ox=width/2-cx*scale+state.dx;oy=(top+bottom)/2-cy*scale+state.dy;}
    else{const xs=routePoints.map(p=>p.x),ys=routePoints.map(p=>p.y),cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;scale=Math.min((availableW-110)/(Math.max(...xs)-Math.min(...xs)+400),(height-170)/(Math.max(...ys)-Math.min(...ys)+380))*state.zoom;scale=Math.min(scale,1.7*state.zoom);ox=left+availableW/2-cx*scale+state.dx;oy=height*.54-cy*scale+state.dy;}
    if(zoomAnchor){const dx=zoomAnchor.screen.x-(ox+zoomAnchor.world.x*scale),dy=zoomAnchor.screen.y-(oy+zoomAnchor.world.y*scale);state.dx+=dx;state.dy+=dy;ox+=dx;oy+=dy;zoomAnchor=null;}
    $('#mc-svg').setAttribute('viewBox','0 0 '+width+' '+height);$('#mc-world').setAttribute('transform','translate('+ox+','+oy+') scale('+scale+')');
    $$('[data-ocean]').forEach(r=>{r.setAttribute('x',-ox/scale-2);r.setAttribute('y',-oy/scale-2);r.setAttribute('width',width/scale+4);r.setAttribute('height',height/scale+4);});
    const selectedSpot=get(state.selected)?.spot;
    const labelPoints=[];
    $$('[data-spot]').forEach(b=>{const s=spots.get(b.dataset.spot),x=ox+s.x*scale,y=oy+s.y*scale;b.style.left=x+'px';b.style.top=y+'px';if(narrow&&scale<.8&&b.dataset.town!=='true'&&b.dataset.route!=='true'&&b.dataset.selected!=='true'){b.hidden=true;return;}b.hidden=false;labelPoints.push({b,x,y,r:b.dataset.route==='true'?13:9});});
    const d=routePath();$('#mc-route').setAttribute('d',d);$('#mc-routehalo').setAttribute('d',d);const c=anchor(state.route[state.step]);$('#mc-traveler').setAttribute('visibility',c&&state.step?'visible':'hidden');if(c){$('#mc-traveler').setAttribute('cx',c.x);$('#mc-traveler').setAttribute('cy',c.y);}
    placeLabels(labelPoints,narrow,left);
    $('#mc-network').setAttribute('d',Object.values(DATA.artRoutes||{}).join(' '));$('#mc-zoom').textContent=Math.round(state.zoom*100)+'%';const unplaced=state.route.filter(id=>!anchor(id)).length;$('#mc-caption').textContent=state.route.length?(state.route.length-1)+' portal transitions · '+(unplaced?unplaced+' stops have no reviewed atlas position':'Select any numbered stop'):'Explore the recorded map network';
  }
  function render(){detail();markers();['all','for-you','shops'].forEach((id,i)=>$('#mc-'+id).setAttribute('aria-pressed',String(state.layer===['all','quests','shops'][i])));}
  function syncFields(){ $('#mc-level').value=state.level;$('#mc-mobile-level').value=state.level;$('#mc-from').value=get(state.from).name;$('#mc-to').value=get(state.to).name; }
  syncFields();
  $('#mc-towns').innerHTML=DATA.maps.map(m=>'<option value="'+esc(m.name)+'"></option>').join('');
  $('#mc-form').onsubmit=e=>{e.preventDefault();const a=find($('#mc-from').value),b=find($('#mc-to').value);if(!a||!b){$('#mc-status').textContent='Select a map name from the suggestions.';$('#mc-route-note').textContent='Choose a valid starting map and destination.';return;}state.from=String(a.id);state.to=String(b.id);state.panel='route';if($('#mc-route-dialog').open)$('#mc-route-dialog').close();plan();setSheet(!mobile.matches);render();$('#mc-status').textContent=state.route.length?'Route follows recorded portal connections · No live game tracking':'No recorded portal route. Try another start.';if(!state.route.length){setSheet(true);detail();camera();}save();};
  $('#mc-from').onchange=()=>{if(!mobile.matches)$('#mc-form').requestSubmit();};$('#mc-to').onchange=()=>{if(!mobile.matches)$('#mc-form').requestSubmit();};
  $('#mc-pickstart').onclick=()=>{state.pick=!state.pick;$('#mc-pickstart').textContent=state.pick?'Select a point…':'Pick start on map';$('#mc-status').textContent=state.pick?'Click any map point to set your current location.':'Location set manually';if(mobile.matches&&state.pick){$('#mc-route-dialog').close();setSheet(false);camera();notice('Tap a map point to set your starting location.');}};
  $$('.mc-tabs button').forEach(b=>b.onclick=()=>{state.panel=b.dataset.panel;setSheet(true);detail();camera();save();});
  function changeLevel(e){state.level=Math.max(1,Math.min(100,Number(e.target.value)||1));$('#mc-level').value=state.level;$('#mc-mobile-level').value=state.level;render();save();}
  $('#mc-level').onchange=changeLevel;$('#mc-mobile-level').onchange=changeLevel;
  ['all','for-you','shops'].forEach((id,i)=>$('#mc-'+id).onclick=()=>{state.layer=['all','quests','shops'][i];state.category=i===2?'connections':i===1?'quests':'monsters';state.panel='place';if(mobile.matches){if(!hasInspected)state.selected=state.from;hasInspected=true;setSheet(true);}render();save();});
  $('#mc-plus').onclick=()=>{state.zoom=Math.min(5,state.zoom*1.2);camera();};$('#mc-minus').onclick=()=>{state.zoom=Math.max(.5,state.zoom/1.2);camera();};$('#mc-fit').onclick=()=>{state.zoom=1;state.dx=0;state.dy=0;state.fitAll=true;state.focus=null;camera();};
  gestures=MapleGestures.create({element:$('#mc-map'),getCamera:()=>{if(cameraFrame){cancelAnimationFrame(cameraFrame);cameraFrame=0;camera();}return{ox,oy,scale,zoom:state.zoom,dx:state.dx,dy:state.dy};},onStart:()=>{if(wheelTimer){clearTimeout(wheelTimer);wheelTimer=0;}},onPan:(dx,dy)=>{state.dx=dx;state.dy=dy;queueCamera();},onZoom:next=>{state.zoom=next.zoom;zoomAnchor=next;queueCamera();},onEnd:queueCamera});
  $('#mc-map').addEventListener('wheel',e=>{if(e.target.closest('button'))return;e.preventDefault();state.zoom=Math.max(.5,Math.min(5,state.zoom*(e.deltaY<0?1.1:1/1.1)));clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>{wheelTimer=0;queueCamera();},160);queueCamera();},{passive:false});
  $('#mc-network').style.visibility='hidden';if(!mobile.matches||state.routeActive)plan();else{state.panel='place';state.fitAll=true;state.zoom=1.3;}render();new ResizeObserver(camera).observe($('#mc-map'));
  if(document.fonts?.ready)document.fonts.ready.then(camera);
  window.addEventListener('openai:set_globals',e=>{if(restore(e.detail?.globals?.widgetState)){syncFields();if(!mobile.matches||state.routeActive)plan();else state.route=[];render();}});
  if(globalThis.Tweak){const options={network:false};const tweak=new Tweak({container:root,onChange:()=>$('#mc-network').style.visibility=options.network?'visible':'hidden'});tweak.addToggle(options,'network',{label:'Show recorded connections'});}
})();
