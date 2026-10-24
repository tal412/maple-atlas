(function(scope) {
  const npcKey=q=>q.npcId?'id:'+q.npcId:q.npc?'name:'+q.npc:'quest:'+q.id;
  function create(quests) {
    const byId=new Map(quests.map(q=>[String(q.id),q]));
    const prerequisites=new Map(quests.map(q=>[String(q.id),new Set(q.objectives.filter(o=>o.type==='quest').map(o=>String(o.id)))]));
    for(const q of quests)if(q.next&&byId.has(String(q.next)))prerequisites.get(String(q.next)).add(String(q.id));
    const compare=(a,b)=>a.level-b.level||String(a.id).localeCompare(String(b.id),undefined,{numeric:true});
    function remaining(q,status) {return [...prerequisites.get(String(q.id))].filter(id=>status[id]!=='completed');}
    function current(status,level) {
      const groups=new Map();
      // A skipped quest is not a completed prerequisite. A later step stays hidden.
      for(const q of quests){
        if(['completed','skipped'].includes(status[q.id])||remaining(q,status).length)continue;
        const key=npcKey(q);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(q);
      }
      return [...groups.values()].map(qs=>qs.sort((a,b)=>
        Number(status[b.id]==='in-progress')-Number(status[a.id]==='in-progress')||
        Number(a.level>level)-Number(b.level>level)||
        Number(prerequisites.get(String(b.id)).size>0)-Number(prerequisites.get(String(a.id)).size>0)||compare(a,b)
      )[0]).sort(compare);
    }
    function journal(status,level,starter='Olaf') {
      const tracked=quests.filter(q=>Object.hasOwn(status,q.id));
      const groups=new Set((tracked.length?tracked:quests.filter(q=>q.npc===starter)).map(npcKey));
      return current(status,level).filter(q=>groups.has(npcKey(q))||
        [...prerequisites.get(String(q.id))].some(id=>status[id]==='completed'));
    }
    return {npcKey,current,journal,remaining};
  }
  const api={create,npcKey};scope.MapleQuestFlow=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
