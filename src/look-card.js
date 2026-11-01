/* What Look says about a thing it found, the same on the phone's list (src/look-ui.js) and the
 * computer's overlay card (src/look-host.js): one or two lines of detail and, for items, the
 * player-market price.
 *
 * describe(f, ctx, env) -> {detail, extra}
 * card(result, title, env) -> {title, note, items: [{t, n, i, d, e, c, p}]} (at most 6 things)
 * env: {catalog: {by: Map}, mapOf(id), quests: [{npc, name}], priceOf(entity) -> record|null}
 */
(function(scope){
  const pct=v=>v==null?'':v>=10?Math.round(v)+'%':v>=1?v.toFixed(1)+'%':v.toFixed(2)+'%';
  const fmt=n=>Number(n).toLocaleString(undefined,{maximumFractionDigits:0});
  function describe(f,ctx,{catalog,mapOf=()=>null,quests=[]}){
    const e=catalog?.by.get(f.type+':'+f.id)||{},here=mapOf(ctx.mapId);
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
  // An item's market price as one short line ("≈ 39,999 mesos"), or ''.
  function priceLine(f,{catalog,priceOf=()=>null}){
    if(f.type!=='item')return '';
    const e=catalog?.by.get('item:'+f.id),p=e?priceOf(e):null;
    return p&&p.median!=null?'≈ '+fmt(p.median)+(p.unit==='set'?' mesos / set':' mesos'):'';
  }
  function card(r,title,env){
    const spritePath=e=>e?.image&&env.catalog?.commit?env.catalog.commit+'/data/'+e.image:'';
    const items=r.summary.filter(f=>!(f.via==='name'&&f.ui)).slice(0,6).map(f=>{const d=describe(f,r,env);return {t:f.type,n:f.name,i:spritePath(env.catalog?.by.get(f.type+':'+f.id)),d:d.detail,e:d.extra,c:f.count,p:priceLine(f,env)};});
    const m=env.mapOf?.(r.mapId);
    return {title,note:items.length?(m?'On '+m.name:''):'Nothing from the database found here'+(m?' on '+m.name:'')+'.',items};
  }
  const api={describe,card,priceLine,fmt};
  scope.MapleLookCard=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof self!=='undefined'?self:globalThis);
