/* Look for the computer: the page look-host.html (built by scripts/build.py) that Maple Atlas
 * Companion opens in a hidden web view, so a box marked on the game (⌃⌥M / Ctrl+Alt+M) is
 * recognized on the computer itself and its card shown at once, with no phone needed. It is
 * Look's own recognition (src/look-engine.js: the same detector, namers and files, kept in the
 * web view's cache) and the phone's own words (src/look-card.js), with market prices.
 *
 * window.MapleLookHost:
 *   ready() -> Promise<true>                      the catalog and the prices loaded
 *   analyze({jpeg, lines, map, mark}) -> Promise<{card, result}>
 *     jpeg: base64 JPEG of the game window; lines: [[text, x, y, w, h]] read on it;
 *     map: the map id the app knows (or null); mark: {x, y, w, h} 0…1 of the window, or null
 *     for the whole window. card: {title, note, items: [{t, n, i, d, e, c, p}]} for the overlay;
 *     result: what was found (each thing with its box), for the phone's Look view.
 * Progress is posted to the app as it goes: webkit.messageHandlers.look ({progress: text}),
 * or the DevTools binding lookProgress (Windows, lookhost_windows.go).
 */
(function(scope){
  const DATA=__LOOK_HOST_DATA__;
  const engine=MapleLookEngine.create({look:DATA.look,catalogUrl:DATA.catalog});
  const maps=DATA.maps,mapOf=id=>maps.find(m=>m.id===String(id));
  // To the app: WKWebView's message handler (Mac), the DevTools binding lookProgress (Windows).
  const post=m=>{try{scope.webkit?.messageHandlers?.look?.postMessage(m);}catch(_){}try{if(typeof scope.lookProgress==='function')scope.lookProgress(JSON.stringify(m));}catch(_){}};
  let catalog=null,prices=new Map();
  const nameKey=n=>String(n).normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  async function loadCatalog(){
    if(catalog)return catalog;
    const r=await fetch(DATA.catalog);if(!r.ok)throw Error('The database did not load.');
    const data=await r.json();catalog={by:new Map((data.entities||[]).map(e=>[e.type+':'+e.id,e])),commit:data.sourceCommit||DATA.sourceCommit};
    return catalog;
  }
  // Prices: the site's copy of the player market (refreshed hourly), checked every 10 minutes.
  let pricesAt=0;
  async function loadPrices(){
    if(Date.now()-pricesAt<600000)return;
    try{const r=await fetch('./data/market.json',{cache:'no-cache'});if(r.ok){const d=await r.json();prices=new Map((d.items||[]).map(i=>[nameKey(i.name),i]));pricesAt=Date.now();}}catch(_){}
  }
  const env=()=>({catalog,mapOf,quests:DATA.quests||[],priceOf:e=>prices.get(nameKey(e.name))||null});
  const mapInfo=id=>{const m=mapOf(id);return m?{id:m.id,name:m.name,monsters:(m.monsters||[]).map(x=>({id:String(x.id),name:x.name})),npcs:(m.npcs||[]).map(x=>({id:String(x.id)}))}:null;};
  function stageText(p){
    if(p.stage==='download')return 'Getting Look ready ('+p.done+'/'+p.total+')…';
    if(p.stage==='detector')return 'Finding monsters, NPCs and items…';
    if(p.stage==='naming')return 'Naming '+(p.done+1)+' of '+p.total+'…';
    if(p.stage==='items')return 'Checking '+(p.done+1)+' of '+p.total+'…';
    return 'Looking…';
  }
  async function decode(jpeg){
    const bytes=Uint8Array.from(atob(jpeg),c=>c.charCodeAt(0)),bmp=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    const c=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(bmp.width,bmp.height):Object.assign(document.createElement('canvas'),{width:bmp.width,height:bmp.height});
    const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(bmp,0,0);bmp.close?.();return x.getImageData(0,0,c.width,c.height);
  }
  let queue=Promise.resolve();
  function analyze({jpeg,lines=[],map=null,mark=null}){
    // One look at a time (a second waits for the first).
    const run=queue.then(async()=>{
      const [image]=await Promise.all([decode(jpeg),loadCatalog(),loadPrices()]);
      const L=(lines||[]).map(l=>Array.isArray(l)?{text:String(l[0]),x:+l[1],y:+l[2],w:+l[3],h:+l[4]}:l);
      const whole=!mark||mark.w>.98&&mark.h>.98,region=whole?null:{x:mark.x*image.width,y:mark.y*image.height,w:mark.w*image.width,h:mark.h*image.height};
      let last=0;
      const r=await engine.analyze({image,lines:L,map:mapInfo(map)},region,p=>{const t=Date.now();if(t-last>200){last=t;post({progress:stageText(p)});}});
      // The phone's view needs the things (with their boxes), not the pictures behind them.
      const result={found:r.found,players:r.players,player:r.player,mapId:r.mapId,drops:r.drops,w:image.width,h:image.height};
      return {card:MapleLookCard.card(r,whole?'Around you':'In the box',env()),result};
    });
    queue=run.catch(()=>{});
    return run;
  }
  scope.MapleLookHost={ready:()=>Promise.all([loadCatalog(),loadPrices()]).then(()=>true),analyze,prefetch:()=>engine.prefetch()};
  // Everything Look compares against, into this web view's cache, right away.
  void engine.prefetch();
  post({ready:true});
})(globalThis);
