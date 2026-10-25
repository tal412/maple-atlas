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
