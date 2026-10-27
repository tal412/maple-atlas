// Regenerate committed, same-origin browser assets. Run npm ci --ignore-scripts first.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),modules=path.join(root,'node_modules'),vendor=path.join(root,'docs/vendor'),out=path.join(vendor,'companion');
fs.mkdirSync(out,{recursive:true});
const copy=(pkg,source,target)=>fs.copyFileSync(path.join(modules,pkg,source),path.join(out,target));
(async()=>{
 await require('esbuild').build({stdin:{contents:"window.MapleQR={...require('qrcode/lib/browser'),decode:require('jsqr')};",resolveDir:root,sourcefile:'qr-entry.js'},bundle:true,minify:true,platform:'browser',outfile:path.join(out,'qr.js')});
 copy('qrcode','license','qrcode.LICENSE');copy('jsqr','LICENSE','jsqr.LICENSE');
 fs.copyFileSync(path.join(modules,'lucide/dist/umd/lucide.js'),path.join(vendor,'lucide.js'));
 fs.copyFileSync(path.join(modules,'lucide/LICENSE'),path.join(vendor,'lucide.LICENSE'));
 fs.copyFileSync(path.join(modules,'@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2'),path.join(vendor,'roboto-latin.woff2'));
 fs.copyFileSync(path.join(modules,'@fontsource-variable/roboto/LICENSE'),path.join(vendor,'roboto.LICENSE'));
 const manifest={};for(const name of ['qrcode','jsqr'])manifest[name]=JSON.parse(fs.readFileSync(path.join(modules,name,'package.json'))).version;
 manifest.files={};for(const name of fs.readdirSync(out).sort())if(name!=='versions.json')manifest.files[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex');
 fs.writeFileSync(path.join(out,'versions.json'),JSON.stringify(manifest,null,2)+'\n');console.log('Pinned QR, icons and font copied to docs/vendor.');
})().catch(e=>{console.error(e);process.exitCode=1;});
