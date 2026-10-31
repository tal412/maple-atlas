/* The in-game Quest Helper (top right of the game window): finding it in a frame,
 * turning its text into tracked quests with "have / need" counts, and matching those
 * to Maple Atlas quests. The desktop companion reads the panel; the phone matches and
 * shows it. Pixel and text readers adapted from Maple Route (src/hud.js, src/core.js,
 * MIT License, Copyright (c) 2026 Maple Route contributors). */
(function(scope){
  const normalize=v=>String(v??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  function editDistance(a,b){
    const row=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){let previous=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(a[i-1]===b[j-1]?0:1));previous=old;}}
    return row[b.length];
  }
  const similarity=(a,b)=>{const x=normalize(a),y=normalize(b);return x&&y?1-editDistance(x,y)/Math.max(x.length,y.length):0;};

  // ---- Finding the panel (ImageData-like {width,height,data}) ----
  const at=(image,x,y)=>{const i=(y*image.width+x)*4;return [image.data[i],image.data[i+1],image.data[i+2]];};
  const isAutoOrange=(r,g,b)=>r>180&&g>85&&g<160&&b<130&&r-g>50;
  const isHeaderBlue=(r,g,b)=>b>180&&r<130&&g>120;
  // The panel is see-through, so it is found by its fixed parts: the orange AUTO button
  // followed by blue buttons in its header, then its thin light bottom border. Returns
  // the body below the header (without the close buttons on the right), or null.
  function find(image){
    const {width,height}=image;
    const runsOf=(y,test)=>{const runs=[];for(let x=0,start=-1;x<=width;x++){const on=x<width&&test(...at(image,x,y));if(on&&start<0)start=x;if(!on&&start>=0){runs.push([start,x-1]);start=-1;}}return runs;};
    const rows=[];
    for(let y=0;y<height;y++){
      for(const [a,b] of runsOf(y,isAutoOrange)){
        const w=b-a+1;if(w<10||w>80)continue;
        let right=b,count=0;
        for(const [c,d] of runsOf(y,isHeaderBlue))if(c>right&&c-right<w*.8&&d-c+1>=w*.2){right=d;count++;}
        if(count>=1){rows.push({y,autoX:a,autoW:w,right});break;}
      }
    }
    if(!rows.length)return null;
    const group=rows.filter(row=>row.y-rows[0].y<rows[0].autoW*1.2&&Math.abs(row.autoX-rows[0].autoX)<=4);
    if(group.length<3)return null;
    const header={bottom:group.at(-1).y,autoX:group[0].autoX,autoW:group[0].autoW,right:Math.max(...group.map(r=>r.right))};
    const top=header.bottom+Math.max(2,Math.round(header.autoW*.15));
    // The panel's light frame on its left: the column (left of the title) that is light on most
    // rows. Panels are of different widths, so a fixed width from the AUTO button cuts text.
    let left=Math.max(0,Math.round(header.autoX-header.autoW*9.8));
    {
      const from=Math.max(0,Math.round(header.autoX-header.autoW*16)),to=Math.max(0,Math.round(header.autoX-header.autoW*5)),y1=Math.min(height-1,top+header.autoW*5);
      let best=-1,bestShare=.55;
      for(let x=from;x<to;x++){let light=0,n=0;for(let y=top;y<=y1;y+=2){const [r,g,b]=at(image,x,y);n++;if((r+g+b)/3>=150&&Math.max(r,g,b)-Math.min(r,g,b)<=90)light++;}if(light/n>bestShare){bestShare=light/n;best=x;}}
      if(best>=0)left=Math.min(left,best+2);
      // Else follow the light title bar ("Quest Helper (2/5)") left from the AUTO button: it runs
      // to the panel's left edge (dark title letters are short gaps in it).
      else{
        const ty=Math.max(0,group[0].y+Math.round((header.bottom-group[0].y)/2)),barLight=(r,g,b)=>(r+g+b)/3>=150;
        let x=header.autoX-2,gap=0,edge=header.autoX;
        for(;x>=0;x--){const [r,g,b]=at(image,x,ty);if(barLight(r,g,b)){gap=0;edge=x;}else if(++gap>header.autoW*.7)break;}
        if(edge<left)left=Math.max(0,edge+2);
      }
    }
    const x0=left+header.autoW,x1=Math.min(width-1,header.right-header.autoW);
    if(x1<=x0)return null;
    const lum=y=>{let sum=0;for(let x=x0;x<=x1;x++){const [r,g,b]=at(image,x,y);sum+=(r+g+b)/3;}return sum/(x1-x0+1);};
    let bottom=-1;
    // The bottom border is light across nearly the whole width (a bright edge in the scenery is not).
    const lightShare=y=>{let n=0;for(let x=x0;x<=x1;x++){const [r,g,b]=at(image,x,y);if((r+g+b)/3>=140)n++;}return n/(x1-x0+1);};
    for(let y=top+header.autoW;y<height-3;y++){const v=lum(y);if(v>=110&&v-Math.max(lum(y-2),lum(y+3))>=12&&lightShare(y)>=.7){bottom=y;break;}}
    if(bottom<0||bottom-top<header.autoW)return null;
    return {x:left,y:top,w:Math.max(1,header.right-left-Math.round(header.autoW*.9)),h:bottom-top,button:header.autoW};
  }
  // Dark panel text -> black, everything brighter -> white. In place.
  function inkDark(image,threshold=75){
    const {data}=image;
    for(let i=0;i<data.length;i+=4){const ink=data[i]*.299+data[i+1]*.587+data[i+2]*.114<threshold;data[i]=data[i+1]=data[i+2]=ink?0:255;data[i+3]=255;}
    return image;
  }
  // Coarse light/dark pattern, so an unchanged panel is not read again.
  function signature(image,cols=24,rows=12){
    const cells=[];
    for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){const x=Math.floor((gx+.5)*image.width/cols),y=Math.floor((gy+.5)*image.height/rows),[r,g,b]=at(image,x,y);cells.push(r*.299+g*.587+b*.114<75?1:0);}
    return cells.join('');
  }
  const changed=(a,b,share=.03)=>{if(!a||!b||a.length!==b.length)return true;let n=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])n++;return n>a.length*share;};

  // ---- Reading its text ----
  // "30 / 30 Dark Stump". The slash is often read as 7, l, I or |, or "1 / 1" squeezed into "111".
  function progressLine(line){
    // The name may follow the number with no space ("8/20PigsRibbon").
    const m=line.match(/^(\d{1,4})\s*[/7lI|\\£#{(f]\s*(\d{1,4})(?:\s+(.{2,})|([^\d\s/].+))$/);
    if(m)return {have:Number(m[1]),need:Number(m[2]),name:m[3]||m[4]};
    const glued=line.match(/^(\d{1,4})\s+[17](\d{1,4})\s+(\D.+)$/);
    if(glued)return {have:Number(glued[1]),need:Number(glued[2]),name:glued[3]};
    const squeezed=line.match(/^(\d{3,7})\s+(\D.+)$/);
    if(squeezed&&squeezed[1].length%2===1){
      const half=(squeezed[1].length-1)/2,a=squeezed[1].slice(0,half),b=squeezed[1].slice(half+1);
      if(a===b&&/[17]/.test(squeezed[1][half]))return {have:Number(a),need:Number(b),name:squeezed[2]};
    }
    return null;
  }
  // The panel's own title, "Quest Helper (2/5)", even misread ("QuestHeper 25)").
  // "Quest Helper (2/5)", allowing a few misread letters ("Quest Het)er"): letters only.
  const isHeader=line=>{const t=String(line||'').toLowerCase().replace(/[^a-z]/g,'').slice(0,11);if(/quest\s*helper/i.test(line))return true;if(t.length<8||!t.startsWith('q'))return false;
    // the title's "(2/5)" lets one more slip through; a quest named "Quest Hunter …" has none
    const d=editDistance(t,'questhelper'.slice(0,Math.max(t.length,10)));return d<=2||(d<=3&&/\(\s*\d[\d\s/|lI]*\)/.test(line));};
  // Every tracked quest: a title line followed by its "have / need name" lines.
  function parse(text){
    const quests=[];
    for(const raw of String(text).split('\n')){
      // Stray marks from the panel's edge come before a line ("¥ 10/10 Slime Bubble").
      const line=raw.trim().replace(/^(?:[^\p{L}\p{N}\s]+\s*|[^\d\s]\s+(?=\d))+/u,'');
      if(!line||isHeader(line))continue;
      const m=progressLine(line);
      if(m){
        const current=quests.at(-1),name=m.name.replace(/[^\p{L}\p{N}' -]+/gu,'').trim().replace(/(?:\s+\S)+$/u,'').trim();   // stray marks from the box edge
        if(current&&m.need>0&&name)current.progress.push({have:m.have,need:m.need,name,done:m.have>=m.need});
        continue;
      }
      if(/[A-Za-z]{3}/.test(line)&&/^[A-Z]/.test(line.replace(/^[^\p{L}]+/u,''))){
        const cleaned=line.replace(/^[^\p{L}]+/u,'').replace(/[^\p{L}\p{N}.…!?')]+$/u,'');
        const truncated=/(\.{2,}|…)$/.test(cleaned);
        const title=cleaned.replace(/\s*(\.{2,}|…)$/,'').replace(/[^\p{L}\p{N}'!?,.:() &-]+/gu,'').replace(/\s+/g,' ').trim();
        if(title.length>=4)quests.push({title,truncated,progress:[]});
      }
    }
    for(const q of quests)q.complete=q.progress.length>0&&q.progress.every(p=>p.done);
    return quests;
  }
  // Matches a (possibly truncated or misread) title to a quest name.
  function matchTitle(title,names,truncated=false){
    const seen=normalize(title);if(seen.length<4)return null;
    let best=null,bestScore=0;
    for(const name of names){
      const full=normalize(name),target=truncated&&full.length>seen.length?full.slice(0,seen.length):full;
      const score=1-editDistance(seen,target)/Math.max(seen.length,target.length);
      if(score>bestScore||(score===bestScore&&best&&name.length<best.length)){best=name;bestScore=score;}
    }
    return bestScore>=.8?best:null;
  }
  const looksLike=(a,b)=>{const x=normalize(a),y=normalize(b);if(!x||!y)return false;if(x.length>=4&&(y.startsWith(x)||x.startsWith(y)))return true;return 1-editDistance(x,y)/Math.max(x.length,y.length)>=.75;};
  // A wrapped line can be read as its own heading; one that is not a quest goes back into
  // the quest above when it names one of that quest's needs or its counts do.
  function mergeWrapped(quests,needsOf){
    const out=[];
    for(const q of quests||[]){
      const prev=out.at(-1);
      if(!q.name&&prev?.name){
        const needs=needsOf(prev.name)||[],named=needs.filter(n=>looksLike(q.title,n.name)),countsFit=q.progress.some(p=>needs.some(n=>looksLike(p.name,n.name)));
        if(named.length||countsFit){
          const need=named.find(n=>!prev.progress.some(p=>looksLike(p.name,n.name)));
          if(need)prev.progress.push({name:need.name,have:null,need:need.count??null,done:false,unknown:true});
          prev.progress.push(...q.progress);prev.complete=false;continue;
        }
      }
      out.push(q);
    }
    return out;
  }

  // ---- Between the computer and the phone ----
  const clip=(s,n)=>String(s??'').replace(/[\u0000-\u001f]/g,'').slice(0,n);
  const count=v=>Number.isInteger(v)&&v>=0&&v<=9999?v:null;
  // Compact, bounded form of the parsed panel for the data channel.
  function pack(quests){
    return (quests||[]).slice(0,8).map(q=>({t:clip(q.title,80),c:q.truncated?1:0,p:(q.progress||[]).slice(0,8).map(p=>[p.have,p.need,clip(p.name,60)])}));
  }
  // Validates what arrived from the computer; drops anything malformed.
  function unpack(list){
    if(!Array.isArray(list))return [];
    return list.slice(0,8).filter(q=>q&&typeof q.t==='string'&&q.t.trim().length>=4).map(q=>({title:clip(q.t,80).trim(),truncated:q.c===1,
      progress:(Array.isArray(q.p)?q.p:[]).slice(0,8).filter(p=>Array.isArray(p)&&count(p[0])!==null&&count(p[1])>0&&typeof p[2]==='string'&&p[2].trim()).map(p=>({have:p[0],need:p[1],name:clip(p[2],60).trim(),done:p[0]>=p[1]}))}));
  }
  // Tracked quests matched to Maple Atlas quests. quests: [{id,name,npc,objectives,...}],
  // status: {id: 'completed'|...}. Each result: {title, quest|null, progress, complete}.
  // A progress entry gets the quest objective it counts (`objective`), and objectives
  // the panel did not show are added with an unknown count.
  function resolve(list,quests,status={}){
    const names=[...new Set(quests.map(q=>q.name))];
    const pick=(name,progress)=>{
      const same=quests.filter(q=>q.name===name);if(same.length<2)return same[0]||null;
      const fits=q=>progress.filter(p=>q.objectives.some(o=>looksLike(p.name,o.name))).length;
      return same.slice().sort((a,b)=>Number(status[a.id]==='completed')-Number(status[b.id]==='completed')||fits(b)-fits(a))[0];
    };
    const named=list.map(q=>({...q,progress:q.progress.map(p=>({...p})),name:matchTitle(q.title,names,false)||(q.truncated?matchTitle(q.title,names,true):null)}));
    const merged=mergeWrapped(named,name=>(quests.find(q=>q.name===name)?.objectives||[]).filter(o=>['item','mob'].includes(o.type)).map(o=>({name:o.name,count:o.count})));
    return merged.filter(q=>q.name||q.progress.length).map(q=>{
      const quest=q.name?pick(q.name,q.progress):null,objectives=(quest?.objectives||[]).filter(o=>['item','mob'].includes(o.type));
      const used=new Set(),progress=q.progress.map(p=>{
        let best=null,score=0;
        objectives.forEach((o,i)=>{if(used.has(i))return;const s=looksLike(p.name,o.name)?Math.max(.75,similarity(p.name,o.name)):0;if(s>score){score=s;best=i;}});
        if(best!==null)used.add(best);
        const o=best!==null?objectives[best]:null;
        return {...p,name:o?.name||p.name,objective:o||null,need:p.need??o?.count??null};
      });
      // A garbled name still pairs with the one unmatched objective that needs the same count.
      progress.forEach((p,k)=>{
        if(p.objective||p.need==null)return;
        const free=objectives.map((o,i)=>i).filter(i=>!used.has(i)&&objectives[i].count===p.need);
        if(free.length===1){used.add(free[0]);const o=objectives[free[0]];progress[k]={...p,name:o.name,objective:o};}
      });
      objectives.forEach((o,i)=>{if(!used.has(i))progress.push({have:null,need:o.count,name:o.name,done:false,unknown:true,objective:o});});
      const complete=progress.length>0&&progress.every(p=>p.done);
      return {title:q.title,quest,progress,complete};
    });
  }
  // ---- Second read of the counts ----
  // The count part of a recognized line ("2 / 10 Slime Bubble"): its leading words that hold
  // digits, or only the characters a "/" is misread as. words: [{text,bbox:{x0,y0,x1,y1}}].
  // Returns {box, rest, lead} (the box around the counts, the name after them, the count
  // words) or null.
  function countSpan(words){
    const lead=[];
    let i=0;
    // Digits and slash look-alikes; a token of 3+ marks may hold one other stray mark glued on
    // by the reader ("F10", "T0710"): the pixels decide the numbers later.
    const isDigits=t=>/\d/.test(t)&&t.replace(/[\d/7lI|\\£#{(\[\]!.,:;]/g,'').length<=(t.length>=3?1:0);
    while(i<(words||[]).length&&/^(?:[^\p{L}\p{N}]+|[^\d\s])$/u.test(String(words[i]?.text||'').trim()))i++;   // stray edge marks
    // Scenery inside a drawn box can add a short letter blob before the counts ("Ne 10710").
    const txt=k=>String(words?.[k]?.text||'').trim();
    while(i<(words||[]).length-1&&txt(i).length<=2&&!/\d/.test(txt(i))&&isDigits(txt(i+1)))i++;
    const rest0=(words||[]).slice(i);
    for(let k=0;k<rest0.length;k++){
      const w=rest0[k],t=String(w?.text||'').trim();if(!t)continue;
      const slash=lead.length&&/^[/7lI|\\]+$/.test(t);
      // A slash misread as one or two other marks ("14 r 20"): taken when digits follow it.
      const odd=lead.length&&t.length<=2&&!/\d/.test(t)&&isDigits(String(rest0[k+1]?.text||'').trim());
      if(isDigits(t)||slash||odd)lead.push(w);else break;
    }
    if(!lead.length||!/\d/.test(lead[0].text))return null;
    const rest=(words||[]).slice((words||[]).indexOf(lead[lead.length-1])+1).map(w=>String(w.text||'').trim()).filter(Boolean).join(' ');
    if(!/\p{L}{2}/u.test(rest))return null;
    const box={x0:Math.min(...lead.map(w=>w.bbox.x0)),y0:Math.min(...lead.map(w=>w.bbox.y0)),x1:Math.max(...lead.map(w=>w.bbox.x1)),y1:Math.max(...lead.map(w=>w.bbox.y1))};
    return {box,rest,lead};
  }
  // "2/10" as the digits-only reader returns it; null when it is not a clean count.
  function counts(text){
    const m=String(text||'').replace(/\s+/g,'').match(/^(\d{1,4})\/(\d{1,4})$/);
    return m&&Number(m[2])>0?{have:Number(m[1]),need:Number(m[2])}:null;
  }
  // The counts from the general reader's character boxes. A slash is sometimes read as "1/"
  // or "/1": the extra digit sits on top of the slash, so digits overlapping a separator are
  // dropped. words: the count span's words with their symbols. Returns {have,need} or null
  // (no single separator found).
  function countsFromBoxes(words){
    const symbols=(words||[]).flatMap(w=>(w.symbols||[]).map(s=>({t:String(s.text||''),x0:s.bbox.x0,x1:s.bbox.x1,h:Math.max(1,s.bbox.y1-s.bbox.y0)})));
    const separators=symbols.filter(s=>/^[/|\\]$/.test(s.t));
    if(separators.length!==1)return null;
    const sep=separators[0],overlap=s=>Math.max(0,Math.min(s.x1,sep.x1)-Math.max(s.x0,sep.x0))/Math.max(1,s.x1-s.x0);
    // A 7 or 1 touching the slash (closer than a space) is the slash's own stroke misread.
    const gap=s=>s.x0>=sep.x1?s.x0-sep.x1:sep.x0-s.x1,touching=s=>/^[71]$/.test(s.t)&&gap(s)<s.h*.22;
    const digits=symbols.filter(s=>/^\d$/.test(s.t)&&overlap(s)<.4&&!touching(s));
    const have=digits.filter(s=>s.x1<=(sep.x0+sep.x1)/2).map(s=>s.t).join(''),need=digits.filter(s=>s.x0>=(sep.x0+sep.x1)/2).map(s=>s.t).join('');
    if(!have||!need||have.length>4||need.length>4||Number(need)<=0)return null;
    return {have:Number(have),need:Number(need)};
  }
  // Finds the slash by its shape in an inked count area ("10 / 10"): the game font's slash is a
  // thin, steep stroke that text recognition reads as 7, 4 or 1. image: ImageData-like, ink black;
  // box: {x0,y0,x1,y1}. Returns the two number areas {have:{x0,x1}, need:{x0,x1}, y0, y1} or null.
  function splitCounts(image,box,info=null){
    const {width,height,data}=image,ink=(x,y)=>data[(y*width+x)*4]<128;
    const x0=Math.max(0,Math.floor(box.x0)),x1=Math.min(width-1,Math.ceil(box.x1)),y0=Math.max(0,Math.floor(box.y0)),y1=Math.min(height-1,Math.ceil(box.y1)),h=y1-y0+1;
    if(x1-x0<h||h<6)return null;
    const segs=[];
    for(let x=x0,start=-1;x<=x1+1;x++){let on=false;if(x<=x1)for(let y=y0;y<=y1;y++)if(ink(x,y)){on=true;break;}if(on&&start<0)start=x;if(!on&&start>=0){segs.push({x0:start,x1:x-1});start=-1;}}
    const shape=s=>{
      let top=y1,bottom=y0,widest=0;const rows=[];
      for(let y=y0;y<=y1;y++){let a=-1,b=-1;for(let x=s.x0;x<=s.x1;x++)if(ink(x,y)){if(a<0)a=x;b=x;}if(a>=0){top=Math.min(top,y);bottom=Math.max(bottom,y);widest=Math.max(widest,b-a+1);rows.push([y,(a+b)/2]);}}
      if(!rows.length)return null;
      const span=bottom-top+1,third=span/3,mean=list=>list.reduce((t,r)=>t+r[1],0)/Math.max(1,list.length);
      return {span,widest,lean:mean(rows.filter(r=>r[0]<top+third))-mean(rows.filter(r=>r[0]>bottom-third))};
    };
    // A slash broken by a one-pixel gap is one stroke.
    for(let i=segs.length-1;i>0;i--)if(segs[i].x0-segs[i-1].x1-1<=Math.max(1,Math.round(h*.04))&&(shape(segs[i])?.widest??99)<=h*.42&&(shape(segs[i-1])?.widest??99)<=h*.42){segs[i-1]={x0:segs[i-1].x0,x1:segs[i].x1};segs.splice(i,1);}
    const thin=s=>{const f=shape(s);return f&&s.x1-s.x0+1<=h*.6&&f.widest<=h*.42;};
    if(info)for(const g of segs){const f=shape(g);info.push({x0:g.x0,x1:g.x1,w:g.x1-g.x0+1,h,widest:f?.widest,span:f?.span,lean:f&&Math.round(f.lean*10)/10});}
    for(let i=1;i<segs.length-1;i++){
      const s=segs[i],f=shape(s);if(!f)continue;
      if(s.x1-s.x0+1<=h*.6&&f.widest<=h*.42&&f.span>=h*.55&&f.lean>=h*.1){
        // Fragments of the same stroke right after it are not the first digit.
        let j=i+1;while(j<segs.length-1&&thin(segs[j])&&segs[j].x0-segs[j-1].x1<=h*.12&&(shape(segs[j]).lean>=0))j++;
        return {have:{x0:segs[0].x0,x1:segs[i-1].x1},need:{x0:segs[j].x0,x1:segs.at(-1).x1},slash:{x0:s.x0,x1:segs[j-1].x1},
          haveGlyphs:segs.slice(0,i),needGlyphs:segs.slice(j),y0,y1};
      }
    }
    return null;
  }
  // Ink for one count line from its colour pixels: darker than halfway between the line's
  // darkest text (5th percentile) and its background (median). Soft, scaled text (a game in
  // full screen) keeps its thin strokes, which a fixed cut breaks apart. Returns ImageData-like.
  function inkAdaptive(image){
    const {width,height,data}=image,lum=new Float32Array(width*height);
    for(let i=0;i<lum.length;i++)lum[i]=data[i*4]*.299+data[i*4+1]*.587+data[i*4+2]*.114;
    const sorted=Float32Array.from(lum).sort(),dark=sorted[Math.floor(sorted.length*.05)],mid=sorted[Math.floor(sorted.length*.5)];
    const cut=dark+(mid-dark)*.5,out=new Uint8ClampedArray(data.length);
    for(let i=0;i<lum.length;i++){const v=lum[i]<cut?0:255;out[i*4]=out[i*4+1]=out[i*4+2]=v;out[i*4+3]=255;}
    return {width,height,data:out,dark,mid};
  }
  // Lines from a system text recognizer (Windows OCR; Apple Vision does the same in Swift):
  // [{text,x,y,w,h}] in pixels, top-left origin. Returns the panel's text from its
  // "Quest Helper" title down, in reading order, or null when no panel is seen. The title
  // row's buttons (AUTO) are dropped; it also sets the panel's right edge. marked: the
  // player drew a box around the panel, so without a readable title every line is taken.
  function panelText(lines,{marked=false}={}){
    const all=(lines||[]).filter(l=>l&&String(l.text||'').trim()&&l.h>0).map(l=>({...l,text:String(l.text).trim()}));
    const over=(a,b)=>Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>Math.min(a.h,b.h)*.5;
    all.sort((a,b)=>over(a,b)?a.x-b.x:(a.y+a.h/2)-(b.y+b.h/2));
    if(!all.length)return null;
    const header=all.find(l=>isHeader(l.text));
    if(!header)return marked?all.map(l=>l.text).join('\n'):null;
    const lh=Math.max(1,header.h),right=Math.max(...all.filter(l=>over(l,header)).map(l=>l.x+l.w))+lh;
    const kept=[header];let bottom=header.y+header.h;
    for(const l of all){
      if(l.y+l.h/2<=header.y+header.h)continue;
      if(l.x<header.x-lh*1.5||l.x>=right)continue;
      if(l.y-bottom>lh*3.5)break;   // past the panel's end
      kept.push(l);bottom=Math.max(bottom,l.y+l.h);
    }
    return kept.map(l=>l.text).join('\n');
  }
  // The monster a quest's own text points at for one of its items ("He said I can easily get
  // them by defeating Stump, Slime, and Pig"): one the item is named after ("Omok Piece: Pig"
  // → Pig, "Omok Piece: Mushroom" → Orange Mushroom), else the only one no other objective is
  // named after ("Omok Table" → Stump). hunt: the quest's named monsters; others: its
  // objective names. Returns the monster name or null.
  function questMonster(item,hunt,others){
    const words=s=>normalize(s).split(' ').filter(Boolean),last=m=>words(m).at(-1);
    const full=(name,m)=>normalize(name).includes(normalize(m)),named=(name,m)=>full(name,m)||words(name).includes(last(m));
    const list=hunt||[],self=normalize(item);
    const direct=list.find(m=>full(item,m))||list.find(m=>named(item,m));
    if(direct)return direct;
    const left=list.filter(m=>!(others||[]).some(o=>normalize(o)!==self&&named(o,m)));
    return left.length===1?left[0]:null;
  }
  // Where to hunt: of the maps holding the monsters ({id, name, n: their spawns there, d:
  // portals away or null}), the reachable ones first; the most spawns, and of the maps with
  // nearly as many (within 15%), the nearest. Returns one of the candidates or null.
  function bestHuntMap(candidates){
    const list=(candidates||[]).filter(c=>c&&c.n>0);if(!list.length)return null;
    const reach=list.filter(c=>c.d!=null),pool=reach.length?reach:list,most=Math.max(...pool.map(c=>c.n));
    return pool.filter(c=>c.n>=most*.85).sort((a,b)=>(a.d??Infinity)-(b.d??Infinity)||b.n-a.n)[0];
  }
  const exported={bestHuntMap,questMonster,panelText,inkAdaptive,splitCounts,countSpan,counts,countsFromBoxes,find,inkDark,signature,changed,parse,matchTitle,mergeWrapped,pack,unpack,resolve,normalize,editDistance,looksLike};
  scope.MapleQuestHelper=exported;if(typeof module!=='undefined')module.exports=exported;
})(globalThis);
