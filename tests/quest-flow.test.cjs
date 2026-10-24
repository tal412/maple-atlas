const assert=require('node:assert/strict');
const {create,npcKey}=require('../src/quest-flow.js');
const {quests}=require('../data/world.json');
const flow=create(quests);
const ids=rows=>rows.map(q=>q.id);
const olaf=status=>ids(flow.current(status,18).filter(q=>q.npc==='Olaf'));

assert.deepEqual(olaf({}),['10000']);
assert.deepEqual(olaf({'10000':'in-progress'}),['10000']);
assert.deepEqual(olaf({'10000':'completed'}),['10009']);
assert.deepEqual(ids(flow.journal({'10000':'completed'},18)),['10009'],'The successor must appear even though it has never been tracked');
assert.deepEqual(olaf({'10000':'completed','10009':'completed'}),[]);
assert.deepEqual(olaf({'10000':'skipped'}),[],'Skipping must not unlock the successor');
assert.deepEqual(olaf({'10009':'in-progress'}),['10000'],'Legacy out-of-order progress must not bypass a prerequisite');
assert.deepEqual(olaf({'10000':'not-started','10009':'completed'}),['10000'],'Undo must bring back the earlier quest');

const q=(id,npc,level,requires=[],next=null)=>({id,npc,npcId:npc,level,next,objectives:requires.map(id=>({id,type:'quest',count:1}))});
const sample=create([
  q('later','A',1,['first']),q('first','A',8,[],'later'),
  q('independent','A',10),q('handoff','B',8,['later']),
  q('missing','C',1,['outside-export']),q('cycle1','D',1,['cycle2']),q('cycle2','D',1,['cycle1'])
]);
assert.deepEqual(ids(sample.current({},18)),['first']);
assert.deepEqual(ids(sample.current({first:'completed'},18)),['later'],'Dependencies take precedence over the quest level or source order');
assert(ids(sample.journal({first:'completed',later:'completed'},18)).includes('handoff'),'Cross-NPC handoffs remain in the journal');
assert.deepEqual(ids(sample.current({first:'completed',later:'completed',independent:'in-progress'},18)),['handoff','independent']);

const levels=create([q('higher','A',30),q('lower','A',8)]);
assert.deepEqual(ids(levels.current({},18)),['lower']);
assert.deepEqual(ids(levels.current({higher:'in-progress'},18)),['higher'],'An existing active quest is retained');

// Walk the real graph: every displayed step has its prerequisites completed and
// no NPC appears twice, including branches and quests that hand off to another NPC.
const status={};let steps=0;
while(true){
  const rows=flow.current(status,100);if(!rows.length)break;
  assert.equal(new Set(rows.map(npcKey)).size,rows.length);
  for(const quest of rows){assert.deepEqual(flow.remaining(quest,status),[]);status[quest.id]='completed';steps++;}
  assert(steps<=quests.length,'Progression must terminate');
}
assert(steps>300,'Most of the recorded graph should be reachable');
assert(!status['10617']&&!status['10621']&&!status['506018'],'Missing prerequisites must stay blocked');
console.log('PASS: one quest per NPC, chain progression, undo, skipped/unknown prerequisites, cross-NPC handoffs and '+steps+' reachable recorded quests.');
