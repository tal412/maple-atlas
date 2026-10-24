const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {create}=require('../src/visual-matcher.js');const cv=require('../docs/vendor/vision/opencv.js');
function test(){
 const catalog=JSON.parse(fs.readFileSync('docs/data/visual-index.json')),binary=fs.readFileSync('docs/'+catalog.data.slice(2)),buffer=binary.buffer.slice(binary.byteOffset,binary.byteOffset+binary.byteLength);
 assert.equal(crypto.createHash('sha256').update(binary).digest('hex'),catalog.sha256);assert.equal(binary.length,catalog.bytes);
 assert.equal(catalog.maps.length,336);assert.equal(catalog.unavailable.length,12);assert.equal(new Set(catalog.records.map(r=>r.id)).size,335);
 let end=0;for(const r of catalog.records){assert.equal(r.offset,end);end+=r.count*40;assert(r.count>=12&&r.count<=1200);const p=new Float32Array(buffer,r.offset,r.count*2);for(let i=0;i<p.length;i++)assert(Number.isFinite(p[i])&&p[i]>=0&&p[i]<(i%2?r.height:r.width));}assert.equal(end,binary.length);
 const engine=create(cv,catalog,buffer);
 for(const f of JSON.parse(fs.readFileSync('tests/fixtures/visual.json'))){const data=zlib.gunzipSync(fs.readFileSync('tests/fixtures/'+f.file)),r=engine.match({...f,data});if(f.ambiguous)assert(!r.strong,'Repeated event scenery must remain ambiguous');else{assert(r.strong,f.name);assert.equal(r.candidates[0].id,f.expected,f.name);}}
 const blank=engine.match({width:240,height:160,data:new Uint8Array(240*160*4).fill(60)});assert(!blank.strong);assert.equal(blank.candidates.length,0);
 assert.throws(()=>engine.match({width:240,height:160,data:new Uint8Array(1)}));engine.destroy();
 console.log('PASS: 335-map vector integrity, cropped-minimap recognition, scene matching, duplicate-map rejection and blank-image rejection');
}
function run(){try{test();}catch(e){console.error(e);process.exitCode=1;}}
if(cv.Mat)run();else cv.onRuntimeInitialized=run;
