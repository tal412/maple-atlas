/* Short, session-only visual history. Scores are evidence, not probabilities. */
(function(scope){
 function create(){
  let history=[],confirmed=null,lastStrong=null,strongCount=0,lastTime=0;
  function reset(){history=[];confirmed=null;lastStrong=null;strongCount=0;lastTime=0;}
  function read(result,now=Date.now()){
   if(now-lastTime>10000)reset();lastTime=now;
   const best=result.candidates?.[0];
   if(!best){history=[];lastStrong=null;strongCount=0;confirmed=null;return {phase:'searching'};}
   strongCount=result.strong&&lastStrong===best.id?strongCount+1:result.strong?1:0;lastStrong=result.strong?best.id:null;
   // Never accumulate a weak candidate over a contradictory strong observation.
   if(result.strong&&history.length&&history.at(-1).candidates[0].id!==best.id)history=[];
   const marks=new Set(best.landmarks),previous=history.at(-1),novel=!previous||best.id!==previous.candidates[0].id||best.landmarks.filter(k=>!previous.marks.has(k)).length>=8;
   if(novel)history.push({at:now,candidates:result.candidates,marks});
   history=history.filter(h=>now-h.at<8000).slice(-5);
   const totals=new Map();for(const frame of history)for(const c of frame.candidates){const t=totals.get(c.id)||{score:0,frames:0,landmarks:new Set()};t.score+=Math.min(c.score,80);t.frames++;for(const p of c.landmarks)t.landmarks.add(p);totals.set(c.id,t);}
   const ranking=[...totals].sort((a,b)=>b[1].score-a[1].score),top=ranking[0],runner=ranking[1];
   const accumulated=top&&top[0]===best.id&&top[1].frames>=3&&top[1].landmarks.size>=40&&(!runner||top[1].score>runner[1].score*1.8);
   if((result.strong&&strongCount>=2)||accumulated){confirmed=best.id;return {phase:'confirmed',match:best,method:accumulated?'multiple-views':'stable-match'};}
   confirmed=null;return {phase:'candidate',match:best,alternatives:result.candidates.length};
  }
  return {read,reset};
 }
 scope.MapleVisualTracker={create};if(typeof module!=='undefined')module.exports=scope.MapleVisualTracker;
})(globalThis);
