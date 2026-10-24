// Uses the same vendored WASM and matching code as the browser worker.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'.openai/vision-benchmark');
const cv=require('../docs/vendor/vision/opencv.js'),{create}=require('../src/visual-matcher.js');
function run(){
 try{
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'docs/data/visual-index.json'))),b=fs.readFileSync(path.join(root,'docs',catalog.data.slice(2)));
  const engine=create(cv,catalog,b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)),rows=[];
  try{for(const f of JSON.parse(fs.readFileSync(path.join(dir,'fixtures.json')))){
   const start=performance.now(),result=engine.match({...f,data:fs.readFileSync(path.join(dir,f.file))});
   const row={name:f.name,expected:f.expected,kind:f.kind,strong:!!result.strong,ms:Math.round(performance.now()-start),candidates:result.candidates.map(c=>({id:c.id,inliers:c.inliers,score:Math.round(c.score),kind:c.kind}))};
   rows.push(row);console.log(JSON.stringify(row));
  }}finally{engine.destroy();}
  const summary={};for(const r of rows){const s=summary[r.kind]||{total:0,correct:0,uncertain:0,wrong:0};s.total++;if(!r.strong)s.uncertain++;else if(r.candidates[0].id===r.expected)s.correct++;else s.wrong++;summary[r.kind]=s;}
  fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify({summary,rows},null,2));console.log(summary);
  if(Object.values(summary).some(s=>s.wrong))process.exitCode=1;
 }catch(e){console.error(e);process.exitCode=1;}
}
if(cv.Mat)run();else cv.onRuntimeInitialized=run;
