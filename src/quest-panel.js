/* Quest helper on the phone: the quests tracked in the game's Quest Helper, as read
 * by Maple Atlas Companion on the computer. Each quest shows what is left, where to
 * hunt each monster, how to get each item (MapleClassic Wiki sources) and who to
 * return to, with Navigate buttons. Uses MapleQuestHelper (matching) and
 * MapleItemSources (item sources). */
(function(scope){
  const KEEP_MS=120000;
  function create({quests,maps,sprite,esc,icon,hops,navigate,openEntity,openCompanion,status,setStatus,channel='main'}){
    const sources=MapleItemSources.create({channel}),itemInfo=new Map();
    const monsterMaps=new Map(),npcMaps=new Map();
    for(const m of maps){
      for(const x of m.monsters||[]){const k=MapleQuestHelper.normalize(x.name);if(!monsterMaps.has(k))monsterMaps.set(k,{id:x.id,name:x.name,maps:[]});monsterMaps.get(k).maps.push(m);}
      for(const n of m.npcs||[]){const k=MapleQuestHelper.normalize(n.name);if(!npcMaps.has(k))npcMaps.set(k,[]);npcMaps.get(k).push(m);}
    }
    const itemIds=new Map();
    for(const q of quests)for(const o of [...q.objectives,...(q.items||[])])if(o.id&&(o.type==='item'||!o.type))itemIds.set(MapleQuestHelper.normalize(o.name),o.id);
    let reading=null,lastSeen=null,connection='disconnected',readyMisses={},onChange=()=>{},selected=null;
    const keyOf=q=>q.quest?.id||MapleQuestHelper.normalize(q.title);

    // The closest of these maps by recorded portals (null when none is reachable).
    function nearest(list){
      let best=null;
      for(const m of list||[]){const d=hops(m.id);if(d===null&&best)continue;if(!best||best.d===null||(d!==null&&d<best.d))best={id:String(m.id),name:m.name,d};}
      return best;
    }
    const away=t=>t?.d==null?'':t.d===0?'You are here':t.d+' portal'+(t.d===1?'':'s')+' away';
    const huntFor=name=>{const mob=monsterMaps.get(MapleQuestHelper.normalize(name));return mob?{mob,at:nearest(mob.maps)}:null;};
    const npcAt=name=>nearest(npcMaps.get(MapleQuestHelper.normalize(name)));

    function loadItem(name){
      const key=MapleQuestHelper.normalize(name);if(itemInfo.has(key))return itemInfo.get(key);
      const info={state:'loading'};itemInfo.set(key,info);
      sources.load(name).then(r=>{info.state='ready';info.sources=r.sources;}).catch(()=>{info.state='error';}).finally(()=>onChange());
      return info;
    }
    // Best way to get an item: the nearest monster that drops it, else the cheapest shop
    // with a recorded route, else a quest.
    function itemHint(name){
      const info=loadItem(name);
      if(info.state==='loading')return {text:'Looking up where to get it…'};
      if(info.state==='error')return {text:'Couldn’t reach the MapleClassic Wiki.'};
      const s=info.sources,drops=s.drops.map(d=>({...d,hunt:huntFor(d.monster)})).filter(d=>d.hunt?.at);
      drops.sort((a,b)=>(a.hunt.at.d??99)-(b.hunt.at.d??99)||(b.rate??0)-(a.rate??0));
      if(drops.length){const d=drops[0];return {text:'Dropped by '+d.monster+(d.rate!=null?' ('+(d.rate>=10?Math.round(d.rate):d.rate.toFixed(1))+'%)':'')+' · Hunt at '+d.hunt.at.name+(away(d.hunt.at)?' · '+away(d.hunt.at):''),target:d.hunt.at,more:s.drops.length+s.shops.length>1};}
      const shops=s.shops.map(x=>({...x,at:nearest(maps.filter(m=>m.name===x.map||m.npcs?.some(n=>n.name===x.npc)))||nearest(maps.filter(m=>m.name===x.town))})).filter(x=>x.at);
      if(shops.length){const x=shops[0];return {text:'Buy from '+x.npc+(x.price!=null?' · '+x.price.toLocaleString()+' '+(/^mesos$/i.test(x.currency)?'mesos':x.currency):'')+' · '+x.at.name,target:x.at,more:s.shops.length>1||s.drops.length>0};}
      if(s.drops.length)return {text:'Dropped by '+s.drops.slice(0,2).map(d=>d.monster).join(', '),more:true};
      if(s.rewards.length||s.given.length)return {text:'From the quest '+(s.given[0]||s.rewards[0]).quest,more:true};
      return {text:'No source recorded on the wiki yet.'};
    }

    // ---- Readings from the computer ----
    function update({visible,quests:list,receivedAt=Date.now()}){
      const parsed=MapleQuestHelper.unpack(list),resolved=MapleQuestHelper.resolve(parsed,quests,status());
      // A briefly hidden or unreadable panel must not wipe the list.
      if(visible&&!resolved.length&&reading?.quests.length&&receivedAt-lastSeen<KEEP_MS){reading={...reading,at:receivedAt,empty:true};onChange();return;}
      if(!visible&&reading?.quests.length&&receivedAt-lastSeen<KEEP_MS){reading={...reading,at:receivedAt,hidden:true};onChange();return;}
      const changes={};
      for(const q of resolved)if(q.quest&&!['in-progress','completed'].includes(status()[q.quest.id]))changes[q.quest.id]='in-progress';
      // A quest that was ready to hand in and is gone on two reads in a row was turned in.
      const shown=new Set(resolved.map(q=>q.quest?.id).filter(Boolean));
      for(const id of Object.keys(readyMisses)){if(shown.has(id)){readyMisses[id]=0;continue;}if(visible&&resolved.length&&++readyMisses[id]>=2){delete readyMisses[id];changes[id]='completed';}}
      for(const q of resolved)if(q.quest&&q.complete)readyMisses[q.quest.id]??=0;
      if(Object.keys(changes).length)setStatus(changes);
      reading={visible,quests:resolved,at:receivedAt};
      if(resolved.length)lastSeen=receivedAt;
      onChange();
    }
    function setConnection(phase){connection=phase;onChange();}
    const tracked=()=>reading?.quests||[];

    // ---- Rendering ----
    const pct=(have,need)=>need?Math.max(0,Math.min(100,Math.round(100*(have??0)/need))):0;
    function objectiveRow(p,qi,pi){
      const o=p.objective,isMob=o?.type==='mob'||(!o&&huntFor(p.name)&&!itemIds.has(MapleQuestHelper.normalize(p.name)));
      const id=o?.id??(isMob?huntFor(p.name)?.mob.id:itemIds.get(MapleQuestHelper.normalize(p.name)));
      const art=id?sprite(isMob?'monster':'item',{id,name:p.name}):'<span class="mc-sprite mc-qh-wiki"><img src="'+esc(MapleItemSources.imageURL(p.name))+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>';
      const count=p.have==null?'<span class="mc-qh-count mc-qh-unknown">? / '+(p.need??'?')+'</span>':'<span class="mc-qh-count">'+p.have+' / '+p.need+'</span>';
      let hint=null;
      if(!p.done){
        if(isMob){const h=huntFor(p.name);hint=h?.at?{text:'Hunt at '+h.at.name+(away(h.at)?' · '+away(h.at):''),target:h.at}:{text:'No recorded map with this monster.'};}
        else hint=itemHint(p.name);
      }
      const actions=hint?(hint.target?'<button type="button" class="mc-nav" data-qh-nav="'+esc(hint.target.id)+'" aria-label="Navigate to '+esc(hint.target.name)+'">'+icon('navigation')+'<span>Navigate</span></button>':'')+
        (!isMob?'<button type="button" class="mc-qh-more" data-qh-entity="item" data-qh-name="'+esc(p.name)+'">'+icon('compass')+'<span>How to get</span></button>':'<button type="button" class="mc-qh-more" data-qh-entity="monster" data-qh-name="'+esc(p.name)+'">'+icon('info')+'<span>Monster</span></button>'):'';
      return '<li class="mc-qh-objective" data-done="'+Boolean(p.done)+'">'+art+'<div class="mc-qh-objective-copy"><div class="mc-qh-line"><strong>'+esc(p.name)+'</strong>'+(p.done?'<span class="mc-qh-check">'+icon('check')+'</span>':'')+count+'</div>'+
        '<span class="mc-qh-bar" aria-hidden="true"><span style="width:'+(p.done?100:pct(p.have,p.need))+'%"></span></span>'+
        (hint?'<small class="mc-qh-hint">'+esc(hint.text)+'</small>'+(actions?'<div class="mc-qh-actions">'+actions+'</div>':''):'')+'</div></li>';
    }
    function card(q,qi){
      const quest=q.quest,done=q.progress.filter(p=>p.done).length,total=q.progress.length;
      const ready=q.complete,npc=quest?.npc,where=npc?npcAt(npc):null;
      const chip=ready?'<span class="mc-qh-chip" data-tone="ready">'+icon('circle-check')+'Ready to turn in</span>':total?'<span class="mc-qh-chip">'+done+' of '+total+' done</span>':'<span class="mc-qh-chip">In progress</span>';
      const reward=quest?[quest.exp?quest.exp.toLocaleString()+' EXP':'',quest.mesos?quest.mesos.toLocaleString()+' mesos':''].filter(Boolean).join(' · '):'';
      const turnIn=npc?'<div class="mc-qh-turnin" data-ready="'+ready+'">'+(quest.npcId?sprite('npc',{id:quest.npcId,name:npc}):'')+'<span><small>'+(ready?'Return to':'Quest from')+'</small><strong>'+esc(npc)+'</strong>'+(where?'<small>'+esc(where.name)+(away(where)?' · '+away(where):'')+'</small>':'')+'</span>'+
        (where&&ready?'<button type="button" class="mc-nav" data-qh-nav="'+esc(where.id)+'" aria-label="Navigate to '+esc(npc)+'">'+icon('navigation')+'<span>Navigate</span></button>':'')+'</div>':'';
      return '<article class="mc-qh-card" data-ready="'+ready+'"><header><div><strong>'+esc(quest?.name||q.title)+'</strong><small>'+(quest?'Lv. '+quest.level+'+'+(reward?' · '+esc(reward):''):'Not in the Victoria Island quest list')+'</small></div>'+chip+'</header>'+
        (total?'<span class="mc-qh-bar mc-qh-total" aria-hidden="true"><span style="width:'+pct(done,total)+'%"></span></span><ul class="mc-qh-objectives">'+q.progress.map((p,pi)=>objectiveRow(p,qi,pi)).join('')+'</ul>':'<p class="mc-qh-note">'+(npc?'Talk to '+esc(npc)+' to continue.':'No counts shown for this quest in game.')+'</p>')+
        turnIn+(quest?'<button type="button" class="mc-qh-link" data-qh-quest="'+esc(quest.name)+'">Quest details'+icon('chevron-right')+'</button>':'')+'</article>';
    }
    const ago=t=>{const s=Math.round((Date.now()-t)/1000);return s<10?'just now':s<60?s+' s ago':Math.round(s/60)+' min ago';};
    function statusLine(){
      const live=connection==='connected'||connection==='stale'||connection==='searching';
      if(!live)return reading?.quests.length?{tone:'off',text:'Companion not connected · Last seen '+ago(reading.at)}:null;
      if(!reading)return {tone:'wait',text:'Waiting for the companion to read your Quest Helper…'};
      if(reading.hidden)return {tone:'wait',text:'Quest Helper not visible in the game · Showing the last read'};
      return {tone:'live',text:'Live from your game · Updated '+ago(reading.at)};
    }
    function html(){
      const line=statusLine(),list=tracked();
      const head='<div class="mc-eyebrow">Your quests</div><h3>Quest helper</h3>'+(line?'<p class="mc-qh-status" data-tone="'+line.tone+'"><span aria-hidden="true"></span>'+esc(line.text)+'</p>':'');
      if(list.length){
        // One quest at a time; the chips above switch between the tracked quests.
        const index=Math.max(0,list.findIndex(q=>keyOf(q)===selected)),current=list[index];
        const tabs=list.length>1?'<div class="mc-qh-tabs" role="tablist" aria-label="Tracked quests">'+list.map((q,i)=>{
          const done=q.progress.filter(p=>p.done).length,total=q.progress.length;
          return '<button type="button" role="tab" class="mc-qh-tab" data-qh-pick="'+esc(keyOf(q))+'" aria-selected="'+(i===index)+'" data-ready="'+q.complete+'"><span class="mc-qh-tab-name">'+esc(q.quest?.name||q.title)+'</span><small>'+(q.complete?icon('circle-check')+'Ready':total?done+'/'+total:'Talk')+'</small></button>';
        }).join('')+'</div><p class="mc-qh-count-line">Quest '+(index+1)+' of '+list.length+' · Tap a quest to switch</p>':'';
        return head+tabs+'<div class="mc-qh-list" role="tabpanel">'+card(current,index)+'</div>';
      }
      const live=['connected','stale','searching'].includes(connection);
      if(!live)return head+'<section class="mc-qh-empty"><span class="mc-qh-empty-art" aria-hidden="true">'+icon('scroll-text')+'</span><strong>See your quests live</strong><p>Maple Atlas Companion reads the Quest Helper at the top right of your game. Each quest shows up here with what’s left, where to hunt, how to get every item and who to return to.</p><button type="button" class="mc-primary" data-qh-connect>'+icon('smartphone')+'Connect the companion</button></section>';
      return head+'<section class="mc-qh-empty"><span class="mc-qh-empty-art" aria-hidden="true">'+icon('scroll-text')+'</span><strong>'+(reading&&!reading.visible?'Open the Quest Helper in the game':'No tracked quests yet')+'</strong><p>'+(reading&&!reading.visible?'Keep the Quest Helper panel visible at the top right of the game window. Your tracked quests appear here.':'Track a quest in the game so it shows in the Quest Helper at the top right. It appears here within a few seconds.')+'</p></section>';
    }
    function bind(box){
      box.querySelectorAll('[data-qh-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.qhNav));
      box.querySelectorAll('[data-qh-entity]').forEach(b=>b.onclick=()=>openEntity(b.dataset.qhEntity,b.dataset.qhName));
      box.querySelectorAll('[data-qh-quest]').forEach(b=>b.onclick=()=>openEntity('quest',b.dataset.qhQuest));
      box.querySelectorAll('[data-qh-connect]').forEach(b=>b.onclick=openCompanion);
      box.querySelectorAll('[data-qh-pick]').forEach(b=>b.onclick=()=>{selected=b.dataset.qhPick;onChange();});
    }
    // Map ids that matter to the tracked quests (quest NPCs and monsters still to hunt).
    function relevantMaps(){
      const ids=new Map();const add=(id,q)=>{if(!ids.has(id))ids.set(id,new Set());ids.get(id).add(q);};
      tracked().forEach((q,i)=>{
        if(q.quest?.npc)for(const m of npcMaps.get(MapleQuestHelper.normalize(q.quest.npc))||[])add(String(m.id),i);
        for(const p of q.progress)if(!p.done)for(const m of huntFor(p.name)?.mob.maps||[])add(String(m.id),i);
      });
      return ids;
    }
    const summary=()=>{const list=tracked();if(!list.length)return null;const ready=list.filter(q=>q.complete).length;return list.length+' quest'+(list.length===1?'':'s')+' tracked'+(ready?' · '+ready+' ready to turn in':'');};
    return {update,setConnection,html,bind,tracked,relevantMaps,summary,onChange:fn=>{onChange=fn;}};
  }
  const exported={create};
  scope.MapleQuestPanel=exported;if(typeof module!=='undefined')module.exports=exported;
})(globalThis);
