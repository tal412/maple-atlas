const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {pack,unpack,create,location,addressing}=require('../src/companion-link.js');
const initial=Date.now(),ids=new Set(['1','2']),seconds=t=>Math.ceil(t/1000)*1000;
const fp=Array.from({length:32},(_,i)=>(i*7).toString(16).padStart(2,'0').toUpperCase()).join(':');
const sdpFor=setup=>['v=0','o=- 1 2 IN IP4 127.0.0.1','s=-','t=0 0','a=group:BUNDLE 0','m=application 9 UDP/DTLS/SCTP webrtc-datachannel','c=IN IP4 0.0.0.0',
 'a=candidate:1 1 udp 2122260223 10.0.0.2 12345 typ host generation 0','a=candidate:2 1 UDP 2122194687 2001:db8::5 23456 typ host generation 0',
 'a=candidate:3 1 udp 2122129151 1f4712db-ea17-4bcf-a596-105139dfd8bf.local 34567 typ host generation 0','a=candidate:4 1 tcp 1518280447 10.0.0.2 9 typ host tcptype active',
 'a=candidate:5 1 udp 1686052607 203.0.113.9 40000 typ srflx raddr 10.0.0.2 rport 12345','a=ice-ufrag:AbC1','a=ice-pwd:abcdefghijklmnopqrstuv12','a=ice-options:trickle',
 'a=fingerprint:sha-256 '+fp,'a=setup:'+setup,'a=mid:0','a=sctp-port:5000',''].join('\r\n');
const secret=Uint8Array.from({length:16},(_,i)=>i);
const offer={v:2,type:'offer',sdp:sdpFor('actpass'),session:'a'.repeat(16),expires:seconds(initial+600000),secret};
class Clock{
 constructor(){this.time=initial;this.next=0;this.tasks=new Map();}
 setTimeout(fn,ms){const id=++this.next;this.tasks.set(id,{fn,at:this.time+ms,every:0});return id;}
 clearTimeout(id){this.tasks.delete(id);}
 setInterval(fn,ms){const id=this.setTimeout(fn,ms);this.tasks.get(id).every=ms;return id;}
 clearInterval(id){this.tasks.delete(id);}
 advance(ms){const end=this.time+ms;for(;;){const task=[...this.tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!task||task[1].at>end)break;const [id,t]=task;this.time=t.at;if(t.every)t.at+=t.every;else this.tasks.delete(id);t.fn();}this.time=end;}
}
class Peer{
 constructor(config){assert.deepEqual(config.iceServers,[]);this.connectionState='new';Peer.last=this;}
 createDataChannel(label){return {label,readyState:'connecting',bufferedAmount:0,messages:[],close(){this.readyState='closed';},send(value){this.messages.push(JSON.parse(value));}};}
 async createAnswer(){return {type:'answer',sdp:sdpFor('active')};}
 async setLocalDescription(value){this.localDescription=value;}
 async setRemoteDescription(value){this.remoteDescription=value;}
 close(){this.closed=true;}
}
function harness(extra={}){const clock=new Clock(),states=[];const link=create({ids,Peer,timers:clock,now:()=>clock.time,onState:s=>states.push(s),...extra});return {link,clock,states,last:()=>states.at(-1)};}
const tick=()=>new Promise(r=>setTimeout(r,30));
// The app creates the data channel, the phone authenticates, then both say hello.
async function connect(h,code){
 await h.link.join(code);const peer=Peer.last,channel=peer.createDataChannel('maple-atlas');peer.ondatachannel({channel});
 channel.readyState='open';channel.onopen();await tick();
 const [auth,hello]=channel.messages,deliver=v=>channel.onmessage({data:JSON.stringify(v)});
 deliver({kind:'hello',v:2,session:offer.session,role:'pc',nonce:'e'.repeat(32)});assert(!h.link.connected,'Both directions must be verified');
 deliver({kind:'hello-ack',v:2,session:offer.session,nonce:hello.nonce});
 return {peer,channel,deliver,auth,hello};
}
(async()=>{
 // Codes: compact, alphanumeric, only from the companion app.
 const code=await pack(offer),decoded=await unpack(code,initial);
 assert.match(code,/^MA2[A-Z2-7]+$/);assert(code.length<260);assert(decoded.native);assert.deepEqual([...decoded.secret],[...secret]);
 for(const line of ['a=ice-lite','a=ice-ufrag:AbC1','a=ice-pwd:abcdefghijklmnopqrstuv12','a=fingerprint:sha-256 '+fp,'a=setup:actpass','a=candidate:1 1 udp 2122260223 10.0.0.2 12345 typ host'])assert(decoded.sdp.includes(line),line);
 assert(!/ tcp | srflx /.test(decoded.sdp),'Only direct UDP host candidates are carried');assert.deepEqual(addressing(decoded.sdp),{ip:2,names:1});
 assert.equal(await pack(decoded),code,'Rebuilt descriptions encode identically');
 const golden='MA2FCVKVKVKVKVKVKTLJHJAAAJQARAWEQZRDBQWEY3EMVTGO2DJNJVWY3LON5YHC4TTOR2XMMJSAADQ4FI4EMVDCOB7IZGVIW3CNFYHO7UFRSJZVINIV63L3RGL2LMQCBAKAAAAEMBZAAAQEAYEAUDAOCAJBIFQYDIOB4';
 const goldenSdp=['v=0','m=application 9 UDP/DTLS/SCTP webrtc-datachannel','a=candidate:1 1 udp 2122260223 10.0.0.2 12345 typ host','a=ice-ufrag:AbC1','a=ice-pwd:abcdefghijklmnopqrstuv12','a=fingerprint:sha-256 '+fp,'a=setup:actpass','a=mid:0',''].join('\r\n');
 assert.equal(await pack({type:'offer',sdp:goldenSdp,session:'a'.repeat(16),expires:1800000000000,secret}),golden,'Must match the Go encoder in macos/link');
 assert.equal((await unpack('https://tal412.github.io/maple-atlas/#link='+golden,1800000000000-60000)).session,'a'.repeat(16),'The QR link form is accepted');
 assert.equal((await unpack(code.toLowerCase(),initial)).session,offer.session,'Codes survive case changes from scanners');
 const browserCode=await pack({...offer,secret:undefined});
 await assert.rejects(unpack(browserCode,initial),/old Maple Atlas version/,'Codes from the removed browser pairing are refused');
 await assert.rejects(unpack('MAPLE1:abc',initial),/old Maple Atlas version/);
 await assert.rejects(unpack('https://tal412.github.io/maple-atlas/',initial),/website link/);
 for(const text of ['MA2'+'A'.repeat(800),code.slice(0,-6),code+'AAAA','MA2!'+code.slice(4)])await assert.rejects(unpack(text,initial));
 await assert.rejects(unpack(await pack({...offer,expires:seconds(initial)-2000}),initial),'Expired codes are refused');
 assert.equal((await unpack(await pack({...offer,expires:seconds(initial)-2000}),initial,{ignoreExpiry:true})).session,offer.session,'Remembered codes resume after expiry');
 for(const bad of [{session:'invalid'},{sdp:offer.sdp+'m=video 9 RTP/AVP 96\r\n'},{sdp:offer.sdp.replace(/ typ host/g,' typ relay')},{sdp:offer.sdp.replace('sha-256','sha-1')}])
  await assert.rejects((async()=>unpack(await pack({...offer,...bad}),initial))());

 // Joining: one scan, the QR secret proven over this phone's own certificate.
 const received=[],readings=[],positions=[],h=harness({onLocation:v=>received.push(v),onReading:v=>readings.push(v),onPosition:v=>positions.push(v)});
 const {peer,channel,deliver,auth,hello}=await connect(h,code);
 assert.match(peer.remoteDescription.sdp,/a=ice-lite/);assert(h.link.connected);assert.equal(h.last().phase,'connected');
 assert.equal(auth.kind,'auth');assert.equal(auth.v,3);assert.equal(hello.kind,'hello');assert.equal(hello.role,'phone');
 assert.equal(auth.proof,crypto.createHmac('sha256',Buffer.from(secret)).update('maple-atlas-link|'+offer.session+'|'+fp).digest('base64url'));
 const at={kind:'location',id:'1',confidence:90,observedAt:initial,seq:1};
 deliver(at);deliver(at);deliver({...at,seq:2,id:'unknown'});deliver({...at,seq:3,confidence:101});assert.equal(received.length,1,'Replays, unknown maps and bad values are ignored');assert(location(received[0],ids));
 deliver({kind:'position',id:'1',x:3400,y:940,seq:4,observedAt:initial});deliver({kind:'position',id:'1',x:'5',y:1,seq:5,observedAt:initial});deliver({kind:'position',id:'missing',x:1,y:1,seq:6,observedAt:initial});
 assert.deepEqual(positions.map(p=>[p.x,p.y]),[[3400,940]]);
 deliver({kind:'tracking',state:'searching',seq:7,observedAt:initial});deliver({kind:'tracking',state:'invented',seq:8,observedAt:initial});assert.deepEqual(readings,['searching']);
 // Heartbeat: quiet after 9 s, restored by a pong, failed after 20 s.
 h.clock.advance(9001);assert.equal(h.last().phase,'reconnecting');
 const ping=channel.messages.findLast(m=>m.kind==='ping');deliver({...ping,kind:'pong'});assert.equal(h.last().phase,'connected');
 h.clock.advance(21000);assert.equal(h.last().phase,'failed');assert.equal(h.last().reason,'heartbeat');assert(peer.closed);

 // Goodbyes: the app's bye ends it; the phone's own Disconnect sends one; leaving quietly does not.
 const b=harness(),bye=await connect(b,code);bye.deliver({kind:'bye',v:2,session:'0'.repeat(16)});assert(b.link.connected,'A goodbye for another session is ignored');
 bye.deliver({kind:'bye',v:2,session:offer.session});assert.equal(b.last().phase,'disconnected');assert.equal(b.last().reason,'bye');assert.equal(b.clock.tasks.size,0);
 const d=harness(),own=await connect(d,code);d.link.stop('Disconnected.');assert.equal(own.channel.messages.at(-1).kind,'bye');assert.equal(d.last().reason,'user');
 const q=harness(),quiet=await connect(q,code);const sent=quiet.channel.messages.length;q.link.stop(undefined,{quiet:true,reason:'page'});assert.equal(quiet.channel.messages.length,sent,'Leaving the page sends no goodbye');assert.equal(q.last().reason,'page');

 // Failures: timeout, expiry, unverified link, version mismatch, network.
 const late=harness();await late.link.join(code);late.clock.advance(25000);assert.equal(late.last().reason,'timeout');
 const resumed=harness();await resumed.link.join(code,{resume:true});assert.match(resumed.last().message,/Reconnecting/);resumed.clock.advance(25000);assert.match(resumed.last().message,/reconnect/i);
 const expired=harness();await expired.link.join(code);expired.clock.advance(601000);assert.ok(['expired','failed'].includes(expired.last().phase));
 const unverified=harness();await unverified.link.join(code);const up=Peer.last,uc=up.createDataChannel('maple-atlas');up.ondatachannel({channel:uc});uc.readyState='open';uc.onopen();unverified.clock.advance(7000);assert.equal(unverified.last().reason,'verification');
 const mismatch=harness(),m=await connect(harness(),code);void m;const mm=await (async()=>{await mismatch.link.join(code);const p=Peer.last,c=p.createDataChannel('maple-atlas');p.ondatachannel({channel:c});c.readyState='open';c.onopen();await tick();c.onmessage({data:JSON.stringify({kind:'hello',v:99,session:offer.session,role:'pc',nonce:'e'.repeat(32)})});return mismatch.last();})();
 assert.equal(mm.reason,'version');
 const network=harness();await network.link.join(code);Peer.last.connectionState='failed';Peer.last.onconnectionstatechange();assert.equal(network.last().reason,'network');
 const twice=harness();await twice.link.join(code);const first=Peer.last;await twice.link.join(code);assert.equal(Peer.last,first,'Scanning the same code again keeps the connection attempt');
 console.log('PASS: app-only codes (golden, QR link, case, expiry, old codes refused) · one-scan join with HMAC auth · hello, heartbeat, positions, tracking · goodbyes, quiet leave · timeout, expiry, verification, version, network');
})().catch(e=>{console.error(e);process.exitCode=1;});
