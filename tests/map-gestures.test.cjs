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
const handlers = {};
const element = {getBoundingClientRect:()=>({left:10,top:20}),setPointerCapture:()=>{},addEventListener:(name,fn,capture)=>{assert.equal(capture,true);handlers[name]=fn;}};
const marker = {setPointerCapture:()=>{}};
let ends=0;
const gesture = create({element,getCamera:()=>({...camera}),onStart:()=>{},onEnd:()=>ends++,
  onPan:(dx,dy)=>{camera.ox+=dx-camera.dx;camera.oy+=dy-camera.dy;camera.dx=dx;camera.dy=dy;},
  onZoom:next=>{camera.scale=next.zoom*2;camera.zoom=next.zoom;const ox=next.screen.x-next.world.x*camera.scale,oy=next.screen.y-next.world.y*camera.scale;camera.dx+=ox-camera.ox;camera.dy+=oy-camera.oy;camera.ox=ox;camera.oy=oy;}
});
const event=(id,x,y,control=false)=>({pointerId:id,clientX:x+10,clientY:y+20,button:0,target:{closest:selector=>selector==='.mc-place'?(control==='marker'?marker:null):(control?marker:null)}});
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
// Small finger movement stays a tap. A drag that begins on a marker must pan
// and suppress the subsequent native click before the marker handler sees it.
const click=(name='click',detail=1)=>{let blocked=false;handlers[name]({detail,preventDefault:()=>{blocked=true;},stopImmediatePropagation:()=>{}});return blocked;};
element.onpointerdown(event(4,100,100,'marker'));
const tapCamera={...camera};
element.onpointermove(event(4,102,103,'marker'));
assert.deepEqual(camera,tapCamera,'Tap jitter must not move the map');
element.onpointerup(event(4,102,103,'marker'));
assert.equal(click(),false,'A marker tap must still open the location');
element.onpointerdown(event(5,100,100,'marker'));
element.onpointermove(event(5,180,140,'marker'));
assert.equal(camera.ox,tapCamera.ox+80,'Dragging from a marker pans horizontally');
assert.equal(camera.oy,tapCamera.oy+40,'Dragging from a marker pans vertically');
element.onpointerup(event(5,180,140,'marker'));
assert.equal(click(),true,'Drag release must not inspect the marker');
assert.equal(click('dblclick',2),true,'Drag release must not trigger double-click zoom');
assert.equal(click('click',0),false,'Keyboard activation must remain usable');
element.onpointerdown(event(6,100,100,'marker'));
element.onpointerup(event(6,100,100,'marker'));
assert.equal(click(),false,'The next deliberate tap must not be swallowed');

// Both pinch contacts can begin on markers; lifting either finger must not open one.
element.onpointerdown(event(7,100,100,'marker'));
element.onpointerdown(event(8,200,100,'marker'));
element.onpointermove(event(8,250,100,'marker'));
element.onpointerup(event(7,100,100,'marker'));
assert.equal(gesture.moving,true);
element.onpointerup(event(8,250,100,'marker'));
assert.equal(click(),true);
element.onpointerdown(event(9,0,0,true));
assert.equal(click(),false,'Toolbar controls remain usable after map gestures');
assert.equal(gesture.moving,false);

// Losing capture cancels cleanly and a fresh gesture still moves the map.
element.onpointerdown(event(10,0,0,'marker'));
element.onlostpointercapture(event(10,0,0,'marker'));
assert.equal(gesture.moving,false);
element.onpointerdown(event(11,0,0,'marker'));
const resumed={...camera};
element.onpointermove(event(11,20,30,'marker'));
assert.equal(camera.ox,resumed.ox+20);assert.equal(camera.oy,resumed.oy+30);
element.onpointerup(event(11,20,30,'marker'));
console.log('PASS: marker drag/tap arbitration, pinch on markers, click suppression, keyboard activation, gesture handoff and cancellation.');
