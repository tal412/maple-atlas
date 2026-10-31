/* Player position from the in-game minimap, and plain-language portal guidance.
 *
 * Adapted from Maple Route (https://github.com/maplerouteadmin-dev/maple-route,
 * src/minimap.js and src/screen.js at 5f92b69). Its colors were sampled from real
 * MapleStory Classic World screenshots. Changes: one browser/Node module, minimap-only,
 * and positions use the same coordinates as this project's portal data.
 *
 * MIT License
 * Copyright (c) 2026 Maple Route contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following
 * conditions: The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
 * OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
(function(scope){
  // Works on ImageData-like objects ({width, height, data: RGBA bytes}).
  const isPanelBlue=(r,g,b)=>r>=120&&r<=190&&g>=160&&g<=215&&b>=180&&b<=235&&b-r>=30&&g-r>=15;
  const isPlayerYellow=(r,g,b)=>r>=225&&g>=185&&b<=110&&r>g;
  const isPortalTeal=(r,g,b)=>b-r>=45&&g-r>=30&&b>=g&&b>=95&&r<140;
  const isFrameLight=(r,g,b)=>r>220&&g>220&&b>220&&Math.max(r,g,b)-Math.min(r,g,b)<18;

  function allRuns(flags,maxGap=0){
    const runs=[];let start=-1,last=-1;
    for(let i=0;i<=flags.length;i++){if(i<flags.length&&flags[i]){if(start<0||i-last-1>maxGap){if(start>=0)runs.push([start,last]);start=i;}last=i;}}
    if(start>=0)runs.push([start,last]);return runs;
  }
  function longestRun(flags,maxGap=0){let best=null;for(const run of allRuns(flags,maxGap))if(!best||run[1]-run[0]>best[1]-best[0])best=run;return best;}

  // The pale-blue strip holding the region emblem and the "street / map" title.
  // frameHeight is the full game frame height in this image's pixels (the image is a crop).
  function findTitleBand(image,{frameHeight=image.height}={}){
    const {width,data}=image,height=frameHeight,regionW=width,regionH=image.height;
    const rowHits=new Array(regionH).fill(0);
    for(let y=0;y<regionH;y++)for(let x=0;x<regionW;x++){const i=(y*width+x)*4;if(isPanelBlue(data[i],data[i+1],data[i+2]))rowHits[y]++;}
    // A pale sky can share the blue; every blue stretch is tried top-down until one is title-shaped.
    for(const [y0,y1] of allRuns(rowHits.map(count=>count>Math.max(30,regionW*.05)),3)){
      const bandH=y1-y0+1;if(bandH<height*.025||bandH>height*.14)continue;
      const columns=[];
      for(let x=0;x<regionW;x++){let hits=0;for(let y=y0;y<=y1;y++){const i=(y*width+x)*4;if(isPanelBlue(data[i],data[i+1],data[i+2]))hits++;}columns.push(hits>bandH*.3);}
      const cols=longestRun(columns,4);
      if(!cols||cols[1]-cols[0]<bandH*1.8)continue;
      if(cols[0]===0&&cols[1]>=regionW-1)continue; // a sky spans the region; the title strip ends at its window
      const textX=cols[0],right=cols[1],x=Math.max(0,textX-Math.round(bandH*.97));
      return {x,y:y0,w:right-x+1,h:bandH,textX};
    }
    return null;
  }
  function components(mask,w,h){
    const seen=new Uint8Array(w*h),found=[];
    for(let start=0;start<mask.length;start++){
      if(!mask[start]||seen[start])continue;
      const stack=[start];seen[start]=1;let count=0,sx=0,sy=0,minX=w,maxX=0,minY=h,maxY=0;
      while(stack.length){
        const p=stack.pop(),x=p%w,y=(p-x)/w;count++;sx+=x;sy+=y;
        if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;const q=ny*w+nx;if(mask[q]&&!seen[q]){seen[q]=1;stack.push(q);}}
      }
      found.push({count,x:sx/count,y:sy/count,w:maxX-minX+1,h:maxY-minY+1});
    }
    return found;
  }
  // The map picture inside its thin light frame, under the title strip; null when collapsed.
  function minimapBody(image,band){
    const {width,height,data}=image;
    const light=(x,y)=>{const i=(y*width+x)*4;return isFrameLight(data[i],data[i+1],data[i+2]);};
    const rowLight=(y,x0,x1)=>{let n=0;for(let x=x0;x<=x1;x++)if(light(x,y))n++;return n/(x1-x0+1);};
    const colLight=(x,y0,y1)=>{let n=0;for(let y=y0;y<=y1;y++)if(light(x,y))n++;return n/(y1-y0+1);};
    const sx0=band.x+Math.round(band.w*.05),sx1=Math.min(width-1,band.x+Math.round(band.w*.95));
    let y=band.y+band.h,frameTop=-1;
    for(const end=Math.min(height-1,y+Math.round(band.h*1.1));y<=end;y++)if(rowLight(y,sx0,sx1)>.85){frameTop=y;break;}
    if(frameTop<0)return null;
    while(y<height&&rowLight(y,sx0,sx1)>.85)y++;
    const top=y;let bottom=-1;
    for(y=top+Math.max(4,Math.round(band.h*.3));y<height;y++)if(rowLight(y,sx0,sx1)>.85){bottom=y-1;break;}
    if(bottom<0||bottom-top<band.h*.4)return null;
    const reach=Math.round(band.h*.4);let left=band.x,right=Math.min(width-1,band.x+band.w-1);
    for(let x=Math.max(0,band.x-reach);x<=band.x+reach;x++)if(colLight(x,top,bottom)>.8)left=x+1;
    for(let x=Math.min(width-1,band.x+band.w-1+reach);x>=band.x+band.w-1-reach;x--)if(colLight(x,top,bottom)>.8)right=x-1;
    return right-left<band.h?null:{x:left,y:top,w:right-left+1,h:bottom-top+1};
  }
  // The player's yellow dot and the teal portal rings inside the minimap picture.
  function findMarkers(image,band){
    const body=minimapBody(image,band),unit=band.h;
    if(!body)return {body:null,unit,player:null,portals:[],collapsed:true};
    const yellow=new Uint8Array(body.w*body.h),teal=new Uint8Array(body.w*body.h);
    for(let y=0;y<body.h;y++)for(let x=0;x<body.w;x++){
      const i=((body.y+y)*image.width+body.x+x)*4,r=image.data[i],g=image.data[i+1],b=image.data[i+2];
      if(isPlayerYellow(r,g,b))yellow[y*body.w+x]=1;if(isPortalTeal(r,g,b))teal[y*body.w+x]=1;
    }
    const dot=components(yellow,body.w,body.h)
      .filter(c=>c.w>=unit*.07&&c.h>=unit*.07&&c.w<=unit*.25&&c.h<=unit*.25&&c.count/(c.w*c.h)>=.45&&Math.max(c.w,c.h)/Math.min(c.w,c.h)<=1.6)
      .sort((a,b)=>b.count-a.count)[0];
    const portals=components(teal,body.w,body.h).filter(c=>c.count>=unit*unit*.0035&&c.w<=unit*.35&&c.h<=unit*.35).map(c=>({x:body.x+c.x,y:body.y+c.y}));
    return {body,unit,player:dot?{x:body.x+dot.x,y:body.y+dot.y}:null,portals,collapsed:false};
  }
  // Picture size relative to the title strip; resizing the minimap changes its zoom.
  const minimapLayout=(band,body)=>body?{w:body.w/band.h,h:body.h/band.h}:null;
  function recallScale(memory,layout){
    if(!layout||!Array.isArray(memory))return null;
    const close=(a,b)=>Math.abs(a-b)<=Math.max(a,b)*.06;
    return memory.find(entry=>close(entry.w,layout.w)&&close(entry.h,layout.h))?.scale??null;
  }
  function rememberScale(memory,layout,scale){
    if(!layout||!Number.isFinite(scale))return memory??[];
    const list=Array.isArray(memory)?[...memory]:[],known=list.findIndex(entry=>recallScale([entry],layout)!==null);
    if(known>=0)list[known]={...list[known],scale:list[known].scale*.8+scale*.2};else list.unshift({...layout,scale});
    return list.slice(0,8);
  }
  // Scale/offset that maps portal coordinates onto the detected rings. The minimap scrolls with
  // the player, so the offset changes every frame; the scale is constant for one minimap size.
  function fitMinimap(rings,marks,unit,hint=null){
    const world=marks.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    if(!rings.length||!world.length)return null;
    const tolerance=Math.max(4,unit*.12);
    const score=(s,ox,oy)=>{let inliers=0,error=0;for(const ring of rings){let best=Infinity;for(const portal of world){const d=Math.abs(ring.x-(s*portal.x+ox))+Math.abs(ring.y-(s*portal.y+oy));if(d<best)best=d;}if(best<=tolerance){inliers++;error+=best;}}return {scale:s,ox,oy,inliers,error};};
    let best=null;const consider=fit=>{if(fit.inliers&&(!best||fit.inliers>best.inliers||(fit.inliers===best.inliers&&fit.error<best.error)))best=fit;};
    const minS=unit*.0003,maxS=unit*.012;
    for(let i=0;i<rings.length;i++)for(let j=0;j<rings.length;j++){
      if(i===j||rings[j].x<=rings[i].x)continue;
      for(const a of world)for(const b of world){
        if(b.x<=a.x)continue;const s=(rings[j].x-rings[i].x)/(b.x-a.x);
        if(s<minS||s>maxS)continue;if(hint?.scale&&Math.abs(s/unit-hint.scale)>hint.scale*.12)continue;
        consider(score(s,rings[i].x-s*a.x,rings[i].y-s*a.y));
      }
    }
    if(hint?.scale&&(!best||best.inliers<2)){const s=hint.scale*unit;for(const ring of rings)for(const portal of world)consider(score(s,ring.x-s*portal.x,ring.y-s*portal.y));}
    if(!best||best.inliers<2&&!hint?.scale)return null; // one ring alone cannot fix the scale
    return {...best,scalePerUnit:best.scale/unit};
  }
  const toWorld=(fit,point)=>({x:(point.x-fit.ox)/fit.scale,y:(point.y-fit.oy)/fit.scale});

  const MARKER_LIFT=8;
  // The title strip is 45 game pixels tall; the minimap picture is drawn at the game's own
  // pixel scale, so the strip's height in the image gives that scale (k image px per picture px).
  const TITLE_GAME_PX=45;
  // How the map's own minimap picture sits in the window body. The game never shrinks the
  // picture: the window hugs it (body = picture * k) up to a largest size, beyond which the
  // picture is clipped and scrolls with the player; a picture narrower than the window's
  // smallest width is centred with margins. Per side: {at, clipped}, at = the picture's left or
  // top edge in the image when the side is not clipped (null when it scrolls).
  // unit: the title strip's height (sets k); without it the picture is assumed to fit whole.
  function pictureFrame(body,picture,unit){
    if(!picture||!body||!(picture.w>0&&picture.h>0))return null;
    const rx=body.w/picture.w,ry=body.h/picture.h,k0=unit?unit/TITLE_GAME_PX:Math.min(rx,ry);
    const hugs=r=>Math.abs(r/k0-1)<=.08;
    const k=hugs(rx)&&hugs(ry)?(rx+ry)/2:hugs(rx)?rx:hugs(ry)?ry:k0;
    const side=(at,size,r,shown)=>r<k*.92&&shown>size+2?{at:null,clipped:true}:{at:at+(size-shown)/2,clipped:false};
    const shownW=picture.w*k,shownH=picture.h*k;
    return {k,shownW,shownH,x:side(body.x,body.w,rx,shownW),y:side(body.y,body.h,ry,shownH)};
  }
  // The dot on the picture: {x, y} in map coordinates, or null when the dot is not on it.
  // left/top: where the picture's edges are in the image.
  const dotOnPicture=(player,picture,k,left,top)=>{
    const px=(player.x-left+.5)/k,py=(player.y-top+.5)/k,s=picture.scale||16;
    if(px<-2||py<-2||px>picture.w+2||py>picture.h+2)return null;
    return {x:Math.round(s*(px+picture.dx)),y:Math.round(s*(py+picture.dy))};
  };
  // Kept for callers that only know the window body: the picture is taken to fit it whole.
  function onPicture(body,player,picture,unit){
    const f=pictureFrame(body,picture,unit);
    if(!f||f.x.clipped||f.y.clipped)return null;
    return dotOnPicture(player,picture,f.k,f.x.at,f.y.at);
  }
  // Where the window's slice of the picture lies on the map's own minimap image (preview:
  // {width, height, data}, the picture at 1:1) when a side scrolls: the body is sampled at
  // picture scale and slid over the image (normalized correlation). Returns {ox, oy, score}, the
  // picture pixel under the body's top-left corner, or null when nothing matches.
  function matchPreview(image,body,preview,f){
    const k=f.k,w=Math.floor(body.w/k),h=Math.floor(body.h/k);
    if(!preview||!image||w<8||h<8||!(preview.width>=8&&preview.height>=8))return null;
    const g=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const sx=Math.min(image.width-1,Math.round(body.x+(x+.5)*k)),sy=Math.min(image.height-1,Math.round(body.y+(y+.5)*k)),i=(sy*image.width+sx)*4;g[y*w+x]=image.data[i]*.299+image.data[i+1]*.587+image.data[i+2]*.114;}
    const pw=preview.width,ph=preview.height,pg=new Float32Array(pw*ph);
    for(let i=0;i<pw*ph;i++){const j=i*4,a=preview.data[j+3]/255;pg[i]=(preview.data[j]*.299+preview.data[j+1]*.587+preview.data[j+2]*.114)*a;}
    // Offsets tried: the whole span on a scrolling side, the known one on the other.
    const span=(side,at,size,psize)=>side.clipped?[0,Math.max(0,psize-size)]:[Math.round((at-side.at)/k),Math.round((at-side.at)/k)];
    const [x0,x1]=span(f.x,body.x,w,pw),[y0,y1]=span(f.y,body.y,h,ph);
    const corr=(ox,oy)=>{
      const ax=Math.max(0,-ox),ay=Math.max(0,-oy),bx=Math.min(w,pw-ox),by=Math.min(h,ph-oy);
      if(bx-ax<8||by-ay<8)return -2;
      let n=0,sa=0,sb=0;for(let y=ay;y<by;y++)for(let x=ax;x<bx;x++){sa+=g[y*w+x];sb+=pg[(y+oy)*pw+x+ox];n++;}
      const ma=sa/n,mb=sb/n;let sab=0,saa=0,sbb=0;
      for(let y=ay;y<by;y++)for(let x=ax;x<bx;x++){const a=g[y*w+x]-ma,b=pg[(y+oy)*pw+x+ox]-mb;sab+=a*b;saa+=a*a;sbb+=b*b;}
      return saa&&sbb?sab/Math.sqrt(saa*sbb):-2;};
    let best={score:-2,ox:x0,oy:y0};
    const step=x1>x0&&y1>y0?3:1;   // both sides scroll: a coarse pass, then around its best
    for(let oy=y0;oy<=y1;oy+=step)for(let ox=x0;ox<=x1;ox+=step){const c=corr(ox,oy);if(c>best.score)best={score:c,ox,oy};}
    if(step>1){const b=best;for(let oy=Math.max(y0,b.oy-step);oy<=Math.min(y1,b.oy+step);oy++)for(let ox=Math.max(x0,b.ox-step);ox<=Math.min(x1,b.ox+step);ox++){const c=corr(ox,oy);if(c>best.score)best={score:c,ox,oy};}}
    return best.score>=.3?best:null;
  }
  // Places the dot on the picture. When a side scrolls, the map's own minimap image (preview)
  // says how far, else a portal ring over a known portal does; then the rings in view: the game draws every
  // marker (dot and rings alike) about MARKER_LIFT picture pixels above its point, and when a
  // side scrolls, a ring over a known portal says how far. Returns {x, y, method, rings} or
  // null, with .reason when the window scrolls and no ring is in view.
  function placeOnPicture(body,player,rings,marks,picture,{unit=null,preview=null,image=null}={}){
    const f=pictureFrame(body,picture,unit);if(!f)return null;
    const s=picture.scale||16,k=f.k,lift=MARKER_LIFT*k;
    const pts=(marks||[]).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map(p=>({x:p.x/s-picture.dx,y:p.y/s-picture.dy}));
    const tol=Math.max(4,k*7);
    const rangeX=[body.x+body.w-f.shownW,body.x],rangeY=[body.y+body.h-f.shownH,body.y];
    const within=(v,r)=>v>=r[0]-tol&&v<=r[1]+tol;
    // Score a placement by the rings that land on known portals (the lift taken off).
    const score=(left,top)=>{let inliers=0,error=0;const res=[];
      for(const ring of rings){let best=null;for(const p of pts){const dx=ring.x-(left+p.x*k),dy=ring.y-(top+p.y*k-lift),d=Math.abs(dx)+Math.abs(dy);if(!best||d<best.d)best={d,dx,dy};}
        if(best&&best.d<=tol*2){inliers++;error+=best.d;res.push(best);}}
      return {left,top,inliers,error,res};};
    let best=null;const consider=c=>{if(!best||c.inliers>best.inliers||(c.inliers===best.inliers&&c.error<best.error))best=c;};
    let matched=false;
    if(!f.x.clipped&&!f.y.clipped)consider(score(f.x.at,f.y.at));
    else{
      const m=matchPreview(image,body,preview,f);
      if(m){consider(score(body.x-m.ox*k,body.y-m.oy*k));matched=true;}
      else for(const ring of rings)for(const p of pts){
        const left=f.x.clipped?ring.x-p.x*k:f.x.at,top=f.y.clipped?ring.y-(p.y*k-lift):f.y.at;
        if(f.x.clipped&&!within(left,rangeX))continue;if(f.y.clipped&&!within(top,rangeY))continue;
        const c=score(left,top);if(c.inliers)consider(c);
      }
      if(!best){
        // No ring over a known portal: the game keeps the dot in the middle of a scrolling side
        // until the picture's edge reaches the window, so a dot off the middle means that edge is
        // in view; a dot in the middle says nothing.
        const edge=(side,at,mid,range)=>{if(!side.clipped)return side.at;const off=at-mid;if(Math.abs(off)<=tol)return null;return off<0?range[1]:range[0];};
        const left=edge(f.x,player.x,body.x+body.w/2,rangeX),top=edge(f.y,player.y,body.y+body.h/2,rangeY);
        if(left===null||top===null)return {reason:'scrolled'};
        best={left,top,inliers:0,error:0,res:[]};
      }
    }
    const median=v=>{const a=[...v].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:0;};
    // The rings' residual against their portals corrects the lift measured for this minimap.
    const cx=median(best.res.map(r=>r.dx)),cy=best.res.length?median(best.res.map(r=>r.dy)):0;
    const at=dotOnPicture({x:player.x-cx,y:player.y-cy+lift},picture,k,best.left,best.top);
    if(!at)return null;
    return {x:at.x,y:at.y,method:(matched?'image':'picture')+(best.inliers?'+rings':'+lift'),rings:best.inliers};
  }

  // Player position in map coordinates from one minimap crop: by the map's own minimap
  // picture when it is known (picture), else the dot plus two portal rings, or one ring once a
  // scale was learned for this minimap size. `memory` is returned updated.
  // preview: the map's own minimap image ({width, height, data}) for a scrolling minimap.
  function locate(image,marks,{frameHeight=image.height,memory=[],picture=null,preview=null}={}){
    const band=findTitleBand(image,{frameHeight});
    if(!band)return {reason:'no-minimap',memory};
    const markers=findMarkers(image,band),layout=minimapLayout(band,markers.body);
    if(markers.collapsed)return {reason:'collapsed',memory};
    // The minimap window's own edges (title bar above the strip to the frame under the picture),
    // so the apps can fit their reading area to it.
    const b=markers.body,pad=band.h*.15,win={x:Math.max(0,band.x-pad),y:Math.max(0,band.y-band.h*.9),w:band.w+pad*2,h:b.y+b.h-band.y+band.h*1.4};
    if(!markers.player)return {reason:'no-dot',window:win,memory};
    const placed=placeOnPicture(markers.body,markers.player,markers.portals,marks,picture,{unit:band.h,preview,image});
    if(placed&&!placed.reason)return {...placed,window:win,memory};
    if(!marks?.length)return {reason:'no-portal-data',memory};
    const scrolled=placed?.reason==='scrolled';
    const known=recallScale(memory,layout);
    const fit=(known&&fitMinimap(markers.portals,marks,band.h,{scale:known}))||fitMinimap(markers.portals,marks,band.h);
    if(!fit)return {reason:scrolled?'scrolled':markers.portals.length<2?'few-portals':'no-fit',window:win,detail:scrolled?'the minimap scrolls and no portal ring is in view':picture?'':'no picture for this map',memory};
    const world=toWorld(fit,markers.player),xs=marks.map(p=>p.x),margin=(Math.max(...xs)-Math.min(...xs))*.15+300;
    if(world.x<Math.min(...xs)-margin||world.x>Math.max(...xs)+margin)return {reason:'implausible',memory};
    return {x:Math.round(world.x),y:Math.round(world.y),rings:fit.inliers,method:'rings',window:win,memory:fit.inliers>=2?rememberScale(memory,layout,fit.scalePerUnit):memory};
  }
  // Plain-language hint from the player's position to a portal. One game screen is roughly
  // 1000 map units wide, which keeps distances meaningful without promising precision.
  // what: what is reached ("the portal", or an NPC's name).
  function guidance(player,portal,{what='the portal'}={}){
    if(!player||!Number.isFinite(portal?.x))return null;
    const dx=portal.x-player.x,dy=Number.isFinite(portal.y)?portal.y-player.y:0,near=Math.abs(dx)<90&&Math.abs(dy)<120;
    const side=dx>0?'right':'left',distance=Math.abs(dx)<450?'a few steps':Math.abs(dx)<1100?'about one screen':'about '+Math.max(2,Math.round(Math.abs(dx)/1000))+' screens';
    const vertical=dy<-120?'up':dy>120?'down':'';
    const It=what==='the portal'?'The portal':what;
    const text=near?(what==='the portal'?'You are at the portal':'You are next to '+what):Math.abs(dx)<90?(vertical==='up'?It+' is above you, climb up':It+' is below you, drop down'):'Head '+side+', '+distance+(vertical==='up'?', then climb up':vertical==='down'?', then drop down':'');
    return {dx,dy,near,side:Math.abs(dx)<90?null:side,vertical:vertical||null,text};
  }
  // Visible portals (type 2) are the ones drawn as rings on the minimap.
  const coordinate=v=>v!==null&&v!==''&&Number.isFinite(Number(v));
  const marksFor=map=>(map?.portals||[]).filter(p=>Number(p.type)===2&&coordinate(p.x)&&coordinate(p.y)).map(p=>({x:Number(p.x),y:Number(p.y)}));
  const api={onPicture,placeOnPicture,pictureFrame,matchPreview,findTitleBand,findMarkers,minimapLayout,recallScale,rememberScale,fitMinimap,toWorld,locate,guidance,marksFor};
  scope.MapleMinimapPosition=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
