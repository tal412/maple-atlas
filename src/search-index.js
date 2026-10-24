(function(scope) {
  const types=['map','monster','npc','quest','item','recipe','skill'];
  const normalize=value=>String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const words=value=>normalize(value).split(' ').filter(Boolean);
  const grams=value=>new Set(Array.from({length:Math.max(0,value.length-2)},(_,i)=>value.slice(i,i+3)));
  const singular=w=>w.length>3&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w;
  function distance(a,b) {
    if(Math.abs(a.length-b.length)>2)return 3;
    const rows=[Array.from({length:b.length+1},(_,i)=>i)];
    for(let i=1;i<=a.length;i++){
      const row=[i];
      for(let j=1;j<=b.length;j++){
        row[j]=Math.min(rows[i-1][j]+1,row[j-1]+1,rows[i-1][j-1]+Number(a[i-1]!==b[j-1]));
        if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])row[j]=Math.min(row[j],rows[i-2][j-2]+1);
      }
      rows.push(row);
    }
    return rows[a.length][b.length];
  }
  function intent(query) {
    let tokens=words(query),type=null;
    const worth=tokens.some(t=>['worth','price','prices','value','cost'].includes(t));
    const typeNames={locations:'map',location:'map',maps:'map',map:'map',monsters:'monster',monster:'monster',mobs:'monster',npc:'npc',npcs:'npc',quests:'quest',quest:'quest',items:'item',item:'item',recipes:'recipe',recipe:'recipe',skills:'skill',skill:'skill'};
    if(typeNames[tokens[0]]){type=typeNames[tokens.shift()];}
    if(worth&&!type)type='item';
    tokens=tokens.filter(t=>!['where','can','i','find','get','show','me','the','a','an','of','is','in','how','much','does','for','worth','price','prices','value','cost'].includes(t));
    return {tokens:tokens.slice(0,12),type,worth};
  }
  function create(catalog) {
    const records=catalog.entities,byKey=new Map(records.map(e=>[e.key,e]));
    const postings=new Map(),prefixes=new Map(),deletions=new Map(),trigrams=new Map(),names=new Map(),relations=new Map();
    const put=(index,key,value)=>{if(!index.has(key))index.set(key,new Set());index.get(key).add(value);};
    function addWords(value,id,weight,fuzzy=true){
      for(const token of new Set(words(value))){
        if(!postings.has(token))postings.set(token,new Map());
        const post=postings.get(token);post.set(id,Math.max(post.get(id)||0,weight));
        if(fuzzy&&!names.has(token))names.set(token,true);
      }
    }
    records.forEach((e,id)=>{
      addWords(e.name,id,10);for(const alias of e.aliases||[])addWords(alias,id,10);
      addWords(e.id,id,10);
      addWords([e.street,e.region,e.npcName,e.category,e.subcategory,e.job,e.discipline,e.success].filter(x=>x!=null).join(' '),id,3);
      addWords((e.maps||[]).map(map=>byKey.get('map:'+map)?.name||'').join(' '),id,2);
      if(e.type==='map')addWords([...(e.npcs||[]).map(n=>byKey.get('npc:'+n)?.name||''),...(e.monsters||[]).map(m=>byKey.get('monster:'+m)?.name||'')].join(' '),id,2);
      addWords([...(e.objectives||[]),...(e.rewards||[]),...(e.ingredients||[])].map(o=>o.name).join(' '),id,2);
      // Descriptions are exact-token searchable, but do not swamp typo suggestions.
      addWords(e.description,id,1,false);
    });
    for(const token of names.keys()){
      for(let n=2;n<Math.min(24,token.length);n++)put(prefixes,token.slice(0,n),token);
      if(token.length>=3){put(deletions,token,token);for(let n=0;n<token.length;n++)put(deletions,token.slice(0,n)+token.slice(n+1),token);}
      for(const gram of grams(token))put(trigrams,gram,token);
    }
    function relate(from,label,to,count){
      if(!byKey.has(from)||!byKey.has(to)||from===to)return;
      if(!relations.has(from))relations.set(from,new Map());
      const group=relations.get(from);if(!group.has(label))group.set(label,new Map());
      group.get(label).set(to,{key:to,count});
    }
    for(const e of records){
      for(const id of e.maps||[])relate(e.key,e.type==='quest'?'NPC locations':'Found in','map:'+id);
      if(e.type==='map'){
        for(const id of e.npcs||[])relate(e.key,'NPCs','npc:'+id);
        for(const id of e.monsters||[])relate(e.key,'Monsters','monster:'+id);
      }
      if(e.type==='quest'){
        if(e.npc){relate(e.key,'NPC','npc:'+e.npc);relate('npc:'+e.npc,'Quests',e.key);}
        for(const o of e.objectives||[]){const kind={mob:'monster',item:'item',quest:'quest'}[o.type];if(!kind)continue;const key=kind+':'+o.id;relate(e.key,'Requirements',key,o.count);relate(key,'Needed for quests',e.key,o.count);}
        for(const r of e.rewards||[]){relate(e.key,'Rewards','item:'+r.id,r.count);relate('item:'+r.id,'Quest rewards',e.key,r.count);}
        if(e.next){relate(e.key,'Next quest','quest:'+e.next);relate('quest:'+e.next,'Earlier quest',e.key);}
      }
      if(e.type==='recipe'){
        relate(e.key,'Produces','item:'+e.output,e.count);relate('item:'+e.output,'Crafting recipes',e.key);
        for(const i of e.ingredients||[])for(const key of i.keys){relate(e.key,'Ingredients',key,i.count);relate(key,'Used in recipes',e.key,i.count);}
      }
    }
    function matches(token){
      const candidates=new Map();const offer=(word,quality)=>{if(postings.has(word))candidates.set(word,Math.max(candidates.get(word)||0,quality));};
      offer(token,100);offer(singular(token),96);
      if(token.length>=2)for(const word of prefixes.get(token)||[])offer(word,80+Math.min(15,token.length/word.length*15));
      if(token.length>=3){
        const possible=new Set(deletions.get(token)||[]);
        for(let n=0;n<token.length;n++)for(const w of deletions.get(token.slice(0,n)+token.slice(n+1))||[])possible.add(w);
        if(token.length>=6)for(const g of grams(token))for(const w of trigrams.get(g)||[])possible.add(w);
        for(const w of possible){if(/^\d+$/.test(token))continue;const d=distance(token,w);if(d<= (token.length>=7?2:1))offer(w,72-d*9);}
      }
      const hits=new Map();
      for(const [word,quality] of candidates)for(const [id,weight] of postings.get(word)){
        const score=quality*weight;if(score>(hits.get(id)?.score||0))hits.set(id,{score,fuzzy:quality<80});
      }
      return hits;
    }
    const defaultRank=e=>Number(!e.limited)*10+Number(Boolean(e.town))*30+Number(Boolean(e.covered))*10+(e.type==='monster'?5:0)+(['map:10000000','map:10001000','map:10002000','map:10003000','map:10004000','map:10005000','map:11000000'].includes(e.key)?30:0);
    function search(query,{type='all',limit=40}={}){
      const parsed=intent(query),effective=type==='all'?parsed.type:type;
      let pool=null;
      for(const token of parsed.tokens){
        const hits=matches(token);
        if(pool===null)pool=hits;
        else for(const [id,result] of pool){const hit=hits.get(id);if(!hit)pool.delete(id);else pool.set(id,{score:result.score+hit.score,fuzzy:result.fuzzy||hit.fuzzy});}
        if(!pool.size)break;
      }
      if(pool===null)pool=new Map(records.map((e,id)=>[id,{score:defaultRank(e),fuzzy:false}]));
      const phrase=normalize(query),core=parsed.tokens.join(' '),counts=Object.fromEntries(types.map(t=>[t,0]));
      const results=[];
      for(const [id,hit] of pool){
        const entity=records[id];counts[entity.type]++;
        if(effective&&effective!==entity.type)continue;
        const exact=Boolean(core)&&[entity.name,...entity.aliases||[]].some(n=>[phrase,core].includes(normalize(n)));
        const close=core.length>=3&&distance(core,normalize(entity.name))<=1;
        results.push({entity,score:hit.score+(exact?5000:close?2000:0)+defaultRank(entity),fuzzy:!exact&&hit.fuzzy});
      }
      results.sort((a,b)=>b.score-a.score||a.entity.name.localeCompare(b.entity.name)||a.entity.key.localeCompare(b.entity.key));
      return {results:results.slice(0,limit),total:results.length,counts,intent:parsed};
    }
    return {search,get:key=>byKey.get(key),related:key=>relations.get(key)||new Map(),size:records.length,tokenCount:postings.size};
  }
  const api={create,normalize,distance,intent};scope.MapleSearch=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
