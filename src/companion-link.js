(function(scope){
  // Pairing codes carry only what a data channel needs: ICE credentials, the DTLS
  // fingerprint and direct host addresses. The receiver rebuilds a minimal SDP, so
  // the QR stays small enough for a laptop webcam to read from a phone screen.
  // Uppercase base32 lets the QR encoder use its denser alphanumeric mode.
  const prefix='MA2',ttl=10*60*1000,maxCandidates=4,maxBytes=400;
  const SETUP=['actpass','active','passive'],ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const ICE_CHARS=/^[A-Za-z0-9+/]+$/,MDNS=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i;
  const invalid=()=>Error('Pairing expired or is invalid. Start a new connection.');
  function base32(bytes){let bits=0,value=0,out='';for(const b of bytes){value=(value<<8|b)&0xffff;bits+=8;while(bits>=5){out+=ALPHABET[value>>>bits-5&31];bits-=5;}}if(bits)out+=ALPHABET[value<<5-bits&31];return out;}
  function unbase32(text){let bits=0,value=0;const out=[];for(const c of text){const n=ALPHABET.indexOf(c);if(n<0)throw Error('This is not a Maple Atlas pairing code.');value=(value<<5|n)&0xfff;bits+=5;if(bits>=8){out.push(value>>>bits-8&255);bits-=8;}}return Uint8Array.from(out);}
  function ipv6Bytes(text){
    if(text.includes('%')||!/^[0-9a-f:]+$/i.test(text))return null;
    const halves=text.split('::');if(halves.length>2)return null;
    const head=halves[0]?halves[0].split(':'):[],tail=halves.length===2&&halves[1]?halves[1].split(':'):[];
    const fill=8-head.length-tail.length;if(fill<0||halves.length===1&&fill!==0)return null;
    const groups=[...head,...Array(halves.length===2?fill:0).fill('0'),...tail];
    if(groups.length!==8||groups.some(g=>!/^[0-9a-f]{1,4}$/i.test(g)))return null;
    return groups.flatMap(g=>{const n=parseInt(g,16);return [n>>8,n&255];});
  }
  // A host candidate as [kind, address bytes]: 4 = IPv4, 6 = IPv6, 1 = mDNS name.
  function addressBytes(address){
    if(/^\d{1,3}(\.\d{1,3}){3}$/.test(address)){const parts=address.split('.').map(Number);return parts.every(n=>n<=255)?[4,parts]:null;}
    if(MDNS.test(address))return [1,address.slice(0,36).replace(/-/g,'').match(/../g).map(h=>parseInt(h,16))];
    const v6=ipv6Bytes(address);return v6?[6,v6]:null;
  }
  function addressText(kind,bytes){
    if(kind===4)return bytes.join('.');
    const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    if(kind===1)return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')+'.local';
    return hex.match(/.{4}/g).map(g=>g.replace(/^0+(?=.)/,'')).join(':');
  }
  // Summarises the direct addresses in a description: real IPs or private mDNS names.
  function addressing(sdp){
    const kinds=String(sdp).split(/\r?\n/).filter(l=>/^a=candidate:\S+ 1 udp /i.test(l)&&/ typ host( |$)/.test(l)).map(l=>addressBytes(l.split(' ')[4])?.[0]).filter(Boolean);
    return {ip:kinds.filter(k=>k!==1).length,names:kinds.filter(k=>k===1).length};
  }
  async function pack({type,sdp,session,expires}){
    const lines=String(sdp).split(/\r?\n/),attr=name=>lines.find(l=>l.startsWith('a='+name+':'))?.slice(name.length+3).trim();
    if(/^m=(audio|video) /m.test(sdp)||!/^m=application /m.test(sdp))throw Error('Unsupported pairing data.');
    const ufrag=attr('ice-ufrag'),pwd=attr('ice-pwd'),mid=attr('mid')??'0',setup=SETUP.indexOf(attr('setup'));
    const fingerprint=/^a=fingerprint:sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})\s*$/m.exec(sdp)?.[1];
    if(!ufrag||!pwd||!ICE_CHARS.test(ufrag+pwd)||ufrag.length>32||pwd.length>64||!fingerprint||setup<0||!/^[A-Za-z0-9_-]{1,16}$/.test(mid))throw Error('Unsupported pairing data.');
    const seen=new Set(),candidates=[];
    for(const line of lines){
      const p=line.split(' ');if(!/^a=candidate:/.test(line)||p[1]!=='1'||p[2].toLowerCase()!=='udp'||p[6]!=='typ'||p[7]!=='host')continue;
      const address=addressBytes(p[4]),port=Number(p[5]);
      if(!address||!Number.isInteger(port)||port<1||port>65535||seen.has(p[4]+' '+port))continue;
      seen.add(p[4]+' '+port);candidates.push([address[0],...address[1],port>>8,port&255]);
    }
    // IPv4 first (most home networks), then private names, then IPv6, capped to keep the QR small.
    candidates.sort((a,b)=>[4,1,6].indexOf(a[0])-[4,1,6].indexOf(b[0]));candidates.length=Math.min(candidates.length,maxCandidates);
    if(!candidates.length)throw Error('A direct local connection is required.');
    if(!/^[a-f0-9]{16}$/.test(session)||!Number.isSafeInteger(expires)||expires%1000)throw invalid();
    const text=s=>[s.length,...Array.from(s,c=>c.charCodeAt(0))],seconds=expires/1000;
    const bytes=[0x20|(type==='answer'?1:0)|setup<<1,...session.match(/../g).map(h=>parseInt(h,16)),seconds>>>24&255,seconds>>>16&255,seconds>>>8&255,seconds&255,
      ...text(mid),...text(ufrag),...text(pwd),...fingerprint.split(':').map(h=>parseInt(h,16)),candidates.length,...candidates.flat()];
    return prefix+base32(bytes);
  }
  async function unpack(text,now=Date.now()){
    text=String(text).trim().toUpperCase();
    if(text.startsWith('MAPLE1:'))throw Error('This code is from an older Maple Atlas version. Refresh Maple Atlas on both devices, then pair again.');
    if(!text.startsWith(prefix)||text.length>prefix.length+Math.ceil(maxBytes*8/5))throw Error('This is not a Maple Atlas pairing code.');
    const bytes=unbase32(text.slice(prefix.length));let at=0;
    const take=n=>{if(at+n>bytes.length)throw invalid();const out=bytes.subarray(at,at+n);at+=n;return out;};
    const string=(min,max,pattern)=>{const n=take(1)[0],s=String.fromCharCode(...take(n));if(n<min||n>max||!pattern.test(s))throw invalid();return s;};
    const head=take(1)[0],type=head&1?'answer':'offer',setup=SETUP[head>>1&3];
    if(head>>4!==2||head&8||!setup||(type==='offer')!==(setup==='actpass'))throw invalid();
    const session=Array.from(take(8),b=>b.toString(16).padStart(2,'0')).join(''),time=take(4),expires=((time[0]<<24>>>0)+(time[1]<<16)+(time[2]<<8)+time[3])*1000;
    if(expires<now||expires>now+ttl+30000)throw invalid();
    const mid=string(1,16,/^[A-Za-z0-9_-]+$/),ufrag=string(4,32,ICE_CHARS),pwd=string(22,64,ICE_CHARS);
    const fingerprint=Array.from(take(32),b=>b.toString(16).toUpperCase().padStart(2,'0')).join(':'),count=take(1)[0];
    if(!count||count>maxCandidates)throw Error('A direct local connection is required.');
    const candidates=[];
    for(let i=0;i<count;i++){
      const kind=take(1)[0],size={1:16,4:4,6:16}[kind];if(!size)throw invalid();
      const address=addressText(kind,take(size)),port=take(2);
      candidates.push('a=candidate:'+(i+1)+' 1 udp '+(2122260223-i)+' '+address+' '+(port[0]<<8|port[1])+' typ host generation 0');
    }
    if(at!==bytes.length)throw invalid();
    const sdp=['v=0','o=- '+parseInt(session.slice(0,12),16)+' 2 IN IP4 127.0.0.1','s=-','t=0 0','a=group:BUNDLE '+mid,'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel','c=IN IP4 0.0.0.0',...candidates,'a=ice-ufrag:'+ufrag,'a=ice-pwd:'+pwd,'a=ice-options:trickle',
      'a=fingerprint:sha-256 '+fingerprint,'a=setup:'+setup,'a=mid:'+mid,'a=sctp-port:5000','a=max-message-size:262144',''].join('\r\n');
    return {v:2,type,sdp,session,expires};
  }
  function location(value,ids){
    return value&&value.kind==='location'&&typeof value.id==='string'&&ids.has(value.id)&&Number.isFinite(value.confidence)&&value.confidence>=0&&value.confidence<=100&&Number.isSafeInteger(value.seq)&&value.seq>=0&&Number.isFinite(value.observedAt)&&value.observedAt>0;
  }
  function create({ids,onState=()=>{},onLocation=()=>{},onReading=()=>{},Peer=scope.RTCPeerConnection,now=Date.now,timers=scope}={}){
    let pc=null,channel=null,role=null,session=null,expires=0,seq=0,lastSeq=-1,epoch=0,phase='idle';
    let expiryTimer,connectTimer,verifyTimer,heartbeat,verified=false,helloSeen=false,helloAck=false,nonce='',pingSeq=0,pongSeq=-1,lastPong=0;
    let savedOffer=null,savedAnswer=null,finishing=false,cancelGather=null,local=null;
    const state=(next,message,extra={})=>{phase=next;onState({phase:next,message,role,expires,...extra});};
    const random=(n=16)=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
    function clear(){
      epoch++;cancelGather?.();cancelGather=null;for(const timer of [expiryTimer,connectTimer,verifyTimer])timers.clearTimeout(timer);timers.clearInterval(heartbeat);
      expiryTimer=connectTimer=verifyTimer=heartbeat=null;
      if(channel){channel.onopen=channel.onmessage=channel.onclose=channel.onerror=null;channel.close();}channel=null;
      if(pc){pc.onconnectionstatechange=pc.ondatachannel=null;pc.close();}pc=null;
      verified=helloSeen=helloAck=false;nonce='';lastPong=0;session=null;expires=0;lastSeq=-1;seq=0;pingSeq=0;pongSeq=-1;savedOffer=savedAnswer=null;finishing=false;local=null;
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
        if(pc.connectionState==='failed')fail('The devices could not reach each other. Use the same Wi-Fi network. Guest Wi-Fi, VPNs, a firewall or (on a Mac) a blocked Local Network permission for your browser can stop the link.','network');
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
      const value={v:2,type:current.localDescription.type,sdp:current.localDescription.sdp,session,expires};
      const code=await pack(value);await unpack(code,now());if(version!==epoch)throw Error('Pairing was cancelled.');
      local=addressing(value.sdp);
      expiryTimer=timers.setTimeout(()=>{clear();state('expired','The pairing code expired. Create a new code on the computer and scan it again.');},Math.max(1,expires-now()));
      return code;
    }
    async function offer(){
      const version=start('pc');session=random(8);expires=Math.ceil((now()+ttl)/1000)*1000;const current=pc;
      try{
        bind(current.createDataChannel('maple-atlas',{ordered:true}));await current.setLocalDescription(await current.createOffer());const code=await gathered(current,version);
        state('waiting-phone','Not connected yet. Scan this code on your phone, then scan the phone’s response on this computer.',{addressing:local});return code;
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
        savedOffer=code;savedAnswer=answerCode;state('waiting-computer','Computer code scanned successfully. Show this new response QR to your computer. You are not connected yet.',{addressing:local});return answerCode;
      }catch(e){if(version===epoch)fail(e.message,'setup');throw e;}
    }
    function waitForConnection(){
      if(!pc||verified||!['waiting-computer','waiting-phone','connecting'].includes(phase))return;
      timers.clearTimeout(connectTimer);const deadline=now()+25000;
      state('connecting','Waiting for the device link. Keep both pages open on the same local network.',{deadline});
      connectTimer=timers.setTimeout(()=>fail('Connection timed out. Make sure the computer scanned the phone response. Both devices must use the same Wi-Fi network; guest Wi-Fi, VPNs, firewalls or (on a Mac) a blocked Local Network permission for your browser may stop pairing.','timeout'),25000);
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
    return {offer,answer,finish,waitForConnection,send,sendStatus,stop,get connected(){return verified&&phase==='connected'&&channel?.readyState==='open';},get addressing(){return local;}};
  }
  scope.MapleCompanionLink={pack,unpack,location,addressing,create};if(typeof module!=='undefined')module.exports=scope.MapleCompanionLink;
})(globalThis);
