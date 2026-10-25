(function(scope){
  const loaded=new Map();
  function load(path){if(!loaded.has(path))loaded.set(path,new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=path;script.onload=resolve;script.onerror=()=>{loaded.delete(path);script.remove();reject(Error('Could not load the local reader. Connect once to download it, then retry.'));};document.head.append(script);}));return loaded.get(path);}
  function create({root,visualMaps,onLocation,onConnection,onPosition=()=>{},device}){
    const $=s=>root.querySelector(s),dialog=$('#mc-companion-dialog'),status=$('#mc-companion-status'),qr=$('#mc-pair-qr'),input=$('#mc-pair-input'),output=$('#mc-pair-output');
    const video=$('#mc-reader-video'),selection=$('#mc-reader-selection'),scanVideo=$('#mc-scan-video'),readerState=$('#mc-reader-state');
    device=device||MapleCompanionDevice.detect({userAgent:navigator.userAgent,platform:navigator.platform,maxTouchPoints:navigator.maxTouchPoints,userAgentData:navigator.userAgentData,canShareScreen:!!navigator.mediaDevices?.getDisplayMedia});
    const role=device.role;dialog.dataset.role=role;
    let stream=null,scanner=null,scanEpoch=0,scanTimer=null,readerEpoch=0,readTimer=null,roi=null,startPoint=null,lastFrame=-1,lastSeen=0,watch=null,qrCells=0,accepting=false,uiEpoch=0;
    let currentState={phase:'idle',message:'',expires:0};
    function fitQR(){
      const parent=qr.parentElement,style=getComputedStyle(parent),available=parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      if(!qrCells||available<=0)return;
      // Whole CSS pixels per module avoid blurred, hard-to-scan downscaling.
      const limit=Math.min(360,available,innerHeight*.48),size=Math.max(1,Math.floor(limit/qrCells))*qrCells+'px';
      if(qr.style.getPropertyValue('--mc-qr-size')!==size)qr.style.setProperty('--mc-qr-size',size);
    }
    new ResizeObserver(fitQR).observe(qr.parentElement);window.addEventListener('resize',fitQR);
    const tracker=MapleVisualTracker.create(),known=new Map(visualMaps.map(m=>[String(m.id),m])),ids=new Set(visualMaps.map(m=>String(m.id)));
    const vision=MapleVisualClient.create({onProgress:message=>{readerState.textContent=message;}});
    function activity(title,message){$('#mc-tracking-title').textContent=title;$('#mc-tracking-message').textContent=message;}
    function clock(){
      const timer=$('#mc-pair-timer'),{phase,expires,deadline}=currentState;
      timer.hidden=!(['waiting-phone','waiting-computer'].includes(phase)&&expires||['connecting','verifying'].includes(phase)&&deadline);
      if(timer.hidden)return;
      const seconds=Math.max(0,Math.ceil(((deadline||expires)-Date.now())/1000));
      timer.textContent=deadline?'Checking connection · '+seconds+'s remaining':'Pairing code expires in '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
    }
    function paint(value){
      currentState=value;const phase=value.phase,terminal=['idle','disconnected','failed','expired'].includes(phase),linked=phase==='connected',pending=!terminal&&!linked;
      const titles={idle:'Not connected',preparing:'Preparing pairing…','scan-computer':'Step 1 · Scan your computer','waiting-phone':'Not connected · Waiting for phone','waiting-computer':'Code scanned · One more step',connecting:'Connecting…',verifying:'Verifying both devices…',connected:role==='phone'?'Connected to computer':'Connected to phone',reconnecting:'Connection interrupted',failed:'Connection failed',expired:'Code expired',disconnected:'Disconnected'};
      status.dataset.tone=linked?'success':['failed','expired'].includes(phase)?'error':pending?'pending':'neutral';
      $('#mc-companion-state-icon').textContent=linked?'✓':['failed','expired'].includes(phase)?'!':pending?'…':'○';
      $('#mc-companion-state-title').textContent=titles[phase]||'Not connected';$('#mc-companion-message').textContent=value.message;
      const saved=role==='phone'&&remembered();
      $('#mc-pair-roles').hidden=phase!=='idle';$('#mc-pair-retry').hidden=!['failed','expired','disconnected'].includes(phase);
      $('#mc-pair-reconnect').hidden=!(saved&&terminal);$('#mc-pair-forget').hidden=!(saved&&terminal);
      $('#mc-pair-active').hidden=terminal;$('#mc-pair-steps').hidden=terminal;
      const step=linked?4:['connecting','verifying','reconnecting'].includes(phase)?3:phase==='waiting-computer'?2:1;
      for(const item of root.querySelectorAll('#mc-pair-steps li')){const n=Number(item.dataset.step);item.dataset.state=n<step?'done':n===step?'active':'pending';item.firstElementChild.textContent=n<step?'✓':n;if(n===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');}
      $('#mc-pair-scan').hidden=!(phase==='scan-computer'||phase==='waiting-phone');
      $('#mc-pair-exchange').hidden=!(['waiting-phone','waiting-computer'].includes(phase)&&output.value);
      $('#mc-pair-check').hidden=phase!=='waiting-computer';
      $('#mc-reader').hidden=!(role==='pc'&&linked);$('#mc-tracking-status').hidden=!(role==='phone'&&linked);$('#mc-pair-view-map').hidden=role!=='phone'||!linked;
      clock();
      if(phase!=='idle'){$('#mc-companion-badge').hidden=false;$('#mc-companion-badge').textContent=linked?(role==='phone'?'Computer connected':'Phone connected'):titles[phase]||'Not connected';}
    }
    const link=MapleCompanionLink.create({ids,onLocation:value=>{
      lastSeen=Date.now();activity('Tracking live',known.get(value.id)?.name||'Map detected');onLocation(value);
    },onPosition:value=>{lastSeen=Date.now();onPosition(value);},onReading:state=>{
      lastSeen=0;activity(state==='paused'?'Tracking paused':'Finding your map',state==='paused'?'The device connection is working. Resume screen sharing and visual tracking on your computer.':'The device connection is working. Keep the minimap or scenery visible while the computer identifies your map.');onConnection(state==='paused'?'stale':'searching');
    },onState:value=>{
      paint(value);
      if(value.phase==='connected'){
        stopScan();output.value='';input.value='';clearError();onConnection('connected');
        if(role==='phone'&&link.native&&pairingCode){remember(pairingCode);resumeTries=0;void requestWake();}
        if(role==='phone'){if(!lastSeen)activity('Waiting for screen sharing','The connection is working. On your computer, share the game window and start visual tracking.');}
        else{$('#mc-companion-badge').textContent='Phone connected';readerState.textContent=stream?'Connection ready. Watching the visible terrain…':'Phone connected. Share the game window to start.';}
        dialog.scrollTo({top:0});
      }
      if(['failed','expired','disconnected'].includes(value.phase)){
        uiEpoch++;stopReader();stopScan();lastSeen=0;output.value='';input.value='';releaseWake();
        // A deliberate end forgets the pairing; a dropped link resumes it.
        // A rejected code forgets the pairing; a deliberate disconnect keeps it but stops
        // retrying; a dropped link retries by itself.
        if(['verification','version'].includes(value.reason))forget();
        else if(['user','bye'].includes(value.reason)&&remembered())remember(remembered().code,{paused:true});
        else if(role==='phone'&&remembered()&&!remembered().paused&&resumeTries<3){onConnection('resuming');setTimeout(()=>void resume(),1500);return;}
        onConnection(value.phase==='disconnected'?'disconnected':'failed');dialog.scrollTo({top:0});
        if(role==='phone'&&remembered()){$('#mc-companion-badge').hidden=false;$('#mc-companion-badge').textContent='Mac not connected · Tap to reconnect';}
      }else if(value.phase==='reconnecting')onConnection('reconnecting');
      else if(['connecting','verifying'].includes(value.phase)&&resuming)onConnection('resuming');
      else if(['preparing','waiting-phone','waiting-computer','connecting','verifying'].includes(value.phase))onConnection('pairing');
    }});
    function clearError(){$('#mc-pair-error').hidden=true;$('#mc-pair-error-message').textContent='';}
    function error(e,source='camera'){
      if(e?.message==='Pairing was cancelled.')return;
      const message=e?.name==='NotAllowedError'?(source==='screen'?'Screen sharing was cancelled or blocked. Choose Share game window to try again. Your phone connection is unchanged.':'Camera access was denied. Allow the camera in browser settings, or use a QR image or paste the pairing code.'):e?.name==='NotFoundError'?(source==='screen'?'No shareable window was found. Open the game, then choose Share game window again.':'No camera was found. Use a QR image or paste the pairing code.'):e?.message||'This step could not finish. Please retry.';
      $('#mc-pair-error-message').textContent=message;$('#mc-pair-error').hidden=false;$('#mc-pair-error').scrollIntoView({block:'start'});
    }
    async function run(button,fn){button.disabled=true;clearError();try{await fn();}catch(e){error(e,button.id==='mc-reader-share'?'screen':'camera');}finally{button.disabled=false;}}
    async function showCode(code,version){
      await load('./vendor/companion/qr.js');if(version!==uiEpoch||link.connected||['failed','expired','disconnected'].includes(currentState.phase))return;
      output.value=code;qrCells=MapleQR.create(code,{errorCorrectionLevel:'M'}).modules.size+8;
      await MapleQR.toCanvas(qr,code,{scale:8,margin:4,errorCorrectionLevel:'M'});
      if(version!==uiEpoch)return;
      qr.style.removeProperty('width');qr.style.removeProperty('height');
      $('#mc-pair-code-title').textContent=role==='pc'?'1 · Scan this with your phone':'2 · Show this response to your computer';
      const hidden=link.addressing&&!link.addressing.ip?' This device is only sharing a private network name, which some networks cannot resolve. Allowing camera access on '+(role==='pc'?'this computer':'this phone')+' makes pairing more reliable.':'';
      $('#mc-pair-next').textContent=(role==='pc'?'On your phone, open Maple Atlas → Live companion → Connect to computer. Scan this code.':'Computer code accepted. This is a new response code, not a refresh. Hold it up to the computer’s camera, or choose “Scan phone response” there.')+hidden;
      paint(currentState);fitQR();$('#mc-pair-copy-status').textContent='';$('#mc-pair-exchange').scrollIntoView({block:'start'});
    }
    // Pair once: the Mac app's code is kept on this phone (localStorage, separately for
    // Main and Dev) and used to reconnect whenever Maple Atlas is on screen, or with one
    // tap after a deliberate disconnect. "Forget this Mac" removes it.
    let pairingCode=null,resuming=false,resumeTries=0,wakeLock=null,storedAt=0;
    const pairingKey=()=>'maple-atlas-mac-pairing:'+location.pathname.replace(/index\.html$/,'');
    function remembered(){try{const v=JSON.parse(localStorage.getItem(pairingKey())||'null');return v&&typeof v.code==='string'&&/^MA2[A-Z2-7]+$/.test(v.code)?v:null;}catch(_){return null;}}
    function remember(code,{paused=false}={}){storedAt=Date.now();try{localStorage.setItem(pairingKey(),JSON.stringify({code,at:storedAt,paused}));}catch(_){}}
    function forget(){pairingCode=null;try{localStorage.removeItem(pairingKey());}catch(_){}paint(currentState);}
    async function resume({manual=false}={}){
      const saved=remembered();
      if(role!=='phone'||!saved||resuming||accepting||link.connected||document.visibilityState!=='visible'||['preparing','connecting','verifying'].includes(currentState.phase))return;
      if(saved.paused&&!manual)return;
      if(manual){resumeTries=0;remember(saved.code);}
      resuming=true;resumeTries++;
      try{await accept(saved.code,{resume:true});}catch(_){/* the status card shows why */}
      finally{resuming=false;}
    }
    // Keeps the phone screen on while connected and on screen (released when hidden).
    async function requestWake(){
      if(role!=='phone'||!navigator.wakeLock||wakeLock||document.visibilityState!=='visible'||!link.connected)return;
      try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch(_){wakeLock=null;}
    }
    function releaseWake(){wakeLock?.release().catch(()=>{});wakeLock=null;}
    async function accept(code,{resume=false}={}){
      if(accepting)return;accepting=true;const version=uiEpoch;clearError();if(role==='phone')pairingCode=code;
      // Browsers reveal a device's real local address only while it holds camera access.
      // The phone keeps the camera open until its response is built, then releases it.
      try{if(role==='pc'){stopScan();await link.finish(code);}else{const answer=await link.answer(code,{resume});stopScan();if(answer&&version===uiEpoch)await showCode(answer,version);}}
      catch(e){stopScan();throw e;}
      finally{accepting=false;}
    }
    async function begin(){
      if(role==='pc'&&!device.canShareScreen)throw Error('This computer’s browser cannot share a game window. Open Maple Atlas in a desktop browser with screen sharing.');
      uiEpoch++;stopScan();stopReader();clearError();output.value='';input.value='';lastSeen=0;
      $('#mc-pair-scan-button').textContent=role==='pc'?'Scan phone response':'Scan computer code';
      $('#mc-pair-scan-title').textContent=role==='pc'?'2 · Scan the phone response':'1 · Scan the computer code';
      $('#mc-pair-scan-help').textContent=role==='pc'?'After the phone scans your code, it displays a new QR. Scan that response here to connect.':'Keep the computer’s Maple Atlas page open. Point your camera at its pairing QR.';
      if(role==='pc'){
        const version=uiEpoch;let note='';
        // Opening the camera first makes the browser share this computer's local address
        // instead of a private .local name that many phones and routers cannot resolve.
        try{await scan();}catch(e){note=e?.name==='NotAllowedError'?'Camera access was not allowed. ':e?.name==='NotFoundError'?'No camera was found. ':'The camera could not start. ';}
        if(version!==uiEpoch)return;
        $('#mc-pair-scan-help').textContent=note?note+'Use a QR image or paste the phone response below. Without camera access the browser hides this computer’s local address, so pairing may fail on some networks.':'The camera is ready. After your phone scans the code above, hold the phone’s response QR up to this camera.';
        await showCode(await link.offer(),version);
      }
      else{link.stop('Starting a new pairing.');clearError();paint({phase:'scan-computer',message:'Scan the code displayed by your computer. You will then show a response code back to it.'});}
    }
    $('#mc-pair-start').textContent=role==='pc'?'Create computer code':'Connect to computer';
    $('#mc-companion-intro').textContent=role==='pc'?'This is your computer. Connect a phone on the same local network to follow your game. Pairing needs two scans.':'This is your phone or tablet. Connect to the computer running your game. Both devices must use the same local network.';
    $('#mc-pair-start').disabled=role==='pc'&&!device.canShareScreen;
    paint({phase:'idle',message:role==='pc'?device.canShareScreen?'Create a code, scan it on your phone, then scan the phone’s response here.':'This computer’s browser cannot share its screen. Use a desktop browser that supports game-window sharing.':'Open Maple Atlas Companion on your Mac and scan its code with your phone’s camera. Or create a code in Maple Atlas on a computer browser, then connect here.'});
    $('#mc-pair-start').onclick=e=>run(e.currentTarget,begin);$('#mc-pair-retry').onclick=e=>run(e.currentTarget,begin);
    $('#mc-pair-check').onclick=()=>{clearError();link.waitForConnection();dialog.scrollTo({top:0});};
    $('#mc-pair-apply').onclick=e=>run(e.currentTarget,()=>accept(input.value));
    $('#mc-pair-copy').onclick=e=>run(e.currentTarget,async()=>{try{await navigator.clipboard.writeText(output.value);$('#mc-pair-copy-status').textContent='Code copied. Paste it into Maple Atlas on the other device.';}catch(_){output.focus();output.select();$('#mc-pair-copy-status').textContent='Select and copy this code to the other device.';}});
    $('#mc-pair-stop').onclick=()=>{clearError();link.stop(link.native?'Disconnected. Tap Reconnect to continue with your Mac.':'You disconnected. Screen sharing and the camera have stopped.');};
    $('#mc-pair-reconnect').onclick=()=>{clearError();void resume({manual:true});};
    $('#mc-pair-forget').onclick=()=>{forget();link.stop('This phone forgot your Mac. Scan the code in Maple Atlas Companion to pair again.',{quiet:true,reason:'forget'});};
    $('#mc-pair-view-map').onclick=()=>{dialog.close();enterFullscreen();};
    function stopScan(){scanEpoch++;clearTimeout(scanTimer);scanner?.getTracks().forEach(t=>t.stop());scanner=null;scanVideo.srcObject=null;$('#mc-camera-box').hidden=true;}
    async function scan(){
      stopScan();const version=scanEpoch;await load('./vendor/companion/qr.js');if(version!==scanEpoch)return;
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera access is unavailable. Use a QR image or paste a pairing code.');
      const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:role==='phone'?'environment':'user'},audio:false});
      if(version!==scanEpoch){camera.getTracks().forEach(t=>t.stop());return;}
      scanner=camera;scanVideo.srcObject=scanner;$('#mc-camera-hint').textContent='Point the camera at the entire QR code.';$('#mc-camera-box').hidden=false;await scanVideo.play();$('#mc-camera-box').scrollIntoView({block:'nearest'});
      const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
      async function frame(){
        if(!scanner||version!==scanEpoch)return;
        if(scanVideo.videoWidth){const scale=Math.min(1,1200/scanVideo.videoWidth);canvas.width=Math.round(scanVideo.videoWidth*scale);canvas.height=Math.round(scanVideo.videoHeight*scale);context.drawImage(scanVideo,0,0,canvas.width,canvas.height);const pixels=context.getImageData(0,0,canvas.width,canvas.height),code=MapleQR.decode(pixels.data,canvas.width,canvas.height,{inversionAttempts:'dontInvert'});
          if(code&&!/^\s*(MA2|MAPLE1:)|#link=MA2/i.test(code.data))$('#mc-camera-hint').textContent='That QR is not a Maple Atlas pairing code. Point the camera at the code in Maple Atlas.';
          else if(code){try{await accept(code.data);}catch(e){error(e);}return;}}
        scanTimer=setTimeout(frame,250);
      }void frame();
    }
    $('#mc-pair-scan-button').onclick=e=>run(e.currentTarget,scan);$('#mc-camera-stop').onclick=stopScan;
    $('#mc-pair-file').onchange=async e=>{
      const file=e.target.files[0];if(!file)return;stopScan();clearError();const version=scanEpoch;
      try{if(file.size>12000000)throw Error('Choose an image under 12 MB.');await load('./vendor/companion/qr.js');if(version!==scanEpoch)return;const bitmap=await createImageBitmap(file);if(version!==scanEpoch){bitmap.close();return;}const canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const data=ctx.getImageData(0,0,canvas.width,canvas.height);const code=MapleQR.decode(data.data,canvas.width,canvas.height);if(!code)throw Error('No readable pairing QR was found. Include the entire code or paste the text instead.');await accept(code.data);}catch(e){error(e);}finally{e.target.value='';}
    };
    function stopReader(){
      if(stream)link.sendStatus('paused');
      readerEpoch++;clearTimeout(readTimer);stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;vision.stop();roi=null;startPoint=null;tracker.reset();lastFrame=-1;selection.hidden=true;$('#mc-reader-preview').hidden=true;$('#mc-reader-stop').hidden=true;$('#mc-reader-run').hidden=true;$('#mc-reader-whole').hidden=true;
    }
    $('#mc-reader-share').onclick=e=>run(e.currentTarget,async()=>{
      if(!link.connected)throw Error('Connect your phone before sharing the game window.');
      stopReader();if(!navigator.mediaDevices?.getDisplayMedia)throw Error('Open this on a desktop browser that supports window sharing, such as Chrome or Edge. The phone only receives your location.');
      const version=readerEpoch,captured=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'window',frameRate:5},audio:false});
      if(version!==readerEpoch){captured.getTracks().forEach(t=>t.stop());return;}
      stream=captured;video.srcObject=stream;await video.play();if(version!==readerEpoch)return;$('#mc-reader-preview').hidden=false;$('#mc-reader-stop').hidden=false;stream.getVideoTracks()[0].addEventListener('ended',()=>{if(stream!==captured)return;stopReader();readerState.textContent='Screen sharing stopped.';});roi={x:0,y:0,w:1,h:1};$('#mc-reader-run').hidden=false;$('#mc-reader-whole').hidden=false;readerState.textContent='Ready to recognize the visible terrain. You can optionally drag around the minimap to focus the search.';
    });
    $('#mc-reader-stop').onclick=()=>{stopReader();readerState.textContent='Screen sharing stopped.';};
    const preview=$('#mc-reader-preview');
    const point=e=>{const r=preview.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
    function select(e){const p=point(e);roi={x:Math.min(startPoint.x,p.x),y:Math.min(startPoint.y,p.y),w:Math.abs(p.x-startPoint.x),h:Math.abs(p.y-startPoint.y)};selection.hidden=false;Object.assign(selection.style,{left:roi.x*100+'%',top:roi.y*100+'%',width:roi.w*100+'%',height:roi.h*100+'%'});}
    preview.onpointerdown=e=>{if(!stream)return;e.preventDefault();link.sendStatus('paused');readerEpoch++;clearTimeout(readTimer);tracker.reset();startPoint=point(e);preview.setPointerCapture(e.pointerId);select(e);};
    preview.onpointermove=e=>{if(startPoint)select(e);};
    preview.onpointerup=e=>{if(!startPoint)return;select(e);startPoint=null;$('#mc-reader-run').hidden=!roi||roi.w<.01||roi.h<.01;readerState.textContent='Area selected. Start visual tracking, or use the whole window.';};
    preview.onpointercancel=()=>{startPoint=null;};
    $('#mc-reader-whole').onclick=()=>{link.sendStatus('paused');readerEpoch++;clearTimeout(readTimer);tracker.reset();roi={x:0,y:0,w:1,h:1};selection.hidden=true;$('#mc-reader-run').hidden=false;readerState.textContent='The whole game window will be matched.';};
    async function startReader(){
      if(!link.connected)throw Error('Connect your phone before starting live tracking.');
      if(!stream||!roi)throw Error('Share the game window first.');
      clearTimeout(readTimer);const version=++readerEpoch;tracker.reset();await vision.ready();if(version!==readerEpoch)return;
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
      async function read(){
        if(version!==readerEpoch||!stream||!roi)return;
        try{
          if(video.readyState>=2&&video.currentTime!==lastFrame){
            lastFrame=video.currentTime;const crop={x:roi.x*video.videoWidth,y:roi.y*video.videoHeight,w:roi.w*video.videoWidth,h:roi.h*video.videoHeight};
            const scale=Math.min(1,960/Math.max(crop.w,crop.h));canvas.width=Math.max(1,Math.round(crop.w*scale));canvas.height=Math.max(1,Math.round(crop.h*scale));ctx.drawImage(video,crop.x,crop.y,crop.w,crop.h,0,0,canvas.width,canvas.height);
            const result=await vision.match(ctx.getImageData(0,0,canvas.width,canvas.height));if(version!==readerEpoch)return;
            const observation=tracker.read(result),match=observation.match,name=known.get(match?.id)?.name;
            $('#mc-reader-text').textContent=match?match.inliers+' aligned landmarks · '+(match.kind==='minimap'?'Minimap':'Game scene'):'No distinctive map landmarks yet';
            if(observation.phase==='confirmed'){
              const value={id:match.id,confidence:Math.min(100,Math.round(match.ratio*100)),observedAt:Date.now()};link.send(value);
              readerState.textContent=(link.connected?'Following on phone · ':'Visual match · ')+name;
            }else {link.sendStatus('searching');readerState.textContent=observation.phase==='candidate'?'Checking the terrain… Keep walking to reveal more landmarks.':'Finding your location… Keep the minimap or game scenery visible.';}
          }
        }catch(e){if(version===readerEpoch){link.sendStatus('searching');tracker.reset();readerState.textContent=e.message||'Could not match this view. Adjust the area or restart tracking.';}}
        if(version===readerEpoch)readTimer=setTimeout(read,1500);
      }void read();
    }
    $('#mc-reader-run').onclick=e=>run(e.currentTarget,startReader);
    function open(){$('#mc-profile-dialog').close();if(!dialog.open)dialog.showModal();}
    // Full screen needs a tap; browsers without it (iPhone Safari) keep their bars.
    function enterFullscreen(){
      const page=document.documentElement;
      if(role!=='phone'||document.fullscreenElement||!page.requestFullscreen)return;
      page.requestFullscreen({navigationUI:'hide'}).catch(()=>{});
    }$('#mc-companion-open').onclick=open;$('#mc-companion-desktop').onclick=open;$('#mc-companion-badge').onclick=()=>{if(role==='phone'&&remembered()&&!link.connected&&!['preparing','connecting','verifying'].includes(currentState.phase)){void resume({manual:true});return;}open();};
    // The Mac app's QR opens this page with the pairing code in the fragment. Remove
    // it from the address bar and history, then connect without a second scan.
    const linked=/^#link=(MA2[A-Z2-7]+)$/i.exec(location.hash);
    if(linked){history.replaceState(null,'',location.pathname+location.search);if(role==='phone'){open();void run($('#mc-pair-start'),()=>accept(linked[1]));}}
    dialog.addEventListener('close',()=>{stopScan();if(!stream)vision.stop();});
    watch=setInterval(()=>{clock();if(link.connected&&pairingCode&&link.native&&Date.now()-storedAt>10000)remember(pairingCode);if(role==='phone'&&link.connected&&lastSeen&&Date.now()-lastSeen>12000){activity('No recent location update','The device connection is working. Check screen sharing and visual tracking on your computer.');onConnection('stale');}},1000);
    // Leaving the page closes the link quietly: the Mac app keeps the pairing so this
    // tab can resume it (a reload, or Android discarding the tab in the background).
    window.addEventListener('pagehide',()=>link.stop(undefined,{quiet:link.native,reason:'page'}));
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='visible'){resumeTries=0;if(link.connected)void requestWake();else void resume();}
      else if(link.connected&&pairingCode)remember(pairingCode);
    });
    window.addEventListener('pageshow',event=>{if(event.persisted)void resume();});
    if(!linked)setTimeout(()=>void resume(),0);
    return {open,enterFullscreen};
  }
  scope.MapleCompanionUI={create};
})(globalThis);
