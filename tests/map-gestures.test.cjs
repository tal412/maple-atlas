const assert = require('node:assert/strict');
const {pinch, updatePinch, create} = require('../src/map-gestures.js');

const camera = {ox:20, oy:30, scale:2, zoom:1, dx:0, dy:0};
const start = pinch(camera, {x:100,y:100}, {x:200,y:100});
const zoomed = updatePinch(start, {x:80,y:120}, {x:280,y:120});
assert.equal(zoomed.zoom, 2);
assert.deepEqual(zoomed.world, {x:65,y:35});
assert.deepEqual(zoomed.screen, {x:180,y:120});
assert.equal(updatePinch(start, {x:0,y:0}, {x:2000,y:0}).zoom, 5);
assert.equal(updatePinch(start, {x:0,y:0}, {x:1,y:0}).zoom, .5);

// Exercise pan → pinch → single-finger pan without losing the world anchor.
const element = {getBoundingClientRect:()=>({left:10,top:20}),setPointerCapture:()=>{}};
let ends=0;
const gesture = create({element,getCamera:()=>({...camera}),onStart:()=>{},onEnd:()=>ends++,
  onPan:(dx,dy)=>{camera.ox+=dx-camera.dx;camera.oy+=dy-camera.dy;camera.dx=dx;camera.dy=dy;},
  onZoom:next=>{camera.scale=next.zoom*2;camera.zoom=next.zoom;const ox=next.screen.x-next.world.x*camera.scale,oy=next.screen.y-next.world.y*camera.scale;camera.dx+=ox-camera.ox;camera.dy+=oy-camera.oy;camera.ox=ox;camera.oy=oy;}
});
const event=(id,x,y,control=false)=>({pointerId:id,clientX:x+10,clientY:y+20,button:0,target:{closest:()=>control}});
element.onpointerdown(event(1,100,100));
element.onpointermove(event(1,120,130));
assert.equal(camera.dx,20);assert.equal(camera.dy,30);
element.onpointerdown(event(2,220,130));
const anchor = {x:(170-camera.ox)/camera.scale,y:(130-camera.oy)/camera.scale};
element.onpointermove(event(2,320,130));
assert.equal(camera.zoom,2);
assert.equal(camera.ox+anchor.x*camera.scale,220);
assert.equal(camera.oy+anchor.y*camera.scale,130);
element.onpointerup(event(2,320,130));
const prior={...camera};
element.onpointermove(event(1,130,150));
assert.equal(camera.ox,prior.ox+10);assert.equal(camera.oy,prior.oy+20);
element.onpointercancel(event(1,130,150));
assert.equal(gesture.moving,false);assert.equal(ends,1);
element.onlostpointercapture(event(1,130,150));
assert.equal(ends,1);
element.onpointerdown(event(3,0,0,true));
assert.equal(gesture.moving,false,'Interactive controls must not start map panning');
console.log('PASS: anchored pinch zoom, zoom limits, pan/pinch handoff, cancellation and control exclusion.');
