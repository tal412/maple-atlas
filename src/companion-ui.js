(function(scope){
  const loaded=new Map();
  function load(path){if(!loaded.has(path))loaded.set(path,new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=path;script.onload=resolve;script.onerror=()=>{loaded.delete(path);script.remove();reject(Error('Could not load the local reader. Connect once to download it, then retry.'));};document.head.append(script);}));return loaded.get(path);}
  function create({root,maps,visualMaps,onLocation,onConnection,onInspect}){
    const $=s=>root.querySelector(s),dialog=$('#mc-companion-dialog'),status=$('#mc-companion-status'),qr=$('#mc-pair-qr'),input=$('#mc-pair-input'),output=$('#mc-pair-output');
    const video=$('#mc-reader-video'),selection=$('#mc-reader-selection'),scanVideo=$('#mc-scan-video'),readerState=$('#mc-reader-state');
    let role=null,stream=null,scanner=null,scanEpoch=0,scanTimer=null,readerEpoch=0,readTimer=null,roi=null,startPoint=null,lastFrame=-1,lastSeen=0,watch=null,qrCells=0;
    function fitQR(){
      const parent=qr.parentElement,style=getComputedStyle(parent),available=parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      if(!qrCells||available<=0)return;
      // Whole CSS pixels per module avoid blurred, hard-to-scan downscaling.
      const limit=Math.min(360,available,innerHeight*.48),size=Math.max(1,Math.floor(limit/qrCells))*qrCells+'px';
      if(qr.style.getPropertyValue('--mc-qr-size')!==size)qr.style.setProperty('--mc-qr-size',size);
    }
    new ResizeObserver(fitQR).observe(qr.parentElement);window.addEventListener('resize',fitQR);
    const tracker=MapleVisualTracker.create(),known=new Map(visualMaps.map(m=>[String(m.id),m])),ids=new Set(visualMaps.map(m=>String(m.id)));
    const vision=MapleVisualClient.create({onProgress:message=>{readerState.textContent=message;$('#mc-visual-result').textContent=message;}});let fileEpoch=0,lastTest=null;
    const link=MapleCompanionLink.create({ids,onLocation:value=>{lastSeen=Date.now();onLocation(value);},onReading:state=>{lastSeen=0;onConnection(state==='paused'?'stale':'searching');},onState:value=>{
      status.textContent=value.message;$('#mc-companion-badge').textContent=value.phase==='connected'?'Phone connected':value.phase==='reconnecting'?'Reconnecting':'Live companion';
      $('#mc-pair-active').hidden=value.phase==='disconnected';
      if(value.phase==='pairing')$('#mc-pair-roles').hidden=true;
      if(value.phase==='connected'){$('#mc-pair-exchange').hidden=true;$('#mc-pair-scan').hidden=true;stopScan();output.value='';input.value='';if(role==='phone'){dialog.close();onConnection('connected');}else readerState.textContent=stream?'Watching the visible terrain…':'Phone connected. Share the game window to start.';}
      if(value.phase==='disconnected'){stopReader();stopScan();lastSeen=0;onConnection('disconnected');$('#mc-pair-roles').hidden=false;}
      if(value.phase==='reconnecting')onConnection('stale');
    }});
    function error(e){status.textContent=e?.message||'Something went wrong. Please retry.';}
    async function run(button,fn){button.disabled=true;try{await fn();}catch(e){error(e);}finally{button.disabled=false;}}
    async function showCode(code){
      output.value=code;await load('./vendor/companion/qr.js');
      qrCells=MapleQR.create(code,{errorCorrectionLevel:'M'}).modules.size+8;
      await MapleQR.toCanvas(qr,code,{scale:8,margin:4,errorCorrectionLevel:'M'});
      // Keep the high-resolution bitmap; let CSS size its on-screen square.
      // node-qrcode also writes inline dimensions, overriding responsive CSS.
      qr.style.removeProperty('width');qr.style.removeProperty('height');
      $('#mc-pair-exchange').hidden=false;fitQR();
      $('#mc-pair-next').textContent=role==='pc'?'1. On the phone, open Live companion → Use this phone. Scan this code. Then scan the phone’s response here.':'2. On the PC, choose Scan phone response and scan this code. Keep this page open.';
    }
    async function accept(code){
      stopScan();if(role==='pc'){await link.finish(code);}else if(role==='phone'){const answer=await link.answer(code);await showCode(answer);}else throw Error('Choose PC or phone first.');
    }
    function choose(nextRole){
      link.stop();role=nextRole;$('#mc-pair-roles').hidden=true;$('#mc-pair-active').hidden=false;$('#mc-reader').hidden=role!=='pc';$('#mc-pair-exchange').hidden=true;$('#mc-pair-scan').hidden=false;input.value='';output.value='';
      $('#mc-pair-scan-button').textContent=role==='pc'?'Scan phone response':'Scan PC code';
    }
    $('#mc-pair-pc').onclick=e=>run(e.currentTarget,async()=>{choose('pc');await showCode(await link.offer());});
    $('#mc-pair-phone').onclick=()=>{choose('phone');status.textContent='Scan the code on your PC. Both devices must use the same local network.';};
    $('#mc-pair-apply').onclick=e=>run(e.currentTarget,()=>accept(input.value));
    $('#mc-pair-copy').onclick=e=>run(e.currentTarget,async()=>{try{await navigator.clipboard.writeText(output.value);status.textContent='Pairing code copied. Share only with your own device.';}catch(_){output.focus();output.select();status.textContent='Select and copy the pairing code.';}});
    $('#mc-pair-stop').onclick=()=>link.stop('Disconnected. Screen sharing and the camera are stopped.');
    function stopScan(){scanEpoch++;clearTimeout(scanTimer);scanner?.getTracks().forEach(t=>t.stop());scanner=null;scanVideo.srcObject=null;$('#mc-camera-box').hidden=true;}
    async function scan(){
      stopScan();const version=scanEpoch;await load('./vendor/companion/qr.js');if(version!==scanEpoch)return;
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera access is unavailable. Use a QR image or paste a pairing code.');
      const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:role==='phone'?'environment':'user'},audio:false});
      if(version!==scanEpoch){camera.getTracks().forEach(t=>t.stop());return;}
      scanner=camera;scanVideo.srcObject=scanner;$('#mc-camera-box').hidden=false;await scanVideo.play();
      const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
      async function frame(){
        if(!scanner||version!==scanEpoch)return;
        if(scanVideo.videoWidth){const scale=Math.min(1,1200/scanVideo.videoWidth);canvas.width=Math.round(scanVideo.videoWidth*scale);canvas.height=Math.round(scanVideo.videoHeight*scale);context.drawImage(scanVideo,0,0,canvas.width,canvas.height);const pixels=context.getImageData(0,0,canvas.width,canvas.height),code=MapleQR.decode(pixels.data,canvas.width,canvas.height,{inversionAttempts:'dontInvert'});if(code){try{await accept(code.data);}catch(e){error(e);}return;}}
        scanTimer=setTimeout(frame,250);
      }void frame();
    }
    $('#mc-pair-scan-button').onclick=e=>run(e.currentTarget,scan);$('#mc-camera-stop').onclick=stopScan;
    $('#mc-pair-file').onchange=async e=>{
      const file=e.target.files[0];if(!file)return;stopScan();const version=scanEpoch;
      try{if(file.size>12000000)throw Error('Choose an image under 12 MB.');await load('./vendor/companion/qr.js');if(version!==scanEpoch)return;const bitmap=await createImageBitmap(file);if(version!==scanEpoch){bitmap.close();return;}const canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const data=ctx.getImageData(0,0,canvas.width,canvas.height);const code=MapleQR.decode(data.data,canvas.width,canvas.height);if(!code)throw Error('No readable QR code found in that image.');await accept(code.data);}catch(e){error(e);}finally{e.target.value='';}
    };
    function stopReader(){
      if(stream)link.sendStatus('paused');
      readerEpoch++;clearTimeout(readTimer);stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;vision.stop();roi=null;startPoint=null;tracker.reset();lastFrame=-1;selection.hidden=true;$('#mc-reader-preview').hidden=true;$('#mc-reader-stop').hidden=true;$('#mc-reader-run').hidden=true;$('#mc-reader-whole').hidden=true;
    }
    $('#mc-reader-share').onclick=e=>run(e.currentTarget,async()=>{
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
    $('#mc-visual-file').onchange=async e=>{
      const file=e.target.files[0];if(!file)return;const version=++fileEpoch;lastTest=null;$('#mc-visual-open').hidden=true;
      try{
        if(file.size>16000000)throw Error('Choose a screenshot under 16 MB.');
        const bitmap=await createImageBitmap(file);if(version!==fileEpoch){bitmap.close();return;}const canvas=$('#mc-visual-canvas'),scale=Math.min(1,960/Math.max(bitmap.width,bitmap.height));canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();canvas.hidden=false;
        $('#mc-visual-result').textContent='Matching the image locally…';const result=await vision.match(ctx.getImageData(0,0,canvas.width,canvas.height));if(version!==fileEpoch)return;
        const best=result.candidates[0];
        if(result.strong){lastTest=known.get(best.id);$('#mc-visual-result').textContent='Visual match · '+lastTest.name+' · '+best.inliers+' aligned landmarks';$('#mc-visual-open').hidden=false;ctx.strokeStyle='#a8ffcf';ctx.lineWidth=1.5;for(const [x,y] of best.points){ctx.beginPath();ctx.arc(x*canvas.width,y*canvas.height,4,0,Math.PI*2);ctx.stroke();}}
        else $('#mc-visual-result').textContent=best?'Several locations look alike in this view. Try a wider view or another part of the map.':'No reliable visual match. Try a clearer view of the minimap or terrain.';
      }catch(error){if(version===fileEpoch)$('#mc-visual-result').textContent=error.message;}finally{e.target.value='';}
    };
    $('#mc-visual-open').onclick=()=>{if(lastTest){dialog.close();onInspect(lastTest.id);}};
    function open(){$('#mc-profile-dialog').close();dialog.showModal();}$('#mc-companion-open').onclick=open;$('#mc-companion-desktop').onclick=open;$('#mc-companion-badge').onclick=open;
    dialog.addEventListener('close',()=>{stopScan();if(!stream){fileEpoch++;vision.stop();}});
    watch=setInterval(()=>{if(role==='phone'&&link.connected&&lastSeen&&Date.now()-lastSeen>12000)onConnection('stale');},3000);
    window.addEventListener('pagehide',()=>{link.stop();clearInterval(watch);});
    return {open};
  }
  scope.MapleCompanionUI={create};
})(globalThis);
