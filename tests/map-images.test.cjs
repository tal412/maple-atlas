const assert=require('node:assert/strict');
const {createLoader}=require('../src/map-images.js');
function harness() {
  const timers=new Map(),states=[],requests=[];let timerId=0,src='';
  const image={naturalWidth:0,removeAttribute(){src='';this.naturalWidth=0;},
    get src(){return src;},set src(value){src=value;requests.push(value);}};
  const loader=createLoader({image,onState:s=>states.push(s),
    schedule:fn=>{timers.set(++timerId,fn);return timerId;},unschedule:id=>timers.delete(id)});
  const loaded=()=>{image.naturalWidth=320;image.onload();};
  const timeout=()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();};
  return {loader,image,states,requests,timers,loaded,timeout};
}
const primary='./assets/minimaps/map.png',fallback='https://example.com/map.png';
{
  const h=harness();h.loader.load([primary,fallback]);h.loaded();
  assert.deepEqual(h.requests,[primary]);assert.deepEqual(h.states,['loading','ready']);assert.equal(h.timers.size,0);
}
{
  const h=harness();h.loader.load([primary,fallback]);h.image.onerror();h.loaded();
  assert.deepEqual(h.requests,[primary,fallback]);assert.equal(h.states.at(-1),'ready');
}
{
  const h=harness();h.loader.load([primary,fallback]);h.timeout();h.timeout();
  assert.deepEqual(h.requests,[primary,fallback]);assert.equal(h.states.at(-1),'error');assert.equal(h.image.src,'');
  h.loader.retry();assert(h.image.src.startsWith(primary+'?retry='));h.loaded();
  assert.equal(h.states.at(-1),'ready');
}
{
  const h=harness();h.loader.load([primary,fallback]);const oldLoad=h.image.onload,oldError=h.image.onerror;
  h.loader.load(['./assets/maps/another.webp']);oldLoad();oldError();
  assert.deepEqual(h.requests,[primary,'./assets/maps/another.webp']);assert.equal(h.states.at(-1),'loading');
  h.loaded();assert.equal(h.states.at(-1),'ready');
}
{
  const h=harness();h.loader.load([primary]);const old=h.image.onload;h.loader.cancel();old();
  assert.equal(h.image.src,'');assert.equal(h.timers.size,0);assert(!h.states.includes('ready'));
  h.loader.load([primary]);h.loaded();assert.equal(h.states.at(-1),'ready','Closing and reopening must work');
}
{
  const h=harness();h.loader.load([null,primary,primary]);h.image.onerror();
  assert.deepEqual(h.requests,[primary]);assert.equal(h.states.at(-1),'error');
  h.loader.load([]);assert.equal(h.states.at(-1),'error');assert.equal(h.timers.size,0);
}
console.log('PASS: same-origin image loading, fallback, bounded timeouts, explicit retry, stale events and close/reopen cancellation.');
