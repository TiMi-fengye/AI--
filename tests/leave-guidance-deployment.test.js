'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const python=process.platform==='win32'?'python':'python3';
const script=path.resolve(__dirname,'../deploy/apply-leave-guidance.py');
test('static leave release hash handles line endings and rejects invalid source encoding',()=>{
  const code=`import importlib.util,sys,hashlib
s=importlib.util.spec_from_file_location('leave_release',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.canonical_hash(b'var x=1;\\r\\n  ')==hashlib.sha256(b'var x=1;\\n').hexdigest()
for raw in [b'abc\\0def',b'abc\\rdef',b'\\xff']:
 try: m.canonical_hash(raw)
 except (m.helper.Refused,UnicodeDecodeError): pass
 else: raise AssertionError('invalid source accepted')
print('ok')`;
  const r=spawnSync(python,['-c',code,script],{encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ok/);
});
test('static leave release requires the reviewed baseline before touching production',()=>{
  for(const args of [[],['--source','.'],['--source','.','--expected-leave-sha256','bad']]){
    const r=spawnSync(python,[script,...args],{encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.status,2);assert.doesNotMatch(r.stderr,/Traceback|systemctl/);
  }
  const r=spawnSync(python,[script,'--help'],{encoding:'utf8'});assert.equal(r.status,0);assert.match(r.stdout,/without restarting/);
});
