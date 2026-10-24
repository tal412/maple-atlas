(function(scope){
  const labels={map:'Locations',monster:'Monsters',npc:'NPCs',quest:'Quests',item:'Items',recipe:'Crafting',skill:'Skills'};
  const singular={map:'Location',monster:'Monster',npc:'NPC',quest:'Quest',item:'Item',recipe:'Recipe',skill:'Skill'};
  const icons={map:'map-pin',monster:'swords',npc:'user-round',quest:'flag',item:'package',recipe:'hammer',skill:'sparkles'};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=n=>Number(n).toLocaleString();
  function create({root,url,onMap,questMarkup,onStatus,questStatus,currentQuestIds,remainingQuests}){
    const $=s=>root.querySelector(s),dialog=$('#mc-search-dialog'),input=$('#mc-search-input');
    const list=$('#mc-search-results'),filters=$('#mc-search-filters'),detail=$('#mc-search-entity'),status=$('#mc-search-status');
    const loader=MapleSearchData.create({url,channel:root.dataset.channel});
    const items=MapleItemData.create({channel:root.dataset.channel}),itemRecords=new Map(),itemStates=new Map();
    let index,catalog,loading,category='all',limit=30,timer,stack=[],lastKey=null,searchScroll=0;
    const icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>';
    const refreshIcons=()=>globalThis.lucide?.createIcons({attrs:{width:20,height:20}});
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
      const npc=e.cash?'':blocked||e.sell!=null?'<div class="mc-worth-value"><span>NPC sell value</span><strong>'+(blocked?'Cannot sell to NPCs':number(e.sell)+' <small>mesos / item</small>')+'</strong></div><p>NPC purchase prices and player-market prices are separate.</p>':'<p>The game source does not supply an NPC sell value for this item.</p>';
      return '<section class="mc-worth"><h3>'+(e.cash?'Market price':'Item value')+'</h3>'+npc+'<div class="mc-market-check"><p>Live quotes aren’t available here yet. Compare recent listings and sales for this item.</p>'+external('https://maplestory.market/items?q='+encodeURIComponent(e.name),'View '+e.name+' listings')+external('https://meowdb.com/msclassic/price-check','Check NiaMeowDB')+'</div></section>';
    }
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
      const scroll=dialog.scrollTop;
      const expanded=focus?new Set():new Set([...detail.querySelectorAll('details[open]')].map(d=>d.querySelector('summary')?.textContent));
      const hadHeadingFocus=!focus&&detail.querySelector('#mc-entity-name')===document.activeElement;
      $('#mc-search-listing').hidden=true;detail.hidden=false;$('#mc-search-back').hidden=false;$('#mc-search-title').textContent=singular[e.type]+' details';
      const blocked=e.type==='quest'?remainingQuests(e.id):[];
      detail.innerHTML='<div class="mc-entity-heading">'+portrait(e)+'<div><h3 tabindex="-1" id="mc-entity-name">'+esc(e.name)+'</h3><p>'+esc(subtitle(e))+'</p></div></div>'+
        (e.limited&&e.type!=='item'?'<p class="mc-record-note">This name exists in the game export. Details are not verified in this snapshot.</p>':'')+
        (e.type==='map'&&!e.covered?'<p class="mc-record-note">This location is outside the atlas’s verified route coverage.</p>':'')+
        (e.type==='quest'?'<p class="mc-record-note">'+esc(questStatus(e.id))+(blocked.length?' · Earlier quests required: '+blocked.map(esc).join(', '):'')+'</p>'+questMarkup(e.id):stats(e))+
        (e.description?'<details class="mc-search-description"><summary>About '+esc(e.name)+'</summary><p>'+esc(e.description)+'</p></details>':'')+
        (e.type==='item'?cashInfo(e)+worth(e):'')+relationGroups(e)+
        (e.type==='monster'?'<p class="mc-record-note">These are recorded spawn locations. Live spawns and monster drop tables are not available in this snapshot.</p>':'')+
        (e.type==='item'?apiInfo(e):'')+
        '<footer class="mc-search-provenance">Snapshot '+esc(catalog.snapshot)+' · Game data and sprites © Nexon'+external('https://github.com/ohmi69/osms_datamine_dashboard/tree/'+catalog.sourceCommit+'/data/current','OSMS source data')+'</footer>';
      detail.querySelectorAll('[data-quest]').forEach(select=>select.onchange=()=>{onStatus(select.dataset.quest,select.value);renderEntity(key);});
      if($('#mc-item-retry'))$('#mc-item-retry').onclick=()=>{void loadItem(key,true);renderEntity(key,false);};
      if(!focus)detail.querySelectorAll('details').forEach(d=>{d.open=expanded.has(d.querySelector('summary')?.textContent);});
      bindRows(detail);dialog.scrollTop=focus?0:scroll;if(focus||hadHeadingFocus)$('#mc-entity-name').focus({preventScroll:true});
    }
    function openEntity(key){
      clearTimeout(timer);
      const e=index?.get(key);if(!e)return;
      if(e.type==='map'&&e.covered){dialog.close();onMap(e.id,stack.length?index.get(stack.at(-1))?.type:null);return;}
      if(!stack.length){searchScroll=dialog.scrollTop;lastKey=key;input.blur();}
      stack.push(key);if(e.type==='item')void loadItem(key);renderEntity(key);
    }
    $('#mc-search-back').onclick=()=>{
      stack.pop();if(stack.length)renderEntity(stack.at(-1));else{showResults();dialog.scrollTop=searchScroll;list.querySelector('[data-entity="'+lastKey+'"]')?.focus({preventScroll:true});}
    };
    dialog.addEventListener('close',()=>clearTimeout(timer));
    async function ready(){
      if(index){showResults();return;}
      if(loading)return loading;
      status.textContent='Opening search catalog…';list.innerHTML='';
      loading=loader.load().then(data=>{catalog=data;index=MapleSearch.create(data);showResults();}).catch(()=>{
        status.textContent='Search catalog could not load. Check your connection and try again.';
        list.innerHTML='<button type="button" id="mc-search-retry">Retry search</button>';
        $('#mc-search-retry').onclick=()=>ready();
      }).finally(()=>{loading=null;});return loading;
    }
    input.oninput=()=>{clearTimeout(timer);limit=30;timer=setTimeout(showResults,65);};
    input.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();list.querySelector('[data-entity]')?.focus();}if(e.key==='Enter'){e.preventDefault();clearTimeout(timer);showResults();list.querySelector('[data-entity]')?.click();}};
    function open(){stack=[];detail.hidden=true;$('#mc-search-listing').hidden=false;$('#mc-search-back').hidden=true;$('#mc-search-title').textContent='Search Maple Atlas';dialog.showModal();input.focus();void ready();}
    $('#mc-mobile-search').onclick=open;$('#mc-desktop-search').onclick=open;
    return {open};
  }
  scope.MapleSearchUI={create};
})(globalThis);
