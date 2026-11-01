/* What is on a game screenshot: the "Look" feature.
 *
 * The computer sends a screenshot of the game window and the text its system reader found
 * on it (Vision on the Mac, Windows.Media.Ocr on Windows); this module finds what in it is in
 * the database, inside a marked box or on the whole screen ("Around me"):
 *   - names: NPC name tags, item names in chat, shops and quests, the map name, read from the
 *     text lines and matched to the database's names;
 *   - sprites: monsters, NPCs and dropped items, by their own sprites from the datamine drawn
 *     at the game's scale (the game draws sprites 1:1 in game pixels; the minimap's title strip
 *     is 45 game px tall, which gives that scale in the screenshot). Only what can be on this
 *     map is looked for: its monsters, its NPCs and what those monsters drop.
 *
 * Works on ImageData-like objects ({width, height, data: RGBA}). Browser and Node.
 */
(function(scope){
  const GAME_WIDTH=1366;   // the game's own width in pixels, when the minimap strip is not seen

  // ---- Names ----
  const norm=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[’`]/g,"'").replace(/[^a-z0-9']+/g,' ').trim();
  function editDistance(a,b,max=2){
    if(Math.abs(a.length-b.length)>max)return max+1;
    let prev=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){
      const cur=[i];let best=i;
      for(let j=1;j<=b.length;j++){cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));if(cur[j]<best)best=cur[j];}
      if(best>max)return max+1;prev=cur;
    }
    return prev[b.length];
  }
  // entries: [{type, id, name, ...}]. Returns a matcher: line text -> [{entry, exact}].
  function nameIndex(entries){
    const byName=new Map(),byWord=new Map();
    for(const e of entries){
      const n=norm(e.name);if(n.length<3)continue;
      if(!byName.has(n))byName.set(n,[]);byName.get(n).push(e);
      const first=n.split(' ')[0];if(!byWord.has(first))byWord.set(first,[]);byWord.get(first).push(n);
    }
    return function match(text){
      const t=norm(text);if(t.length<3)return [];
      if(byName.has(t))return byName.get(t).map(entry=>({entry,exact:true}));
      const words=t.split(' '),found=[];
      // A name inside the line ("Dances with Balrog's Letter x1 earned", "13/15 Blue Mushroom Cap"):
      // the longest name that starts at some word, compared whole-word.
      for(let i=0;i<words.length;i++){
        for(const n of byWord.get(words[i])||[]){
          const len=n.split(' ').length;if(len===1&&n.length<5)continue;
          if(words.slice(i,i+len).join(' ')===n)found.push({n,at:i,len});
        }
      }
      if(found.length){
        found.sort((a,b)=>b.n.length-a.n.length);const taken=new Set(),out=[];
        for(const f of found){let free=true;for(let i=f.at;i<f.at+f.len;i++)if(taken.has(i))free=false;if(!free)continue;for(let i=f.at;i<f.at+f.len;i++)taken.add(i);for(const entry of byName.get(f.n))out.push({entry,exact:true});}
        return out;
      }
      // A reading slip in a whole line that is a name ("Mr. Thundor").
      if(t.length>=6){
        let best=null;
        for(const n of byWord.get(words[0])||[])if(Math.abs(n.length-t.length)<=2){const d=editDistance(t,n,t.length>=10?2:1);if(d<=(t.length>=10?2:1)&&(!best||d<best.d))best={n,d};}
        if(best)return byName.get(best.n).map(entry=>({entry,exact:false}));
      }
      return [];
    };
  }
  // The player's own name: the one in the status bar at the bottom ("LV. 18 Archer TalTBest").
  function playerName(lines,frame){
    const bottom=lines.filter(l=>l.y>frame.h*.9&&/^[A-Za-z0-9]{3,13}$/.test(String(l.text).trim()));
    const lv=lines.find(l=>l.y>frame.h*.9&&/^lv\.?$/i.test(String(l.text).trim()));
    const pick=lv?bottom.filter(l=>l.x>lv.x).sort((a,b)=>a.x-b.x).find(l=>!/^(archer|warrior|magician|thief|pirate|beginner|bowman|cleric|wizard|hunter|crossbowman|fighter|page|spearman|assassin|bandit|brawler|gunslinger)$/i.test(l.text.trim())):null;
    return pick?String(pick.text).trim():null;
  }
  // Where the player stands on screen: their name tag (the status bar's name, shown again
  // under the character), the one nearest the middle; else the middle (the camera follows you).
  function findPlayer(lines,frame){
    const name=playerName(lines,frame),mid={x:frame.w/2,y:frame.h*.6};
    if(name){
      const n=norm(name),tags=lines.filter(l=>l.y<frame.h*.9&&l.x<frame.w*.86&&(norm(l.text)===n||editDistance(norm(l.text),n,1)<=1));
      tags.sort((a,b)=>Math.hypot(a.x+a.w/2-mid.x,a.y-mid.y)-Math.hypot(b.x+b.w/2-mid.x,b.y-mid.y));
      if(tags[0]){const t=tags[0];return {x:t.x+t.w/2,y:t.y-t.h*2.5,name,found:true};}
    }
    return {x:mid.x,y:mid.y,name,found:false};
  }

  // A name tag: light letters on a dark box, so much of the text's own box is dark.
  function darkTag(img,l){
    let dark=0,n=0;
    const x0=Math.max(0,Math.round(l.x)),x1=Math.min(img.width,Math.round(l.x+l.w)),y0=Math.max(0,Math.round(l.y)),y1=Math.min(img.height,Math.round(l.y+l.h));
    for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const j=(y*img.width+x)*4;if(img.data[j]*.299+img.data[j+1]*.587+img.data[j+2]*.114<75)dark++;n++;}
    return n>=20&&dark/n>=.3;
  }

  // ---- Sprites ----
  const at=(img,x,y)=>(y*img.width+x)*4;
  // A sprite drawn at scale k (bilinear, as the game window is scaled), with its opaque pixels.
  function template(sprite,k,flip=false){
    const w=Math.max(2,Math.round(sprite.width*k)),h=Math.max(2,Math.round(sprite.height*k)),px=[];
    const src=sprite.data,sw=sprite.width,sh=sprite.height;
    const sample=(fx,fy,c)=>{const x0=Math.max(0,Math.min(sw-1,Math.floor(fx))),y0=Math.max(0,Math.min(sh-1,Math.floor(fy))),x1=Math.min(sw-1,x0+1),y1=Math.min(sh-1,y0+1),ax=Math.max(0,Math.min(1,fx-x0)),ay=Math.max(0,Math.min(1,fy-y0));
      const v=(x,y)=>src[(y*sw+x)*4+c];return (v(x0,y0)*(1-ax)+v(x1,y0)*ax)*(1-ay)+(v(x0,y1)*(1-ax)+v(x1,y1)*ax)*ay;};
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const fx=((flip?w-1-x:x)+.5)/k-.5,fy=(y+.5)/k-.5;
      // Fully opaque here and around: edges blend with whatever is behind the sprite.
      let solid=true;for(const [dx,dy] of [[0,0],[-.6,0],[.6,0],[0,-.6],[0,.6]])if(sample(fx+dx/k*k,fy+dy/k*k,3)<250)solid=false;
      if(solid)px.push({x,y,r:sample(fx,fy,0),g:sample(fx,fy,1),b:sample(fx,fy,2)});
    }
    return {w,h,px,flip};
  }
  // Masked match score at origin (ox, oy): normalized correlation of the colours, less the
  // mean colour difference (a shape in the wrong colours is not the sprite).
  function score(img,t,ox,oy,step=1){
    let n=0,sa=0,sb=0,sab=0,saa=0,sbb=0,diff=0;const d=img.data;
    for(let i=0;i<t.px.length;i+=step){
      const p=t.px[i],j=at(img,ox+p.x,oy+p.y);
      for(const [a,b] of [[d[j],p.r],[d[j+1],p.g],[d[j+2],p.b]]){n++;sa+=a;sb+=b;sab+=a*b;saa+=a*a;sbb+=b*b;diff+=Math.abs(a-b);}
    }
    const va=saa-sa*sa/n,vb=sbb-sb*sb/n;if(va<=0||vb<=0)return -1;
    return (sab-sa*sb/n)/Math.sqrt(va*vb)-diff/n/255;
  }
  const close=(img,j,c,tol)=>Math.abs(img.data[j]-c.r)+Math.abs(img.data[j+1]-c.g)+Math.abs(img.data[j+2]-c.b)<=tol;
  // Where template t is in the region: candidates from its two rarest colours (both in place),
  // then the full score. Returns [{x, y, w, h, score}] in image pixels.
  // Every pixel of a region by its colour (16 levels a channel): a sprite's anchor colour is then
  // looked up instead of scanning the whole screen for it.
  function colorIndex(img,region){
    const x0=Math.max(0,Math.floor(region.x)),y0=Math.max(0,Math.floor(region.y)),x1=Math.min(img.width,Math.ceil(region.x+region.w)),y1=Math.min(img.height,Math.ceil(region.y+region.h));
    const n=Math.max(0,(x1-x0)*(y1-y0)),bin=new Uint16Array(n),count=new Uint32Array(4097),d=img.data;let i=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++,i++){const j=(y*img.width+x)*4,q=((d[j]>>4)<<8)|((d[j+1]>>4)<<4)|(d[j+2]>>4);bin[i]=q;count[q+1]++;}
    for(let q=1;q<=4096;q++)count[q]+=count[q-1];
    const fill=count.slice(0,4096),pos=new Int32Array(n);i=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++,i++)pos[fill[bin[i]]++]=y*img.width+x;
    return {start:count,pos,x0,y0,x1,y1,hist:q=>count[q+1]-count[q]};
  }
  function findSprite(img,t,region,{threshold=.55,hist=null,tol=60,index=null}={}){
    if(t.px.length<12)return [];
    const rx0=Math.max(0,Math.floor(region.x)),ry0=Math.max(0,Math.floor(region.y)),rx1=Math.min(img.width,Math.ceil(region.x+region.w)),ry1=Math.min(img.height,Math.ceil(region.y+region.h));
    if(rx1-rx0<t.w||ry1-ry0<t.h)return [];
    const q=p=>((p.r>>4)<<8)|((p.g>>4)<<4)|(p.b>>4);
    // Anchors: well-separated pixels in flat areas of the sprite (not a blend at the border of two
    // colours, which the screen may not have) whose colours are rarest on the screen.
    if(!t.flat){
      const at2=new Map(t.px.map(p=>[p.y*t.w+p.x,p])),near=(p,o)=>o&&Math.abs(p.r-o.r)+Math.abs(p.g-o.g)+Math.abs(p.b-o.b)<=24;
      t.flat=t.px.filter(p=>near(p,at2.get(p.y*t.w+p.x-1))&&near(p,at2.get(p.y*t.w+p.x+1))&&near(p,at2.get((p.y-1)*t.w+p.x))&&near(p,at2.get((p.y+1)*t.w+p.x)));
      if(t.flat.length<8)t.flat=t.px;
    }
    const ranked=t.flat.map(p=>({p,rare:index?index.hist(q(p)):hist?hist[q(p)]||0:0})).sort((a,b)=>a.rare-b.rare);
    const hits=[],far=(p,q)=>Math.hypot(p.x-q.x,p.y-q.y)>Math.max(t.w,t.h)*.35;
    // Two anchor pairs: the rarest colour and one far from it; then the next rarest that is far
    // from the first (a colour shifted by the screenshot's compression is caught by the other).
    const b1=ranked.find(r=>far(r.p,ranked[0].p))?.p||ranked[1].p;
    const c0=ranked.find(r=>r.p!==ranked[0].p&&r.p!==b1&&far(r.p,ranked[0].p))?.p||ranked[2]?.p||ranked[0].p;
    const pairs=[[ranked[0].p,b1],[c0,ranked[0].p]],seen=new Set();
    for(const [a1,a2] of pairs){
    const test=(x,y)=>{
      if(x<rx0+a1.x||x>=rx1-(t.w-a1.x)||y<ry0+a1.y||y>=ry1-(t.h-a1.y))return;
      if(!close(img,at(img,x,y),a1,tol))return;
      const ox=x-a1.x,oy=y-a1.y,key=oy*img.width+ox;
      if(seen.has(key)||!close(img,at(img,ox+a2.x,oy+a2.y),a2,tol*1.4))return;
      seen.add(key);
      const s=score(img,t,ox,oy,3);if(s>=threshold-.15)hits.push({x:ox,y:oy,s});
    };
    if(index){
      // The pixels whose colour is within a level of the anchor's, from the index.
      const r=a1.r>>4,g=a1.g>>4,b=a1.b>>4;
      for(let dr=-2;dr<=2;dr++)for(let dg=-2;dg<=2;dg++)for(let db=-2;db<=2;db++){
        const R=r+dr,G=g+dg,B=b+db;if(R<0||G<0||B<0||R>15||G>15||B>15)continue;
        const q=(R<<8)|(G<<4)|B;for(let i=index.start[q];i<index.start[q+1];i++){const p=index.pos[i],y=(p/img.width)|0;test(p-y*img.width,y);}
      }
    }else for(let y=ry0+a1.y;y<ry1-(t.h-a1.y);y++)for(let x=rx0+a1.x;x<rx1-(t.w-a1.x);x++)test(x,y);
    }
    // Best of each neighbourhood, scored in full.
    hits.sort((a,b)=>b.s-a.s);const out=[];
    for(const h of hits){
      if(out.some(o=>Math.abs(o.x-h.x)<t.w*.6&&Math.abs(o.y-h.y)<t.h*.6))continue;
      let best={x:h.x,y:h.y,s:score(img,t,h.x,h.y)};
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const x=h.x+dx,y=h.y+dy;if(x<0||y<0||x+t.w>img.width||y+t.h>img.height)continue;const s=score(img,t,x,y);if(s>best.s)best={x,y,s};}
      if(best.s>=threshold)out.push({x:best.x,y:best.y,w:t.w,h:t.h,score:Math.round(best.s*100)/100});
      if(out.length>=12)break;
    }
    return out;
  }
  // Half size (2x2 averages) of a region of the image, for scanning large areas faster.
  function half(img,region){
    const x0=Math.max(0,region.x|0),y0=Math.max(0,region.y|0),x1=Math.min(img.width,Math.ceil(region.x+region.w)),y1=Math.min(img.height,Math.ceil(region.y+region.h));
    const w=(x1-x0)>>1,h=(y1-y0)>>1,data=new Uint8ClampedArray(w*h*4),d=img.data;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const a=at(img,x0+x*2,y0+y*2),b=a+4,c=a+img.width*4,e=c+4,o=(y*w+x)*4;
      for(let ch=0;ch<3;ch++)data[o+ch]=(d[a+ch]+d[b+ch]+d[c+ch]+d[e+ch]+2)>>2;data[o+3]=255;
    }
    return {image:{width:w,height:h,data},x0,y0};
  }
  function colorHistogram(img,region){
    const hist=new Uint32Array(4096),x0=Math.max(0,region.x|0),y0=Math.max(0,region.y|0),x1=Math.min(img.width,Math.ceil(region.x+region.w)),y1=Math.min(img.height,Math.ceil(region.y+region.h));
    for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const j=at(img,x,y);hist[((img.data[j]>>4)<<8)|((img.data[j+1]>>4)<<4)|(img.data[j+2]>>4)]++;}
    return hist;
  }

  // ---- The whole look ----
  // image: the screenshot. lines: [{text, x, y, w, h}] in its pixels. region: {x, y, w, h} in its
  // pixels (the marked box), or null for the whole screen. k: image pixels per game pixel.
  // names: a nameIndex() matcher. sprites: [{type, id, name, image: ImageData-like}] to look for.
  // Returns {player, found: [{type, id, name, box, via: 'name'|'sprite', score}]}, most certain first.
  function analyze({image,lines=[],region=null,k=null,names=null,sprites=[],now=()=>Date.now(),budget=6000}){
    const frame={w:image.width,h:image.height},area=region||{x:0,y:0,w:frame.w,h:frame.h},started=now();
    k=k||frame.w/GAME_WIDTH;
    const inside=b=>b.x+b.w/2>=area.x&&b.x+b.w/2<=area.x+area.w&&b.y+b.h/2>=area.y&&b.y+b.h/2<=area.y+area.h;
    const found=[],players=[],candidates=[];
    const player=findPlayer(lines,frame);
    if(names)for(const l of lines){
      if(!inside(l))continue;
      const uiLine=l.y>frame.h*.9||l.x>frame.w*.83&&l.y<frame.h*.62;
      if(player.name&&norm(l.text)===norm(player.name)){if(!uiLine&&!players.some(p=>p.you))players.push({name:player.name,box:{x:l.x,y:l.y,w:l.w,h:l.h},you:true});continue;}
      // Text in the game's own windows (Quest Helper, chat and status bar) rather than over the world.
      const ui=l.y>frame.h*.9||l.x>frame.w*.83&&l.y<frame.h*.62;
      const seen=new Set();let matched=false;
      for(const {entry,exact} of names(l.text)){
        // Monsters carry no name tag in the game: a tag over the world with a monster's name is
        // a pet's or a player's.
        if(entry.type==='monster'&&!ui&&norm(l.text)===norm(entry.name))continue;
        // A one-word tag over the world that is an item's name is a pet's or a player's too.
        if(entry.type==='item'&&!ui&&norm(l.text)===norm(entry.name)&&!/\s/.test(norm(entry.name)))continue;
        const key=entry.type+':'+norm(entry.name);if(seen.has(key))continue;seen.add(key);
        matched=true;found.push({type:entry.type,id:entry.id,name:entry.name,box:{x:l.x,y:l.y,w:l.w,h:l.h},via:'name',ui,score:exact?(ui?.9:1):.8});}
      // Other players: a one-word name tag over the world on the tag's dark box, that is nothing
      // in the database (not the minimap's name, an NPC's title or a button's label).
      const word=String(l.text).trim();
      if(!matched&&!ui&&l.y<frame.h*.86&&/^[A-Za-z0-9]{3,13}$/.test(word)&&/[a-z]/.test(word)&&l.h<frame.h*.04&&darkTag(image,l))candidates.push({name:word,box:{x:l.x,y:l.y,w:l.w,h:l.h},you:false});
    }
    // An NPC's title sits right under its name ("Mr. Thunder" / "Weaponcrafter"): not a player.
    for(const c of candidates){
      // A slip of your own name ("TalTBestU") is you; each name once.
      if(player.name&&editDistance(norm(c.name),norm(player.name),1)<=1){c.you=true;c.name=player.name;}
      if(players.some(p=>norm(p.name)===norm(c.name)))continue;
      const title=found.some(f=>f.type==='npc'&&f.via==='name'&&Math.abs(c.box.y-(f.box.y+f.box.h))<f.box.h*1.6&&Math.abs(c.box.x+c.box.w/2-(f.box.x+f.box.w/2))<Math.max(f.box.w,c.box.w));
      if(!title)players.push(c);
    }
    // A little margin: a sprite cut by the box still counts when most of it is inside.
    const pad=40*k,search={x:area.x-pad,y:area.y-pad,w:area.w+pad*2,h:area.h+pad*2};
    // Large areas are scanned at half size (monsters and NPCs only; dropped items are too small).
    const big=search.w*search.h>300000&&k>=.9,small=big?half(image,search):null;
    const index=colorIndex(image,search),smallIndex=small?colorIndex(small.image,{x:0,y:0,w:small.image.width,h:small.image.height}):null;
    for(const s of sprites){
      if(now()-started>budget)break;
      // Small sprites (a snail) lose too much at half size: those are scanned in full.
      const useHalf=big&&s.type!=='item'&&Math.min(s.image.width,s.image.height)*k>=48;
      for(const flip of s.type==='item'?[false]:[false,true]){
        const t=template(s.image,useHalf?k/2:k,flip);
        // A dropped item's icon is small: only one with enough solid pixels is told apart from
        // the scenery (a thin sword is not).
        if(s.type==='item'&&t.px.length<150)continue;
        const hits=useHalf?findSprite(small.image,t,{x:0,y:0,w:small.image.width,h:small.image.height},{index:smallIndex,threshold:.58})
          .map(h=>({...h,x:small.x0+h.x*2,y:small.y0+h.y*2,w:h.w*2,h:h.h*2})):findSprite(image,t,search,{index,threshold:s.type==='item'?.82:.5});
        for(const hit of hits){
          const box={x:hit.x,y:hit.y,w:hit.w,h:hit.h};if(!inside(box))continue;
          found.push({type:s.type,id:s.id,name:s.name,box,via:'sprite',score:hit.score});
        }
      }
    }
    // An item seen on a monster or an NPC is part of it (a Blue Mushroom's cap), not a drop.
    const bodies=found.filter(f=>f.via==='sprite'&&f.type!=='item').map(f=>f.box);
    const overlaps=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y))>a.w*a.h*.3;
    for(let i=found.length-1;i>=0;i--)if(found[i].type==='item'&&found[i].via==='sprite'&&bodies.some(b=>overlaps(found[i].box,b)))found.splice(i,1);
    // One entry per thing seen: the same sprite flipped, or a name tag over its own NPC.
    found.sort((a,b)=>b.score-a.score);const out=[];
    for(const f of found){
      const same=out.find(o=>o.type===f.type&&o.id===f.id&&Math.abs(o.box.x+o.box.w/2-(f.box.x+f.box.w/2))<Math.max(o.box.w,f.box.w)*.8&&Math.abs(o.box.y-f.box.y)<Math.max(o.box.h,f.box.h)*1.5);
      if(same){same.count=(same.count||1);continue;}
      out.push(f);
    }
    return {player,k,found:out,players,elapsed:now()-started};
  }
  // Summary: each thing once, with how many were seen.
  function summary(found){
    const by=new Map();
    for(const f of found){const key=f.type+':'+f.id;const e=by.get(key);if(e){e.count++;e.score=Math.max(e.score,f.score);if(!f.ui)e.ui=false;if(f.via==='sprite')e.via='sprite';}else by.set(key,{type:f.type,id:f.id,name:f.name,count:1,score:f.score,via:f.via,ui:!!f.ui,box:f.box});}
    const order={monster:0,npc:1,item:2,map:3,quest:4};
    return [...by.values()].sort((a,b)=>(order[a.type]??9)-(order[b.type]??9)||b.count-a.count||b.score-a.score);
  }

  const api={analyze,summary,nameIndex,findPlayer,playerName,template,findSprite,colorIndex,score,norm,editDistance,GAME_WIDTH};
  scope.MapleLook=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
