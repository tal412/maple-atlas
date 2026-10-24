const assert=require('node:assert/strict');
const {create}=require('../src/map-labels.js');
const bounds={left:320,right:1000,top:70,bottom:650};
const points=[
 {id:'selected',x:530,y:350,r:13,w:180,h:22,label:true,selected:true},
 {id:'lith',x:480,y:430,r:13,w:80,h:22,label:true,selected:false},
 {id:'stop',x:570,y:390,r:13,w:0,h:0,label:false,selected:false}
];
const planner=create();
const initial=planner.layout({points,bounds});
assert(initial.get('selected').visible);
assert(initial.get('lith').visible);
// Pan and zoom frames preserve visibility and the exact pixel offset from each marker,
// even while the marker passes an overlay or viewport boundary.
for(let frame=1;frame<=120;frame++){
 const moved=points.map(p=>({...p,x:p.x-frame*5,y:p.y+frame*1.5}));
 const during=planner.layout({points:moved,bounds,moving:true,blocked:[{x:400,y:200,w:200,h:250}]});
 assert.deepEqual(during,initial,`label changed during frame ${frame}`);
}
const settled=planner.layout({points:points.map(p=>({...p,x:p.x+10,y:p.y+10})),bounds});
for(const id of ['selected','lith'])assert.deepEqual(settled.get(id),initial.get(id),'valid placement should survive a pan');
const before=initial.get('selected');
const obstructed=planner.layout({points,bounds,blocked:[{x:points[0].x+before.dx,y:points[0].y+before.dy,w:180,h:22}]});
const label=obstructed.get('selected');
assert(label.visible);
assert(label.dx!==initial.get('selected').dx||label.dy!==initial.get('selected').dy,'overlap should be resolved after settling');
const offscreen=planner.layout({points:points.map(p=>({...p,x:-500})),bounds});
assert(!offscreen.get('selected').visible);
const returned=planner.layout({points,bounds});
assert(returned.get('selected').visible,'returning to a location must restore its label');
console.log('PASS: 120 motion frames retain label offsets and visibility; settled collisions and offscreen return are handled.');
