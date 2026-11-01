// The Look feature's recognizer: names from the text read on a screenshot, the player's place
// from their name tag, and sprites found at the game's scale. Drawn stand-ins only (no game
// images in this public repository).
const assert=require('node:assert/strict');
const L=require('../src/look.js');

function image(w,h,paint){const data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const [r,g,b,a=255]=paint(x,y);data.set([r,g,b,a],(y*w+x)*4);}return {width:w,height:h,data};}

// Names: whole lines, names inside lines, a reading slip; monsters' names on world tags are pets.
{
  const names=L.nameIndex([{type:'npc',id:'503',name:'Mr. Thunder'},{type:'item',id:'4031',name:"Dances with Balrog's Letter"},{type:'item',id:'4000',name:'Blue Mushroom Cap'},{type:'monster',id:'2',name:'Snail'}]);
  assert.equal(names('Mr. Thunder')[0].entry.id,'503');
  assert.equal(names("Dances with Balrog's Letter x1 earned. (Etc)")[0].entry.id,'4031');
  assert.equal(names('11 /15 Blue Mushroom Cap')[0].entry.id,'4000');
  assert.equal(names('Mr. Thundor')[0].exact,false);
  assert.deepEqual(names('hello there'),[]);
  const frame={w:1600,h:900},lines=[{text:'LV.',x:342,y:872,w:30,h:19},{text:'Archer',x:430,y:865,w:47,h:12},{text:'TalTBest',x:428,y:879,w:60,h:14},{text:'TalTBest',x:798,y:644,w:63,h:14},{text:'Snail',x:1160,y:628,w:37,h:14},{text:'Mr. Thunder',x:233,y:556,w:79,h:12}];
  assert.equal(L.playerName(lines,frame),'TalTBest');
  const p=L.findPlayer(lines,frame);assert(p.found&&Math.abs(p.x-829.5)<1&&p.y<644,JSON.stringify(p));
  const r=L.analyze({image:image(1600,900,()=>[20,20,20]),lines,names,k:1.17});
  assert.deepEqual(r.found.map(f=>f.name),['Mr. Thunder'],JSON.stringify(r.found));
  // Inside a marked box only.
  assert.equal(L.analyze({image:image(1600,900,()=>[20,20,20]),lines,names,k:1.17,region:{x:900,y:500,w:300,h:200}}).found.length,0);
  console.log('look: names and the player pass');
}
// Sprites: a two-colour stand-in drawn into a busy screen at scale 1.25, facing either way.
{
  const sprite=image(20,24,(x,y)=>x<2||x>17||y<2?[0,0,0,0]:y<10?[60,120,230]:x<10?[240,230,200]:[200,40,40]);
  const k=1.25,screen=image(800,450,(x,y)=>[(x*7+y*3)%90+40,(x*3+y*5)%80+60,(x+y)%70+50]);
  const put=(ox,oy,flip)=>{for(let y=0;y<sprite.height*k;y++)for(let x=0;x<sprite.width*k;x++){const sx=Math.floor((flip?sprite.width*k-1-x:x)/k),sy=Math.floor(y/k),i=(sy*sprite.width+sx)*4;if(sprite.data[i+3]<128)continue;screen.data.set([sprite.data[i],sprite.data[i+1],sprite.data[i+2],255],((oy+y)*screen.width+ox+x)*4);}};
  put(100,200,false);put(500,120,true);
  const r=L.analyze({image:screen,k,sprites:[{type:'monster',id:'16',name:'Stand-in',image:sprite}]});
  assert.equal(r.found.length,2,JSON.stringify(r.found));
  for(const [x,y] of [[100,200],[500,120]])assert(r.found.some(f=>Math.abs(f.box.x-x)<=4&&Math.abs(f.box.y-y)<=4),'found at '+x+','+y+': '+JSON.stringify(r.found));
  assert.equal(L.summary(r.found)[0].count,2);
  console.log('look: sprites at the game scale pass');
}
