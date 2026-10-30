const assert=require('node:assert/strict');
const Q=require('../src/quest-helper.js');
// Reading: misread slashes, squeezed counts, truncated titles.
const parsed=Q.parse('Quest Helper (1/5)\nChrishrama in Need of an Appre...\n111 Garnet Ore\n30 7 30 Dark Stump\nMaya and the Weird Medicine\n3 / 10 Blue Snail Shell');
assert.equal(parsed.length,2);
assert.equal(parsed[0].truncated,true);
assert.deepEqual(parsed[0].progress.map(p=>[p.have,p.need,p.name]),[[1,1,'Garnet Ore'],[30,30,'Dark Stump']]);
assert.equal(parsed[0].complete,true);assert.equal(parsed[1].complete,false);
// Wire form: bounded and validated on the phone.
const wire=Q.pack(parsed);assert.deepEqual(Q.unpack(wire).map(q=>q.title),parsed.map(q=>q.title));
assert.deepEqual(Q.unpack([{t:'abc'},{t:'Real Quest',p:[[1,0,'x'],['a',2,'y'],[1,2,'Snail']]},'junk']),[{title:'Real Quest',truncated:false,progress:[{have:1,need:2,name:'Snail',done:false}]}]);
// Matching to quest data, objectives filled in, wrapped lines merged back.
const quests=[{id:'1',name:'Luke the Security Guy',npc:'Luke',objectives:[{type:'item',id:4000,name:'Jr. Necki Skin',count:10},{type:'mob',id:7,name:'Stirge',count:20}]},{id:'2',name:"Olaf's First Training",npc:'Olaf',objectives:[{type:'mob',id:6,name:'Stump',count:8}]}];
const r=Q.resolve([{title:'Luke the Securty Guy',truncated:false,progress:[{have:7,need:10,name:'Jr Necki Skin',done:false}]},{title:'Stirge',truncated:false,progress:[]},{title:"Olaf's First Tr",truncated:true,progress:[{have:8,need:8,name:'Stump',done:true}]}],quests,{});
assert.equal(r.length,2,'The wrapped "Stirge" line joins Luke');
assert.equal(r[0].quest.id,'1');assert.equal(r[0].progress[0].objective.id,4000);assert.equal(r[0].progress[0].name,'Jr. Necki Skin');
assert(r[0].progress.some(p=>p.name==='Stirge'&&p.unknown));assert.equal(r[0].complete,false);
assert.equal(r[1].quest.id,'2');assert.equal(r[1].complete,true);
console.log('PASS: quest helper reading · wire validation · matching, objectives and wrapped lines');
// Counts read twice: a digit drawn on top of the slash is the slash misread ("2 / 10" as "21 / 10").
{
  const sym = (t, x0, x1) => ({ text: t, bbox: { x0, x1, y0: 0, y1: 10 } });
  const word = syms => ({ text: syms.map(x => x.text).join(''), bbox: { x0: syms[0].bbox.x0, x1: syms.at(-1).bbox.x1, y0: 0, y1: 10 }, symbols: syms });
  const span = Q.countSpan([word([sym('2', 0, 10), sym('1', 12, 18), sym('/', 11, 22)]), word([sym('1', 30, 36), sym('0', 38, 46)]), { text: 'Slime', bbox: { x0: 60, x1: 90, y0: 0, y1: 10 } }, { text: 'Bubble', bbox: { x0: 95, x1: 130, y0: 0, y1: 10 } }]);
  assert.equal(span.rest, 'Slime Bubble');
  assert.deepEqual(Q.countsFromBoxes(span.lead), { have: 2, need: 10 });
  // A real 21 with its own slash stays 21.
  assert.deepEqual(Q.countsFromBoxes([word([sym('2', 0, 10), sym('1', 12, 20)]), word([sym('/', 26, 36)]), word([sym('1', 42, 48), sym('0', 50, 58)])]), { have: 21, need: 10 });
  // No slash: the digits-only reader decides.
  assert.equal(Q.countsFromBoxes([word([sym('2', 0, 10), sym('7', 12, 20), sym('1', 26, 32), sym('0', 34, 42)])]), null);
  assert.deepEqual(Q.counts('2/10'), { have: 2, need: 10 });
  assert.equal(Q.counts('2/'), null);
  console.log('quest-helper: count re-read passes');
}
// A box drawn by hand around the panel: edge marks before lines, the misread title, a name glued to its count.
{
  const read = Q.parse('QuestHeper 25) po OE\nMake a Match Cards Set )\n"15 #15 Monster Card\n] Mrs: Ming Ming\'s First Worry\n¥ 10/10 Slime Buble |\n. 8/20PigsRikbon B |');
  assert.deepEqual(read.map(q => q.title.replace(/[^A-Za-z' ]/g, '').trim()), ['Make a Match Cards Set', "Mrs Ming Ming's First Worry"]);
  assert.deepEqual(read[1].progress.map(p => [p.have, p.need]), [[10, 10], [8, 20]]);
  assert.deepEqual(read[0].progress.map(p => [p.have, p.need]), [[15, 15]]);
  console.log('quest-helper: marked box reading passes');
}
// The game font's slash, found by its shape between two numbers (drawn: "10 / 10").
{
  const W = 60, H = 12, data = new Uint8ClampedArray(W * H * 4).fill(255);
  const dot = (x, y) => { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; };
  const one = x => { for (let y = 1; y < 11; y++) dot(x, y); };
  const zero = x => { for (let y = 1; y < 11; y++) { dot(x, y); dot(x + 4, y); } for (let k = 0; k < 5; k++) { dot(x + k, 1); dot(x + k, 10); } };
  one(2); zero(5);                       // 10
  for (let y = 1; y < 11; y++) dot(22 + Math.round((10 - y) * .35), y);   // a steep slash
  one(34); zero(37);                     // 10
  const split = Q.splitCounts({ width: W, height: H, data }, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
  assert.ok(split && split.have.x1 < 22 && split.need.x0 > 25, JSON.stringify(split));
  console.log('quest-helper: slash found by shape');
}
// A name garbled by busy scenery pairs with the objective that needs the same count.
{
  const quests = [{ id: 'q1', name: 'Make a Match Cards Set', objectives: [{ type: 'item', name: 'Monster Card', count: 15 }] }];
  const [r] = Q.resolve([{ title: 'Make a Match Cards Set', progress: [{ have: 15, need: 15, name: 'Monstepmg py', done: true }] }], quests);
  assert.equal(r.progress.length, 1);
  assert.equal(r.progress[0].name, 'Monster Card');
  assert.equal(r.progress[0].have, 15);
  console.log('quest-helper: garbled name pairs by count');
}
// The slash read as a letter ("14 r 20"): still one count span, and the name is clean.
{
  const w=(text,x0)=>({text,bbox:{x0,y0:0,x1:x0+10,y1:12}});
  const sp=Q.countSpan([w('14',0),w('r',14),w('20',24),w("Pig'z",40),w('Rikabon',70)]);
  assert.ok(sp&&sp.lead.length===3&&sp.box.x1===34,JSON.stringify(sp));
  assert.equal(sp.rest,"Pig'z Rikabon");
  // A real one-letter word after the counts is not taken as the slash.
  assert.equal(Q.countSpan([w('3/5',0),w('a',30),w('Snail',40)]).lead.length,1);
  console.log('quest-helper: misread slash token passes');
}
// One stray mark glued to the digits ("10 F10", "T0710").
{
  const w=(text,x0)=>({text,bbox:{x0,y0:0,x1:x0+10,y1:12}});
  assert.equal(Q.countSpan([w('10',0),w('F10',14),w('Slime',40),w('Bubble',70)]).lead.length,2);
  assert.equal(Q.countSpan([w('T0710',0),w('Slime',40),w('Bubble',70)]).rest,'Slime Bubble');
  assert.equal(Q.countSpan([w('Slime',0),w('Bubble',40)]),null);
  console.log('quest-helper: glued stray mark passes');
}
// A short scenery blob before the counts ("Ne 10710 Slime Bubble").
{
  const w=(text,x0)=>({text,bbox:{x0,y0:0,x1:x0+10,y1:12}});
  const sp=Q.countSpan([w('Ne',0),w('10710',20),w('Slime',60),w('Bubble',90)]);
  assert.ok(sp&&sp.box.x0===20&&sp.rest==='Slime Bubble',JSON.stringify(sp));
  console.log('quest-helper: leading scenery blob passes');
}
// System recognizer lines -> panel text: title down, AUTO dropped, scenery to the side and
// far below ignored.
{
  const L=(text,x,y,w=200,h=20)=>({text,x,y,w,h});
  const lines=[L('AUTO',260,10,40),L('Quest Helper (2/5)',40,10),L('Make a Match Cards Set',50,40),L('15 /15 Monster Card',50,65),
    L('Henesys',600,70,80),L('Mrs. Ming Ming\'s First Worry',50,110),L('10 / 10 Slime Bubble',50,135),L('18 / 20 Pig\'s Ribbon',50,160),L('Snail',60,400,40)];
  const text=Q.panelText(lines);
  assert.equal(text,"Quest Helper (2/5)\nMake a Match Cards Set\n15 /15 Monster Card\nMrs. Ming Ming's First Worry\n10 / 10 Slime Bubble\n18 / 20 Pig's Ribbon");
  const quests=Q.pack(Q.parse(text));
  assert.deepEqual(quests[1].p,[[10,10,'Slime Bubble'],[18,20,"Pig's Ribbon"]]);
  assert.equal(Q.panelText([L('Henesys',0,0)]),null);
  assert.equal(Q.panelText([L('3 / 5 Snail Shell',0,0)],{marked:true}),'3 / 5 Snail Shell');
  console.log('quest-helper: system recognizer lines pass');
}
// Windows OCR on a drawn panel (real output): a slipped title is still the header.
{
  const lines=[{text:'Quest Het)er (2/5)',x:95.5,y:30.5,w:141.5,h:16},{text:'Make a Match Cards Set',x:96,y:56.5,w:183,h:13},{text:'15 / 15 Monster Card',x:96.5,y:82.5,w:159.5,h:15},{text:"Mrs. Mng Ming's First Worry",x:95.5,y:134.5,w:214.5,h:16},{text:'10 / 10 Slirne Bubble',x:96.5,y:160.5,w:152.5,h:15},{text:"18 / 20 Pig's Rbbon",x:96.5,y:186.5,w:147.5,h:16}];
  const q=Q.pack(Q.parse(Q.panelText(lines)));
  assert.deepEqual(q.map(x=>x.p.map(p=>p[0]+'/'+p[1])),[['15/15'],['10/10','18/20']]);
  // Quest titles are not taken for the header.
  for(const t of ['Quest for the Snail Shell','Questions for Helena','Quest Hunter Rookie'])assert.equal(Q.pack(Q.parse('Quest Helper\n'+t+'\n1 / 2 Shell'))[0]?.t,t,t);
  assert.equal(Q.pack(Q.parse('Quest Helper\nQuest for the Snail Shell\n1 / 2 Shell'))[0].t,'Quest for the Snail Shell');
  console.log('quest-helper: slipped header passes');
}
// Items with no recorded source: the monster the quest's own text names for them.
{
  const omok=['Make a Slime & Mushroom Omok Set','Omok Table','Omok Piece: Slime','Omok Piece: Pig'];
  assert.equal(Q.questMonster('Omok Table',['Stump','Slime','Pig'],omok),'Stump');
  assert.equal(Q.questMonster('Omok Piece: Pig',['Stump','Slime','Pig'],omok),'Pig');
  assert.equal(Q.questMonster('Omok Piece: Mushroom',['Stump','Slime','Orange Mushroom'],['Omok Table','Omok Piece: Slime','Omok Piece: Mushroom']),'Orange Mushroom');
  // Two monsters left for one item: no guess.
  assert.equal(Q.questMonster('Mystery Box',['Stump','Slime'],['Mystery Box']),null);
  assert.equal(Q.questMonster('Omok Table',undefined,omok),null);
  console.log('quest-helper: quest text monsters pass');
}
