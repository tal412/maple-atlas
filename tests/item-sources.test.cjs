const assert=require('node:assert/strict');
const S=require('../src/item-sources.js');
const row=title=>({title});
const replies={
  shop_items:{cargoquery:[row({page:'24 Hr Mobile Store','shop id':'24 Hr Mobile Store','item id':'Pure Water',price:'1120',currency:'Mesos','purchase limit':null}),row({page:'Mr. Sweatbottom','shop id':'Mr. Sweatbottom','item id':'Pure Water',price:'1100',currency:'Mesos','purchase limit':'5'})]},
  shops:{cargoquery:[row({page:'Mr. Sweatbottom','name en':'Mr. Sweatbottom',npc:'Mr. Sweatbottom',map:'Regular Sauna',town:'Sleepywood','shop type':'General',currency:'Mesos'})]},
  monster_drops:{cargoquery:[row({'monster id':'Snail','drop rate':'51.45','rate low':'41.9','rate high':'60.9','min quantity':null,'max quantity':null,'quest flag':'0'}),row({'monster id':'Orange Mushroom','drop rate':null,'quest flag':'1'}),row({'monster id':null})]},
  quest_rewards:{cargoquery:[row({'quest id':'Estelle&#039;s Request',quantity:'10',chance:null})]},
  quest_given_items:{cargoquery:[]},
  reactor_drops:{cargoquery:[row({'reactor id':'Box','drop rate':'20','required quest':''})]},
};
(async()=>{
  const calls=[];let store={},clock=1e12;
  const request=async(url,options)=>{assert.equal(options.credentials,'omit');const p=new URL(url).searchParams;calls.push(p);assert.equal(p.get('origin'),'*');return {ok:true,json:async()=>replies[p.get('tables')]};};
  const sources=S.create({request,store:{read:k=>store[k],write:(k,v)=>{store[k]=v;}},now:()=>clock});
  const r=await sources.load('Pure Water'),s=r.sources;
  assert.equal(calls.length,6,'Five lookups plus one for the shops found');
  assert.match(calls.find(p=>p.get('tables')==='shops').get('where'),/name_en='24 Hr Mobile Store' OR name_en='Mr. Sweatbottom'/);
  assert.deepEqual(s.shops.map(x=>[x.npc,x.map,x.town,x.price,x.limit]),[['Mr. Sweatbottom','Regular Sauna','Sleepywood',1100,5],['24 Hr Mobile Store',null,null,1120,null]],'Cheapest first, shop details joined, unknown shop kept');
  assert.deepEqual(s.drops.map(x=>[x.monster,x.rate,x.quest]),[['Snail',51.45,false],['Orange Mushroom',null,true]],'Rows without a monster are dropped');
  assert.equal(s.rewards[0].quest,"Estelle's Request",'HTML entities decoded');
  assert.equal(s.boxes[0].quest,null);assert(!S.empty(s));
  assert.equal((await sources.load('Pure Water')).cached,true);assert.equal(calls.length,6,'Cached for a week');
  clock+=8*86400000;const failing=S.create({request:async()=>{throw Error('offline');},store:{read:k=>store[k],write:()=>{}},now:()=>clock});
  const stale=await failing.load('Pure Water');assert(stale.stale&&stale.cached,'Offline falls back to the saved copy');
  await assert.rejects(failing.load('Never Seen'),/offline/);
  calls.length=0;await sources.load("Jr. Necki's Skin");assert(calls[0].get('where').includes("'Jr. Necki''s Skin'"),'Names are quoted safely');
  assert.throws(()=>S.rows({cargoquery:'x'}));assert.throws(()=>S.rows({error:{code:'db_error'}}));
  assert.equal(S.pageURL('Pure Water'),'https://mapleclassic.wiki/wiki/Pure_Water');
  assert.equal(S.imageURL('Mr. Sweatbottom'),'https://mapleclassic.wiki/wiki/Special:FilePath/Mr._Sweatbottom.png');
  console.log('PASS: wiki shops, drops, quests and boxes · shop joins · ordering · caching and offline fallback · safe quoting');
})().catch(e=>{console.error(e);process.exitCode=1;});
