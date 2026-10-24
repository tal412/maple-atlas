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
    let index,catalog,loading,category='all',limit=30,timer,stack=[],lastKey=null,searchScroll=0;
    const icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>';
    const refreshIcons=()=>globalThis.lucide?.createIcons({attrs:{width:20,height:20}});
    function portrait(e){
      const src=e.image?'https://cdn.jsdelivr.net/gh/ohmi69/osms_datamine_dashboard@'+catalog.sourceCommit+'/data/'+e.image:null;
      return '<span class="mc-search-portrait" aria-hidden="true">'+icon(icons[e.type])+(src?'<img src="'+esc(src)+'" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">':'')+'</span>';
    }
    function imageEvents(){
      dialog.querySelectorAll('.mc-search-portrait img').forEach(img=>{img.onload=()=>img.parentElement.classList.add('mc-image-ready');img.onerror=()=>img.remove();if(img.complete&&img.naturalWidth)img.onload();});refreshIcons();
    }
    function subtitle(e,worth=false){
      let parts=[singular[e.type]];
      if(e.limited)parts.push('Name record', 'ID '+e.id);
      else if(e.type==='map')parts.push(e.street||e.region||'',e.covered?'Explore map':'Outside route coverage');
      else if(e.type==='monster')parts.push('Lv. '+e.level,number(e.exp)+' EXP');
      else if(e.type==='npc')parts.push(number(e.maps?.length||0)+' recorded location'+(e.maps?.length===1?'':'s'));
      else if(e.type==='quest')parts.push(e.npcName||'', 'Lv. '+e.level+'+');
      else if(e.type==='item')parts.push(e.category, e.level!=null?'Lv. '+e.level:'',e.success!=null?e.success+'% success':'',worth?(e.sell!=null?'NPC sell '+number(e.sell)+' mesos':'NPC value unknown'):'');
      else if(e.type==='recipe')parts.push(e.discipline,'Crafting Lv. '+e.level);
      else if(e.type==='skill')parts.push(e.job);
      return parts.filter(Boolean).join(' · ');
    }
    function row(e,{fuzzy=false,worth=false,count}={}){
      return '<button type="button" class="mc-search-result" data-entity="'+esc(e.key)+'">'+portrait(e)+'<span class="mc-search-copy"><strong>'+esc(e.name)+(count?' <small>× '+number(count)+'</small>':'')+'</strong><small>'+esc(subtitle(e,worth))+'</small>'+(fuzzy?'<small class="mc-similar">Similar match</small>':'')+'</span>'+icon(e.type==='map'&&e.covered?'arrow-up-right':'chevron-right')+'</button>';
    }
    function bindRows(container){container.querySelectorAll('[data-entity]').forEach(b=>b.onclick=()=>openEntity(b.dataset.entity));imageEvents();}
    function showResults(){
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
      return '<section class="mc-worth"><h3>What’s it worth?</h3><div class="mc-worth-value"><span>NPC sell value</span><strong>'+(blocked?'Cannot sell to NPCs':e.sell!=null?number(e.sell)+' <small>mesos / item</small>':'Not recorded')+'</strong></div><p>Game-data snapshot · '+esc(catalog.snapshot)+'. NPC buy prices and player-market prices are different.</p><div class="mc-market-check"><strong>Player-market value</strong><p>No live market feed is connected. Check current sales and listings; item stats and scrolls affect the price.</p>'+external('https://meowdb.com/msclassic/price-check','Check prices on NiaMeowDB')+external('https://beta.meso.watch/','Open MesoWatch')+'</div></section>';
    }
    function stats(e){
      const values=e.type==='monster'?[['Level',e.level],['HP',e.hp],['EXP',e.exp]]:
        e.type==='skill'?[['Class',e.job],['Master level',e.maxLevel]]:
        e.type==='recipe'?[['Discipline',e.discipline],['Crafting level',e.level],['Craft fee',number(e.mesos)+' mesos']]:
        e.type==='item'?[['Required level',e.level],['Class',e.job],['Success',e.success!=null?e.success+'%':null],
          ...Object.entries({incPAD:'Attack',incMAD:'Magic attack',incPDD:'Defense',incMDD:'Magic defense',incSTR:'STR',incDEX:'DEX',incINT:'INT',incLUK:'LUK',tuc:'Upgrade slots',slotMax:'Stack size'}).map(([key,label])=>[label,e.stats?.[key]])]:[];
      return '<dl class="mc-search-stats">'+values.filter(([,v])=>v!=null).map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(typeof v==='number'?number(v):v)+'</dd></div>').join('')+'</dl>';
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
    function renderEntity(key){
      const e=index.get(key);if(!e)return;
      $('#mc-search-listing').hidden=true;detail.hidden=false;$('#mc-search-back').hidden=false;$('#mc-search-title').textContent=singular[e.type]+' details';
      const blocked=e.type==='quest'?remainingQuests(e.id):[];
      detail.innerHTML='<div class="mc-entity-heading">'+portrait(e)+'<div><h3 tabindex="-1" id="mc-entity-name">'+esc(e.name)+'</h3><p>'+esc(subtitle(e))+'</p></div></div>'+
        (e.limited?'<p class="mc-record-note">This name exists in the game export. Stats and availability are not verified in this snapshot.</p>':'')+
        (e.type==='map'&&!e.covered?'<p class="mc-record-note">This location is outside the atlas’s verified route coverage.</p>':'')+
        (e.type==='quest'?'<p class="mc-record-note">'+esc(questStatus(e.id))+(blocked.length?' · Earlier quests required: '+blocked.map(esc).join(', '):'')+'</p>'+questMarkup(e.id):stats(e))+
        (e.description?'<details class="mc-search-description"><summary>About '+esc(e.name)+'</summary><p>'+esc(e.description)+'</p></details>':'')+
        (e.type==='item'?worth(e):'')+relationGroups(e)+
        (e.type==='monster'?'<p class="mc-record-note">These are recorded spawn locations. Live spawns and monster drop tables are not available in this snapshot.</p>':'')+
        (e.type==='item'?'<p class="mc-record-note">Quest and crafting links come from the game export. Drop sources and shop inventories are not verified here.</p>':'')+
        '<footer class="mc-search-provenance">Snapshot '+esc(catalog.snapshot)+' · Game data and sprites © Nexon'+external('https://github.com/ohmi69/osms_datamine_dashboard/tree/'+catalog.sourceCommit+'/data/current','OSMS source data')+'</footer>';
      detail.querySelectorAll('[data-quest]').forEach(select=>select.onchange=()=>{onStatus(select.dataset.quest,select.value);renderEntity(key);});
      bindRows(detail);dialog.scrollTop=0;$('#mc-entity-name').focus({preventScroll:true});
    }
    function openEntity(key){
      clearTimeout(timer);
      const e=index?.get(key);if(!e)return;
      if(e.type==='map'&&e.covered){dialog.close();onMap(e.id,stack.length?index.get(stack.at(-1))?.type:null);return;}
      if(!stack.length){searchScroll=dialog.scrollTop;lastKey=key;input.blur();}
      stack.push(key);renderEntity(key);
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
