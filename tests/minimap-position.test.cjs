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
// The dot placed on the map's own minimap picture: the window shows the whole picture, so
// the dot's place in the window is its place on the picture (Perion: 204x192, offset 8,3).
{
  const P=require('path');const M=require(P.join(__dirname,'../src/minimap-position.js'));
  const picture={w:204,h:192,dx:8,dy:3,scale:16};
  const body={x:10,y:40,w:408,h:384};   // shown at twice the picture's size
  const at=M.onPicture(body,{x:10+204,y:40+96},picture);
  assert.deepEqual(at,{x:16*(102.25+8),y:16*(48.25+3)});
  // A window wider than the picture: the picture is centred with margins at the sides
  // (Construction Site North of Kerning City, from a real game window).
  const wide=M.onPicture({x:0,y:0,w:400,h:96},{x:100+51,y:48},picture);   // shown at 0.5: 102 wide from x=149
  assert.equal(wide.y,Math.round(16*(48.5/0.5+3)));
  assert.equal(M.onPicture({x:0,y:0,w:400,h:96},{x:5,y:5},picture),null,'a dot in the margin is not on the picture');
  assert.equal(M.onPicture(body,{x:20,y:50},null),null);
  console.log('minimap-position: placing on the minimap picture passes');
}
// Without a ring, the marker's usual lift (8 picture pixels) is taken off.
{
  const P=require('path');const M=require(P.join(__dirname,'../src/minimap-position.js'));
  const picture={w:204,h:192,dx:8,dy:3,scale:16},body={x:10,y:40,w:408,h:384};
  const raw=M.onPicture(body,{x:214,y:136},picture);
  assert.equal(raw.y+8*16, raw.y+128);
  console.log('minimap-position: marker lift passes');
}
// A minimap whose picture is bigger than its window: the game draws it at its own scale
// (the title strip is 45 game px tall) and scrolls it. The window's slice is matched against
// the map's own minimap image to find how far it scrolled, then the dot is placed on it.
{
  const P=require('path');const M=require(P.join(__dirname,'../src/minimap-position.js'));
  const pw=300,ph=120,preview={width:pw,height:ph,data:new Uint8ClampedArray(pw*ph*4)};
  let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
  const blocks=[];for(let i=0;i<Math.ceil(pw/4)*Math.ceil(ph/4);i++)blocks.push(40+Math.floor(rnd()*180));   // 4 px blocks: a picture, not noise
  for(let i=0;i<pw*ph;i++){const x=i%pw,y=(i-x)/pw,v=blocks[(y>>2)*Math.ceil(pw/4)+(x>>2)];preview.data.set([v,v*.8,v*.5,255],i*4);}
  const k=1.25,unit=45*k,body={x:20,y:60,w:200,h:100},ox=90,oy=10,picture={w:pw,h:ph,dx:6,dy:3,scale:16};
  const W=260,H=200,image={width:W,height:H,data:new Uint8ClampedArray(W*H*4)};
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    let c=[30,32,40];
    if(x>=body.x&&x<body.x+body.w&&y>=body.y&&y<body.y+body.h){const px=Math.min(pw-1,Math.floor(ox+(x-body.x)/k)),py=Math.min(ph-1,Math.floor(oy+(y-body.y)/k)),j=(py*pw+px)*4;c=[preview.data[j],preview.data[j+1],preview.data[j+2]];}
    image.data.set([...c,255],(y*W+x)*4);
  }
  // The dot marks picture pixel (150, 60), drawn 8 picture px above it.
  const player={x:body.x+(150-ox)*k,y:body.y+(60-8-oy)*k};
  const f=M.pictureFrame(body,picture,unit);
  assert(f.x.clipped&&f.y.clipped,'both sides scroll: '+JSON.stringify(f));
  const m=M.matchPreview(image,body,preview,f);
  assert(m&&Math.abs(m.ox-ox)<=1&&Math.abs(m.oy-oy)<=1,'the slice is found on the image: '+JSON.stringify(m));
  const at=M.placeOnPicture(body,player,[],[],picture,{unit,preview,image});
  assert(at&&Math.abs(at.x-16*(150+6))<=24&&Math.abs(at.y-16*(60+3))<=24,'the dot is placed on the scrolled picture: '+JSON.stringify(at));
  assert.equal(at.method,'image+lift');
  // Without the image and without a ring, a dot in the middle says nothing.
  assert.equal(M.placeOnPicture(body,{x:body.x+body.w/2,y:body.y+body.h/2},[],[],picture,{unit}).reason,'scrolled');
  // A side that is not clipped: the window hugs the picture (k from the strip, 8% tolerance).
  const hug=M.pictureFrame({x:0,y:0,w:Math.round(pw*k),h:Math.round(ph*k)},picture,unit);
  assert(!hug.x.clipped&&!hug.y.clipped&&Math.abs(hug.k-k)<.02,JSON.stringify(hug));
  console.log('minimap-position: scrolling minimap matched on the map image passes');
}
