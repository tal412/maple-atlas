/* Live companion on the phone: pair with Maple Atlas Companion (Mac or Windows) by
 * scanning its QR once, then reconnect by itself or with one tap. On a computer the
 * dialog only points to the companion app. */
(function(scope){
  const loaded=new Map();
  function load(path){if(!loaded.has(path))loaded.set(path,new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=path;script.onload=resolve;script.onerror=()=>{loaded.delete(path);script.remove();reject(Error('Could not load the QR reader. Connect once to download it, then retry.'));};document.head.append(script);}));return loaded.get(path);}
  const busy=['connecting','verifying'];
  function create({root,visualMaps,onLocation,onConnection,onPosition=()=>{},onQuests=()=>{},device}){
    const $=s=>root.querySelector(s),dialog=$('#mc-companion-dialog'),status=$('#mc-companion-status'),input=$('#mc-pair-input'),scanVideo=$('#mc-scan-video');
    device=device||MapleCompanionDevice.detect({userAgent:navigator.userAgent,platform:navigator.platform,maxTouchPoints:navigator.maxTouchPoints,userAgentData:navigator.userAgentData});
    const role=device.role;dialog.dataset.role=role;
    const known=new Map(visualMaps.map(m=>[String(m.id),m])),ids=new Set(visualMaps.map(m=>String(m.id)));
    let scanner=null,scanEpoch=0,scanTimer=null,lastSeen=0,accepting=false,scanning=false;
    let currentState={phase:'idle',message:'',expires:0};

    // Pair once: the app's code is kept on this phone (localStorage, per site) and used
    // to reconnect whenever Maple Atlas is on screen, or with one tap after a
    // deliberate disconnect. "Forget this computer" removes it.
    let pairingCode=null,resuming=false,resumeTries=0,wakeLock=null,storedAt=0;
    const pairingKey=()=>'maple-atlas-mac-pairing:'+location.pathname.replace(/index\.html$/,'');
    function remembered(){try{const v=JSON.parse(localStorage.getItem(pairingKey())||'null');return v&&typeof v.code==='string'&&/^MA2[A-Z2-7]+$/.test(v.code)?v:null;}catch(_){return null;}}
    function remember(code,{paused=false}={}){storedAt=Date.now();try{localStorage.setItem(pairingKey(),JSON.stringify({code,at:storedAt,paused}));}catch(_){}}
    function forget(){pairingCode=null;try{localStorage.removeItem(pairingKey());}catch(_){}paint(currentState);}

    function activity(title,message){$('#mc-tracking-title').textContent=title;$('#mc-tracking-message').textContent=message;}
    function clock(){
      const timer=$('#mc-pair-timer'),{phase,deadline}=currentState;
      timer.hidden=!(busy.includes(phase)&&deadline);if(timer.hidden)return;
      timer.textContent='Checking connection · '+Math.max(0,Math.ceil((deadline-Date.now())/1000))+'s remaining';
    }
    function paint(value){
      currentState=value;const phase=value.phase,linked=phase==='connected',pending=busy.includes(phase)||phase==='reconnecting',ended=!linked&&!pending,saved=role==='phone'&&remembered();
      const titles={idle:saved?'Computer not connected':'Not paired',connecting:'Connecting…',verifying:'Verifying…',connected:'Connected to your computer',reconnecting:'Connection interrupted',failed:'Could not connect',expired:'Code expired',disconnected:'Disconnected'};
      status.dataset.tone=linked?'success':['failed','expired'].includes(phase)?'error':pending?'pending':'neutral';
      $('#mc-companion-state-icon').textContent=linked?'✓':['failed','expired'].includes(phase)?'!':pending?'…':'○';
      $('#mc-companion-state-title').textContent=titles[phase]||'Not connected';
      $('#mc-companion-message').textContent=value.message||(saved?'Open Maple Atlas Companion on your computer, then tap Reconnect.':'');$('#mc-companion-message').hidden=!$('#mc-companion-message').textContent;
      $('#mc-companion-intro').hidden=!!saved||linked||pending;
      $('#mc-pair-reconnect').hidden=!(saved&&ended);
      $('#mc-pair-start').hidden=!!saved||!ended||scanning;
      $('#mc-pair-retry').hidden=!(saved&&ended);
      $('#mc-pair-forget').hidden=!(saved&&ended);
      $('#mc-pair-scan').hidden=!scanning||!ended;
      $('#mc-pair-active').hidden=!(linked||pending);
      $('#mc-tracking-status').hidden=!linked;$('#mc-pair-view-map').hidden=!linked;
      clock();
      // App-bar button and the wide layout's header button share the state dot.
      const state=linked?'connected':pending?'pending':saved?'away':'off',label='Live companion · '+{connected:'Connected',pending:'Connecting',away:'Computer not connected',off:'Not connected'}[state];
      for(const button of [$('#mc-mobile-companion'),$('#mc-companion-desktop')]){button.dataset.state=state;button.setAttribute('aria-label',label);}
      if(phase!=='idle'){$('#mc-companion-badge').hidden=false;$('#mc-companion-badge').textContent=linked?'Computer connected':titles[phase]||'Not connected';}
    }
    const link=MapleCompanionLink.create({ids,onLocation:value=>{
      lastSeen=Date.now();activity('Tracking live',known.get(value.id)?.name||'Map detected');onLocation(value);
    },onPosition:value=>{lastSeen=Date.now();onPosition(value);},onQuests:value=>onQuests(value),onReading:state=>{
      lastSeen=0;activity(state==='paused'?'Tracking paused':'Finding your map',state==='paused'?'The connection is working. Start tracking in Maple Atlas Companion.':'The connection is working. Keep the minimap visible while your computer identifies the map.');onConnection(state==='paused'?'stale':'searching');
    },onState:value=>{
      paint(value);
      if(value.phase==='connected'){
        stopScan();input.value='';clearError();onConnection('connected');
        if(pairingCode){remember(pairingCode);resumeTries=0;void requestWake();}
        if(!lastSeen)activity('Waiting for the game','The connection is working. In Maple Atlas Companion, choose the game window and start tracking.');
        dialog.scrollTo({top:0});
      }
      if(['failed','expired','disconnected'].includes(value.phase)){
        stopScan();lastSeen=0;input.value='';releaseWake();
        // The pairing is only removed with "Forget this computer": a failed or slow check
        // after a reload is retried, never treated as a rejection. A deliberate disconnect
        // keeps it but stops retrying; a dropped link retries by itself, backing off.
        if(['user','bye'].includes(value.reason)&&remembered())remember(remembered().code,{paused:value.reason==='user'?'user':'mac'});
        else if(remembered()&&!remembered().paused&&resumeTries<6){onConnection('resuming');setTimeout(()=>void resume(),Math.min(8000,1500*resumeTries));return;}
        onConnection(value.phase==='disconnected'?'disconnected':'failed');dialog.scrollTo({top:0});
        checklist(value.phase==='failed'&&['network','timeout'].includes(value.reason));
        if(remembered()){$('#mc-companion-badge').hidden=false;$('#mc-companion-badge').textContent='Computer not connected · Tap to reconnect';}
      }else if(value.phase==='reconnecting')onConnection('reconnecting');
      else if(busy.includes(value.phase))onConnection(resuming?'resuming':'pairing');
    }});
    function clearError(){$('#mc-pair-error').hidden=true;$('#mc-pair-error-message').textContent='';checklist(false);}
    // What usually blocks the link, for this kind of phone.
    function checklist(show){
      const list=$('#mc-pair-checklist'),apple=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
      const items=[apple?'<b>iPhone or iPad:</b> open Settings, then '+(/CriOS/.test(navigator.userAgent)?'Chrome':/FxiOS/.test(navigator.userAgent)?'Firefox':/EdgiOS/.test(navigator.userAgent)?'Edge':'your browser')+', and turn on <b>Local Network</b>. Then reload this page.':'',
        '<b>Windows PC:</b> install the latest companion from the website. It allows itself through Windows Firewall. Or, in Windows Security → Firewall → Allow an app, allow Maple Atlas Companion on private and public networks.',
        '<b>Same Wi-Fi:</b> the phone must be on the Wi-Fi of the computer’s network, not mobile data, a guest network or a VPN.'].filter(Boolean);
      list.innerHTML=show?items.map(t=>'<li>'+t+'</li>').join(''):'';list.hidden=!show;
      if(show)$('#mc-pair-error').hidden=false;
      // Which addresses the phone tried, to compare with "This PC" under the app's QR.
      const code=pairingCode||remembered()?.code;
      if(show&&code)MapleCompanionLink.unpack(code,Date.now(),{ignoreExpiry:true}).then(v=>{
        const ips=[...new Set([...v.sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) \d+/g)].map(m=>m[1]))].join(', ');
        if(ips&&!list.hidden)list.insertAdjacentHTML('beforeend','<li><b>Address check:</b> this phone tried '+ips.replace(/[<>&]/g,'')+'. The companion app shows the same address under its QR (“This PC”). If the app says your phone reached it, the Wi-Fi is fine and the computer is blocking it.</li>');
      }).catch(()=>{});
    }
    function error(e){
      if(e?.message==='Pairing was cancelled.')return;
      const message=e?.name==='NotAllowedError'?'Camera access was denied. Allow the camera in your browser settings, or use a QR image or the link.':e?.name==='NotFoundError'?'No camera was found. Use a QR image or paste the link.':e?.message||'Something went wrong. Please try again.';
      $('#mc-pair-error-message').textContent=message;$('#mc-pair-error').hidden=false;
    }
    async function run(button,fn){button.disabled=true;clearError();try{await fn();}catch(e){error(e);}finally{button.disabled=false;}}
    // paused: 'user' after Disconnect on this phone (only a tap reconnects), 'mac' after
    // the app said goodbye (a freshly opened page still tries once first).
    async function resume({manual=false,opening=false}={}){
      const saved=remembered();
      if(role!=='phone'||!saved||resuming||accepting||link.connected||document.visibilityState!=='visible'||busy.includes(currentState.phase))return;
      if(saved.paused&&!manual&&!(opening&&saved.paused==='mac'))return;
      if(manual){resumeTries=0;remember(saved.code);}
      resuming=true;resumeTries++;
      try{await accept(saved.code,{resume:true});}catch(_){/* the status card shows why */}
      finally{resuming=false;}
    }
    // Keeps the phone screen on while connected and on screen (released when hidden).
    async function requestWake(){
      if(!navigator.wakeLock||wakeLock||document.visibilityState!=='visible'||!link.connected)return;
      try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch(_){wakeLock=null;}
    }
    function releaseWake(){wakeLock?.release().catch(()=>{});wakeLock=null;}
    async function accept(code,{resume=false}={}){
      if(accepting)return;accepting=true;clearError();pairingCode=String(code).trim();
      try{await link.join(pairingCode,{resume});}
      finally{accepting=false;stopScan();}
    }
    function stopScan(){scanEpoch++;scanning=false;clearTimeout(scanTimer);scanner?.getTracks().forEach(t=>t.stop());scanner=null;scanVideo.srcObject=null;$('#mc-camera-box').hidden=true;paint(currentState);}
    async function scan(){
      stopScan();scanning=true;paint(currentState);const version=scanEpoch;
      await load('./vendor/companion/qr.js');if(version!==scanEpoch)return;
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera access is unavailable. Use a QR image or paste the link.');
      const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
      if(version!==scanEpoch){camera.getTracks().forEach(t=>t.stop());return;}
      scanner=camera;scanVideo.srcObject=scanner;$('#mc-camera-hint').textContent='Point the camera at the QR in Maple Atlas Companion.';$('#mc-camera-box').hidden=false;await scanVideo.play();
      const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
      async function frame(){
        if(!scanner||version!==scanEpoch)return;
        if(scanVideo.videoWidth){
          const scale=Math.min(1,1200/scanVideo.videoWidth);canvas.width=Math.round(scanVideo.videoWidth*scale);canvas.height=Math.round(scanVideo.videoHeight*scale);context.drawImage(scanVideo,0,0,canvas.width,canvas.height);
          const pixels=context.getImageData(0,0,canvas.width,canvas.height),code=MapleQR.decode(pixels.data,canvas.width,canvas.height,{inversionAttempts:'dontInvert'});
          if(code&&!/^\s*MA2|#link=MA2/i.test(code.data))$('#mc-camera-hint').textContent='That QR is not from Maple Atlas Companion. Point the camera at the QR in the app.';
          else if(code){try{await accept(code.data);}catch(e){error(e);}return;}
        }
        scanTimer=setTimeout(frame,250);
      }void frame();
    }
    $('#mc-pair-start').onclick=e=>run(e.currentTarget,scan);
    $('#mc-pair-retry').onclick=e=>run(e.currentTarget,scan);
    $('#mc-camera-stop').onclick=stopScan;
    $('#mc-pair-apply').onclick=e=>run(e.currentTarget,()=>accept(input.value));
    $('#mc-pair-file').onchange=async e=>{
      const file=e.target.files[0];if(!file)return;clearError();
      try{
        if(file.size>12000000)throw Error('Choose an image under 12 MB.');
        await load('./vendor/companion/qr.js');const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
        canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
        const data=ctx.getImageData(0,0,canvas.width,canvas.height),code=MapleQR.decode(data.data,canvas.width,canvas.height);
        if(!code)throw Error('No readable QR was found. Include the whole code, or paste the link instead.');await accept(code.data);
      }catch(err){error(err);}finally{e.target.value='';}
    };
    $('#mc-pair-stop').onclick=()=>{clearError();link.stop('Disconnected. Tap Reconnect to continue.');};
    $('#mc-pair-reconnect').onclick=()=>{clearError();void resume({manual:true});};
    $('#mc-pair-forget').onclick=()=>{forget();link.stop('This phone forgot the computer. Scan the code in Maple Atlas Companion to pair again.',{quiet:true,reason:'forget'});};
    $('#mc-pair-view-map').onclick=()=>{dialog.close();enterFullscreen();};
    function open(){$('#mc-profile-dialog').close();if(!dialog.open)dialog.showModal();}
    // Full screen needs a tap; browsers without it (iPhone Safari) keep their bars.
    function enterFullscreen(){
      const page=document.documentElement;
      if(role!=='phone'||document.fullscreenElement||!page.requestFullscreen)return;
      page.requestFullscreen({navigationUI:'hide'}).catch(()=>{});
    }
    if(role==='pc'){
      // A computer runs the companion app; the dialog only points to it.
      $('#mc-get-app').hidden=false;$('#mc-phone-flow').hidden=true;if(/Mac/i.test(navigator.platform||navigator.userAgent)){$('#mc-get-mac').classList.add('mc-primary');$('#mc-get-windows').classList.remove('mc-primary');root.querySelector('.mc-get-app-links').prepend($('#mc-get-mac'));}
      $('#mc-companion-desktop').querySelector('span').textContent='Get the companion';
      $('#mc-companion-desktop').onclick=open;
      return {open,enterFullscreen};
    }
    // One tap: open the companion and, when a paired computer isn't connected, reconnect.
    const tap=()=>{open();if(remembered()&&!link.connected&&!busy.includes(currentState.phase))void resume({manual:true});};
    $('#mc-mobile-companion').onclick=$('#mc-companion-desktop').onclick=tap;
    // Tablets use the wide layout: its header button follows the computer too.
    const wide=$('#mc-companion-desktop');wide.querySelector('span').textContent='Live companion';wide.insertAdjacentHTML('beforeend','<span class="mc-companion-dot" aria-hidden="true"></span>');
    $('#mc-companion-badge').onclick=()=>{if(remembered()&&!link.connected&&!busy.includes(currentState.phase)){void resume({manual:true});return;}open();};
    paint({phase:'idle',message:''});
    // The app's QR opens this page with the pairing code in the fragment. Remove it from
    // the address bar and history, then connect: no second scan.
    const linked=/^#link=(MA2[A-Z2-7]+)$/i.exec(location.hash);
    if(linked){history.replaceState(null,'',location.pathname+location.search);open();void run($('#mc-pair-start'),()=>accept(linked[1]));}
    dialog.addEventListener('close',stopScan);
    setInterval(()=>{clock();if(link.connected&&pairingCode&&Date.now()-storedAt>10000)remember(pairingCode);if(link.connected&&lastSeen&&Date.now()-lastSeen>12000){activity('No recent location update','The connection is working. Check tracking in Maple Atlas Companion.');onConnection('stale');}},1000);
    // Leaving the page closes the link quietly: the app keeps the pairing so this tab
    // can resume it (a reload, or Android discarding the tab in the background).
    window.addEventListener('pagehide',()=>link.stop(undefined,{quiet:true,reason:'page'}));
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='visible'){resumeTries=0;if(link.connected)void requestWake();else void resume();}
      else if(link.connected&&pairingCode)remember(pairingCode);
    });
    window.addEventListener('pageshow',event=>{if(event.persisted)void resume();});
    if(!linked)setTimeout(()=>void resume({opening:true}),0);
    return {open,enterFullscreen};
  }
  scope.MapleCompanionUI={create};
})(globalThis);
