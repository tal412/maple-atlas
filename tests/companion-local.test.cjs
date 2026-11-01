// The page's link to the companion app it runs in (createLocal) and the app's token.
const assert=require('node:assert/strict');
const {createLocal,localToken}=require('../src/companion-link.js');
const token='a'.repeat(32),ids=new Set(['100000000','2']);
class Clock{constructor(){this.t=0;this.n=0;this.tasks=new Map();}setTimeout(fn,ms){const id=++this.n;this.tasks.set(id,{fn,at:this.t+ms});return id;}clearTimeout(id){this.tasks.delete(id);}advance(ms){this.t+=ms;for(const [id,k] of [...this.tasks])if(k.at<=this.t){this.tasks.delete(id);k.fn();}}}
class Source{constructor(url){this.url=url;this.readyState=0;Source.last=this;}close(){this.readyState=2;}emit(v){this.onmessage({data:JSON.stringify(v)});}}
// The token: only on this computer's address, taken from the fragment, kept for reloads.
{
  const store=new Map(),storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};let replaced=null;
  const history={replaceState:(a,b,url)=>{replaced=url;}};
  assert.equal(localToken({loc:{hostname:'tal412.github.io',hash:'#companion='+token,pathname:'/',search:''},store:storage,history}),null,'not on the public site');
  assert.equal(localToken({loc:{hostname:'127.0.0.1',hash:'#companion='+token,pathname:'/',search:''},store:storage,history}),token);
  assert.equal(replaced,'/','the token leaves the address bar');
  assert.equal(localToken({loc:{hostname:'127.0.0.1',hash:'',pathname:'/',search:''},store:storage,history}),token,'kept for a reload');
  assert.equal(localToken({loc:{hostname:'127.0.0.1',hash:'#companion=zz',pathname:'/',search:''},store:new Map(),history}),null);
}
{
  const clock=new Clock(),states=[],got={loc:[],pos:[],quests:[],reading:[],look:[]},sent=[];
  const link=createLocal({token,ids,Source,timers:clock,now:()=>1000,send:async(url,init)=>{sent.push([url,init]);},
    onState:v=>states.push(v),onLocation:v=>got.loc.push(v),onPosition:v=>got.pos.push(v),onQuests:v=>got.quests.push(v),onReading:v=>got.reading.push(v),onLook:v=>got.look.push(v)});
  assert(!link.look('p1'),'nothing is sent before the app says hello');
  link.start();const s=Source.last;
  assert.equal(s.url,'/__companion/link?t='+token);assert.equal(states.at(-1).phase,'connecting');
  s.emit({kind:'location',id:'100000000',confidence:90,seq:0,observedAt:5});assert.equal(got.loc.length,0,'only after hello');
  s.emit({kind:'hello',v:2,role:'pc',host:'windows',ui:'/__companion/ui/?t='+token,version:'0.4.0'});
  assert.equal(states.at(-1).phase,'connected');assert.deepEqual(link.hello,{host:'windows',ui:'/__companion/ui/?t='+token,version:'0.4.0'});
  s.emit({kind:'tracking',state:'paused',seq:0,observedAt:4});
  s.emit({kind:'location',id:'100000000',confidence:90,seq:1,observedAt:5});
  s.emit({kind:'location',id:'100000000',confidence:90,seq:1,observedAt:5});
  s.emit({kind:'location',id:'999',confidence:90,seq:2,observedAt:5});
  s.emit({kind:'position',id:'100000000',x:10,y:-4,seq:3,observedAt:6});
  s.emit({kind:'quests',visible:true,quests:[],seq:4,observedAt:7});
  assert.deepEqual([got.reading,got.loc.length,got.pos[0].x,got.quests.length],[['paused'],1,10,1]);
  // A reconnect (new hello) replays the latest messages: taken again.
  s.emit({kind:'hello',v:2,role:'pc',host:'windows',ui:'',version:''});
  s.emit({kind:'location',id:'100000000',confidence:90,seq:1,observedAt:5});assert.equal(got.loc.length,2);
  // Look: the screenshot in parts, then what was found.
  const jpeg='QUJD',found=Buffer.from(JSON.stringify({found:[{type:'monster',id:'100100',name:'Snail',box:{x:1,y:2,w:3,h:4}}],mapId:'100000000'})).toString('base64');
  assert(link.look('p7'));assert.equal(JSON.parse(sent.at(-1)[1].body).kind,'look');assert.equal(sent.at(-1)[1].headers['X-Companion-Token'],token);
  s.emit({kind:'look-meta',v:1,req:'p7',w:100,h:80,parts:1,bytes:3,lines:[]});s.emit({kind:'look-part',v:1,req:'p7',i:0,data:jpeg});
  s.emit({kind:'look-progress',v:1,req:'p7',text:'Naming 1 of 1…'});
  s.emit({kind:'look-found',v:1,req:'p7',i:0,n:1,data:found});
  assert.equal(got.look[0].jpeg,jpeg);assert.equal(got.look[1].progress,'Naming 1 of 1…');assert.equal(got.look[2].found.found[0].name,'Snail');
  assert(!link.look('c1'),'the window asks with p… only');
  assert(link.pins([]));assert.deepEqual(JSON.parse(sent.at(-1)[1].body),{kind:'pins',v:1,pins:[]});
  assert(link.controls());assert.equal(JSON.parse(sent.at(-1)[1].body).kind,'controls');
  // The app stops answering: reconnecting, then closed after 20 s.
  s.onerror();assert.equal(states.at(-1).phase,'reconnecting');assert(!link.connected);
  clock.advance(20000);assert.equal(states.at(-1).phase,'failed');assert.equal(states.at(-1).reason,'closed');
}
{
  // A stale token (the app restarted): the stream is refused and closed for good.
  const states=[];const link=createLocal({token,ids,Source,timers:new Clock(),send:async()=>{},onState:v=>states.push(v)});
  link.start();Source.last.readyState=2;Source.last.onerror();assert.equal(states.at(-1).phase,'failed');
  const other=createLocal({token,ids,Source,timers:new Clock(),send:async()=>{},onState:v=>states.push(v)});other.start();
  Source.last.emit({kind:'hello',v:1,role:'pc'});assert.equal(states.at(-1).reason,'version');
}
console.log('PASS: app token (loopback only, leaves the address bar, kept for reloads) · local link hello, replay, live messages, Look parts, pins, controls, reconnect, closed app, version');
