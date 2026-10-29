/* Maple Atlas Companion for Windows: the window's logic. Mirrors the Mac app
 * (macos/App/.../CompanionModel.swift): helper events in, commands out, game-window
 * capture, the minimap box, reading the map name every 1.5 s and the dot ~5 times a second. */
(function(){
  const $=id=>document.getElementById(id);
  const token=new URLSearchParams(location.search).get('t')||'';
  const cmd=body=>fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json','X-Companion-Token':token},body:JSON.stringify(body)}).catch(()=>{});
  const DEFAULT_BOX={x:0,y:0,w:.4,h:.4},BOX_KEY='maple-atlas-companion-minimap-box';
  let contactAt=0,contactFrom='',phase='idle',paired=false,code=null,stream=null,video=null,tracking=false,box=loadBox();
  let lastMap=null,lastPosition=null,readBusy=false,dotBusy=false,questBusy=false,lastQuestRead=0,questsSentAt=0,lastRead=0,lastSearching=0,noMatchSince=Date.now(),engineReady=false;
  const titles={idle:'Not paired',waiting:'Waiting for your phone',connecting:'Connecting…',verifying:'Verifying…',connected:'Connected to phone',reconnecting:'Phone away',disconnected:'Disconnected',failed:'Connection failed',expired:'Code expired'};

  // Helper events.
  const events=new EventSource('/api/events?t='+encodeURIComponent(token));
  events.onmessage=e=>{let v;try{v=JSON.parse(e.data);}catch(_){return;}
    if(v.event==='code'){code=v;paired=false;showCode();}
    else if(v.event==='paired'){code=null;paired=true;$('qr').hidden=true;}
    else if(v.event==='state'){phase=v.phase;if(v.paired)paired=true;if(phase==='connected'){paired=true;questsSentAt=0;}paintPhone(v.message);}
    else if(v.event==='contact'){contactAt=Date.now();contactFrom=v.from;paintContact();}
    else if(v.event==='update'){$('update-text').textContent=v.message;$('update').hidden=v.phase!=='failed';$('update').disabled=false;if(v.phase==='failed')$('update').textContent='Try again';}
    else if(v.event==='error'){$('phone-error').textContent=v.message;$('phone-error').hidden=false;}
    paintPhone();
  };
  events.onerror=()=>{$('phone-state').textContent='Companion stopped';$('phone-message').textContent='Close this window and open Maple Atlas Companion again.';};
  function paintPhone(message){
    if(message!==undefined)$('phone-message').textContent=message;
    $('phone-state').textContent=phase==='waiting'&&paired?'Paired · waiting for your phone':titles[phase]||phase;
    $('phone-dot').dataset.tone=phase==='connected'?'ok':['connecting','verifying','reconnecting','waiting'].includes(phase)?'wait':['failed','expired'].includes(phase)?'bad':'';
    $('qr').hidden=!(code&&!paired&&phase==='waiting');
    $('new-code').textContent=paired?'Pair a new phone':'New code';
    $('disconnect').hidden=!['connected','reconnecting'].includes(phase);
  }
  function showCode(){
    MapleQR.toCanvas($('qr-canvas'),code.link,{scale:8,margin:4,errorCorrectionLevel:'M'});
    $('qr-address').textContent='This PC: '+(code.addresses||[]).join(', ');$('phone-error').hidden=true;
  }
  setInterval(()=>{if(code&&!paired){const s=Math.max(0,Math.round((code.expires-Date.now())/1000));$('qr-expiry').textContent=s?'Expires in '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0'):'Code expired — press New code';}},1000);
  $('new-code').onclick=()=>{paired=false;cmd({cmd:'pair'});};
  // The navigation card on top of the game during a route on the phone (drawn by the app).
  const OVERLAY_KEY='maple-atlas-companion-overlay';let overlayOn=true;try{overlayOn=localStorage.getItem(OVERLAY_KEY)!=='off';}catch(_){}
  $('overlay').checked=overlayOn;cmd({cmd:'overlay',on:overlayOn});
  $('overlay').onchange=()=>{overlayOn=$('overlay').checked;try{localStorage.setItem(OVERLAY_KEY,overlayOn?'on':'off');}catch(_){}cmd({cmd:'overlay',on:overlayOn});};
  $('disconnect').onclick=()=>cmd({cmd:'stop'});

  // Whether the phone's connection attempts arrive at all (a blocked network looks the same as no try).
  function paintContact(){
    const el=$('contact');if(phase==='connected'){el.hidden=true;return;}
    el.hidden=!contactAt;if(contactAt)el.textContent='Your phone reached this PC ('+contactFrom+', '+Math.round((Date.now()-contactAt)/1000)+' s ago).';
  }
  setInterval(paintContact,2000);
  // Windows Firewall: checked at launch; one button asks Windows to allow this app.
  async function checkFirewall(){
    try{
      const r=await fetch('/api/firewall',{headers:{'X-Companion-Token':token}}).then(r=>r.json());
      const bad=['blocked','missing','shielded'].includes(r.state);$('firewall').hidden=!bad;$('firewall-fix').hidden=r.state==='shielded';
      if(bad)$('firewall-text').textContent=(r.detail||'Windows Firewall is blocking this app.')+' Your phone cannot connect until it is allowed.';
      return r.state;
    }catch(_){return 'unknown';}
  }
  $('firewall-fix').onclick=async()=>{
    $('firewall-fix').disabled=true;$('firewall-hint').textContent='Choose Yes when Windows asks about Maple Atlas Companion…';
    const r=await fetch('/api/firewall',{method:'POST',headers:{'X-Companion-Token':token}}).catch(()=>null);
    if(!r||!r.ok){$('firewall-fix').disabled=false;$('firewall-hint').textContent='Windows did not allow it. Try again and choose Yes.';return;}
    for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,1500));if(await checkFirewall()==='ok'){$('firewall-hint').textContent='';break;}}
    $('firewall-fix').disabled=false;$('firewall-hint').textContent=$('firewall').hidden?'':'Still blocked. Try again and choose Yes.';
  };
  checkFirewall();

  // Updates: checked at launch and every 6 hours; one click downloads and runs the setup.
  async function checkUpdate(){
    try{
      const r=await fetch('/api/update',{headers:{'X-Companion-Token':token}}).then(r=>r.json());
      if(r.error){$('update-text').textContent='Version '+r.current;return;}
      $('update-text').textContent=r.available?'Version '+r.latest+' is available (you have '+r.current+')':'Version '+r.current+' · Up to date';
      $('update').hidden=!r.available;$('update').textContent='Update to '+r.latest;
    }catch(_){}
  }
  $('update-check').onclick=async()=>{$('update-check').disabled=true;$('update-check').textContent='Checking…';await checkUpdate();$('update-check').disabled=false;$('update-check').textContent='Check for updates';};
  $('update').onclick=()=>{$('update').disabled=true;$('update-text').textContent='Starting the update…';fetch('/api/update',{method:'POST',headers:{'X-Companion-Token':token}}).catch(()=>{$('update').disabled=false;});};
  checkUpdate();setInterval(checkUpdate,6*3600*1000);

  // Engine.
  window.addEventListener('atlas-engine',e=>{if(!engineReady&&e.detail?.message)$('engine').textContent=e.detail.message;});
  atlasEngine.ready().then(info=>{engineReady=true;$('engine').textContent='Ready · '+info.maps.length+' maps';}).catch(e=>{$('engine').textContent='Could not load: '+e.message;});

  // The game window. The helper finds the MapleStory window by itself and hands this page
  // crops of it (no share-picker click); the picker stays as a fallback for other windows.
  const api=path=>fetch(path,{headers:{'X-Companion-Token':token}});
  let helperGame=null,stoppedByPlayer=false,ocrBroken='';
  const haveSource=()=>!!(helperGame||video?.videoWidth);
  const sourceSize=()=>helperGame?{w:helperGame.width,h:helperGame.height}:{w:video.videoWidth,h:video.videoHeight};
  // A crop of the helper's window capture as a canvas, plus the window height at its scale.
  const grabCanvases={};
  async function grab(b,maxSide,slot){
    const r=await api('/api/frame?x='+b.x+'&y='+b.y+'&w='+b.w+'&h='+b.h+'&max='+maxSide);
    if(!r.ok)throw Error((await r.text()).trim()||'The game window could not be read.');
    const w=+r.headers.get('X-Width'),h=+r.headers.get('X-Height'),pix=new Uint8ClampedArray(await r.arrayBuffer());
    const c=grabCanvases[slot]??=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d',{willReadFrequently:true}).putImageData(new ImageData(pix,w,h),0,0);
    return {canvas:c,frameHeight:+r.headers.get('X-Frame-Height')||h};
  }
  async function findGame(){
    if(video)return;   // the player chose a window in the picker
    try{
      const g=await api('/api/game').then(r=>r.json());
      if(g.found){
        const isNew=!helperGame||helperGame.title!==g.title;helperGame=g;
        if(isNew){$('window-name').textContent=g.title+' · found automatically';cmd({cmd:'window',title:g.title});stoppedByPlayer=false;showSourceUI(true);drawPreview();}
      }else if(helperGame){helperGame=null;stopTracking();showSourceUI(false);$('window-name').textContent='Waiting for MapleStory… ('+(g.error||'not open')+')';}
      else $('window-name').textContent='Waiting for MapleStory to open… (or choose its window)';
    }catch(_){}
  }
  function showSourceUI(on){$('preview').hidden=!on;$('region-row').hidden=!on;$('box-switch').hidden=!on;$('track').disabled=!on;$('choose').textContent=on?'Change window…':'Choose game window…';}
  setInterval(findGame,2000);findGame();
  $('choose').onclick=async()=>{
    try{
      const next=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'window',frameRate:10},audio:false,preferCurrentTab:false,selfBrowserSurface:'exclude'});
      stopCapture();helperGame=null;stream=next;video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=stream;await video.play();
      const track=stream.getVideoTracks()[0];$('window-name').textContent=track.label||'Game window';cmd({cmd:'window',title:track.label||''});
      track.addEventListener('ended',()=>{if(stream===next){stopCapture();$('window-name').textContent='Game window no longer shared. Choose it again.';}});
      stoppedByPlayer=false;showSourceUI(true);drawPreview();
    }catch(e){if(e?.name!=='NotAllowedError')$('window-name').textContent='Could not share the window: '+e.message;}
  };
  function stopCapture(){stopTracking();stream?.getTracks().forEach(t=>t.stop());stream=null;video=null;showSourceUI(false);findGame();}

  // Minimap box: normalized, top-left origin, remembered on this PC.
  function loadBox(){try{const b=JSON.parse(localStorage.getItem(BOX_KEY));if(b&&[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.w>.02&&b.h>.02)return b;}catch(_){}return {...DEFAULT_BOX};}
  function saveBox(){try{localStorage.setItem(BOX_KEY,JSON.stringify(box));}catch(_){}atlasEngine.reset();noMatchSince=Date.now();placeBox();}
  function placeBox(){
    const put=(el,b)=>Object.assign(el.style,{left:b.x*100+'%',top:b.y*100+'%',width:b.w*100+'%',height:b.h*100+'%'});
    put($('box'),box);put($('qbox'),qbox);$('box').classList.toggle('passive',editQuest);$('qbox').classList.toggle('passive',!editQuest);
  }
  // Quest Helper box: drawn by the player around the panel (else the top-right corner is searched).
  const QBOX_KEY='maple-atlas-companion-quest-box',DEFAULT_QBOX={x:.55,y:0,w:.45,h:.5};
  let qbox={...DEFAULT_QBOX},qmarked=false,editQuest=false;
  try{const b=JSON.parse(localStorage.getItem(QBOX_KEY));if(b&&[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.w>.03&&b.h>.03){qbox=b;qmarked=true;}}catch(_){}
  $('mode-map').onchange=$('mode-quest').onchange=()=>{editQuest=$('mode-quest').checked;placeBox();};
  let dragStart=null;
  const point=e=>{const r=$('preview').getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))};};
  $('preview').onpointerdown=e=>{dragStart=point(e);$('preview').setPointerCapture(e.pointerId);};
  $('preview').onpointermove=e=>{if(!dragStart)return;const p=point(e),b={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),w:Math.abs(p.x-dragStart.x),h:Math.abs(p.y-dragStart.y)};if(editQuest)qbox=b;else box=b;placeBox();};
  $('preview').onpointerup=()=>{dragStart=null;if(editQuest){if(qbox.w<.03||qbox.h<.03){qbox={...DEFAULT_QBOX};qmarked=false;try{localStorage.removeItem(QBOX_KEY);}catch(_){}}else{qmarked=true;try{localStorage.setItem(QBOX_KEY,JSON.stringify(qbox));}catch(_){}}placeBox();return;}if(box.w<.02||box.h<.02)box={...DEFAULT_BOX};saveBox();};
  $('reset-box').onclick=()=>{if(editQuest){qbox={...DEFAULT_QBOX};qmarked=false;try{localStorage.removeItem(QBOX_KEY);}catch(_){}placeBox();return;}box={...DEFAULT_BOX};saveBox();};
  placeBox();
  let previewBusy=false;
  async function drawPreview(){
    const c=$('preview-canvas');
    if(helperGame){
      if(previewBusy)return;previewBusy=true;
      try{const g=await grab({x:0,y:0,w:1,h:1},560,'preview');c.width=g.canvas.width;c.height=g.canvas.height;c.getContext('2d').drawImage(g.canvas,0,0);}catch(_){}finally{previewBusy=false;}
      return;
    }
    if(!video?.videoWidth)return;const scale=Math.min(1,560/video.videoWidth);
    c.width=Math.round(video.videoWidth*scale);c.height=Math.round(video.videoHeight*scale);c.getContext('2d').drawImage(video,0,0,c.width,c.height);
  }
  const crop=()=>({x:Math.round(box.x*video.videoWidth),y:Math.round(box.y*video.videoHeight),w:Math.max(16,Math.round(box.w*video.videoWidth)),h:Math.max(16,Math.round(box.h*video.videoHeight))});
  // The minimap box as the engine wants it: a helper crop (≤ 960 px, like the Mac) or the
  // picker video with a crop rectangle.
  async function minimapSource(slot){
    if(helperGame){const g=await grab(box,960,slot);return [g.canvas,null,g.frameHeight];}
    return [video,crop(),video.videoHeight];
  }

  // Tracking.
  $('track').onclick=()=>{if(tracking){stoppedByPlayer=true;stopTracking();}else{stoppedByPlayer=false;startTracking();}};
  function startTracking(){if(!haveSource()||tracking)return;tracking=true;atlasEngine.reset();noMatchSince=Date.now();lastSearching=0;$('track').textContent='Stop tracking';$('reading').textContent='Reading the map name…';}
  function stopTracking(){if(!tracking)return;tracking=false;$('track').textContent='Start tracking';$('reading').textContent='Not tracking';cmd({cmd:'tracking',state:'paused'});}
  async function readMap(){
    readBusy=true;lastRead=Date.now();
    try{
      const r=await atlasEngine.readFrame(...await minimapSource('map'));if(!tracking)return;
      if(r.phase==='confirmed'){
        noMatchSince=Date.now();lastMap={id:r.id,name:r.name,at:Date.now()};$('last-map').textContent=r.name+' · '+r.inliers+' landmarks';
        $('reading').textContent=(phase==='connected'?'Following on phone · ':'Map name · ')+r.name;
        cmd({cmd:'location',id:r.id,confidence:r.confidence||0,observedAt:Date.now()});
        if(r.position)sendPosition(r.id,r.position);
        return;
      }
      if(r.phase==='candidate'){noMatchSince=Date.now();$('reading').textContent='Reading the map name…'+(r.name?' · '+r.name+'?':'');}
      else $('reading').textContent=Date.now()-noMatchSince>12000?(r.text||'No map name found in the box. Press + on the in-game minimap so its name shows, and keep it inside the box.'):'Reading the map name…';
      if(Date.now()-lastSearching>5000){cmd({cmd:'tracking',state:'searching'});lastSearching=Date.now();}
    }catch(e){$('reading').textContent=e.message;}
    finally{readBusy=false;}
  }
  async function readDot(){
    dotBusy=true;
    try{const r=await atlasEngine.locateFrame(...await minimapSource('dot'),lastMap.id);if(tracking&&r.position)sendPosition(lastMap.id,r.position);}
    catch(_){}finally{dotBusy=false;}
  }
  function sendPosition(id,p){lastPosition=p;$('position').textContent='x '+Math.round(p.x)+', y '+Math.round(p.y);cmd({cmd:'position',id,x:p.x,y:p.y,observedAt:Date.now()});}
  // The game's Quest Helper (top right) every 3 s; the phone gets the list when it
  // changes and again every 15 s.
  async function readQuests(){
    questBusy=true;lastQuestRead=Date.now();
    try{
      const r=await questReading();
      if(!tracking)return;
      $('quests').textContent=!r.visible?(qmarked?'Not found in its box':'Not found · draw its box (Quest Helper box)'):r.quests.length?r.quests.length+' quest'+(r.quests.length===1?'':'s')+' tracked':'Open · no quests read';
      if(phase==='connected'&&(r.changed||Date.now()-questsSentAt>=15000)){cmd({cmd:'quests',visible:r.visible,quests:r.quests,observedAt:Date.now()});questsSentAt=Date.now();}
    }catch(_){}finally{questBusy=false;}
  }
  // Windows' own text recognition reads the panel (far better than the bundled reader on
  // the game font); the bundled reader is used only when Windows has none.
  async function questReading(){
    if(!ocrBroken){
      let res;
      if(helperGame)res=await api('/api/ocr?x='+qbox.x+'&y='+qbox.y+'&w='+qbox.w+'&h='+qbox.h);
      else{
        const {w,h}=sourceSize(),c=grabCanvases.quest??=document.createElement('canvas'),r={x:Math.round(qbox.x*w),y:Math.round(qbox.y*h),w:Math.max(16,Math.round(qbox.w*w)),h:Math.max(16,Math.round(qbox.h*h))};
        c.width=r.w;c.height=r.h;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(video,r.x,r.y,r.w,r.h,0,0,r.w,r.h);
        res=await fetch('/api/ocr?w='+r.w+'&h='+r.h,{method:'POST',headers:{'X-Companion-Token':token,'Content-Type':'application/octet-stream'},body:x.getImageData(0,0,r.w,r.h).data});
      }
      const v=await res.json().catch(()=>({}));
      if(res.ok&&Array.isArray(v.lines))return atlasEngine.questsFromText(MapleQuestHelper.panelText(v.lines,{marked:qmarked}));
      if(res.status===503){ocrBroken=v.error||'unavailable';$('quests').textContent='Windows text recognition: '+ocrBroken;}
      else throw Error(v.error||'The Quest Helper could not be read.');
    }
    if(helperGame){const g=await grab(qbox,1600,'questT');return atlasEngine.readQuestsFrame(g.canvas,null,{marked:qmarked});}
    const {w,h}=sourceSize();
    return atlasEngine.readQuestsFrame(video,{x:Math.round(qbox.x*w),y:Math.round(qbox.y*h),w:Math.max(16,Math.round(qbox.w*w)),h:Math.max(16,Math.round(qbox.h*h))},{marked:qmarked});
  }
  // Ticks come from a worker: its timers keep running while this window is behind the game.
  const ticker=new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),200)'],{type:'text/javascript'})));
  let previewAt=0;
  ticker.onmessage=()=>{
    if(!haveSource())return;
    if(Date.now()-previewAt>(helperGame?1000:500)){previewAt=Date.now();void drawPreview();}
    // Tracking starts by itself once there is a window and the engine is ready.
    if(!tracking&&engineReady&&!stoppedByPlayer)startTracking();
    if(!tracking||!engineReady)return;
    if(!questBusy&&!readBusy&&Date.now()-lastQuestRead>=3000)void readQuests();
    if(!readBusy&&Date.now()-lastRead>=1500)void readMap();
    else if(!dotBusy&&lastMap&&Date.now()-lastMap.at<10000)void readDot();
  };
})();
