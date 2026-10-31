/* How to get an item: NPC shops, monster drops, quests and boxes from the
 * MapleClassic Wiki's public Cargo tables (community data, CC BY-NC-SA 4.0).
 * Queried by item name, cached for a week per channel, never invented: an empty
 * result means the wiki has no record, not that the item cannot be obtained. */
(function(scope){
  const api='https://mapleclassic.wiki/api.php',wiki='https://mapleclassic.wiki/wiki/',week=7*86400000;
  const decode=s=>String(s??'').replace(/&#0?39;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
  const quote=s=>"'"+String(s).replace(/\\/g,'').replace(/'/g,"''")+"'";
  const number=v=>{const n=Number(v);return v!==null&&v!==''&&Number.isFinite(n)?n:null;};
  const pageURL=name=>wiki+encodeURIComponent(String(name).replace(/ /g,'_'));
  const imageURL=name=>wiki+'Special:FilePath/'+encodeURIComponent(String(name).replace(/ /g,'_'))+'.png';
  // Turns Cargo rows (each {title:{field:value}}) into plain objects; rejects odd payloads.
  function rows(payload,max=200){
    if(!Array.isArray(payload?.cargoquery)||payload.cargoquery.length>max)throw Error('The wiki listing changed format.');
    return payload.cargoquery.map(r=>Object.fromEntries(Object.entries(r?.title||{}).map(([k,v])=>[k,v==null?null:decode(v)])));
  }
  function parse({shopItems=[],shops=[],drops=[],rewards=[],given=[],boxes=[]}){
    const shopInfo=new Map(shops.map(s=>[s['name en']||s.page,s]));
    const seen=new Set();
    return {
      shops:shopItems.filter(r=>r['shop id']&&!seen.has(r['shop id'])&&seen.add(r['shop id'])).map(r=>{const s=shopInfo.get(r['shop id'])||{};
        return {shop:r['shop id'],npc:s.npc||r['shop id'],map:s.map||null,town:s.town||null,type:s['shop type']||null,price:number(r.price),currency:r.currency||s.currency||'Mesos',limit:number(r['purchase limit'])};})
        .sort((a,b)=>(a.price??Infinity)-(b.price??Infinity)),
      drops:drops.filter(r=>r['monster id']).map(r=>({monster:r['monster id'],rate:number(r['drop rate']),low:number(r['rate low']),high:number(r['rate high']),min:number(r['min quantity']),max:number(r['max quantity']),quest:r['quest flag']==='1'}))
        .sort((a,b)=>(b.rate??-1)-(a.rate??-1)),
      rewards:rewards.filter(r=>r['quest id']).map(r=>({quest:r['quest id'],quantity:number(r.quantity),chance:number(r.chance)})),
      given:given.filter(r=>r['quest id']).map(r=>({quest:r['quest id'],quantity:number(r.quantity)})),
      boxes:boxes.filter(r=>r['reactor id']).map(r=>({box:r['reactor id'],rate:number(r['drop rate']),quest:r['required quest']||null})),
    };
  }
  const empty=s=>!s.shops.length&&!s.drops.length&&!s.rewards.length&&!s.given.length&&!s.boxes.length;
  function storage(channel){
    const key=name=>'maple-atlas-item-sources:'+channel+':'+name.toLowerCase();
    return {read:name=>{try{return JSON.parse(localStorage.getItem(key(name)));}catch(_){return null;}},write:(name,v)=>{try{localStorage.setItem(key(name),JSON.stringify(v));}catch(_){}}};
  }
  function create({channel='main',request=(...a)=>fetch(...a),store=storage(channel),now=Date.now,timeout=12000}={}){
    const pending=new Map();
    async function cargo(table,fields,where){
      const params=new URLSearchParams({action:'cargoquery',tables:table,fields,where,limit:'200',format:'json',origin:'*'});
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
      try{const r=await request(api+'?'+params,{credentials:'omit',signal:controller.signal});if(!r.ok)throw Error('Wiki request failed');return rows(await r.json());}
      finally{clearTimeout(timer);}
    }
    async function fetchSources(name){
      const item=quote(name);
      const [shopItems,drops,rewards,given,boxes]=await Promise.all([
        cargo('shop_items','_pageName=page,shop_id,item_id,price,currency,purchase_limit','item_id='+item),
        cargo('monster_drops','monster_id,item_id,drop_rate,rate_low,rate_high,min_quantity,max_quantity,quest_flag','item_id='+item),
        cargo('quest_rewards','quest_id,item_id,quantity,chance','item_id='+item),
        cargo('quest_given_items','quest_id,item_id,quantity','item_id='+item),
        cargo('reactor_drops','reactor_id,item_id,drop_rate,required_quest','item_id='+item),
      ]);
      const ids=[...new Set(shopItems.map(r=>r['shop id']).filter(Boolean))].slice(0,40);
      const shops=ids.length?await cargo('shops','_pageName=page,name_en,npc,map,town,shop_type,currency',ids.map(id=>'name_en='+quote(id)).join(' OR ')):[];
      return parse({shopItems,shops,drops,rewards,given,boxes});
    }
    async function load(name,{refresh=false}={}){
      name=String(name||'').trim();if(!name||name.length>160)throw Error('Choose a valid item.');
      if(pending.has(name))return pending.get(name);
      const task=(async()=>{
        const saved=store.read(name),valid=saved?.schema===1&&saved.name===name&&Number.isFinite(saved.checked);
        if(!refresh&&valid&&now()-saved.checked<week)return {...saved,cached:true};
        try{const record={schema:1,name,checked:now(),sources:await fetchSources(name)};store.write(name,record);return record;}
        catch(e){if(valid)return {...saved,cached:true,stale:true};throw e;}
      })();
      pending.set(name,task);try{return await task;}finally{pending.delete(name);}
    }
    // Every monster drop of these items (the crafting materials) in one go, cached for a week:
    // [{monster, item, rate}], for the map page's Ores tab.
    let craftTask=null;
    async function craftDrops(names){
      const key='__crafting:'+names.length;
      const saved=store.read(key);
      if(saved?.schema===1&&Number.isFinite(saved.checked)&&now()-saved.checked<week)return saved.rows;
      craftTask??=(async()=>{
        const out=[],where='item_id IN ('+names.map(quote).join(',')+')';
        for(let offset=0;offset<3000;offset+=500){
          const params=new URLSearchParams({action:'cargoquery',tables:'monster_drops',fields:'monster_id,item_id,drop_rate',where,limit:'500',offset:String(offset),format:'json',origin:'*'});
          const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
          let page;
          try{const r=await request(api+'?'+params,{credentials:'omit',signal:controller.signal});if(!r.ok)throw Error('Wiki request failed');page=rows(await r.json(),500);}
          finally{clearTimeout(timer);}
          for(const r of page)if(r['monster id']&&r['item id'])out.push({monster:r['monster id'],item:r['item id'],rate:number(r['drop rate'])});
          if(page.length<500)break;
        }
        store.write(key,{schema:1,name:key,checked:now(),rows:out});
        return out;
      })().finally(()=>{craftTask=null;});
      try{return await craftTask;}catch(e){if(saved?.rows)return saved.rows;throw e;}
    }
    return {load,craftDrops};
  }
  const exported={create,parse,rows,empty,pageURL,imageURL,license:'https://creativecommons.org/licenses/by-nc-sa/4.0/'};
  scope.MapleItemSources=exported;if(typeof module!=='undefined')module.exports=exported;
})(globalThis);
