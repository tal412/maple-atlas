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
  async function pack({type,sdp,session,expires,secret}){
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
    if(secret&&(type!=='offer'||secret.length!==16))throw invalid();
    const text=s=>[s.length,...Array.from(s,c=>c.charCodeAt(0))],seconds=expires/1000;
    const bytes=[0x20|(type==='answer'?1:0)|setup<<1|(secret?8:0),...session.match(/../g).map(h=>parseInt(h,16)),seconds>>>24&255,seconds>>>16&255,seconds>>>8&255,seconds&255,
      ...text(mid),...text(ufrag),...text(pwd),...fingerprint.split(':').map(h=>parseInt(h,16)),candidates.length,...candidates.flat(),...(secret||[])];
    return prefix+base32(bytes);
  }
  // ignoreExpiry: a code remembered from an earlier pairing, used to resume it.
  async function unpack(text,now=Date.now(),{ignoreExpiry=false}={}){
    text=String(text).trim().toUpperCase();
    // The Mac app's QR is a link to this site with the code in the fragment.
    const linked=/^HTTPS?:\/\/[^#\s]+#LINK=(MA2[A-Z2-7]+)$/.exec(text);if(linked)text=linked[1];
    else if(/^HTTPS?:\/\//.test(text))throw Error('This QR is a website link, not a pairing code. Scan the QR shown in Maple Atlas Companion on your computer.');
    if(text.startsWith('MAPLE1:'))throw Error('This code is from an old Maple Atlas version. Scan the code in Maple Atlas Companion instead.');
    if(!text.startsWith(prefix)||text.length>prefix.length+Math.ceil(maxBytes*8/5))throw Error('This is not a Maple Atlas pairing code.');
    const bytes=unbase32(text.slice(prefix.length));let at=0;
    const take=n=>{if(at+n>bytes.length)throw invalid();const out=bytes.subarray(at,at+n);at+=n;return out;};
    const string=(min,max,pattern)=>{const n=take(1)[0],s=String.fromCharCode(...take(n));if(n<min||n>max||!pattern.test(s))throw invalid();return s;};
    const head=take(1)[0],type=head&1?'answer':'offer',setup=SETUP[head>>1&3];
    // Bit 3 marks a native host (Maple Atlas Companion for Mac): ICE-lite, single scan.
    const native=!!(head&8);
    if(head>>4!==2||!setup||(type==='offer')!==(setup==='actpass')||native&&type!=='offer')throw invalid();
    // Codes from the removed browser-to-browser pairing carry no app secret.
    if(!native)throw Error('This code is from an old Maple Atlas version. Scan the code in Maple Atlas Companion instead.');
    const session=Array.from(take(8),b=>b.toString(16).padStart(2,'0')).join(''),time=take(4),expires=((time[0]<<24>>>0)+(time[1]<<16)+(time[2]<<8)+time[3])*1000;
    if(!ignoreExpiry&&(expires<now||expires>now+ttl+30000))throw invalid();
    const mid=string(1,16,/^[A-Za-z0-9_-]+$/),ufrag=string(4,32,ICE_CHARS),pwd=string(22,64,ICE_CHARS);
    const fingerprint=Array.from(take(32),b=>b.toString(16).toUpperCase().padStart(2,'0')).join(':'),count=take(1)[0];
    if(!count||count>maxCandidates)throw Error('A direct local connection is required.');
    const candidates=[];
    for(let i=0;i<count;i++){
      const kind=take(1)[0],size={1:16,4:4,6:16}[kind];if(!size)throw invalid();
      const address=addressText(kind,take(size)),port=take(2);
      candidates.push('a=candidate:'+(i+1)+' 1 udp '+(2122260223-i)+' '+address+' '+(port[0]<<8|port[1])+' typ host generation 0');
    }
    const secret=native?Uint8Array.from(take(16)):null;
    if(at!==bytes.length)throw invalid();
    const sdp=['v=0','o=- '+parseInt(session.slice(0,12),16)+' 2 IN IP4 127.0.0.1','s=-','t=0 0',...(native?['a=ice-lite']:[]),'a=group:BUNDLE '+mid,'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel','c=IN IP4 0.0.0.0',...candidates,'a=ice-ufrag:'+ufrag,'a=ice-pwd:'+pwd,'a=ice-options:trickle',
      'a=fingerprint:sha-256 '+fingerprint,'a=setup:'+setup,'a=mid:'+mid,'a=sctp-port:5000','a=max-message-size:262144',''].join('\r\n');
    return native?{v:2,type,sdp,session,expires,native,secret}:{v:2,type,sdp,session,expires};
  }
  // Proves to the Mac app that this phone scanned its screen: an HMAC of the QR
  // secret over this phone's own DTLS certificate fingerprint for this session.
  async function proof(secret,session,sdp){
    const fingerprint=/^a=fingerprint:sha-256 (\S+)/m.exec(sdp)?.[1]?.toUpperCase();if(!fingerprint)throw Error('Missing local fingerprint.');
    const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('maple-atlas-link|'+session+'|'+fingerprint)));
    return btoa(String.fromCharCode(...mac)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function location(value,ids){
    return value&&value.kind==='location'&&typeof value.id==='string'&&ids.has(value.id)&&Number.isFinite(value.confidence)&&value.confidence>=0&&value.confidence<=100&&Number.isSafeInteger(value.seq)&&value.seq>=0&&Number.isFinite(value.observedAt)&&value.observedAt>0;
  }
  // What the computer sends once linked, the same from the phone's link and the app's own
  // window: the live map, dot, Quest Helper and tracking messages (each newer than the last),
  // and Look's screenshot and results. Everything is checked field by field.
  function receiver({ids,onLocation=()=>{},onReading=()=>{},onPosition=()=>{},onQuests=()=>{},onLook=()=>{},now=Date.now}){
    let lastSeq=-1;
    // Screenshots being received, by request: kept until whole (at most 3 MB) or 20 s old.
    const looks=new Map();
    function lookMessage(m){
      if(m.v!==1||typeof m.req!=='string'||!/^[pc][0-9a-z]{1,16}$/.test(m.req))return;
      for(const [req,l] of looks)if(now()-l.at>20000)looks.delete(req);
      if(m.kind==='look-error'){looks.delete(m.req);onLook({req:m.req,error:String(m.message||'The computer could not take a screenshot.').slice(0,200)});return;}
      // The computer recognizes its screenshot itself: how far it is, then what it found.
      if(m.kind==='look-progress'){if(typeof m.text==='string'&&m.req[0]==='p')onLook({req:m.req,progress:m.text.slice(0,60)});return;}
      if(m.kind==='look-found'){
        if(m.req[0]!=='p'||!Number.isInteger(m.n)||m.n<1||m.n>120||!Number.isInteger(m.i)||m.i<0||m.i>=m.n||typeof m.data!=='string'||m.data.length>6000)return;
        const key='found:'+m.req;let f=looks.get(key);if(!f||f.parts.length!==m.n){f={at:now(),parts:new Array(m.n),got:0};looks.set(key,f);}
        if(f.parts[m.i]!==undefined)return;f.parts[m.i]=m.data;f.got++;
        if(f.got===f.parts.length){looks.delete(key);try{const text=new TextDecoder().decode(Uint8Array.from(atob(f.parts.join('')),c=>c.charCodeAt(0)));const found=lookFound(JSON.parse(text));if(found)onLook({req:m.req,found});}catch(_){}}
        return;
      }
      if(m.kind==='look-meta'){
        if(!(m.parts>0&&m.parts<=600&&m.bytes>0&&m.bytes<=3<<20&&m.w>=16&&m.h>=16&&m.w<=4096&&m.h<=4096))return;
        const lines=(Array.isArray(m.lines)?m.lines:[]).filter(l=>Array.isArray(l)&&l.length===5&&typeof l[0]==='string'&&l.slice(1).every(Number.isFinite)).slice(0,200).map(([text,x,y,w,h])=>({text:text.slice(0,60),x,y,w,h}));
        const mark=Array.isArray(m.mark)&&m.mark.length===4&&m.mark.every(n=>Number.isFinite(n)&&n>=-0.01&&n<=1.01)?{x:m.mark[0],y:m.mark[1],w:m.mark[2],h:m.mark[3]}:null;
        looks.set(m.req,{at:now(),w:m.w,h:m.h,parts:new Array(m.parts),got:0,lines,mark,map:typeof m.map==='string'&&ids.has(m.map)?m.map:null});
        return;
      }
      const l=looks.get(m.req);
      if(!l||!Number.isInteger(m.i)||m.i<0||m.i>=l.parts.length||typeof m.data!=='string'||m.data.length>6000||l.parts[m.i]!==undefined)return;
      l.parts[m.i]=m.data;l.got++;
      if(l.got===l.parts.length){looks.delete(m.req);onLook({req:m.req,w:l.w,h:l.h,lines:l.lines,mark:l.mark,map:l.map,jpeg:l.parts.join('')});}
    }
    // What the computer found, checked field by field: each thing a known type with a name, an id
    // and a box (numbers); the map's drop rows; the players' boxes. Anything else is dropped.
    function lookFound(r){
      if(!r||typeof r!=='object')return null;
      const num=v=>Number.isFinite(v)?v:0,str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
      const box=b=>b&&typeof b==='object'?{x:num(b.x),y:num(b.y),w:Math.max(0,num(b.w)),h:Math.max(0,num(b.h))}:null;
      const types=new Set(['monster','npc','item','quest','map']);
      const found=(Array.isArray(r.found)?r.found:[]).slice(0,400).filter(f=>f&&types.has(f.type)&&typeof f.name==='string'&&box(f.box)).map(f=>({type:f.type,id:str(String(f.id??''),24),name:str(f.name,80),box:box(f.box),via:str(f.via,12),score:num(f.score),ui:!!f.ui,pet:!!f.pet}));
      const drops=(Array.isArray(r.drops)?r.drops:[]).slice(0,400).filter(d=>d&&typeof d.monster==='string'&&typeof d.item==='string').map(d=>({monster:str(d.monster,80),item:str(d.item,80),id:d.id==null?null:str(String(d.id),24),rate:Number.isFinite(d.rate)?d.rate:null}));
      const players=(Array.isArray(r.players)?r.players:[]).slice(0,60).filter(p=>p&&box(p.box)).map(p=>({name:str(p.name,40),box:box(p.box),you:!!p.you}));
      return {found,drops,players,mapId:typeof r.mapId==='string'&&ids.has(r.mapId)?r.mapId:null};
    }
    function deliver(value){
      // Look: a screenshot of the game in parts (look-meta, then look-part 0…n-1), or why none.
      if(value.kind==='look-meta'||value.kind==='look-part'||value.kind==='look-error'||value.kind==='look-found'||value.kind==='look-progress'){lookMessage(value);return;}
      if(location(value,ids)&&value.seq>lastSeq){lastSeq=value.seq;onLocation({...value,receivedAt:now()});}
      // The player's dot on that map, in the portal data's coordinates.
      else if(value.kind==='position'&&typeof value.id==='string'&&ids.has(value.id)&&[value.x,value.y].every(n=>Number.isFinite(n)&&Math.abs(n)<1e6)&&Number.isSafeInteger(value.seq)&&value.seq>lastSeq&&Number.isFinite(value.observedAt)&&value.observedAt>0){lastSeq=value.seq;onPosition({id:value.id,x:value.x,y:value.y,observedAt:value.observedAt,receivedAt:now()});}
      // The quests tracked in the game's Quest Helper (MapleQuestHelper.pack form).
      else if(value.kind==='quests'&&typeof value.visible==='boolean'&&Array.isArray(value.quests)&&value.quests.length<=8&&Number.isSafeInteger(value.seq)&&value.seq>lastSeq&&Number.isFinite(value.observedAt)&&value.observedAt>0){lastSeq=value.seq;onQuests({visible:value.visible,quests:value.quests,observedAt:value.observedAt,receivedAt:now()});}
      else if(value.kind==='tracking'&&['searching','paused'].includes(value.state)&&Number.isSafeInteger(value.seq)&&value.seq>lastSeq&&Number.isFinite(value.observedAt)&&value.observedAt>0){lastSeq=value.seq;onReading(value.state);}
    }
    return {deliver,reset(){lastSeq=-1;looks.clear();}};
  }
  // The phone side of the link to Maple Atlas Companion (Mac or Windows app). The app
  // is an ICE-lite peer that learns this phone's ICE username from its connectivity
  // checks, so one scan is enough; the phone then proves the QR secret over the
  // encrypted channel before the usual hello, heartbeat and location messages.
  function create({ids,onState=()=>{},onLocation=()=>{},onReading=()=>{},onPosition=()=>{},onQuests=()=>{},onLook=()=>{},Peer=scope.RTCPeerConnection,now=Date.now,timers=scope}={}){
    let pc=null,channel=null,session=null,expires=0,epoch=0,phase='idle',secret=null,joined=null;
    const rx=receiver({ids,onLocation,onReading,onPosition,onQuests,onLook,now});
    let expiryTimer,connectTimer,verifyTimer,heartbeat,verified=false,helloSeen=false,helloAck=false,nonce='',pingSeq=0,pongSeq=-1,lastPong=0;
    const state=(next,message,extra={})=>{phase=next;onState({phase:next,message,expires,...extra});};
    const random=(n=16)=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
    function clear(){
      epoch++;for(const timer of [expiryTimer,connectTimer,verifyTimer])timers.clearTimeout(timer);timers.clearInterval(heartbeat);
      expiryTimer=connectTimer=verifyTimer=heartbeat=null;
      if(channel){channel.onopen=channel.onmessage=channel.onclose=channel.onerror=null;channel.close();}channel=null;
      if(pc){pc.onconnectionstatechange=pc.ondatachannel=null;pc.close();}pc=null;
      verified=helloSeen=helloAck=false;nonce='';lastPong=0;session=null;expires=0;rx.reset();pingSeq=0;pongSeq=-1;secret=null;joined=null;
    }
    // quiet: leave without a goodbye (the page is only going away), so the app keeps
    // the pairing and the phone can resume it. A goodbye ends it on the computer too.
    function stop(message='Disconnected.',{quiet=false,reason='user'}={}){if(verified&&!quiet)control({kind:'bye',v:2,session});clear();state('disconnected',message,{reason});}
    function fail(message,reason='network'){clear();state('failed',message,{reason});}
    function control(value){if(channel?.readyState==='open'&&channel.bufferedAmount<4096)channel.send(JSON.stringify(value));}
    function ping(){
      if(!verified)return;
      const age=now()-lastPong;
      if(age>=20000){fail('Your computer stopped responding.','heartbeat');return;}
      if(age>=9000&&phase==='connected')state('reconnecting','No response from your computer. Checking the connection…');
      control({kind:'ping',v:2,session,seq:++pingSeq});
    }
    function confirm(){
      if(!helloSeen||!helloAck||verified)return;
      verified=true;lastPong=now();
      for(const timer of [expiryTimer,connectTimer,verifyTimer])timers.clearTimeout(timer);
      state('connected','Connected to Maple Atlas Companion. Your map follows the game.');
      heartbeat=timers.setInterval(ping,3000);ping();
    }
    function bind(c){
      if(channel||c.label!=='maple-atlas'){c.close();return;}channel=c;
      c.onopen=()=>{
        timers.clearTimeout(connectTimer);state('verifying','Verifying the connection…',{deadline:now()+7000});
        nonce=random();verifyTimer=timers.setTimeout(()=>fail('Could not verify the companion app. Reload Maple Atlas, then scan a new code.','verification'),7000);
        const version=epoch;proof(secret,session,pc.localDescription.sdp).then(value=>{if(version!==epoch)return;control({kind:'auth',v:3,session,proof:value});control({kind:'hello',v:2,session,role:'phone',nonce});})
          .catch(()=>{if(version===epoch)fail('Could not prepare the secure check. Reload Maple Atlas, then scan a new code.','verification');});
      };
      c.onclose=()=>stop('The companion app closed the connection.',{quiet:true,reason:'closed'});
      c.onerror=()=>fail('The connection to your computer had an error.','channel');
      c.onmessage=event=>{
        if(typeof event.data!=='string'||event.data.length>8192)return;
        try{
          const value=JSON.parse(event.data);
          if(['hello','hello-ack','ping','pong','bye'].includes(value.kind)){
            if(value.session!==session)return;
            if(value.kind==='bye'){stop('Maple Atlas Companion disconnected.',{quiet:true,reason:'bye'});return;}
            if(value.v!==2){fail('The companion app uses a different version. Update it or reload Maple Atlas, then scan a new code.','version');return;}
            if(value.kind==='hello'&&value.role==='pc'&&/^[a-f0-9]{32}$/.test(value.nonce)){helloSeen=true;control({kind:'hello-ack',v:2,session,nonce:value.nonce});confirm();}
            else if(value.kind==='hello-ack'&&value.nonce===nonce&&nonce){helloAck=true;confirm();}
            else if(value.kind==='ping'&&verified&&Number.isSafeInteger(value.seq)&&value.seq>0)control({kind:'pong',v:2,session,seq:value.seq});
            else if(value.kind==='pong'&&verified&&Number.isSafeInteger(value.seq)&&value.seq>pongSeq&&value.seq<=pingSeq){
              pongSeq=value.seq;lastPong=now();if(phase==='reconnecting'&&pc?.connectionState!=='disconnected')state('connected','Connection restored.');
            }
            return;
          }
          if(!verified||phase!=='connected')return;
          rx.deliver(value);
        }catch(_){}
      };
    }
    // Joins the companion app from its code (scanned or remembered). resume: a code
    // from an earlier pairing, which the app keeps accepting, so its expiry is ignored.
    async function join(code,{resume=false}={}){
      const previous=epoch,value=await unpack(code,now(),{ignoreExpiry:resume});if(previous!==epoch)throw Error('Pairing was cancelled.');
      if(joined===code&&pc)return;
      clear();
      if(!Peer){state('failed','This browser cannot connect directly to another device.',{reason:'unsupported'});throw Error('Use a browser with WebRTC support.');}
      const version=epoch;session=value.session;expires=value.expires;secret=value.secret;joined=code;
      // The computer's addresses in the code: named in failures, so they can be compared with
      // the address the computer shows (a different network is the usual cause).
      const tried=[...new Set([...String(value.sdp||'').matchAll(/a=candidate:\S+ \d+ \w+ \d+ ([\d.]+) (\d+) typ/g)].map(m=>m[1]+':'+m[2]))].join(', ')||'the address in the code';
      pc=new Peer({iceServers:[],iceTransportPolicy:'all'});const current=pc;
      pc.onconnectionstatechange=()=>{
        if(!pc)return;
        if(pc.connectionState==='failed')fail('Your phone could not reach the computer at '+tried+'. Use the same Wi-Fi network on both (not guest Wi-Fi or mobile data); a VPN or the computer\u2019s firewall can also block it.','network');
        else if(pc.connectionState==='disconnected'&&verified)state('reconnecting','Connection interrupted. Waiting for your computer…');
        else if(pc.connectionState==='connected'&&verified&&now()-lastPong<9000)ping();
      };
      pc.ondatachannel=e=>bind(e.channel);
      try{
        await current.setRemoteDescription({type:'offer',sdp:value.sdp});await current.setLocalDescription(await current.createAnswer());
        if(version!==epoch)throw Error('Pairing was cancelled.');
        state('connecting',resume?'Reconnecting to your computer…':'Connecting to your computer…',{deadline:now()+25000,resume});
        connectTimer=timers.setTimeout(()=>fail((resume?'Could not reconnect to the computer at ':'Could not reach Maple Atlas Companion at ')+tried+'. Keep it open, use the same Wi-Fi network on both devices (not guest Wi-Fi or mobile data), and check that the computer\u2019s firewall allows it.','timeout'),25000);
        if(!resume)expiryTimer=timers.setTimeout(()=>{if(!verified){clear();state('expired','This code expired. Create a new code in Maple Atlas Companion and scan it again.');}},Math.max(1,expires-now()));
      }catch(e){if(version===epoch)fail(e.message,'setup');throw e;}
    }
    // Ask the computer for a screenshot (req "p…"); answer a look marked on the computer (req "c…").
    function look(req){if(!verified||phase!=='connected'||channel?.readyState!=='open'||!/^p[0-9a-z]{1,16}$/.test(req))return false;control({kind:'look',v:1,session,req});return true;}
    function lookResult(req,card){if(!verified||phase!=='connected'||channel?.readyState!=='open'||!/^c[0-9a-z]{1,16}$/.test(req))return false;control({kind:'look-result',v:1,session,req,card});return true;}
    // How a look marked on the computer is going, for its card ("Naming 3 of 12…").
    function lookProgress(req,text){if(!verified||phase!=='connected'||channel?.readyState!=='open'||!/^c[0-9a-z]{1,16}$/.test(req))return false;control({kind:'look-progress',v:1,session,req,text:String(text).slice(0,60)});return true;}
    function nav(value){if(!verified||phase!=='connected'||channel?.readyState!=='open')return false;control({kind:'nav',v:1,session,nav:value});return true;}
    // Pinned quests for the computer's overlay row.
    function pins(value){if(!verified||phase!=='connected'||channel?.readyState!=='open')return false;control({kind:'pins',v:1,session,pins:value});return true;}
    return {join,stop,nav,pins,look,lookResult,lookProgress,get connected(){return verified&&phase==='connected'&&channel?.readyState==='open';}};
  }
  // Inside Maple Atlas Companion: the app opens this page from its own loopback address with a
  // per-launch token in the fragment (#companion=…). The token is kept for this tab (reloads)
  // and removed from the address bar. null when this page is not the app's own window.
  function localToken({loc=scope.location,store=scope.sessionStorage,history=scope.history}={}){
    if(!loc||!/^(127\.0\.0\.1|localhost)$/.test(loc.hostname))return null;
    const key='maple-atlas-companion-token',m=/^#companion=([a-f0-9]{32})$/.exec(loc.hash||'');
    if(m){try{store?.setItem(key,m[1]);}catch(_){}try{history?.replaceState(null,'',loc.pathname+loc.search);}catch(_){}return m[1];}
    try{const t=store?.getItem(key);return /^[a-f0-9]{32}$/.test(t||'')?t:null;}catch(_){return null;}
  }
  // The page's link to the app it runs in (macos/link/local.go): an event stream for what the
  // computer sends (the phone link's own messages) and POST for what the page sends. No
  // pairing: the app's token is the proof. hello carries the app ({host, ui}): ui is where the
  // companion's controls open in this page (Windows), "" when the app shows them (Mac).
  const SHOW=['map','search','quests','directions','look','controls'];
  function createLocal({token,ids,base='',onState=()=>{},onShow=()=>{},onLocation,onReading,onPosition,onQuests,onLook,Source=scope.EventSource,send=(url,init)=>scope.fetch(url,init),now=Date.now,timers=scope}={}){
    const rx=receiver({ids,onLocation,onReading,onPosition,onQuests,onLook,now});
    let source=null,phase='idle',hello=null,failures=0,lost=null;
    const state=(next,message,extra={})=>{phase=next;onState({phase:next,message,expires:0,local:true,...extra});};
    function start(){
      if(source)return;
      if(!Source){state('failed','This window cannot reach Maple Atlas Companion.',{reason:'unsupported'});return;}
      state('connecting','Connecting to Maple Atlas Companion…');
      source=new Source(base+'/__companion/link?t='+encodeURIComponent(token));
      source.onmessage=e=>{
        if(typeof e.data!=='string'||e.data.length>8192)return;
        let value;try{value=JSON.parse(e.data);}catch(_){return;}
        if(value.kind==='hello'){
          if(value.v!==2||value.role!=='pc'){state('failed','Maple Atlas Companion uses a different version. Update it.',{reason:'version'});stop();return;}
          hello={host:value.host==='windows'?'windows':'mac',ui:typeof value.ui==='string'&&/^\/__companion\/ui\/\?t=[a-f0-9]{32}$/.test(value.ui)?value.ui:'',version:String(value.version||'').slice(0,20)};
          failures=0;timers.clearTimeout(lost);rx.reset();
          state('connected','This window follows the game on this computer.',{host:hello.host});return;
        }
        // The app's Atlas button on the game asks for a view: the map, search, quests, directions, Look.
        if(value.kind==='show'&&value.v===1&&phase==='connected'){if(SHOW.includes(value.what))onShow(value.what);return;}
        if(phase==='connected')rx.deliver(value);
      };
      // The stream reconnects by itself; after a few failures (the app quit) it says so.
      source.onerror=()=>{
        failures++;
        if(source?.readyState===2){source=null;state('failed','Maple Atlas Companion is closed. Open it again to follow the game.',{reason:'closed'});return;}
        if(phase==='connected'){state('reconnecting','Maple Atlas Companion is not answering. Reconnecting…');timers.clearTimeout(lost);lost=timers.setTimeout(()=>{if(phase!=='connected'){stop();state('failed','Maple Atlas Companion is closed. Open it again to follow the game.',{reason:'closed'});}},20000);}
      };
    }
    function stop(){timers.clearTimeout(lost);if(source){source.onmessage=source.onerror=null;source.close();}source=null;}
    function post(value){
      if(phase!=='connected')return false;
      send(base+'/__companion/send',{method:'POST',headers:{'Content-Type':'application/json','X-Companion-Token':token},body:JSON.stringify(value)}).catch(()=>{});
      return true;
    }
    return {start,stop,
      nav:value=>post({kind:'nav',v:1,nav:value}),pins:value=>post({kind:'pins',v:1,pins:value}),
      look:req=>/^p[0-9a-z]{1,16}$/.test(req)&&post({kind:'look',v:1,req}),lookResult:()=>false,lookProgress:()=>false,
      controls:()=>post({kind:'controls'}),
      get connected(){return phase==='connected';},get hello(){return hello;}};
  }
  scope.MapleCompanionLink={pack,unpack,location,addressing,proof,create,createLocal,localToken};if(typeof module!=='undefined')module.exports=scope.MapleCompanionLink;
})(globalThis);
