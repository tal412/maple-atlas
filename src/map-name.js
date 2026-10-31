/* The map name in the in-game minimap's header ("Victoria Road" / "Henesys"): finding the
 * light-blue name strip, preparing its white letters for text recognition, and matching the
 * recognized lines to known maps (street + map name). The desktop companion reads it; the
 * player keeps the name shown (the minimap's + button). Works on ImageData-like
 * {width,height,data}. */
(function(scope){
  const normalize=v=>String(v??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  function editDistance(a,b){
    const row=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){let previous=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(a[i-1]===b[j-1]?0:1));previous=old;}}
    return row[b.length];
  }
  // A trailing Roman numeral, as text recognition often reads it ("Il", "11", "l|" -> "ii").
  const numeral=v=>v.replace(/(^| )([ivxl1|!]{1,4})$/,(m,space,n)=>space+n.replace(/[l1|!]/g,'i'));
  const similarity=(a,b)=>{const x=numeral(normalize(a)),y=numeral(normalize(b));return x&&y?1-editDistance(x,y)/Math.max(x.length,y.length):0;};

  const px=(image,x,y)=>{const i=(y*image.width+x)*4;return [image.data[i],image.data[i+1],image.data[i+2]];};
  // The strip is light blue; the letters are near white with a dark outline. Both tests are
  // relative, so screen gamma and colour settings do not matter much.
  // Pale grey-blue (about 145,175,195 on screen): a deep sky blue (red far lower, colours far
  // apart) is not the strip, so a sky beside the minimap never joins it.
  const isStrip=(r,g,b)=>{const l=(r+g+b)/3;return l>=105&&l<=235&&b-r>=16&&g-r>=6&&b>=g-6&&r>=100&&Math.max(r,g,b)-Math.min(r,g,b)<=85;};
  const lum=(r,g,b)=>r*.299+g*.587+b*.114;
  const isLetter=(r,g,b,floor=185)=>Math.min(r,g,b)>=floor&&Math.max(r,g,b)-Math.min(r,g,b)<=55;

  // The name strip: the topmost run of rows that are mostly strip blue and hold letters (a
  // sky-blue minimap below it is not taken for it), and the columns it spans. Returns
  // {x,y,w,h} or null.
  function find(image){
    const {width,height}=image,share=[],runs=[];
    for(let y=0;y<height;y++){let n=0;for(let x=0;x<width;x+=2)if(isStrip(...px(image,x,y)))n++;share.push(n/Math.ceil(width/2));}
    for(let y=0,start=-1;y<=height;y++){
      const on=y<height&&share[y]>=.28;
      if(on&&start<0)start=y;
      // two lines of text: far taller than the window's thin light-blue borders
      if(!on&&start>=0){if(y-start>=Math.max(16,height*.06))runs.push({y:start,h:y-start});start=-1;}
    }
    for(const run of runs){
      let x0=width,x1=-1;
      for(let x=0;x<width;x++){let n=0;for(let y=run.y;y<run.y+run.h;y+=2)if(isStrip(...px(image,x,y)))n++;if(n>=run.h*.25){x0=Math.min(x0,x);x1=Math.max(x1,x);}}
      if(x1-x0<run.h*2)continue;
      let letters=0,all=0;
      for(let y=run.y;y<run.y+run.h;y+=2)for(let x=x0;x<=x1;x+=2){all++;if(isLetter(...px(image,x,y)))letters++;}
      if(letters/all>=.004&&letters/all<=.35)return {x:x0,y:run.y,w:x1-x0+1,h:run.h};
    }
    return null;
  }
  // Letters -> black, everything else -> white. In place. Letters are the pale pixels clearly
  // brighter than the strip itself (its median brightness + 28): white on a screen, bluish
  // white when the colours are shifted.
  function ink(image){
    const {data}=image,ls=[];
    for(let i=0;i<data.length;i+=16)if(isStrip(data[i],data[i+1],data[i+2]))ls.push(lum(data[i],data[i+1],data[i+2]));
    ls.sort((a,b)=>a-b);const floor=Math.min(225,Math.max(150,(ls.length?ls[ls.length>>1]:180)+28));
    for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2],on=lum(r,g,b)>=floor&&Math.max(r,g,b)-Math.min(r,g,b)<=75;data[i]=data[i+1]=data[i+2]=on?0:255;data[i+3]=255;}
    return image;
  }
  // Right edge of the area emblem: the dark block at the strip's left end (0 when none).
  // Measured on the strip's own pixels, before ink().
  function emblemEnd(image){
    const {width,height}=image,dark=x=>{let n=0;for(let y=0;y<height;y+=2){const [r,g,b]=px(image,x,y);if(lum(r,g,b)<95)n++;}return n/Math.ceil(height/2);};
    const limit=Math.min(width,Math.round(height*2));let x=0,start=-1;
    for(;x<limit;x++){if(dark(x)>=.3){start=x;break;}}
    if(start<0||start>height*.6)return 0;   // no emblem near the left end
    let quiet=0;
    for(x=start;x<limit;x++){if(dark(x)<.08){if(++quiet>=4)return Math.min(width,x+Math.round(height*.06));}else quiet=0;}
    return 0;
  }
  // Drops ink touching the left edge block (the area emblem) so only the text remains.
  // `emblem`: width in pixels to blank from the left.
  function blankLeft(image,emblem){
    const {width,height,data}=image;
    for(let y=0;y<height;y++)for(let x=0;x<Math.min(width,emblem);x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=255;}
    return image;
  }
  // Coarse letter pattern, so an unchanged strip is not read again.
  function signature(image,cols=32,rows=6){
    const cells=[];
    for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=Math.floor((gx+.5)*image.width/cols),y=Math.floor((gy+.5)*image.height/rows);cells.push(isLetter(...px(image,x,y))?1:0);}
    return cells.join('');
  }
  const changed=(a,b,share=.04)=>{if(!a||!b||a.length!==b.length)return true;let n=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])n++;return n>a.length*share;};

  // Lines of recognized text, plus each pair of neighbours joined (a long name can wrap).
  function lines(text){
    const out=String(text||'').split('\n').map(l=>l.replace(/[^\p{L}\p{N}<>'.,:\- ]+/gu,' ').replace(/\s+/g,' ').trim()).filter(l=>normalize(l).length>=3);
    const joined=[];for(let i=0;i+1<out.length;i++)joined.push(out[i]+' '+out[i+1]);
    return [...out,...joined];
  }
  // Best known map for the recognized text. maps: [{id,name,street}]. Returns
  // {id,name,street,score,ids (every map with that exact name and street)} or null.
  function match(text,maps,{minScore=.78}={}){
    const ls=lines(text);if(!ls.length)return null;
    const scored=[];
    for(const m of maps){
      let name=0,street=0;
      for(const l of ls){name=Math.max(name,similarity(l,m.name));if(m.street)street=Math.max(street,similarity(l,m.street));}
      scored.push({m,name,score:name+.25*street});
    }
    scored.sort((a,b)=>b.score-a.score);
    const top=scored[0];if(!top||top.name<minScore)return null;
    const same=scored.filter(s=>normalize(s.m.name)===normalize(top.m.name)&&normalize(s.m.street)===normalize(top.m.street)).map(s=>String(s.m.id));
    const rival=scored.find(s=>normalize(s.m.name)!==normalize(top.m.name));
    // Two different names read about equally well: no answer, unless one is read exactly
    // (numbered maps differ by one letter: "... I" and "... II").
    if(rival&&top.name<.97&&top.score-rival.score<.06)return null;
    return {id:String(top.m.id),name:top.m.name,street:top.m.street||'',score:Math.round(top.name*100)/100,ids:same};
  }
  const api={find,ink,emblemEnd,blankLeft,signature,changed,lines,match,similarity,normalize};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  scope.MapleMapName=api;
})(typeof globalThis!=='undefined'?globalThis:this);
