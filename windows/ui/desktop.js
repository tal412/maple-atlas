/* Maple Atlas Companion for Windows: the window's logic. Mirrors the Mac app
 * (macos/App/.../CompanionModel.swift): helper events in, commands out, game-window
 * capture, the minimap box, map recognition every 1.5 s and the dot ~5 times a second. */
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
    $('firewall-fix').disabled=true;$('firewall-hint').textContent='Choose Yes in the Windows prompt…';
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
  $('update').onclick=()=>{$('update').disabled=true;$('update-text').textContent='Starting the update…';fetch('/api/update',{method:'POST',headers:{'X-Companion-Token':token}}).catch(()=>{$('update').disabled=false;});};
  checkUpdate();setInterval(checkUpdate,6*3600*1000);

  // Engine.
  window.addEventListener('atlas-engine',e=>{if(!engineReady&&e.detail?.message)$('engine').textContent=e.detail.message;});
  atlasEngine.ready().then(info=>{engineReady=true;$('engine').textContent='Ready · '+info.maps.length+' maps';}).catch(e=>{$('engine').textContent='Could not load: '+e.message;});

  // Game window capture (Windows' share picker; the browser asks once per launch).
  $('choose').onclick=async()=>{
    try{
      const next=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'window',frameRate:10},audio:false,preferCurrentTab:false,selfBrowserSurface:'exclude'});
      stopCapture();stream=next;video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=stream;await video.play();
      const track=stream.getVideoTracks()[0];$('window-name').textContent=track.label||'Game window';
      track.addEventListener('ended',()=>{if(stream===next){stopCapture();$('window-name').textContent='Game window no longer shared. Choose it again.';}});
      $('preview').hidden=false;$('region-row').hidden=false;$('track').disabled=false;$('choose').textContent='Change window…';drawPreview();
    }catch(e){if(e?.name!=='NotAllowedError')$('window-name').textContent='Could not share the window: '+e.message;}
  };
  function stopCapture(){stopTracking();stream?.getTracks().forEach(t=>t.stop());stream=null;video=null;$('preview').hidden=true;$('region-row').hidden=true;$('track').disabled=true;$('choose').textContent='Choose game window…';}

  // Minimap box: normalized, top-left origin, remembered on this PC.
  function loadBox(){try{const b=JSON.parse(localStorage.getItem(BOX_KEY));if(b&&[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.w>.02&&b.h>.02)return b;}catch(_){}return {...DEFAULT_BOX};}
  function saveBox(){try{localStorage.setItem(BOX_KEY,JSON.stringify(box));}catch(_){}atlasEngine.reset();noMatchSince=Date.now();placeBox();}
  function placeBox(){Object.assign($('box').style,{left:box.x*100+'%',top:box.y*100+'%',width:box.w*100+'%',height:box.h*100+'%'});}
  let dragStart=null;
  const point=e=>{const r=$('preview').getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))};};
  $('preview').onpointerdown=e=>{dragStart=point(e);$('preview').setPointerCapture(e.pointerId);};
  $('preview').onpointermove=e=>{if(!dragStart)return;const p=point(e);box={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),w:Math.abs(p.x-dragStart.x),h:Math.abs(p.y-dragStart.y)};placeBox();};
  $('preview').onpointerup=()=>{dragStart=null;if(box.w<.02||box.h<.02)box={...DEFAULT_BOX};saveBox();};
  $('reset-box').onclick=()=>{box={...DEFAULT_BOX};saveBox();};
  placeBox();
  function drawPreview(){
    if(!video?.videoWidth)return;const c=$('preview-canvas'),scale=Math.min(1,560/video.videoWidth);
    c.width=Math.round(video.videoWidth*scale);c.height=Math.round(video.videoHeight*scale);c.getContext('2d').drawImage(video,0,0,c.width,c.height);
  }
  const crop=()=>({x:Math.round(box.x*video.videoWidth),y:Math.round(box.y*video.videoHeight),w:Math.max(16,Math.round(box.w*video.videoWidth)),h:Math.max(16,Math.round(box.h*video.videoHeight))});

  // Tracking.
  $('track').onclick=()=>tracking?stopTracking():startTracking();
  function startTracking(){if(!video)return;tracking=true;atlasEngine.reset();noMatchSince=Date.now();lastSearching=0;$('track').textContent='Stop tracking';$('reading').textContent='Reading the minimap…';}
  function stopTracking(){if(!tracking)return;tracking=false;$('track').textContent='Start tracking';$('reading').textContent='Not tracking';cmd({cmd:'tracking',state:'paused'});}
  async function readMap(){
    readBusy=true;lastRead=Date.now();
    try{
      const r=await atlasEngine.readFrame(video,crop(),video.videoHeight);if(!tracking)return;
      if(r.phase==='confirmed'){
        noMatchSince=Date.now();lastMap={id:r.id,name:r.name,at:Date.now()};$('last-map').textContent=r.name+' · '+r.inliers+' landmarks';
        $('reading').textContent=(phase==='connected'?'Following on phone · ':'Minimap match · ')+r.name;
        cmd({cmd:'location',id:r.id,confidence:r.confidence||0,observedAt:Date.now()});
        if(r.position)sendPosition(r.id,r.position);
        return;
      }
      if(r.phase==='candidate'){noMatchSince=Date.now();$('reading').textContent='Checking the minimap…'+(r.name?' · '+r.name+'?':'');}
      else $('reading').textContent=Date.now()-noMatchSince>12000?'No map found in the selected minimap area. Adjust the box around the minimap.':'Reading the minimap…';
      if(Date.now()-lastSearching>5000){cmd({cmd:'tracking',state:'searching'});lastSearching=Date.now();}
    }catch(e){$('reading').textContent=e.message;}
    finally{readBusy=false;}
  }
  async function readDot(){
    dotBusy=true;
    try{const r=await atlasEngine.locateFrame(video,crop(),video.videoHeight,lastMap.id);if(tracking&&r.position)sendPosition(lastMap.id,r.position);}
    catch(_){}finally{dotBusy=false;}
  }
  function sendPosition(id,p){lastPosition=p;$('position').textContent='x '+Math.round(p.x)+', y '+Math.round(p.y);cmd({cmd:'position',id,x:p.x,y:p.y,observedAt:Date.now()});}
  // The game's Quest Helper (top right) every 3 s; the phone gets the list when it
  // changes and again every 15 s.
  async function readQuests(){
    questBusy=true;lastQuestRead=Date.now();
    try{
      const w=video.videoWidth,h=video.videoHeight,r=await atlasEngine.readQuestsFrame(video,{x:Math.round(w*.55),y:0,w:Math.round(w*.45),h:Math.round(h*.5)});
      if(!tracking)return;
      $('quests').textContent=!r.visible?'Not visible (top right of the game)':r.quests.length?r.quests.length+' quest'+(r.quests.length===1?'':'s')+' tracked':'Open · no quests read';
      if(phase==='connected'&&(r.changed||Date.now()-questsSentAt>=15000)){cmd({cmd:'quests',visible:r.visible,quests:r.quests,observedAt:Date.now()});questsSentAt=Date.now();}
    }catch(_){}finally{questBusy=false;}
  }
  // Ticks come from a worker: its timers keep running while this window is behind the game.
  const ticker=new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),200)'],{type:'text/javascript'})));
  let previewAt=0;
  ticker.onmessage=()=>{
    if(!video?.videoWidth)return;
    if(Date.now()-previewAt>500){previewAt=Date.now();drawPreview();}
    if(!tracking||!engineReady)return;
    if(!questBusy&&!readBusy&&Date.now()-lastQuestRead>=3000)void readQuests();
    if(!readBusy&&Date.now()-lastRead>=1500)void readMap();
    else if(!dotBusy&&lastMap&&Date.now()-lastMap.at<10000)void readDot();
  };
})();
