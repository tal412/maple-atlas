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

  // The dot on the map's own minimap picture: the game draws that picture whole inside the
  // minimap window (any size), so where the dot sits in the window is where it sits on the
  // picture. picture: {w, h, dx, dy, scale} (scripts/minimap-geometry.py):
  // map = scale * (picture pixel + offset). null when the window does not show the whole
  // picture (its shape differs), so the portal rings decide instead.
  function onPicture(body,player,picture){
    if(!picture||!body||!(picture.w>0&&picture.h>0))return null;
    const shape=(body.w/body.h)/(picture.w/picture.h);
    if(shape<.93||shape>1.07)return null;
    const px=(player.x-body.x+.5)/body.w*picture.w,py=(player.y-body.y+.5)/body.h*picture.h,s=picture.scale||16;
    return {x:Math.round(s*(px+picture.dx)),y:Math.round(s*(py+picture.dy))};
  }

  // Player position in map coordinates from one minimap crop: by the map's own minimap
  // picture when it is known (picture), else the dot plus two portal rings, or one ring once a
  // scale was learned for this minimap size. `memory` is returned updated.
  function locate(image,marks,{frameHeight=image.height,memory=[],picture=null}={}){
    const band=findTitleBand(image,{frameHeight});
    if(!band)return {reason:'no-minimap',memory};
    const markers=findMarkers(image,band),layout=minimapLayout(band,markers.body);
    if(markers.collapsed)return {reason:'collapsed',memory};
    if(!markers.player)return {reason:'no-dot',memory};
    const placed=onPicture(markers.body,markers.player,picture);
    if(placed)return {...placed,method:'picture',memory};
    // Shown in diagnostics: how the window's shape compared with the picture's.
    const shape=picture&&markers.body?Math.round((markers.body.w/markers.body.h)/(picture.w/picture.h)*100)/100:null;
    if(!marks?.length)return {reason:'no-portal-data',memory};
    const known=recallScale(memory,layout);
    const fit=(known&&fitMinimap(markers.portals,marks,band.h,{scale:known}))||fitMinimap(markers.portals,marks,band.h);
    if(!fit)return {reason:markers.portals.length<2?'few-portals':'no-fit',detail:shape?'window/picture shape '+shape:picture?'':'no picture for this map',memory};
    const world=toWorld(fit,markers.player),xs=marks.map(p=>p.x),margin=(Math.max(...xs)-Math.min(...xs))*.15+300;
    if(world.x<Math.min(...xs)-margin||world.x>Math.max(...xs)+margin)return {reason:'implausible',memory};
    return {x:Math.round(world.x),y:Math.round(world.y),rings:fit.inliers,method:'rings',memory:fit.inliers>=2?rememberScale(memory,layout,fit.scalePerUnit):memory};
  }
  // Plain-language hint from the player's position to a portal. One game screen is roughly
  // 1000 map units wide, which keeps distances meaningful without promising precision.
  function guidance(player,portal){
    if(!player||!Number.isFinite(portal?.x))return null;
    const dx=portal.x-player.x,dy=Number.isFinite(portal.y)?portal.y-player.y:0,near=Math.abs(dx)<90&&Math.abs(dy)<120;
    const side=dx>0?'right':'left',distance=Math.abs(dx)<450?'a few steps':Math.abs(dx)<1100?'about one screen':'about '+Math.max(2,Math.round(Math.abs(dx)/1000))+' screens';
    const vertical=dy<-120?'up':dy>120?'down':'';
    const text=near?'You are at the portal':Math.abs(dx)<90?(vertical==='up'?'The portal is above you, climb up':'The portal is below you, drop down'):'Head '+side+', '+distance+(vertical==='up'?', then climb up':vertical==='down'?', then drop down':'');
    return {dx,dy,near,side:Math.abs(dx)<90?null:side,vertical:vertical||null,text};
  }
  // Visible portals (type 2) are the ones drawn as rings on the minimap.
  const coordinate=v=>v!==null&&v!==''&&Number.isFinite(Number(v));
  const marksFor=map=>(map?.portals||[]).filter(p=>Number(p.type)===2&&coordinate(p.x)&&coordinate(p.y)).map(p=>({x:Number(p.x),y:Number(p.y)}));
  const api={onPicture,findTitleBand,findMarkers,minimapLayout,recallScale,rememberScale,fitMinimap,toWorld,locate,guidance,marksFor};
  scope.MapleMinimapPosition=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
