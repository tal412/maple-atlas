const assert=require('node:assert/strict');
const {pack,unpack,create,location}=require('../src/companion-link.js');
const now=Date.now(),ids=new Set(['1','2']);
const sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 UDP 211 10.0.0.2 12345 typ host\r\n';
const offer={v:1,type:'offer',sdp,session:'a'.repeat(32),expires:now+600000};
class Peer {
  constructor(config){assert.deepEqual(config.iceServers,[]);this.iceGatheringState='complete';this.connectionState='new';Peer.last=this;}
  createDataChannel(label){return this.channel={label,readyState:'connecting',bufferedAmount:0,close(){this.readyState='closed';},send(value){this.sent=value;}};}
  async createOffer(){return {type:'offer',sdp};}
  async createAnswer(){return {type:'answer',sdp};}
  async setLocalDescription(value){this.localDescription=value;this.signalingState=value.type==='offer'?'have-local-offer':'stable';}
  async setRemoteDescription(value){this.remoteDescription=value;this.signalingState=value.type==='offer'?'have-remote-offer':'stable';}
  close(){this.closed=true;}
}
(async()=>{
  assert.deepEqual(await unpack(await pack(offer),now),offer);
  for(const patch of [{expires:now-1},{expires:now+700000},{session:'invalid'},{v:2},{sdp:sdp+'m=video 9 RTP/AVP 96\r\n'},{sdp:sdp.replace('typ host','typ relay')},{sdp:sdp.replace('a=fingerprint:','a=unknown:')},{sdp:'v=0'+'.'.repeat(25000)}])await assert.rejects(unpack(await pack({...offer,...patch}),now));
  await assert.rejects(unpack('https://not-a-pairing-code.test',now));
  const pc=create({ids,Peer,now:()=>now});const own=await unpack(await pc.offer(),now),pcPeer=Peer.last;
  await assert.rejects(pc.finish(await pack({...own,type:'answer',session:'b'.repeat(32)})));
  await pc.finish(await pack({...own,type:'answer'}));pcPeer.channel.readyState='open';pcPeer.channel.onopen();
  assert.equal(pc.send({id:'missing',confidence:99,observedAt:now}),false);
  assert(pc.send({id:'1',confidence:90,observedAt:now,pixels:'must not transmit'}));
  const sent=JSON.parse(pcPeer.channel.sent);assert.deepEqual(Object.keys(sent),['kind','id','confidence','observedAt','seq']);assert(location(sent,ids));
  assert(!pc.sendStatus('invalid'));assert(pc.sendStatus('searching'));
  const searching=JSON.parse(pcPeer.channel.sent);assert.equal(searching.kind,'tracking');assert.equal(searching.state,'searching');assert(searching.seq>sent.seq);
  pc.stop();assert(pcPeer.closed);assert(!pc.connected);assert(!pc.send({id:'1',confidence:90,observedAt:now}));
  const received=[],readings=[],phone=create({ids,Peer,now:()=>now,onLocation:v=>received.push(v),onReading:v=>readings.push(v)});
  await phone.answer(await pack(offer));const phonePeer=Peer.last,channel=phonePeer.createDataChannel('maple-atlas');phonePeer.ondatachannel({channel});channel.readyState='open';channel.onopen();
  const deliver=v=>channel.onmessage({data:JSON.stringify(v)});
  deliver(sent);deliver(sent);deliver({...sent,seq:sent.seq+1,id:'unknown'});deliver({...sent,seq:sent.seq+2,confidence:101});
  assert.equal(received.length,1,'Duplicate, unknown and invalid readings are ignored');
  deliver(searching);deliver(searching);deliver(sent);
  deliver({...searching,seq:searching.seq+1,state:'invented'});deliver({...searching,seq:searching.seq+1,observedAt:null});
  assert.deepEqual(readings,['searching']);assert.equal(received.length,1);
  deliver({...sent,seq:sent.seq+3,id:'2'});assert.equal(received.length,2);assert.equal(received[1].receivedAt,now);
  deliver({...searching,seq:sent.seq+4,state:'paused'});assert.deepEqual(readings,['searching','paused']);
  phone.stop();assert.equal(channel.onmessage,null);assert(phonePeer.closed);
  console.log('PASS: direct-only expiring pairing, mismatched sessions, data-only payloads, replay/unknown-location rejection and disconnect cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
