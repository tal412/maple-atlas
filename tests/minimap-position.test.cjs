const assert=require('node:assert/strict');
const M=require('../src/minimap-position.js');
// Henesys visible portals (OSMS coordinates), as in Maple Route's tests.
const HENESYS=[{x:246,y:870},{x:2962,y:925},{x:3706,y:930},{x:4528,y:719},{x:4599,y:1048},{x:5816,y:1048},{x:6587,y:1050},{x:6753,y:419}];
// Draws a minimap window like the game's: pale-blue title strip, light frame, dark picture with
// a gold player dot and teal portal rings at scale * world + offset. Adapted from Maple Route.
function draw({width=480,height=280,frameHeight=700,x=0,y=20,unit=50,pictureW=300,pictureH=110,scale=.07,offsetX=-60,offsetY=20,player={x:3400,y:940},collapsed=false,dot=true}={}){
  const data=new Uint8ClampedArray(width*height*4);
  const fill=(rx,ry,rw,rh,[r,g,b])=>{for(let yy=Math.max(0,Math.round(ry));yy<Math.min(height,Math.round(ry+rh));yy++)for(let xx=Math.max(0,Math.round(rx));xx<Math.min(width,Math.round(rx+rw));xx++)data.set([r,g,b,255],(yy*width+xx)*4);};
  fill(0,0,width,height,[70,120,200]);
  const frame=Math.max(2,Math.round(unit*.06)),windowW=pictureW+frame*2;
  fill(x,y,unit,unit,[60,50,90]);fill(x+unit,y,windowW-unit,unit,[155,188,206]);
  if(!collapsed){
    const top=y+unit;
    fill(x,top,windowW,frame,[238,238,238]);fill(x,top+frame,frame,pictureH,[238,238,238]);fill(x+windowW-frame,top+frame,frame,pictureH,[238,238,238]);fill(x,top+frame+pictureH,windowW,frame*2,[238,238,238]);
    const px=x+frame,py=top+frame,d=Math.round(unit*.13),ring=Math.round(unit*.17);
    fill(px,py,pictureW,pictureH,[30,45,40]);
    for(const p of HENESYS){const cx=px+scale*p.x+offsetX,cy=py+scale*p.y+offsetY;if(cx>px+ring&&cx<px+pictureW-ring&&cy>py+ring&&cy<py+pictureH-ring)fill(cx-ring/2,cy-ring/2,ring,ring,[40,110,140]);}
    if(dot)fill(px+scale*player.x+offsetX-d/2,py+scale*player.y+offsetY-d/2,d,d,[240,218,69]);
  }
  return {image:{width,height,data},frameHeight};
}
const near=(a,b,t)=>assert(Math.abs(a-b)<=t,a+' is not within '+t+' of '+b);

const {image,frameHeight}=draw();
let found=M.locate(image,HENESYS,{frameHeight});
assert.equal(found.reason,undefined,JSON.stringify(found));near(found.x,3400,40);near(found.y,940,40);assert(found.rings>=2);assert.equal(found.memory.length,1,'The minimap scale is learned');

// The minimap scrolls with the player: a different offset still lands on the right spot.
const moved=draw({player:{x:4300,y:1000},offsetX:-180,offsetY:10});
const again=M.locate(moved.image,HENESYS,{frameHeight,memory:found.memory});near(again.x,4300,40);near(again.y,1000,40);

// With a learned scale, one visible ring is enough.
const zoomed=draw({player:{x:600,y:880},offsetX:150});
const one=M.locate(zoomed.image,HENESYS,{frameHeight,memory:found.memory});near(one.x,600,60);assert.equal(one.rings,1);
assert.equal(M.locate(zoomed.image,HENESYS,{frameHeight}).reason,'few-portals','Without a learned scale one ring cannot fix the position');

assert.equal(M.locate(draw({dot:false}).image,HENESYS,{frameHeight}).reason,'no-dot');
assert.equal(M.locate(draw({collapsed:true}).image,HENESYS,{frameHeight}).reason,'collapsed');
assert.equal(M.locate(draw().image,[],{frameHeight}).reason,'no-portal-data');
const blank={width:200,height:120,data:new Uint8ClampedArray(200*120*4).fill(90)};assert.equal(M.locate(blank,HENESYS,{frameHeight:700}).reason,'no-minimap');

assert.match(M.guidance({x:1000,y:900},{x:3500,y:910}).text,/^Head right, about 2 screens$|^Head right, about 3 screens$/);
assert.equal(M.guidance({x:1000,y:900},{x:1300,y:900}).text,'Head right, a few steps');
assert.equal(M.guidance({x:1000,y:900},{x:400,y:500}).text,'Head left, about one screen, then climb up');
assert.equal(M.guidance({x:1000,y:900},{x:1040,y:950}).near,true);
assert.equal(M.guidance(null,{x:1,y:1}),null);
assert.deepEqual(M.marksFor({portals:[{type:2,x:'5',y:6},{type:1,x:1,y:1},{type:2,x:null,y:2}]}),[{x:5,y:6}]);
console.log('PASS: minimap title, dot and portal rings, portal fit, scrolling, learned scale, rejection and guidance');
