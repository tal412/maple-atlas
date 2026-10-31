(function(scope){
  const labels={map:'Locations',monster:'Monsters',npc:'NPCs',quest:'Quests',item:'Items',recipe:'Crafting',skill:'Skills'};
  const singular={map:'Location',monster:'Monster',npc:'NPC',quest:'Quest',item:'Item',recipe:'Recipe',skill:'Skill'};
  const icons={map:'map-pin',monster:'swords',npc:'user-round',quest:'flag',item:'package',recipe:'hammer',skill:'sparkles'};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=n=>Number(n).toLocaleString();
  // Whole mesos for prices of 100 or more; one decimal below that.
  const price=n=>Number(n).toLocaleString(undefined,{maximumFractionDigits:Math.abs(n)>=100?0:1});
  function create({root,url,marketUrl,onMap,onNavigate=()=>{},routeLength=()=>null,spawns=()=>0,questMarkup,onStatus,questStatus,currentQuestIds,remainingQuests}){
    const $=s=>root.querySelector(s),dialog=$('#mc-search-dialog'),input=$('#mc-search-input');
    const list=$('#mc-search-results'),filters=$('#mc-search-filters'),detail=$('#mc-search-entity'),status=$('#mc-search-status');
    const loader=MapleSearchData.create({url,channel:root.dataset.channel});
    const items=MapleItemData.create({channel:root.dataset.channel}),itemRecords=new Map(),itemStates=new Map();
    const market=MapleMarketData.create({url:marketUrl,channel:root.dataset.channel});
    const marketWatch=MapleMarketData.watch({store:market});
    let itemIdentities=new Map(),visibleItem=null,byName=new Map();
    const sources=MapleItemSources.create({channel:root.dataset.channel}),sourceStates=new Map();
    let index,catalog,loading,category='all',limit=30,timer,stack=[],lastKey=null,searchScroll=0;
    const icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>';
    const refreshIcons=()=>globalThis.lucide?.createIcons({attrs:{width:20,height:20}});
    const spriteURL=e=>e?.image?'https://cdn.jsdelivr.net/gh/ohmi69/osms_datamine_dashboard@'+catalog.sourceCommit+'/data/'+e.image:null;
    function thumb(src,name){return '<span class="mc-search-portrait" aria-hidden="true">'+icon(name)+(src?'<img src="'+esc(src)+'" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">':'')+'</span>';}
    function portrait(e){
      const src=e.image?'https://cdn.jsdelivr.net/gh/ohmi69/osms_datamine_dashboard@'+catalog.sourceCommit+'/data/'+e.image:e.type==='item'&&e.apiRecord?MapleItemData.base+e.id+'/icon':null;
      return '<span class="mc-search-portrait" aria-hidden="true">'+icon(icons[e.type])+(src?'<img src="'+esc(src)+'" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">':'')+'</span>';
    }
    function imageEvents(){
      dialog.querySelectorAll('.mc-search-portrait img').forEach(img=>{img.onload=()=>img.parentElement.classList.add('mc-image-ready');img.onerror=()=>img.remove();if(img.complete&&img.naturalWidth)img.onload();});refreshIcons();
    }
    function subtitle(e,worth=false){
      let parts=[singular[e.type]];
      if(e.limited)parts.push(e.type==='item'?'Game item':'Name record', 'ID '+e.id);
      else if(e.type==='map')parts.push(e.street||e.region||'',e.covered?'Explore map':'Outside route coverage');
      else if(e.type==='monster')parts.push('Lv. '+e.level,number(e.exp)+' EXP');
      else if(e.type==='npc')parts.push(number(e.maps?.length||0)+' recorded location'+(e.maps?.length===1?'':'s'));
      else if(e.type==='quest')parts.push(e.npcName||'', 'Lv. '+e.level+'+');
      else if(e.type==='item')parts.push(e.cash?'Cash item':e.category,e.subcategory,e.level>0?'Lv. '+e.level:'',e.success!=null?e.success+'% success':'',worth&&!e.cash?(e.sell!=null?'NPC sell '+number(e.sell)+' mesos':''):'','ID '+e.id);
      else if(e.type==='recipe')parts.push(e.discipline,'Crafting Lv. '+e.level);
      else if(e.type==='skill')parts.push(e.job);
      return parts.filter(Boolean).join(' · ');
    }
    function row(e,{fuzzy=false,worth=false,count}={}){
      return '<button type="button" class="mc-search-result" data-entity="'+esc(e.key)+'">'+portrait(e)+'<span class="mc-search-copy"><strong>'+esc(e.name)+(count?' <small>× '+number(count)+'</small>':'')+'</strong><small>'+esc(subtitle(e,worth))+'</small>'+(fuzzy?'<small class="mc-similar">Similar match</small>':'')+'</span>'+icon(e.type==='map'&&e.covered?'arrow-up-right':'chevron-right')+'</button>';
    }
    function bindRows(container){container.querySelectorAll('[data-entity]').forEach(b=>b.onclick=()=>openEntity(b.dataset.entity));imageEvents();}
    function showResults(){
      clearTimeout(timer);
      visibleItem=null;marketWatch.view(false);
      stack=[];detail.hidden=true;$('#mc-search-listing').hidden=false;$('#mc-search-back').hidden=true;$('#mc-search-title').textContent='Search Maple Atlas';
      if(!index)return;
      const found=index.search(input.value,{type:category,limit});
      filters.innerHTML=[['all','All'],...Object.entries(labels)].map(([type,label])=>'<button type="button" data-search-type="'+type+'" aria-pressed="'+(category===type)+'">'+label+'</button>').join('');
      filters.querySelectorAll('button').forEach(b=>b.onclick=()=>{category=b.dataset.searchType;limit=30;showResults();filters.querySelector('[aria-pressed=true]').focus({preventScroll:true});});
      status.textContent=input.value.trim()?(number(found.total)+' results'+(found.intent.worth?' · Item values & market checks':'')):'Search '+number(index.size)+' records · Try “snial”, “Olaf”, or “work gloves worth”';
      list.innerHTML=found.results.map(r=>row(r.entity,{fuzzy:r.fuzzy,worth:found.intent.worth})).join('')+
        (!found.total?'<div class="mc-search-empty">'+icon('search')+'<h3>No matches'+(category!=='all'?' in '+labels[category].toLowerCase():'')+'</h3><p>Try a shorter name, an item ID, or another category. Small spelling mistakes are supported.</p>'+(category!=='all'?'<button type="button" id="mc-search-all">Search all categories</button>':'')+'</div>':'')+
        (found.total>limit?'<button type="button" id="mc-search-more" class="mc-search-more">Show more results</button>':'');
      bindRows(list);
      if($('#mc-search-all'))$('#mc-search-all').onclick=()=>{category='all';showResults();};
      if($('#mc-search-more'))$('#mc-search-more').onclick=()=>{const old=limit;limit+=30;showResults();list.querySelectorAll('[data-entity]')[old]?.focus({preventScroll:true});};
    }
    function external(href,text){return '<a class="mc-search-link" href="'+esc(href)+'" target="_blank" rel="noopener">'+esc(text)+icon('arrow-up-right')+'</a>';}
    function worth(e){
      const blocked=e.stats?.notSale;
      const npc=e.cash?'':'<div class="mc-value-tile"><span>Sell to NPC</span><strong>'+(blocked?'Not sellable':e.sell!=null?number(e.sell)+' <small>mesos</small>':'—')+'</strong></div>';
      return '<section class="mc-value"><div class="mc-section-head"><h3>'+icon('coins')+(e.cash?'Market price':'Value')+'</h3><button type="button" id="mc-market-refresh" class="mc-icon-button" aria-label="Refresh market prices">'+icon('refresh-cw')+'</button></div>'+
        '<div class="mc-value-tiles">'+npc+'<div id="mc-market-content" class="mc-value-market"></div></div><p id="mc-market-status" class="mc-fine" role="status" aria-live="polite"></p>'+
        '<div class="mc-link-row">'+external('https://maplestory.market/items?q='+encodeURIComponent(e.name),'Current listings')+'<span id="mc-market-history"></span></div></section>';
    }
    function updateMarket(){
      if(!dialog.open||!visibleItem||stack.at(-1)!==visibleItem.key)return;
      const content=$('#mc-market-content'),status=$('#mc-market-status'),refresh=$('#mc-market-refresh');if(!content)return;
      const state=market.getState(),data=state.data,match=data?market.match(visibleItem,itemIdentities):null;
      const signature=(data?.digest||'none')+'|'+(data?.updatedAt||'')+'|'+visibleItem.name+'|'+Number(data&&Date.now()-Date.parse(data.updatedAt)>172800000);
      if(content.dataset.version!==signature){
        const scroll=dialog.scrollTop,focused=content.contains(document.activeElement)?document.activeElement.getAttribute('href'):null;
        let html='';
        let history='';
        if(match){
          const r=match.record,unit=r.unit==='set'?'mesos / set':'mesos';
          html='<div class="mc-value-tile mc-value-main"><span>'+(match.ambiguous?'Market (by name)':'Player market')+'</span><strong>'+(r.median===null?(r.sales?'—':'No sales'):price(r.median)+' <small>'+unit+'</small>')+'</strong>'+
            (r.typicalLow!==null&&r.typicalHigh!==null?'<small>Usually '+price(r.typicalLow)+'–'+price(r.typicalHigh)+'</small>':'')+'</div>'+
            (r.askingMedian!==null?'<div class="mc-value-tile"><span>Asking</span><strong>'+price(r.askingMedian)+' <small>mesos</small></strong></div>':'')+
            '<div class="mc-value-tile"><span>Sales</span><strong>'+number(r.sales)+'</strong></div>'+
            '<p class="mc-fine mc-value-note">'+(match.ambiguous?esc(r.name)+' matches '+match.identityCount+' game IDs · ':'')+(r.sales<data.lowDataBelow?'Limited sales data · ':'')+'Prices as of '+esc(new Date(data.updatedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))+(Date.now()-Date.parse(data.updatedAt)>172800000?' · Older snapshot':'')+'</p>';
          history=external(data.page+'/'+r.slug,'Price history');
        }else html='<p class="mc-fine mc-value-note">'+(data?'No player-market record for this item.':'Market prices will appear here when available.')+'</p>';
        content.innerHTML=html;content.dataset.version=signature;const h=$('#mc-market-history');if(h)h.innerHTML=history;
        if(focused)[...content.querySelectorAll('a')].find(a=>a.getAttribute('href')===focused)?.focus({preventScroll:true});
        dialog.scrollTop=scroll;refreshIcons();
      }
      refresh.disabled=state.loading;refresh.setAttribute('aria-busy',String(state.loading));
      status.textContent=state.loading?'Checking for updates…':state.error?(data?'Showing saved prices · Update unavailable':'Prices unavailable · Retry or open current listings'):state.checkedAt?'Checked '+new Date(state.checkedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})+' · Updates while open':data?'Showing saved prices':'';
    }
    market.subscribe(updateMarket);
    function cashInfo(e){
      if(!e.cash)return '';
      const shop=e.cashShop;
      const cosmetic=['Equipment','Armor','Accessory','Weapon'].includes(e.category);
      return '<section class="mc-cash-info"><h3>'+(cosmetic?'Cosmetic equipment':'Cash item')+'</h3><p>'+(cosmetic?'Appearance item'+(e.subcategory?' · '+esc(e.subcategory):''):'Cash-shop purchases use NX; player trades use mesos.')+'</p>'+
        (shop?.price>0?'<p><strong>'+number(shop.price)+' NX</strong> · Shop-data price'+(shop.count>1?' for '+number(shop.count):'')+(shop.period>0?' · '+number(shop.period)+' days':'')+'</p>':'')+
        (shop?'<details class="mc-source-note"><summary>Cash-shop record</summary><p>'+(shop.on_sale?'Listed in the cash-shop snapshot':'No direct cash-shop listing in this snapshot')+' · '+esc(catalog.snapshot)+'. Crates, events and player trades can have separate availability.</p></details>':'')+'</section>';
    }
    function apiInfo(e){
      const record=itemRecords.get(e.key),state=itemStates.get(e.key);
      const message=record?(record.stale?'Saved game record · Update unavailable':'Classic World game record')+' · '+new Date(record.checked).toLocaleDateString():state==='loading'?'Loading Classic World item details…':state==='error'?'Couldn’t reach the game-data API. Saved catalog details are shown.':'Classic World item data';
      return '<div class="mc-item-source"><p role="status">'+esc(message)+'</p>'+((state==='error'||record?.stale)?'<button type="button" id="mc-item-retry">Retry game details</button>':'')+external(MapleItemData.base+e.id,'View game-data source')+'</div>';
    }
    async function loadItem(key,refresh=false){
      const e=index.get(key);itemStates.set(key,'loading');
      try{itemRecords.set(key,await items.load(e.id,{refresh}));itemStates.set(key,'ready');}
      catch(_){itemStates.set(key,'error');}
      if(dialog.open&&stack.at(-1)===key)renderEntity(key,false);
    }
    // How to get it: community-recorded sources from the MapleClassic Wiki, linked to the
    // atlas's own monsters, NPCs, quests and maps so each source can be navigated to.
    const entityByName=(type,name)=>name?byName.get(type+':'+String(name).toLowerCase())||null:null;
    function nearest(mapIds){
      let best=null;
      for(const id of mapIds||[]){const m=index.get('map:'+id);if(!m?.covered)continue;const d=routeLength(m.id);if(!best||(d!==null&&(best.d===null||d<best.d)))best={id:m.id,name:m.name,d};}
      return best;
    }
    // Where to hunt a monster: the reachable map with the most of its spawns (the nearer one
    // on a tie), so farming a drop goes where the monster is densest.
    // Where to hunt: most spawns, and of maps nearly as good the nearest (MapleQuestHelper.bestHuntMap).
    function densest(mob){
      const list=[];
      for(const id of mob?.maps||[]){const m=index.get('map:'+id);if(!m?.covered)continue;list.push({id:m.id,name:m.name,d:routeLength(m.id),n:spawns(mob.id,m.id)});}
      const best=MapleQuestHelper.bestHuntMap(list);
      return best?{...best,monster:String(mob.id),monsterName:mob.name}:null;
    }
    const away=t=>t&&t.d!=null?(t.d?t.d+' portal'+(t.d===1?'':'s')+' away':'You are here'):'';
    const percent=n=>n==null?'':(n>=10?Math.round(n):n>=1?n.toFixed(1).replace(/\.0$/,''):n.toFixed(2).replace(/0$/,''))+'%';
    function sourceRow({img,iconName,title,detail,extra='',target,key}){
      const main=(key?'<button type="button" class="mc-get-main" data-entity="'+esc(key)+'">':'<div class="mc-get-main">')+thumb(img,iconName)+
        '<span class="mc-get-copy"><strong>'+esc(title)+'</strong>'+(detail?'<small>'+detail+'</small>':'')+'</span>'+extra+(key?'</button>':'</div>');
      return '<div class="mc-get-row">'+main+(target?'<button type="button" class="mc-nav" data-navigate="'+esc(target.id)+'"'+(target.monster?' data-hunt="'+esc(target.monster)+'" data-hunt-name="'+esc(target.monsterName)+'"':'')+' aria-label="Navigate to '+esc(target.name)+'">'+icon('navigation')+'<span>Navigate</span></button>':'')+'</div>';
    }
    function group(iconName,label,rows){
      if(!rows.length)return '';
      return '<div class="mc-get-group"><h4>'+icon(iconName)+esc(label)+'<span>'+rows.length+'</span></h4>'+rows.slice(0,4).join('')+
        (rows.length>4?'<details class="mc-get-more"><summary>Show all '+rows.length+'</summary>'+rows.slice(4).join('')+'</details>':'')+'</div>';
    }
    function howToGet(e){
      const st=sourceStates.get(e.key),head='<div class="mc-section-head"><h3>'+icon('compass')+'How to get it</h3></div>';
      const credit='<p class="mc-fine mc-get-credit">Community data from the '+'<a href="'+esc(MapleItemSources.pageURL(e.name))+'" target="_blank" rel="noopener">MapleClassic Wiki</a> · <a href="'+MapleItemSources.license+'" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>'+(st?.record?.stale?' · Saved copy, update unavailable':'')+'</p>';
      if(!st||st.state==='loading')return '<section class="mc-get" aria-busy="true">'+head+'<div class="mc-get-loading" aria-hidden="true"><span></span><span></span><span></span></div><p class="mc-fine" role="status">Looking up shops, drops and quests…</p></section>';
      if(st.state==='error')return '<section class="mc-get">'+head+'<p class="mc-fine" role="status">Couldn’t reach the MapleClassic Wiki.</p><button type="button" id="mc-sources-retry" class="mc-chip-button">'+icon('refresh-cw')+'Try again</button></section>';
      const src=st.record.sources,quest=name=>entityByName('quest',name);
      const shops=src.shops.map(x=>{
        const npc=entityByName('npc',x.npc),map=entityByName('map',x.map),town=entityByName('map',x.town);
        // The shop's own map if a recorded route reaches it, else the NPC's other maps, else its town.
        const at=m=>m?.covered?{id:m.id,name:m.name,d:routeLength(m.id)}:null,options=[at(map),nearest(npc?.maps),at(town)].filter(Boolean);
        const target=options.find(o=>o.d!==null)||options[0]||null;
        const place=[x.map,x.town].filter((v,i,a)=>v&&a.indexOf(v)===i).map(esc).join(' · ');
        return sourceRow({img:spriteURL(npc)||MapleItemSources.imageURL(x.npc),iconName:'store',title:x.npc,key:npc?.key,detail:place+(away(target)?' · '+away(target):'')+(x.limit?' · Limit '+number(x.limit):''),
          extra:x.price!=null?'<span class="mc-price">'+number(x.price)+'<small>'+esc(/^mesos$/i.test(x.currency)?'mesos':x.currency)+'</small></span>':'',target});
      });
      const drops=src.drops.map(x=>{
        const mob=entityByName('monster',x.monster),target=densest(mob);
        const qty=x.min!=null&&x.max!=null&&(x.min>1||x.max>1)?' · ×'+(x.min===x.max?x.min:x.min+'–'+x.max):'';
        return sourceRow({img:spriteURL(mob)||MapleItemSources.imageURL(x.monster),iconName:'swords',title:x.monster,key:mob?.key,
          detail:[mob?'Lv. '+mob.level:'',x.rate!=null?percent(x.rate)+' drop chance':'Drop rate not recorded'].filter(Boolean).join(' · ')+qty+(target?' · Hunt at '+esc(target.name)+(target.n?' · '+number(target.n)+' spawns':''):''),
          extra:x.quest?'<span class="mc-tag">Quest only</span>':'',target});
      });
      const questRow=(x,verb)=>{const q=quest(x.quest),target=nearest(q?.maps);
        return sourceRow({img:spriteURL(q),iconName:'flag',title:x.quest,key:q?.key,detail:esc(verb)+(x.quantity>1?' × '+number(x.quantity):'')+(x.chance!=null?' · '+percent(x.chance)+' chance':'')+(q?.npcName?' · '+esc(q.npcName):'')+(q?' · Lv. '+q.level+'+':''),target});};
      const boxes=src.boxes.map(x=>sourceRow({img:MapleItemSources.imageURL(x.box),iconName:'package-open',title:x.box,detail:(x.rate!=null?percent(x.rate)+' chance':'Chance not recorded')+(x.quest?' · Needs '+esc(x.quest):'')}));
      const body=group('shopping-bag','Buy from a shop',shops)+group('swords','Dropped by',drops)+group('flag','Quest reward',src.rewards.map(x=>questRow(x,'Reward')))+
        group('gift','Given by a quest',src.given.map(x=>questRow(x,'Given when you start it')))+group('package-open','From boxes and reactors',boxes);
      return '<section class="mc-get">'+head+(body||'<p class="mc-get-empty">'+icon('search-x')+'No shops, drops or quests are recorded on the wiki for this item yet. That doesn’t mean it can’t be found.</p>')+credit+'</section>';
    }
    async function loadSources(e,refresh=false){
      sourceStates.set(e.key,{state:'loading'});
      try{sourceStates.set(e.key,{state:'ready',record:await sources.load(e.name,{refresh})});}
      catch(_){sourceStates.set(e.key,{state:'error'});}
      if(dialog.open&&stack.at(-1)===e.key)renderEntity(e.key,false);
    }
    function itemHero(e){
      const chips=[e.cash?'Cash item':e.category,e.subcategory&&e.subcategory!==e.category&&!/^consume$/i.test(e.subcategory)?e.subcategory:'',e.level>0?'Lv. '+e.level:'',e.job&&e.job!=='All'?e.job:'',e.success!=null?e.success+'% success':''].filter(Boolean);
      return '<div class="mc-item-hero">'+portrait(e)+'<div class="mc-item-title"><h3 tabindex="-1" id="mc-entity-name">'+esc(e.name)+'</h3>'+(chips.length?'<div class="mc-chips">'+chips.map(c=>'<span>'+esc(c)+'</span>').join('')+'</div>':'')+'</div></div>'+
        (e.description?'<p class="mc-item-desc">'+esc(e.description)+'</p>':'');
    }
    function stats(e){
      const values=e.type==='monster'?[['Level',e.level],['HP',e.hp],['EXP',e.exp]]:
        e.type==='skill'?[['Class',e.job],['Master level',e.maxLevel]]:
        e.type==='recipe'?[['Discipline',e.discipline],['Crafting level',e.level],['Craft fee',number(e.mesos)+' mesos']]:
        e.type==='item'?[['Required level',e.cash?null:e.level],['Class',e.job],['Success',e.success!=null?e.success+'%':null],
          ...Object.entries({incPAD:'Attack',incMAD:'Magic attack',incPDD:'Defense',incMDD:'Magic defense',incSTR:'STR',incDEX:'DEX',incINT:'INT',incLUK:'LUK',tuc:'Upgrade slots',slotMax:'Stack size'}).map(([key,label])=>[label,e.stats?.[key]])]:[];
      const visible=values.filter(([,v])=>v!=null);
      return visible.length?'<dl class="mc-search-stats">'+visible.map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(typeof v==='number'?number(v):v)+'</dd></div>').join('')+'</dl>':'';
    }
    function relationGroups(e){
      let html='';
      for(const [label,group] of index.related(e.key)){
        let related=[...group.values()].map(r=>({...r,entity:index.get(r.key)}));
        if(e.type==='npc'&&label==='Quests')related=related.filter(r=>currentQuestIds().has(r.entity.id));
        if(e.type==='quest'&&label==='Needed for quests')related=related.filter(r=>r.entity.id!==e.next);
        if(!related.length)continue;
        related.sort((a,b)=>Number(Boolean(b.entity.covered))-Number(Boolean(a.entity.covered))||a.entity.name.localeCompare(b.entity.name));
        const heading=e.type==='npc'&&label==='Quests'?'Next quest':label;
        const rows=related.map(r=>row(r.entity,{count:r.count}));
        const body=rows.slice(0,5).join('')+(rows.length>5?'<details class="mc-related-more"><summary>Show all '+related.length+'</summary>'+rows.slice(5).join('')+'</details>':'');
        const collapsed=e.type==='quest'&&['Requirements','Rewards','Next quest','Earlier quest','Needed for quests'].includes(label);
        html+=collapsed?'<details class="mc-search-group"><summary>Explore '+esc(heading.toLowerCase())+' <span>'+related.length+'</span></summary>'+body+'</details>':'<section class="mc-search-related"><h3>'+esc(heading)+' <span>'+related.length+'</span></h3>'+body+'</section>';
      }
      return html;
    }
    function renderEntity(key,focus=true){
      const original=index.get(key);if(!original)return;
      const fresh=itemRecords.get(key)?.data;
      const e=fresh?{...original,...fresh,description:fresh.description||original.description,cash:original.cash||fresh.cash,stats:{...original.stats,...fresh.stats},limited:false}:original;
      visibleItem=e.type==='item'?e:null;
      const scroll=dialog.scrollTop;
      const expanded=focus?new Set():new Set([...detail.querySelectorAll('details[open]')].map(d=>d.querySelector('summary')?.textContent));
      const hadHeadingFocus=!focus&&detail.querySelector('#mc-entity-name')===document.activeElement;
      $('#mc-search-listing').hidden=true;detail.hidden=false;$('#mc-search-back').hidden=false;$('#mc-search-title').textContent=singular[e.type]+' details';
      const blocked=e.type==='quest'?remainingQuests(e.id):[];
      if(e.type==='item')detail.innerHTML=itemHero(e)+stats(e)+(e.cash?cashInfo(e):howToGet(e))+worth(e)+relationGroups(e)+apiInfo(e)+
        '<footer class="mc-search-provenance">Item ID '+esc(e.id)+' · Snapshot '+esc(catalog.snapshot)+' · Game data and sprites © Nexon'+external('https://github.com/ohmi69/osms_datamine_dashboard/tree/'+catalog.sourceCommit+'/data/current','OSMS source data')+'</footer>';
      else detail.innerHTML='<div class="mc-entity-heading">'+portrait(e)+'<div><h3 tabindex="-1" id="mc-entity-name">'+esc(e.name)+'</h3><p>'+esc(subtitle(e))+'</p></div></div>'+
        (e.limited&&e.type!=='item'?'<p class="mc-record-note">This name exists in the game export. Details are not verified in this snapshot.</p>':'')+
        (e.type==='map'&&!e.covered?'<p class="mc-record-note">This location is outside the atlas’s verified route coverage.</p>':'')+
        (e.type==='quest'?'<p class="mc-record-note">'+esc(questStatus(e.id))+(blocked.length?' · Earlier quests required: '+blocked.map(esc).join(', '):'')+'</p>'+questMarkup(e.id):stats(e))+
        (e.description?'<details class="mc-search-description"><summary>About '+esc(e.name)+'</summary><p>'+esc(e.description)+'</p></details>':'')+
        (e.type==='item'?cashInfo(e)+worth(e):'')+relationGroups(e)+
        (e.type==='monster'?'<p class="mc-record-note">These are recorded spawn locations. Live spawns and monster drop tables are not available in this snapshot.</p>':'')+
        (e.type==='item'?apiInfo(e):'')+
        '<footer class="mc-search-provenance">Snapshot '+esc(catalog.snapshot)+' · Game data and sprites © Nexon'+external('https://github.com/ohmi69/osms_datamine_dashboard/tree/'+catalog.sourceCommit+'/data/current','OSMS source data')+'</footer>';
      detail.querySelectorAll('[data-navigate]').forEach(b=>b.onclick=()=>{marketWatch.view(false);dialog.close();onNavigate(b.dataset.navigate,b.dataset.hunt?{monster:b.dataset.hunt,name:b.dataset.huntName}:null);});
      if($('#mc-sources-retry'))$('#mc-sources-retry').onclick=()=>{void loadSources(e,true);renderEntity(key,false);};
      detail.querySelectorAll('[data-quest]').forEach(select=>select.onchange=()=>{onStatus(select.dataset.quest,select.value);renderEntity(key);});
      if($('#mc-item-retry'))$('#mc-item-retry').onclick=()=>{void loadItem(key,true);renderEntity(key,false);};
      if($('#mc-market-refresh'))$('#mc-market-refresh').onclick=()=>void market.refresh();
      if(!focus)detail.querySelectorAll('details').forEach(d=>{d.open=expanded.has(d.querySelector('summary')?.textContent);});
      bindRows(detail);dialog.scrollTop=focus?0:scroll;if(focus||hadHeadingFocus)$('#mc-entity-name').focus({preventScroll:true});
      updateMarket();
    }
    function openEntity(key){
      clearTimeout(timer);
      const e=index?.get(key);if(!e)return;
      if(e.type==='map'&&e.covered){marketWatch.view(false);dialog.close();onMap(e.id,stack.length?index.get(stack.at(-1))?.type:null);return;}
      if(!stack.length){searchScroll=dialog.scrollTop;lastKey=key;input.blur();}
      stack.push(key);if(e.type==='item'){void loadItem(key);if(!e.cash&&sourceStates.get(key)?.state!=='ready')void loadSources(e);}renderEntity(key);marketWatch.view(e.type==='item');
    }
    $('#mc-search-back').onclick=()=>{
      stack.pop();if(stack.length){renderEntity(stack.at(-1));marketWatch.view(Boolean(visibleItem));}else{showResults();dialog.scrollTop=searchScroll;list.querySelector('[data-entity="'+lastKey+'"]')?.focus({preventScroll:true});}
    };
    dialog.addEventListener('close',()=>{clearTimeout(timer);visibleItem=null;marketWatch.view(false);});
    async function ready(){
      if(index){showResults();return;}
      if(loading)return loading;
      status.textContent='Opening search catalog…';list.innerHTML='';
      loading=loader.load().then(data=>{catalog=data;index=MapleSearch.create(data);
        byName=new Map();for(const x of data.entities)if(['npc','monster','map','quest'].includes(x.type)){const k=x.type+':'+x.name.toLowerCase(),had=byName.get(k);if(!had||(x.type==='map'&&x.covered&&!had.covered))byName.set(k,x);}itemIdentities=MapleMarketData.identities(data.entities);showResults();}).catch(()=>{
        status.textContent='Search catalog could not load. Check your connection and try again.';
        list.innerHTML='<button type="button" id="mc-search-retry">Retry search</button>';
        $('#mc-search-retry').onclick=()=>ready();
      }).finally(()=>{loading=null;});return loading;
    }
    input.oninput=()=>{clearTimeout(timer);limit=30;timer=setTimeout(showResults,65);};
    input.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();list.querySelector('[data-entity]')?.focus();}if(e.key==='Enter'){e.preventDefault();clearTimeout(timer);showResults();list.querySelector('[data-entity]')?.click();}};
    function open(){stack=[];detail.hidden=true;$('#mc-search-listing').hidden=false;$('#mc-search-back').hidden=true;$('#mc-search-title').textContent='Search Maple Atlas';dialog.showModal();input.focus();void ready();}
    $('#mc-mobile-search').onclick=open;$('#mc-desktop-search').onclick=open;
    // Opens one record by type and exact name (an item, monster, NPC or quest), e.g. from the quest helper.
    async function show(type,name){
      stack=[];detail.hidden=true;$('#mc-search-listing').hidden=false;$('#mc-search-back').hidden=true;if(!dialog.open)dialog.showModal();
      await ready();if(!catalog)return false;
      const want=String(name).toLowerCase(),norm=v=>String(v).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      const e=catalog.entities.find(x=>x.type===type&&x.name.toLowerCase()===want)||catalog.entities.find(x=>x.type===type&&norm(x.name)===norm(name));
      if(!e){input.value=name;showResults();return false;}
      openEntity(e.key);return true;
    }
    return {open,show};
  }
  scope.MapleSearchUI={create};
})(globalThis);
