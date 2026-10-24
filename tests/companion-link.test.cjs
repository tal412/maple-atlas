const assert=require('node:assert/strict');
const {pack,unpack,create,location}=require('../src/companion-link.js');
const initial=Date.now(),ids=new Set(['1','2']);
const sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 UDP 211 10.0.0.2 12345 typ host\r\n';
const offer={v:1,type:'offer',sdp,session:'a'.repeat(32),expires:initial+600000};
class Clock{
 constructor(){this.time=initial;this.next=0;this.tasks=new Map();}
 setTimeout(fn,ms){const id=++this.next;this.tasks.set(id,{fn,at:this.time+ms,every:0});return id;}
 clearTimeout(id){this.tasks.delete(id);}
 setInterval(fn,ms){const id=this.setTimeout(fn,ms);this.tasks.get(id).every=ms;return id;}
 clearInterval(id){this.tasks.delete(id);}
 advance(ms){const end=this.time+ms;for(;;){const task=[...this.tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!task||task[1].at>end)break;const [id,t]=task;this.time=t.at;if(t.every)t.at+=t.every;else this.tasks.delete(id);t.fn();}this.time=end;}
}
class Peer{
 constructor(config){assert.deepEqual(config.iceServers,[]);this.iceGatheringState='complete';this.connectionState='new';Peer.last=this;}
 createDataChannel(label){return this.channel={label,readyState:'connecting',bufferedAmount:0,messages:[],close(){this.readyState='closed';},send(value){this.sent=value;this.messages.push(JSON.parse(value));}};}
 async createOffer(){return {type:'offer',sdp};}
 async createAnswer(){return {type:'answer',sdp};}
 async setLocalDescription(value){this.localDescription=value;this.signalingState=value.type==='offer'?'have-local-offer':'stable';}
 async setRemoteDescription(value){this.remoteDescription=value;this.signalingState=value.type==='offer'?'have-remote-offer':'stable';}
 close(){this.closed=true;}
}
function harness(extra={}){const clock=new Clock(),states=[];const link=create({ids,Peer,timers:clock,now:()=>clock.time,onState:s=>states.push(s),...extra});return {link,clock,states,last:()=>states.at(-1)};}
function openChannel(peer,link,session,remoteRole){
 const channel=peer.channel;channel.readyState='open';channel.onopen();assert(!link.connected,'An open channel is not an application confirmation');
 const hello=channel.messages.findLast(m=>m.kind==='hello'),deliver=v=>channel.onmessage({data:JSON.stringify(v)});
 deliver({kind:'hello-ack',v:2,session,nonce:'0'.repeat(32)});assert(!link.connected,'A mismatched acknowledgement is rejected');
 deliver({kind:'hello',v:2,session,role:remoteRole,nonce:'f'.repeat(32)});assert(!link.connected,'Both directions must be verified');
 deliver({kind:'hello-ack',v:2,session,nonce:hello.nonce});assert(link.connected);return {channel,deliver};
}
(async()=>{
 assert.deepEqual(await unpack(await pack(offer),initial),offer);
 for(const patch of [{expires:initial-1},{expires:initial+700000},{session:'invalid'},{v:2},{sdp:sdp+'m=video 9 RTP/AVP 96\r\n'},{sdp:sdp.replace('typ host','typ relay')},{sdp:sdp.replace('a=fingerprint:','a=unknown:')},{sdp:'v=0'+'.'.repeat(25000)}])await assert.rejects(unpack(await pack({...offer,...patch}),initial));
 await assert.rejects(unpack('https://not-a-pairing-code.test',initial));
 const pc=harness(),own=await unpack(await pc.link.offer(),initial),pcPeer=Peer.last;
 assert.equal(pc.last().phase,'waiting-phone');
 await assert.rejects(pc.link.finish(await pack({...own,type:'answer',session:'b'.repeat(32)})));assert.equal(pc.last().phase,'waiting-phone');
 await pc.link.finish(await pack({...own,type:'answer'}));assert.equal(pc.last().phase,'connecting');assert(!pc.link.connected);
 pcPeer.connectionState='connected';pcPeer.onconnectionstatechange();assert(!pc.link.connected,'ICE success alone never displays Connected');
 const {channel:pcChannel,deliver:toPC}=openChannel(pcPeer,pc.link,own.session,'phone');
 assert(!pc.link.send({id:'missing',confidence:99,observedAt:initial}));assert(pc.link.send({id:'1',confidence:90,observedAt:initial,pixels:'must not transmit'}));
 const sent=JSON.parse(pcChannel.sent);assert.deepEqual(Object.keys(sent),['kind','id','confidence','observedAt','seq']);assert(location(sent,ids));
 assert(!pc.link.sendStatus('invalid'));assert(pc.link.sendStatus('searching'));const searching=JSON.parse(pcChannel.sent);
 pc.clock.advance(9001);assert.equal(pc.last().phase,'reconnecting');assert(!pc.link.connected);assert(!pc.link.send({id:'1',confidence:90,observedAt:pc.clock.time}));
 const ping=pcChannel.messages.findLast(m=>m.kind==='ping');toPC({...ping,kind:'pong'});assert.equal(pc.last().phase,'connected');assert(pc.link.connected);
 pc.clock.advance(21000);assert.equal(pc.last().phase,'failed');assert.equal(pc.last().reason,'heartbeat');assert(pcPeer.closed);

 const received=[],readings=[],phone=harness({onLocation:v=>received.push(v),onReading:v=>readings.push(v)}),offerCode=await pack(offer);
 const response=await phone.link.answer(offerCode),phonePeer=Peer.last;
 assert.equal(phone.last().phase,'waiting-computer');assert.equal(await phone.link.answer(offerCode),response,'Repeated scans keep the same response');assert.equal(Peer.last,phonePeer);
 const channel=phonePeer.createDataChannel('maple-atlas');phonePeer.ondatachannel({channel});channel.onmessage({data:JSON.stringify(sent)});assert.equal(received.length,0);
 const {deliver}=openChannel(phonePeer,phone.link,offer.session,'pc');
 deliver(sent);deliver(sent);deliver({...sent,seq:sent.seq+1,id:'unknown'});deliver({...sent,seq:sent.seq+2,confidence:101});assert.equal(received.length,1);
 deliver(searching);deliver(searching);deliver(sent);deliver({...searching,seq:searching.seq+1,state:'invented'});deliver({...searching,seq:searching.seq+1,observedAt:null});assert.deepEqual(readings,['searching']);
 deliver({...sent,seq:sent.seq+3,id:'2'});assert.equal(received.length,2);deliver({...searching,seq:sent.seq+4,state:'paused'});assert.deepEqual(readings,['searching','paused']);
 phone.link.stop();assert.equal(channel.onmessage,null);assert(phonePeer.closed);assert.equal(phone.clock.tasks.size,0);

 const timeout=harness();await timeout.link.answer(offerCode);timeout.link.waitForConnection();assert.equal(timeout.last().phase,'connecting');timeout.clock.advance(25000);assert.equal(timeout.last().reason,'timeout');assert(!timeout.link.connected);
 const expired=harness();await expired.link.offer();expired.clock.advance(600001);assert.equal(expired.last().phase,'expired');assert.equal(expired.clock.tasks.size,0);
 const unverified=harness();await unverified.link.offer();const oldPeer=Peer.last;oldPeer.channel.readyState='open';oldPeer.channel.onopen();unverified.clock.advance(7000);assert.equal(unverified.last().reason,'verification');assert(!unverified.link.connected);
 const network=harness();await network.link.offer();Peer.last.connectionState='failed';Peer.last.onconnectionstatechange();assert.equal(network.last().reason,'network');
 const stopped=harness();await stopped.link.offer();stopped.link.stop();assert.equal(stopped.last().phase,'disconnected');assert.equal(stopped.clock.tasks.size,0);
 const decoding=harness(),decodingAnswer=decoding.link.answer(offerCode);decoding.link.stop();await assert.rejects(decodingAnswer,/cancelled/);assert.equal(decoding.last().phase,'disconnected');assert.equal(decoding.clock.tasks.size,0);
 let startedGather;const gatheringStarted=new Promise(resolve=>{startedGather=resolve;});
 class GatheringPeer extends Peer{
  constructor(config){super(config);this.iceGatheringState='gathering';}
  addEventListener(name,fn){this.listener=fn;startedGather();}
  removeEventListener(){this.listener=null;}
 }
 const gathering=harness({Peer:GatheringPeer}),gatheringOffer=gathering.link.offer();await gatheringStarted;gathering.link.stop();await assert.rejects(gatheringOffer,/cancelled/);assert.equal(gathering.last().phase,'disconnected');assert.equal(gathering.clock.tasks.size,0);assert.equal(Peer.last.listener,null);
 const mismatch=harness();await mismatch.link.offer();const mismatchPeer=Peer.last;mismatchPeer.channel.readyState='open';mismatchPeer.channel.onopen();const hello=mismatchPeer.channel.messages.find(m=>m.kind==='hello');mismatchPeer.channel.onmessage({data:JSON.stringify({...hello,v:99,role:'phone'})});assert.equal(mismatch.last().reason,'version');assert(!mismatch.link.connected);
 console.log('PASS: explicit scan/response states, stable repeated scans, two-way confirmation, no false connected state, heartbeat loss/recovery, timeout/expiry/failure, replay rejection and cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
