'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const Export = require('../js/personnel-export');
const fields = [
  {key:'employeeNo',label:'工号'},{key:'name',label:'姓名'},{key:'building',label:'楼栋'},
  {key:'phone',label:'手机号'},{key:'aiProfile',label:'人员简介'},
  {key:'resumeName',label:'简历文件名'},{key:'credentialName',label:'证件文件名'}
];
function payload(role='admin') {
  return {ok:true,generatedAt:'2026-11-16T08:00:00.000Z',scope:{role,buildings:role==='leader'?['楼栋A']:[]},fields,
    employees:[{id:1,employeeNo:'0000123',name:'演示甲',building:'楼栋A',phone:'013800000000',aiProfile:'中文简介\n第二行',resumeName:'../../简历.pdf',resumeData:'data:application/pdf;base64,JVBERi0x',credentialName:'简历.pdf',credentialData:'data:application/pdf;base64,QUJD',passwordHash:'DO-NOT-EXPORT'}]};
}
function unzip(bytes) {
  const buffer=Buffer.from(bytes), files={}; let offset=0;
  while(buffer.readUInt32LE(offset)===0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset+8),0,'Store-only ZIP needs no decompressor');
    const size=buffer.readUInt32LE(offset+18), length=buffer.readUInt16LE(offset+26), extra=buffer.readUInt16LE(offset+28);
    const name=buffer.subarray(offset+30,offset+30+length).toString('utf8');
    const begin=offset+30+length+extra;files[name]=buffer.subarray(begin,begin+size);offset=begin+size;
  }
  assert.equal(buffer.readUInt32LE(offset),0x02014b50);
  assert.equal(buffer.readUInt32LE(buffer.length-22),0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length-12),Object.keys(files).length);
  return files;
}
function checkArchiveWithPython(bytes, xml=false) {
  const script='import io,zipfile,sys,xml.etree.ElementTree as ET\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\n'+(xml?'[ET.fromstring(z.read(n)) for n in z.namelist() if n.endswith((".xml",".rels"))]\n':'')+'print(len(z.namelist()))';
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-c',script],{input:Buffer.from(bytes),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return Number(result.stdout.trim());
}

test('XLSX / XLS / ODS round-trip preserve text, leading zeros and literal formula-like names',()=>{
  const XLSX=require('../js/xlsx.full.min.js');
  const input=payload();input.employees[0].name='=HYPERLINK("https://example.com")';
  for(const format of ['xlsx','xls','ods']) {
    const file=Export.makeFile(format,input,XLSX);
    assert.ok(file.content.byteLength>100);
    const workbook=XLSX.read(file.content,{type:'array'}),sheet=workbook.Sheets[workbook.SheetNames[0]];
    assert.equal(sheet.A2.v,'0000123');assert.equal(sheet.A2.t,'s');
    assert.equal(sheet.D2.v,'013800000000');assert.equal(sheet.B2.v,input.employees[0].name);
    assert.equal(sheet.B2.f,undefined);
  }
});

test('CSV / TSV quote delimiters and multiline text, use BOM and neutralize formula/control prefixes',()=>{
  const input=payload();input.employees[0].name=' \t=1+1';input.employees[0].aiProfile='引号"与,逗号\t制表\n换行';
  const csv=Export.makeFile('csv',input).content,tsv=Export.makeFile('tsv',input).content;
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(tsv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\' \t=1+1"'));assert.ok(tsv.includes('"\' \t=1+1"'));
  assert.ok(csv.includes('"引号""与,逗号\t制表\n换行"'));assert.match(csv,/"0000123"/);
  for(const prefix of ['=','+','-','@','\t','\r','\n',' \r','\uFEFF=']) {
    input.employees[0].name=prefix+'payload';assert.ok(Export.makeFile('csv',input).content.includes('"\''+prefix+'payload"'));
  }
});

test('JSON includes full authorized attachments but discards unrelated and credential fields',()=>{
  const input=payload();input.secret='not-exported';
  const json=JSON.parse(Export.makeFile('json',input).content);
  assert.equal(json.employees[0].employeeNo,'0000123');assert.equal(json.employees[0].resumeData,input.employees[0].resumeData);
  assert.equal(json.employees[0].id,1);assert.equal(json.employees[0].passwordHash,undefined);assert.equal(json.secret,undefined);
});

test('HTML / XML / DOCX escape hostile text and controls without fetching any external resources',()=>{
  const input=payload();input.employees[0].name='<script>alert(1)</script>&"\u0001';
  const html=Export.makeFile('html',input).content,xml=Export.makeFile('xml',input).content;
  for(const text of [html,xml]) {assert.doesNotMatch(text,/<script|\u0001|resumeData|JVBERi0x/);assert.match(text,/&lt;script&gt;/);}
  assert.match(xml,/<employee id="1">/);assert.doesNotMatch(html,/<(?:iframe|img|link)\b/i);
  const docx=Export.makeFile('docx',input);const files=unzip(docx.content);
  assert.ok(files['[Content_Types].xml']);assert.ok(files['_rels/.rels']);
  assert.match(files['word/document.xml'].toString(),/&lt;script&gt;/);assert.match(files['word/document.xml'].toString(),/0000123/);
  assert.equal(checkArchiveWithPython(docx.content,true),5);
});

test('ZIP preserves attachment bytes with unique safe paths and a manifest',()=>{
  const input=payload();input.employees.push({...input.employees[0],id:2,name:'同名人员'});
  const zip=Export.makeFile('zip',input),files=unzip(zip.content),names=Object.keys(files);
  assert.equal(checkArchiveWithPython(zip.content),7);
  assert.deepEqual(files['附件/人员-1/简历/.._.._简历.pdf'],Buffer.from('%PDF-1'));
  assert.deepEqual(files['附件/人员-1/证件/简历.pdf'],Buffer.from('ABC'));
  assert.ok(names.some(n=>n.startsWith('附件/人员-2/')));assert.ok(names.every(n=>!n.split('/').includes('..')));
  const manifest=JSON.parse(files['附件清单.json']);assert.equal(manifest.attachments.length,4);
  assert.equal(JSON.parse(files['人员信息.json']).employees.length,2);
});

test('empty scope yields valid header-only files; unsupported formats and invalid attachments fail explicitly',()=>{
  const input=payload('leader');input.employees=[];
  for(const format of ['csv','tsv','json','xml','txt','html','docx','zip']) assert.doesNotThrow(()=>Export.makeFile(format,input));
  assert.throws(()=>Export.makeFile('exe',input),/不支持/);assert.throws(()=>Export.makeFile('pdf',input),/不支持/);
  const broken=payload();broken.employees[0].resumeData='data:text/plain;base64,broken!';assert.throws(()=>Export.makeFile('zip',broken),/附件/);
  broken.employees[0].resumeData='';assert.throws(()=>Export.makeFile('zip',broken),/缺少附件内容/);
  const outside=payload('leader');outside.employees[0].building='楼栋B';assert.throws(()=>Export.makeFile('json',outside),/超出/);
});

test('large spreadsheet cells cannot silently truncate complete personnel information',()=>{
  const input=payload();input.employees[0].aiProfile='长'.repeat(32768);
  const XLSX=require('../js/xlsx.full.min.js');
  assert.throws(()=>Export.makeFile('xlsx',input,XLSX),/32767/);
  assert.equal(JSON.parse(Export.makeFile('json',input).content).employees[0].aiProfile.length,32768);
});

function environment(role='admin') {
  const state={toasts:[],downloads:[],requests:[],flushes:0,closed:0,modals:[]};
  const user={username:'test',role,employeeId:1,buildings:role==='leader'?['楼栋A']:[]};
  const button={disabled:false,textContent:'导出'},select={value:'json'},overlay={classList:{contains:()=>true}};
  const elements={personnelExportSubmit:button,personnelExportFormat:select,modalOverlay:overlay};
  const context=vm.createContext({console,TextEncoder,Uint8Array,Uint32Array,DataView,Set,Blob,setTimeout,
    Auth:{currentUser:()=>user},
    Store:{flushServerSync:async()=>{state.flushes++;}},
    App:{currentPage:'employees',toast:(...args)=>state.toasts.push(args),openModal:(...args)=>state.modals.push(args),closeModal:()=>{state.closed++;}},
    document:{getElementById:id=>elements[id]},
    fetch:async(url,options)=>{state.requests.push({url,options});return {ok:true,status:200,json:async()=>payload(role)};}
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/personnel-export.js'),'utf8'),context);
  const api=context.PersonnelExport,nativeDownload=api._download;api._download=file=>state.downloads.push(file);
  return {context,api,state,user,button,select,elements,nativeDownload};
}

test('export uses fresh authorized server rows after successful save, never cached Store records',async()=>{
  const f=environment('leader');f.context.Store.getEmployees=()=>{throw Error('must not read cached personnel');};
  await f.api.run();assert.equal(f.state.flushes,1);assert.equal(f.state.requests.length,1);
  assert.equal(f.state.requests[0].url,'/api/employees/export');
  assert.equal(f.state.requests[0].options.credentials,'same-origin');assert.equal(f.state.requests[0].options.cache,'no-store');
  assert.equal(f.state.downloads.length,1);assert.equal(JSON.parse(f.state.downloads[0].content).employees.length,1);
  assert.equal(f.button.disabled,false);assert.equal(f.state.closed,1);
});

test('ordinary accounts cannot open export modal or invoke export; manager modal explains full authorized scope',async()=>{
  const f=environment('user');f.api.showModal();await f.api.run();
  assert.equal(f.state.requests.length,0);assert.equal(f.state.modals.length,0);assert.equal(f.state.downloads.length,0);
  const leader=environment('leader');leader.api.showModal();assert.match(leader.state.modals[0][1],/楼栋A/);assert.match(leader.state.modals[0][1],/不受列表搜索/);
  assert.equal((leader.state.modals[0][1].match(/<option /g)||[]).length,12);
});

test('failed save, 401/403, invalid JSON, or changed server scope never produce files',async()=>{
  const save=environment();save.context.Store.flushServerSync=async()=>{throw Error('保存失败');};await save.api.run();assert.equal(save.state.requests.length,0);assert.equal(save.state.downloads.length,0);assert.match(save.state.toasts[0][0],/保存失败/);
  for(const status of [401,403]){const f=environment();f.context.fetch=async()=>({ok:false,status,json:async()=>({ok:false})});await f.api.run();assert.equal(f.state.downloads.length,0);assert.equal(f.button.disabled,false);}
  const invalid=environment();invalid.context.fetch=async()=>({ok:true,status:200,json:async()=>{throw Error('bad');}});await invalid.api.run();assert.equal(invalid.state.downloads.length,0);
  const changed=environment('leader');changed.context.fetch=async()=>({ok:true,status:200,json:async()=>({...payload('leader'),scope:{role:'leader',buildings:['楼栋B']},employees:[]})});await changed.api.run();assert.equal(changed.state.downloads.length,0);assert.match(changed.state.toasts[0][0],/权限已变化/);
});

test('duplicate clicks are suppressed and late results after logout, navigation, or modal replacement are dropped',async()=>{
  for(const reason of ['logout','navigation','modal','role','building']) {
    const f=environment('leader');let release;
    f.context.fetch=async()=>new Promise(done=>{release=done;});
    const first=f.api.run();await new Promise(done=>setImmediate(done));assert.equal(f.button.disabled,true);
    await f.api.run();
    if(reason==='logout') f.context.Auth.currentUser=()=>null;
    if(reason==='navigation') f.context.App.currentPage='profile';
    if(reason==='modal') f.elements.personnelExportSubmit={};
    if(reason==='role') f.user.role='user';
    if(reason==='building') f.user.buildings=['楼栋B'];
    release({ok:true,status:200,json:async()=>payload('leader')});await first;
    assert.equal(f.state.downloads.length,0,reason);assert.equal(f.api._busy,false);
  }
});

test('PDF opens a preview synchronously before waiting, and closes it on request failure',async()=>{
  const f=environment();f.select.value='pdf';let opened=false,closed=false;
  const popup={closed:false,opener:{},document:{title:'',body:{textContent:''}},close(){closed=true;this.closed=true;}};
  f.context.window={open:()=>{opened=true;return popup;}};
  f.context.Store.flushServerSync=async()=>{assert.equal(opened,true);throw Error('保存失败');};
  await f.api.run();assert.equal(closed,true);assert.equal(popup.opener,null);assert.equal(f.state.downloads.length,0);
});

test('PDF preview is a real printable HTML report, with escaped personnel and no raw attachment payload',async()=>{
  const f=environment();f.select.value='pdf';const printed=[];let content='';const printButton={};
  const popup={closed:false,opener:{},focus(){},print(){printed.push('print');},document:{title:'',body:{textContent:''},fonts:{ready:Promise.resolve()},open(){},write(html){content=html;},close(){},getElementById:()=>printButton}};
  f.context.window={open:()=>popup};
  f.context.fetch=async()=>({ok:true,status:200,json:async()=>{const p=payload();p.employees[0].name='<img src=x onerror=alert(1)>';return p;}});
  await f.api.run();await new Promise(done=>setImmediate(done));
  assert.equal(popup.opener,null);assert.match(content,/打印 \/ 另存为 PDF/);assert.match(content,/&lt;img/);assert.doesNotMatch(content,/<img|resumeData|JVBERi0x/);
  assert.equal(typeof printButton.onclick,'function');assert.equal(printed.length,1);assert.equal(f.state.downloads.length,0);
  const blocked=environment();blocked.select.value='pdf';blocked.context.window={open:()=>null};await blocked.api.run();assert.equal(blocked.state.flushes,0);assert.match(blocked.state.toasts[0][0],/阻止了打印窗口/);
});

test('download uses a Blob, removes its link and delays object URL cleanup',()=>{
  const f=environment(),calls=[],link={click(){calls.push('click');},remove(){calls.push('remove');}};
  f.api._download=f.nativeDownload;
  let cleanup;f.context.Blob=class{constructor(content,options){assert.equal(content[0],'text');assert.equal(options.type,'text/plain');}};
  f.context.URL={createObjectURL:()=>{calls.push('url');return 'blob:test';},revokeObjectURL:url=>{assert.equal(url,'blob:test');calls.push('revoke');}};
  f.context.document.createElement=()=>link;f.context.document.body={appendChild:()=>calls.push('append')};
  f.context.setTimeout=(fn,delay)=>{assert.equal(delay,30000);cleanup=fn;};
  vm.runInContext('PersonnelExport._download({content:"text",mime:"text/plain",filename:"人员.txt"})',f.context);
  assert.deepEqual(calls,['url','append','click','remove']);assert.equal(link.download,'人员.txt');cleanup();assert.deepEqual(calls,['url','append','click','remove','revoke']);
});

test('personnel page renders export control only through the existing manager guard and loads its script',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../js/employees.js'),'utf8');
  assert.match(source,/if \(!Auth\.isAdmin\(\) && !Auth\.isLeader\(\)\) \{ App\.navigate\('profile'\); return; \}/);
  assert.match(source,/PersonnelExport\.showModal\(\).*导出人员/);
  const index=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
  assert.ok(index.indexOf('js/personnel-export.js')<index.indexOf('App.init()'));
});
