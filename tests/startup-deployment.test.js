'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const script = path.resolve(__dirname,'../deploy/apply-startup-performance.py');
const python = process.platform==='win32'?'python':'python3';
const canonical = value => value.replace(/\r\n/g,'\n').trimEnd()+'\n';
const sha = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const bridge = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('performance_release',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
v=json.loads(sys.stdin.buffer.read().decode('utf-8'))
groups={'auth':m.PATCHES,'server':m.SERVER_PATCHES,'index':m.INDEX_PATCHES,'client':m.CLIENT_AUTH_PATCHES}
if v.get('groups'): print(json.dumps(groups))
else:
 try: print(json.dumps({'ok':True,'text':m.patch_exact(v['text'].encode('utf-8'),v['sha'],groups[v['group']]).decode('utf-8')}))
 except m.Refused as e: print(json.dumps({'ok':False,'error':str(e)}))
`;
function invoke(value){const r=spawnSync(python,['-c',bridge,script],{input:JSON.stringify(value),encoding:'utf8',timeout:15000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
const groups=invoke({groups:true});
for(const [group,file] of Object.entries({auth:'server/auth-service.js',server:'server/server.js',index:'index.html',client:'js/auth.js'})){
  test('reviewed startup '+group+' patch preserves unrelated code and rejects changed baselines',()=>{
    const current=canonical(fs.readFileSync(path.resolve(__dirname,'..',file),'utf8'));let baseline=current;
    for(const [old,replacement] of groups[group]){assert.equal(baseline.split(replacement).length,2);baseline=baseline.replace(replacement,old);}
    const apply=(text,expected=sha(text))=>invoke({text,sha:expected,group});
    assert.deepEqual(apply(baseline),{ok:true,text:current});
    assert.deepEqual(apply(baseline.replace(/\n/g,'\r\n')+'  ',sha(baseline)),{ok:true,text:current});
    assert.equal(apply(baseline,sha(current)).ok,false);assert.equal(apply(current).ok,false);
    for(const [old,replacement] of groups[group]){
      assert.equal(apply(baseline.replace(old,'/*missing*/')).ok,false);
      assert.equal(apply(baseline+'\n'+old+'\n// duplicate anchor fixture\n').ok,false);
      assert.equal(apply(baseline.replace(old,replacement)).ok,false);
    }
    assert.equal(apply(baseline+'\0').ok,false);
  });
}
test('all three startup baseline hashes are required before production access',()=>{
  for(const args of [[],['--source','.'],['--source','.','--expected-auth-sha256','a'.repeat(64),'--expected-index-sha256','b'.repeat(64)],['--source','.','--expected-auth-sha256','bad']]){
    const r=spawnSync(python,[script,...args],{encoding:'utf8',timeout:15000});assert.ifError(r.error);assert.equal(r.status,2);assert.doesNotMatch(r.stderr,/Traceback|systemctl|Preflight passed/);
  }
});
