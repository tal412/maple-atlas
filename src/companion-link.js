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
  function create({ids,onState=()=>{},onLocation=()=>{},onReading=()=>{},Peer=scope.RTCPeerConnection,now=Date.now}={}){
    let pc=null,channel=null,role=null,session=null,expires=0,seq=0,lastSeq=-1,epoch=0,expiryTimer=null,connectTimer=null;
    const state=(phase,message)=>onState({phase,message,role});
    function stop(message='Disconnected. Pair again to reconnect.'){
      epoch++;clearTimeout(expiryTimer);clearTimeout(connectTimer);
      if(channel){channel.onopen=channel.onmessage=channel.onclose=null;channel.close();}channel=null;
      if(pc){pc.onconnectionstatechange=pc.ondatachannel=null;pc.close();}pc=null;session=null;lastSeq=-1;seq=0;
      state('disconnected',message);
    }
    function bind(c){
      if(channel||c.label!=='maple-atlas'){c.close();return;}channel=c;
      c.onopen=()=>{clearTimeout(expiryTimer);clearTimeout(connectTimer);state('connected','Connected directly · Keep both pages open');};
      c.onclose=()=>stop();
      c.onmessage=event=>{
        if(role!=='phone'||typeof event.data!=='string'||event.data.length>512)return;
        try{const value=JSON.parse(event.data);if(location(value,ids)&&value.seq>lastSeq){lastSeq=value.seq;onLocation({...value,receivedAt:now()});}else if(value.kind==='tracking'&&['searching','paused'].includes(value.state)&&Number.isSafeInteger(value.seq)&&value.seq>lastSeq&&Number.isFinite(value.observedAt)){lastSeq=value.seq;onReading(value.state);}}catch(_){}
      };
    }
    function start(nextRole){
      stop('Preparing a local connection…');role=nextRole;
      if(!Peer)throw Error('This browser does not support direct device connections.');
      pc=new Peer({iceServers:[],iceTransportPolicy:'all'});
      pc.onconnectionstatechange=()=>{
        if(!pc)return;
        if(pc.connectionState==='failed')stop('Could not connect. Use the same home Wi-Fi; guest networks or VPNs may block peers.');
        else if(pc.connectionState==='disconnected')state('reconnecting','Connection interrupted · Waiting for the other device');
        else if(pc.connectionState==='connected'&&channel?.readyState==='open')state('connected','Connected directly · Keep both pages open');
      };
      pc.ondatachannel=e=>bind(e.channel);
      state('pairing','Pairing stays in this page. Refreshing or closing it ends the session.');
      return epoch;
    }
    async function gathered(current,version){
      if(current.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{current.removeEventListener('icegatheringstatechange',check);reject(Error('Could not find a local connection. Retry with Wi-Fi enabled.'));},8000);
        function check(){if(current.iceGatheringState==='complete'){clearTimeout(timer);current.removeEventListener('icegatheringstatechange',check);resolve();}}
        current.addEventListener('icegatheringstatechange',check);check();
      });
      if(version!==epoch)throw Error('Pairing was cancelled.');
      const value={v:1,type:current.localDescription.type,sdp:current.localDescription.sdp,session,expires};
      const code=await pack(value);await unpack(code,now());
      expiryTimer=setTimeout(()=>stop('Pairing code expired. Start again.'),Math.max(1,expires-now()));
      return code;
    }
    async function offer(){
      const version=start('pc');session=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');expires=now()+ttl;
      const current=pc;bind(pc.createDataChannel('maple-atlas',{ordered:true}));await current.setLocalDescription(await current.createOffer());return gathered(current,version);
    }
    async function answer(code){
      const value=await unpack(code,now());if(value.type!=='offer')throw Error('Scan the pairing code from the PC first.');
      const version=start('phone');session=value.session;expires=value.expires;const current=pc;
      await current.setRemoteDescription({type:'offer',sdp:value.sdp});await current.setLocalDescription(await current.createAnswer());return gathered(current,version);
    }
    async function finish(code){
      const value=await unpack(code,now());
      if(role!=='pc'||!pc||value.type!=='answer'||value.session!==session||value.expires!==expires||pc.signalingState!=='have-local-offer')throw Error('This response belongs to another pairing. Start again on both devices.');
      await pc.setRemoteDescription({type:'answer',sdp:value.sdp});state('connecting','Connecting over the local network…');
      connectTimer=setTimeout(()=>{if(channel?.readyState!=='open')stop('Connection timed out. Guest Wi-Fi, VPNs or firewalls may block direct pairing.');},20000);
    }
    function send({id,confidence,observedAt}){
      if(role!=='pc'||channel?.readyState!=='open'||channel.bufferedAmount>4096)return false;
      const value={kind:'location',id:String(id),confidence,observedAt,seq:seq++};if(!location(value,ids))return false;
      channel.send(JSON.stringify(value));return true;
    }
    function sendStatus(value){
      if(role!=='pc'||channel?.readyState!=='open'||channel.bufferedAmount>4096||!['searching','paused'].includes(value))return false;
      channel.send(JSON.stringify({kind:'tracking',state:value,seq:seq++,observedAt:now()}));return true;
    }
    return {offer,answer,finish,send,sendStatus,stop,get connected(){return channel?.readyState==='open';}};
  }
  scope.MapleCompanionLink={pack,unpack,location,create};if(typeof module!=='undefined')module.exports=scope.MapleCompanionLink;
})(globalThis);
