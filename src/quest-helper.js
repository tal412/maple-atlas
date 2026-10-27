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
    const left=Math.max(0,Math.round(header.autoX-header.autoW*9.8));
    const top=header.bottom+Math.max(2,Math.round(header.autoW*.15));
    const x0=left+header.autoW,x1=Math.min(width-1,header.right-header.autoW);
    if(x1<=x0)return null;
    const lum=y=>{let sum=0;for(let x=x0;x<=x1;x++){const [r,g,b]=at(image,x,y);sum+=(r+g+b)/3;}return sum/(x1-x0+1);};
    let bottom=-1;
    for(let y=top+header.autoW;y<height-3;y++){const v=lum(y);if(v>=110&&v-Math.max(lum(y-2),lum(y+3))>=12){bottom=y;break;}}
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
  const isHeader=line=>{const t=normalize(line).replace(/ /g,'').slice(0,11);return /quest\s*helper/i.test(line)||(t.length>=8&&editDistance(t,'questhelper'.slice(0,t.length))<=2);};
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
        const title=cleaned.replace(/\s*(\.{2,}|…)$/,'').replace(/[^\p{L}\p{N}'!?,.:() -]+/gu,'').trim();
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
    while(i<(words||[]).length&&/^(?:[^\p{L}\p{N}]+|[^\d\s])$/u.test(String(words[i]?.text||'').trim()))i++;   // stray edge marks
    for(const w of (words||[]).slice(i)){
      const t=String(w?.text||'').trim();if(!t)continue;
      const digits=/\d/.test(t)&&/^[\d/7lI|\\£#{(\[\]!.,:;]+$/.test(t),slash=lead.length&&/^[/7lI|\\]+$/.test(t);
      if(digits||slash)lead.push(w);else break;
    }
    if(!lead.length||!/\d/.test(lead[0].text))return null;
    const rest=(words||[]).slice(i+lead.length).map(w=>String(w.text||'').trim()).filter(Boolean).join(' ');
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
    const symbols=(words||[]).flatMap(w=>(w.symbols||[]).map(s=>({t:String(s.text||''),x0:s.bbox.x0,x1:s.bbox.x1})));
    const separators=symbols.filter(s=>/^[/|\\]$/.test(s.t));
    if(separators.length!==1)return null;
    const sep=separators[0],overlap=s=>Math.max(0,Math.min(s.x1,sep.x1)-Math.max(s.x0,sep.x0))/Math.max(1,s.x1-s.x0);
    const digits=symbols.filter(s=>/^\d$/.test(s.t)&&overlap(s)<.4);
    const have=digits.filter(s=>s.x1<=(sep.x0+sep.x1)/2).map(s=>s.t).join(''),need=digits.filter(s=>s.x0>=(sep.x0+sep.x1)/2).map(s=>s.t).join('');
    if(!have||!need||have.length>4||need.length>4||Number(need)<=0)return null;
    return {have:Number(have),need:Number(need)};
  }
  const exported={countSpan,counts,countsFromBoxes,find,inkDark,signature,changed,parse,matchTitle,mergeWrapped,pack,unpack,resolve,normalize,editDistance,looksLike};
  scope.MapleQuestHelper=exported;if(typeof module!=='undefined')module.exports=exported;
})(globalThis);
