const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/storage.js'), 'utf8');
const databases = new Map();
const legacy = {modelContent:{preview:'maple-atlas-data-v2',level:18,quests:{}}};
let legacyValue = JSON.stringify(legacy);
async function boot(channel) {
  const app = {dataset:{channel},inert:false};
  const context = {
    window:{},structuredClone,
    document:{getElementById:id=>id==='maple-atlas-concept'?app:{textContent:''}},
    localStorage:{getItem:()=>legacyValue,removeItem:()=>{legacyValue=null;}},
    indexedDB:{open(name) {
      const request = {};
      queueMicrotask(()=>{
        if (!databases.has(name)) databases.set(name,new Map());
        const records=databases.get(name);
        request.result={close(){},transaction(){
          const tx={objectStore(){return {
            get:key=>({result:records.get(key)}),
            put:(value,key)=>{records.set(key,value);return {result:key};}
          };}};
          queueMicrotask(()=>tx.oncomplete());
          return tx;
        }};
        request.onsuccess();
      });
      return request;
    }}
  };
  vm.runInNewContext(source,context);
  await context.window.mapleStorageReady;
  assert.equal(app.inert,false);
  return context.window.openai;
}
(async()=>{
  const dev=await boot('dev');
  assert.equal(dev.widgetState,null,'dev must not import production legacy state');
  assert.notEqual(legacyValue,null,'dev must leave legacy production data intact');
  const main=await boot('main');
  assert.equal(main.widgetState.modelContent.level,18);
  assert.equal(legacyValue,null,'main migrates legacy data');
  await dev.setWidgetState({modelContent:{preview:'maple-atlas-data-v2',level:99}});
  assert.equal((await boot('main')).widgetState.modelContent.level,18);
  assert.equal((await boot('dev')).widgetState.modelContent.level,99);
  console.log('PASS: main/dev IndexedDB isolation and production-only legacy migration.');
})().catch(error=>{console.error(error);process.exitCode=1;});
