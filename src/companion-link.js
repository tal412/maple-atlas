(function(scope){
  const prefix='MAPLE1:',maxText=24000,ttl=10*60*1000;
  async function pack(value){
    const stream=new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('deflate'));
    const bytes=new Uint8Array(await new Response(stream).arrayBuffer());
    return prefix+btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  async function unpack(text,now=Date.now()){
    text=String(text).trim();
    if(text.length>maxText||!text.startsWith(prefix)||!/^[A-Za-z0-9_-]+$/.test(text.slice(prefix.length)))throw Error('This is not a Maple Atlas pairing code.');
    const bytes=Uint8Array.from(atob(text.slice(prefix.length).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    let size=0,chunks=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxText)throw Error('Pairing code is too large.');chunks.push(value);}}finally{await reader.cancel();}
    const value=JSON.parse(await new Blob(chunks).text());
    if(value.v!==1||!['offer','answer'].includes(value.type)||!/^[a-f0-9]{32}$/.test(value.session)||!Number.isSafeInteger(value.expires)||value.expires<now||value.expires>now+ttl+30000)throw Error('Pairing expired or is invalid. Start a new connection.');
    if(typeof value.sdp!=='string'||value.sdp.length>20000||!value.sdp.startsWith('v=0')||!/^m=application /m.test(value.sdp)||/^m=(audio|video) /m.test(value.sdp)||!/^a=fingerprint:sha-256 /m.test(value.sdp))throw Error('Unsupported pairing data.');
    const candidates=value.sdp.split(/\r?\n/).filter(s=>s.startsWith('a=candidate:'));
    if(!candidates.length||candidates.some(s=>!s.includes(' typ host')))throw Error('A direct local connection is required.');
    return value;
  }
  function location(value,ids){
    return value&&value.kind==='location'&&typeof value.id==='string'&&ids.has(value.id)&&Number.isFinite(value.confidence)&&value.confidence>=0&&value.confidence<=100&&Number.isSafeInteger(value.seq)&&value.seq>=0&&Number.isFinite(value.observedAt)&&value.observedAt>0;
  }
  function create({ids,onState=()=>{},onLocation=()=>{},onReading=()=>{},Peer=scope.RTCPeerConnection,now=Date.now,timers=scope}={}){
    let pc=null,channel=null,role=null,session=null,expires=0,seq=0,lastSeq=-1,epoch=0,phase='idle';
    let expiryTimer,connectTimer,verifyTimer,heartbeat,verified=false,helloSeen=false,helloAck=false,nonce='',pingSeq=0,pongSeq=-1,lastPong=0;
    let savedOffer=null,savedAnswer=null,finishing=false,cancelGather=null;
    const state=(next,message,extra={})=>{phase=next;onState({phase:next,message,role,expires,...extra});};
    const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
    function clear(){
      epoch++;cancelGather?.();cancelGather=null;for(const timer of [expiryTimer,connectTimer,verifyTimer])timers.clearTimeout(timer);timers.clearInterval(heartbeat);
      expiryTimer=connectTimer=verifyTimer=heartbeat=null;
      if(channel){channel.onopen=channel.onmessage=channel.onclose=channel.onerror=null;channel.close();}channel=null;
      if(pc){pc.onconnectionstatechange=pc.ondatachannel=null;pc.close();}pc=null;
      verified=helloSeen=helloAck=false;nonce='';lastPong=0;session=null;expires=0;lastSeq=-1;seq=0;pingSeq=0;pongSeq=-1;savedOffer=savedAnswer=null;finishing=false;
    }
    function stop(message='Disconnected. Start a new pairing to reconnect.'){clear();state('disconnected',message);}
    function fail(message,reason='network'){clear();state('failed',message,{reason});}
    function control(value){if(channel?.readyState==='open'&&channel.bufferedAmount<4096)channel.send(JSON.stringify(value));}
    function ping(){
      if(!verified)return;
      const age=now()-lastPong;
      if(age>=20000){fail('The other device stopped responding. Keep both pages open and pair again.','heartbeat');return;}
      if(age>=9000&&phase==='connected')state('reconnecting','No response from the other device. Checking the connection…');
      control({kind:'ping',v:2,session,seq:++pingSeq});
    }
    function confirm(){
      if(!helloSeen||!helloAck||verified)return;
      verified=true;lastPong=now();
      for(const timer of [expiryTimer,connectTimer,verifyTimer])timers.clearTimeout(timer);
      state('connected','Both devices exchanged a confirmation. The connection is working.');
      heartbeat=timers.setInterval(ping,3000);ping();
    }
    function bind(c){
      if(channel||c.label!=='maple-atlas'){c.close();return;}channel=c;
      c.onopen=()=>{
        timers.clearTimeout(connectTimer);state('verifying','The link opened. Verifying that the other device can send and receive…',{deadline:now()+7000});
        nonce=random();verifyTimer=timers.setTimeout(()=>fail('Could not verify the other device. Refresh Maple Atlas on both devices, then pair again.','verification'),7000);
        control({kind:'hello',v:2,session,role,nonce});
      };
      c.onclose=()=>stop('The other device disconnected or closed its page. Start a new pairing to reconnect.');
      c.onerror=()=>fail('The device connection encountered an error. Start a new pairing.','channel');
      c.onmessage=event=>{
        if(typeof event.data!=='string'||event.data.length>512)return;
        try{
          const value=JSON.parse(event.data);
          if(['hello','hello-ack','ping','pong'].includes(value.kind)){
            if(value.session!==session)return;
            if(value.v!==2){fail('These pages use different pairing versions. Refresh both devices and pair again.','version');return;}
            if(value.kind==='hello'&&value.role===(role==='pc'?'phone':'pc')&&/^[a-f0-9]{32}$/.test(value.nonce)){
              helloSeen=true;control({kind:'hello-ack',v:2,session,nonce:value.nonce});confirm();
            }else if(value.kind==='hello-ack'&&value.nonce===nonce&&nonce){helloAck=true;confirm();}
            else if(value.kind==='ping'&&verified&&Number.isSafeInteger(value.seq)&&value.seq>0)control({kind:'pong',v:2,session,seq:value.seq});
            else if(value.kind==='pong'&&verified&&Number.isSafeInteger(value.seq)&&value.seq>pongSeq&&value.seq<=pingSeq){
              pongSeq=value.seq;lastPong=now();if(phase==='reconnecting'&&pc?.connectionState!=='disconnected')state('connected','Connection restored. Both devices are responding.');
            }
            return;
          }
          if(role!=='phone'||!verified||phase!=='connected')return;
          if(location(value,ids)&&value.seq>lastSeq){lastSeq=value.seq;onLocation({...value,receivedAt:now()});}
          else if(value.kind==='tracking'&&['searching','paused'].includes(value.state)&&Number.isSafeInteger(value.seq)&&value.seq>lastSeq&&Number.isFinite(value.observedAt)&&value.observedAt>0){lastSeq=value.seq;onReading(value.state);}
        }catch(_){}
      };
    }
    function start(nextRole){
      clear();role=nextRole;
      if(!Peer){state('failed','This browser cannot connect directly to another device.',{reason:'unsupported'});throw Error('Use a browser with WebRTC support.');}
      pc=new Peer({iceServers:[],iceTransportPolicy:'all'});
      pc.onconnectionstatechange=()=>{
        if(!pc)return;
        if(pc.connectionState==='failed')fail('The devices could not reach each other. Use the same local network. Guest Wi-Fi, VPNs or a firewall can block the link.','network');
        else if(pc.connectionState==='disconnected'&&verified)state('reconnecting','Connection interrupted. Waiting for the other device to respond…');
        // ICE alone does not prove that the other app is receiving messages.
        else if(pc.connectionState==='connected'&&verified&&now()-lastPong<9000)ping();
      };
      pc.ondatachannel=e=>bind(e.channel);
      state('preparing','Preparing a private pairing code…');return epoch;
    }
    async function gathered(current,version){
      if(version!==epoch)throw Error('Pairing was cancelled.');
      if(current.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
        const timer=timers.setTimeout(()=>finish(Error('Could not find a local connection. Check Wi-Fi and retry.')),8000);
        function finish(error){timers.clearTimeout(timer);current.removeEventListener('icegatheringstatechange',check);cancelGather=null;error?reject(error):resolve();}
        function check(){if(current.iceGatheringState==='complete')finish();}
        cancelGather=()=>finish(Error('Pairing was cancelled.'));
        current.addEventListener('icegatheringstatechange',check);check();
      });
      if(version!==epoch)throw Error('Pairing was cancelled.');
      const value={v:1,type:current.localDescription.type,sdp:current.localDescription.sdp,session,expires};
      const code=await pack(value);await unpack(code,now());if(version!==epoch)throw Error('Pairing was cancelled.');
      expiryTimer=timers.setTimeout(()=>{clear();state('expired','The pairing code expired. Create a new code on the computer and scan it again.');},Math.max(1,expires-now()));
      return code;
    }
    async function offer(){
      const version=start('pc');session=random();expires=now()+ttl;const current=pc;
      try{
        bind(current.createDataChannel('maple-atlas',{ordered:true}));await current.setLocalDescription(await current.createOffer());const code=await gathered(current,version);
        state('waiting-phone','Not connected yet. Scan this code on your phone, then scan the phone’s response on this computer.');return code;
      }catch(e){if(version===epoch)fail(e.message,'setup');throw e;}
    }
    async function answer(code){
      const previous=epoch,value=await unpack(code,now());if(previous!==epoch)throw Error('Pairing was cancelled.');
      if(value.type!=='offer')throw Error('This is a phone response. Scan the code shown on your computer.');
      // Re-reading the same computer QR must not rotate an active response.
      if(savedOffer===code&&savedAnswer&&pc)return savedAnswer;
      const version=start('phone');session=value.session;expires=value.expires;const current=pc;
      try{
        await current.setRemoteDescription({type:'offer',sdp:value.sdp});await current.setLocalDescription(await current.createAnswer());const answerCode=await gathered(current,version);
        savedOffer=code;savedAnswer=answerCode;state('waiting-computer','Computer code scanned successfully. Show this new response QR to your computer. You are not connected yet.');return answerCode;
      }catch(e){if(version===epoch)fail(e.message,'setup');throw e;}
    }
    function waitForConnection(){
      if(!pc||verified||!['waiting-computer','waiting-phone','connecting'].includes(phase))return;
      timers.clearTimeout(connectTimer);const deadline=now()+25000;
      state('connecting','Waiting for the device link. Keep both pages open on the same local network.',{deadline});
      connectTimer=timers.setTimeout(()=>fail('Connection timed out. Make sure the computer scanned the phone response. Both devices must use the same local network; guest Wi-Fi, VPNs or firewalls may block pairing.','timeout'),25000);
    }
    async function finish(code){
      const previous=epoch,value=await unpack(code,now());if(previous!==epoch)throw Error('Pairing was cancelled.');
      if(role!=='pc'||!pc||value.type!=='answer'||value.session!==session||value.expires!==expires||pc.signalingState!=='have-local-offer'||finishing)throw Error('This is not the response to this computer’s current code. Scan the current phone response, or restart pairing on both devices.');
      const current=pc,version=epoch;finishing=true;
      try{await current.setRemoteDescription({type:'answer',sdp:value.sdp});if(version===epoch&&!verified&&phase!=='verifying')waitForConnection();}
      catch(e){if(version===epoch)fail('The phone response could not be applied. Start a new pairing.','response');throw e;}
      finally{finishing=false;}
    }
    function send({id,confidence,observedAt}){
      if(role!=='pc'||!verified||phase!=='connected'||channel?.readyState!=='open'||channel.bufferedAmount>4096)return false;
      const value={kind:'location',id:String(id),confidence,observedAt,seq:seq++};if(!location(value,ids))return false;
      channel.send(JSON.stringify(value));return true;
    }
    function sendStatus(value){
      if(role!=='pc'||!verified||phase!=='connected'||channel?.readyState!=='open'||channel.bufferedAmount>4096||!['searching','paused'].includes(value))return false;
      channel.send(JSON.stringify({kind:'tracking',state:value,seq:seq++,observedAt:now()}));return true;
    }
    return {offer,answer,finish,waitForConnection,send,sendStatus,stop,get connected(){return verified&&phase==='connected'&&channel?.readyState==='open';}};
  }
  scope.MapleCompanionLink={pack,unpack,location,create};if(typeof module!=='undefined')module.exports=scope.MapleCompanionLink;
})(globalThis);
