/** Personnel exports use only a fresh, server-authorized payload. No runtime dependencies. */
(function(root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PersonnelExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';
  var FORMATS = [
    ['xlsx', 'Excel 工作簿（.xlsx）'], ['xls', 'Excel 97–2003（.xls）'],
    ['ods', 'OpenDocument 表格（.ods）'], ['csv', 'CSV 表格（.csv）'],
    ['tsv', 'TSV 制表符表格（.tsv）'], ['json', 'JSON 完整档案（含附件数据）'],
    ['xml', 'XML 人员信息（.xml）'], ['txt', '纯文本（.txt）'],
    ['html', 'HTML 人员报告（.html）'], ['docx', 'Word 文档（.docx）'],
    ['pdf', 'PDF（打印 / 另存为 PDF）'], ['zip', '完整档案 ZIP（含附件原文件）']
  ];
  var KEYS = ['employeeNo','name','gender','position','company','personAttribute','workAttribute','department','status','region','room','building','phone','email','joinDate','leaveDate','aiProfile','resumeName','credentialName','_resumeText'];
  var MAX_ZIP_BYTES = 128 * 1024 * 1024;
  var CRC_TABLE;
  function string(value) { return value == null ? '' : String(value); }
  function xml(value) {
    return Array.from(string(value)).filter(function(c) {
      var n = c.codePointAt(0);
      return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xD7FF) || (n >= 0xE000 && n <= 0xFFFD) || (n >= 0x10000 && n <= 0x10FFFF);
    }).join('').replace(/[&<>"']/g, function(c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]; });
  }
  function textBytes(text) { return new TextEncoder().encode(text); }
  function normalize(payload) {
    if (!payload || !Array.isArray(payload.fields) || !Array.isArray(payload.employees) || !payload.scope || !['admin','leader'].includes(payload.scope.role)) throw new Error('人员导出数据格式无效，请重新登录后重试');
    var seen = new Set();
    var fields = payload.fields.map(function(f) {
      if (!f || !KEYS.includes(f.key) || seen.has(f.key) || typeof f.label !== 'string') throw new Error('人员导出字段格式无效');
      seen.add(f.key); return {key:f.key,label:f.label};
    });
    if (!fields.length) throw new Error('人员导出字段为空');
    var scope = {role:payload.scope.role,buildings:Array.isArray(payload.scope.buildings) ? payload.scope.buildings.filter(function(b) { return typeof b === 'string' && b.trim(); }) : []};
    var ids = new Set();
    var employees = payload.employees.map(function(employee) {
      if (!employee || !Number.isSafeInteger(employee.id) || employee.id <= 0 || ids.has(employee.id)) throw new Error('人员导出编号无效或重复');
      ids.add(employee.id);
      if (scope.role === 'leader' && (!employee.building || !scope.buildings.includes(employee.building))) throw new Error('导出数据超出负责楼栋，请重新登录后重试');
      var row = {id:employee.id};
      KEYS.concat(['resumeData','credentialData']).forEach(function(k) { row[k] = typeof employee[k] === 'string' ? employee[k] : ''; });
      return row;
    });
    return {generatedAt:string(payload.generatedAt),scope:scope,fields:fields,employees:employees};
  }
  function scopeText(payload) { return payload.scope.role === 'admin' ? '全部人员' : '负责楼栋：' + (payload.scope.buildings.join('、') || '未分配楼栋'); }
  function rows(payload) { return [payload.fields.map(function(f) { return f.label; })].concat(payload.employees.map(function(e) { return payload.fields.map(function(f) { return e[f.key]; }); })); }
  function safeCell(value) {
    var result = string(value);
    // Protect Excel-compatible text imports, including whitespace/control-prefix bypasses.
    return /^[\s\uFEFF]*[=+\-@]/.test(result) || /^[\s\uFEFF]*[\t\r\n]/.test(result) ? "'" + result : result;
  }
  function delimited(payload, delimiter) {
    return '\uFEFF' + rows(payload).map(function(row) { return row.map(function(value) { return '"' + safeCell(value).replace(/"/g, '""') + '"'; }).join(delimiter); }).join('\r\n') + '\r\n';
  }
  function report(payload) {
    var head = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人员信息</title><style>body{font:14px/1.7 "Microsoft YaHei",sans-serif;color:#172c31;margin:28px}h1{font-size:24px}article{break-inside:avoid-page;margin:24px 0}h2{font-size:18px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #ccd7db;padding:7px 10px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{width:145px;background:#f0f5f5}p{color:#52676b}.toolbar{padding:12px;border:1px solid #b8c9ce;border-radius:8px;margin-bottom:20px}.toolbar button{padding:9px 20px;font-size:15px;cursor:pointer}@page{size:A4;margin:16mm}@media print{body{margin:0;font-size:10pt}.toolbar{display:none}article{break-inside:auto;break-before:page}article:first-of-type{break-before:auto}tr{break-inside:avoid}h2{break-after:avoid}}</style></head><body>';
    return head + '<h1>人员信息</h1><p>' + xml(scopeText(payload)) + ' · 共 ' + payload.employees.length + ' 人<br>导出时间：' + xml(payload.generatedAt) + '</p>' +
      payload.employees.map(function(e) { return '<article><h2>' + xml(e.name || '姓名未填写') + ' · 工号 ' + xml(e.employeeNo || '未填写') + '</h2><table><tbody>' + payload.fields.map(function(f) { return '<tr><th scope="row">' + xml(f.label) + '</th><td>' + xml(e[f.key]) + '</td></tr>'; }).join('') + '</tbody></table></article>'; }).join('') +
      (payload.employees.length ? '' : '<p>当前范围暂无人员。</p>') + '</body></html>';
  }
  function crc32(bytes) {
    if (!CRC_TABLE) { CRC_TABLE = new Uint32Array(256); for (var n=0;n<256;n++) { var c=n; for(var k=0;k<8;k++) c=c&1 ? 0xEDB88320^(c>>>1) : c>>>1; CRC_TABLE[n]=c>>>0; } }
    var crc=0xFFFFFFFF; for(var i=0;i<bytes.length;i++) crc=CRC_TABLE[(crc^bytes[i])&255]^(crc>>>8); return (crc^0xFFFFFFFF)>>>0;
  }
  function zip(files) {
    if (files.length > 65535) throw new Error('ZIP 文件数量超过格式限制，请分批导出');
    var entries=[], names=new Set(), size=22;
    files.forEach(function(f) {
      if (!f.name || /(?:^|\/)\.\.(?:\/|$)|^\/|\\|\0/.test(f.name) || names.has(f.name)) throw new Error('附件打包路径无效或重复');
      names.add(f.name);
      var name=textBytes(f.name), data=typeof f.data==='string'?textBytes(f.data):new Uint8Array(f.data);
      if(name.length>65535) throw new Error('附件文件名过长');
      size+=76+name.length*2+data.length;
      if(size>MAX_ZIP_BYTES) throw new Error('ZIP 内容超过128MB，无法在浏览器内完整打包，请分批整理附件后重试');
      entries.push({name:name,data:data,crc:crc32(data)});
    });
    var output=new Uint8Array(size), view=new DataView(output.buffer), offset=0, central=[];
    function u16(n){view.setUint16(offset,n,true);offset+=2;} function u32(n){view.setUint32(offset,n>>>0,true);offset+=4;}
    function put(data){output.set(data,offset);offset+=data.length;}
    entries.forEach(function(e) {
      var start=offset;u32(0x04034b50);u16(20);u16(0x800);u16(0);u16(0);u16(33);u32(e.crc);u32(e.data.length);u32(e.data.length);u16(e.name.length);u16(0);put(e.name);put(e.data);central.push({e:e,start:start});
    });
    var centralStart=offset;
    central.forEach(function(item) {
      var e=item.e;u32(0x02014b50);u16(20);u16(20);u16(0x800);u16(0);u16(0);u16(33);u32(e.crc);u32(e.data.length);u32(e.data.length);u16(e.name.length);u16(0);u16(0);u16(0);u16(0);u32(0);u32(item.start);put(e.name);
    });
    var centralSize=offset-centralStart;u32(0x06054b50);u16(0);u16(0);u16(entries.length);u16(entries.length);u32(centralSize);u32(centralStart);u16(0);
    return output;
  }
  function filename(name, fallback) {
    var clean=string(name).normalize('NFC').replace(/[\\/<>:"|?*\u0000-\u001F\u007F]/g,'_').replace(/[ .]+$/g,'').slice(0,150).replace(/[ .]+$/g,'');
    if(!clean || clean==='.' || clean==='..') clean=fallback;
    if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean='_'+clean;
    return clean;
  }
  function attachmentData(value) {
    var match=/^data:[^,\r\n]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
    if(!match || match[1].length%4!==0 || match[1].length>Math.ceil(MAX_ZIP_BYTES/3)*4) throw new Error('附件数据无效或过大，完整档案未导出；请检查原附件');
    var binary;try { binary=typeof root.atob==='function'?root.atob(match[1]):Buffer.from(match[1],'base64').toString('binary'); } catch(_){throw new Error('附件无法解码，完整档案未导出');}
    var bytes=new Uint8Array(binary.length);for(var i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);return bytes;
  }
  function completeZip(payload) {
    var files=[{name:'人员信息.json',data:JSON.stringify(payload,null,2)},{name:'人员信息.csv',data:delimited(payload,',')}], attachments=[];
    payload.employees.forEach(function(e) {
      [['resumeData','resumeName','简历'],['credentialData','credentialName','证件']].forEach(function(pair) {
        if(!e[pair[0]]) { if(e[pair[1]]) throw new Error('人员存在附件名称但缺少附件内容，完整档案未导出；请检查原附件'); return; }
        var path='附件/人员-'+e.id+'/'+pair[2]+'/'+filename(e[pair[1]],pair[2]+'.bin');
        files.push({name:path,data:attachmentData(e[pair[0]])});attachments.push({employeeId:e.id,field:pair[0],originalName:e[pair[1]],path:path});
      });
    });
    files.push({name:'附件清单.json',data:JSON.stringify({generatedAt:payload.generatedAt,scope:payload.scope,attachments:attachments},null,2)});
    return zip(files);
  }
  function docx(payload) {
    function paragraph(text,style) { return '<w:p>'+(style?'<w:pPr><w:pStyle w:val="'+style+'"/></w:pPr>':'')+string(text).split(/\r?\n/).map(function(line,i){return (i?'<w:r><w:br/></w:r>':'')+'<w:r><w:t xml:space="preserve">'+xml(line)+'</w:t></w:r>';}).join('')+'</w:p>'; }
    var body=paragraph('人员信息','Title')+paragraph(scopeText(payload)+' · 共'+payload.employees.length+'人')+paragraph('导出时间：'+payload.generatedAt);
    payload.employees.forEach(function(e,i) {
      if(i) body+='<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      body+=paragraph((e.name||'姓名未填写')+' · 工号 '+(e.employeeNo||'未填写'),'Heading1');
      body+='<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>'+['top','left','bottom','right','insideH','insideV'].map(function(s){return '<w:'+s+' w:val="single" w:sz="4" w:color="CBD5E1"/>';}).join('')+'</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2200"/><w:gridCol w:w="7000"/></w:tblGrid>';
      body+=payload.fields.map(function(f){return '<w:tr><w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/></w:tcPr>'+paragraph(f.label)+'</w:tc><w:tc><w:tcPr><w:tcW w:w="7000" w:type="dxa"/></w:tcPr>'+paragraph(e[f.key])+'</w:tc></w:tr>';}).join('')+'</w:tbl>';
    });
    if(!payload.employees.length) body+=paragraph('当前范围暂无人员。');
    var document='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900"/></w:sectPr></w:body></w:document>';
    return zip([
      {name:'[Content_Types].xml',data:'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'},
      {name:'_rels/.rels',data:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'},
      {name:'word/document.xml',data:document},
      {name:'word/styles.xml',data:'<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'},
      {name:'word/_rels/document.xml.rels',data:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'}
    ]);
  }
  function makeFile(format,input,spreadsheet) {
    if(!FORMATS.some(function(f){return f[0]===format;}) || format==='pdf') throw new Error('不支持此导出格式');
    var payload=normalize(input), content, mime='text/plain;charset=utf-8';
    if(['xlsx','xls','ods'].includes(format)) {
      var x=spreadsheet||root.XLSX;if(!x||!x.utils||typeof x.write!=='function') throw new Error('表格组件未加载，请刷新页面后重试或选择其他格式');
      var data=rows(payload), limit=format==='xls'?65536:1048576;
      if(data.length>limit) throw new Error('人员数量超过当前表格格式行数限制，请选择其他格式');
      if(data.some(function(row){return row.some(function(v){return v.length>32767;});})) throw new Error('人员文本超过表格单元格32767字符限制，请选择 JSON 或完整档案 ZIP');
      var sheet=x.utils.aoa_to_sheet(data.map(function(row){return row.map(function(v){return {t:'s',v:string(v)};});}));
      sheet['!cols']=payload.fields.map(function(f){return {wch:f.key==='aiProfile'||f.key==='_resumeText'?50:20};});
      var workbook=x.utils.book_new();x.utils.book_append_sheet(workbook,sheet,'人员信息');
      content=x.write(workbook,{type:'array',bookType:format});
      mime=({xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',ods:'application/vnd.oasis.opendocument.spreadsheet'})[format];
    } else if(format==='csv'||format==='tsv') {content=delimited(payload,format==='csv'?',':'\t');mime=format==='csv'?'text/csv;charset=utf-8':'text/tab-separated-values;charset=utf-8';}
    else if(format==='json'){content=JSON.stringify(payload,null,2);mime='application/json;charset=utf-8';}
    else if(format==='xml'){content='<?xml version="1.0" encoding="UTF-8"?><personnel generatedAt="'+xml(payload.generatedAt)+'" role="'+xml(payload.scope.role)+'"><scope>'+payload.scope.buildings.map(function(b){return '<building>'+xml(b)+'</building>';}).join('')+'</scope>'+payload.employees.map(function(e){return '<employee id="'+e.id+'">'+payload.fields.map(function(f){return '<'+f.key+'>'+xml(e[f.key])+'</'+f.key+'>';}).join('')+'</employee>';}).join('')+'</personnel>';mime='application/xml;charset=utf-8';}
    else if(format==='txt') content='人员信息\r\n'+scopeText(payload)+'\r\n导出时间：'+payload.generatedAt+'\r\n共'+payload.employees.length+'人\r\n\r\n'+payload.employees.map(function(e){return payload.fields.map(function(f){return f.label+'：'+e[f.key];}).join('\r\n');}).join('\r\n\r\n');
    else if(format==='html'){content=report(payload);mime='text/html;charset=utf-8';}
    else if(format==='docx'){content=docx(payload);mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';}
    else if(format==='zip'){content=completeZip(payload);mime='application/zip';}
    var date=/^\d{4}-\d{2}-\d{2}/.exec(payload.generatedAt);
    return {filename:'人员信息-'+(payload.scope.role==='admin'?'全部':'负责楼栋')+'-'+(date?date[0]:'导出')+'.'+format,mime:mime,content:content,count:payload.employees.length};
  }
  function actor() { return typeof Auth!=='undefined'&&Auth.currentUser?Auth.currentUser():null; }
  function canExport() { var u=actor();return !!u&&['admin','leader'].includes(u.role); }
  function identity(user) { return user?JSON.stringify([user.username,user.employeeId,user.role,(user.buildings||[]).slice().sort()]):''; }
  var api={formats:FORMATS,makeFile:makeFile,normalize:normalize,report:report,_sequence:0,_busy:false,
    showModal:function() {
      if(!canExport()){App.toast('仅管理员和楼长可导出人员信息','warning');return;}
      this._sequence++;
      var user=actor(), scope=user.role==='admin'?'全部人员':'负责楼栋：'+((user.buildings||[]).join('、')||'未分配楼栋');
      App.openModal('导出人员信息',
        '<p>导出范围：<strong>'+xml(scope)+'</strong></p><p>导出当前授权范围的全部人员，不受列表搜索、筛选影响。</p><div class="form-group"><label for="personnelExportFormat">文件格式</label><select class="form-control" id="personnelExportFormat">'+FORMATS.map(function(f){return '<option value="'+f[0]+'">'+xml(f[1])+'</option>';}).join('')+'</select></div><p style="font-size:12px;color:var(--text-light);line-height:1.8;">表格和报告包含全部人员表单文字字段及附件名称。需要附件原文件请选择完整档案 ZIP，JSON 也保留附件数据。CSV / TSV 对公式危险前缀加单引号；保留工号前导零建议使用 Excel 或 JSON。PDF 将打开打印预览，在打印目标选择“另存为 PDF”。</p>',
        '<button class="btn btn-primary" id="personnelExportSubmit" onclick="PersonnelExport.run()">导出</button><button class="btn btn-outline" onclick="App.closeModal()">取消</button>');
    },
    _download:function(file) {
      var blob=new Blob([file.content],{type:file.mime}), url=URL.createObjectURL(blob), link=document.createElement('a');
      link.href=url;link.download=file.filename;document.body.appendChild(link);
      try{link.click();}finally{link.remove();setTimeout(function(){URL.revokeObjectURL(url);},30000);}
    },
    _print:function(popup,payload) {
      if(!popup||popup.closed) throw new Error('打印窗口已关闭，请重新导出');
      var content=report(payload).replace('<body>','<body><div class="toolbar"><p>在打印窗口选择“另存为 PDF”即可保存文件；关闭此页面结束预览。</p><button type="button" id="printPersonnel">打印 / 另存为 PDF</button></div>');
      popup.document.open();popup.document.write(content);popup.document.close();
      popup.document.getElementById('printPersonnel').onclick=function(){popup.focus();popup.print();};
      popup.focus();
      var ready=popup.document.fonts&&popup.document.fonts.ready?popup.document.fonts.ready:Promise.resolve();
      ready.then(function(){if(!popup.closed) popup.print();}).catch(function(){/* The visible button remains available. */});
    },
    run:async function() {
      if(!canExport()){App.toast('仅管理员和楼长可导出人员信息','warning');return;}
      if(this._busy) return;
      var select=document.getElementById('personnelExportFormat'), button=document.getElementById('personnelExportSubmit');
      if(!select||!button||App.currentPage!=='employees') return;
      var format=select.value;if(!FORMATS.some(function(f){return f[0]===format;})){App.toast('请选择支持的导出格式','error');return;}
      var self=this, startUser=actor(), actorKey=identity(startUser), sequence=++this._sequence, popup=null;
      function current(){var overlay=document.getElementById('modalOverlay');return sequence===self._sequence&&identity(actor())===actorKey&&canExport()&&App.currentPage==='employees'&&document.getElementById('personnelExportSubmit')===button&&(!overlay||overlay.classList.contains('show'));}
      this._busy=true;button.disabled=true;button.textContent='正在准备…';
      try {
        if(format==='pdf') {popup=window.open('about:blank','_blank');if(!popup) throw new Error('浏览器阻止了打印窗口，请允许此站点弹出窗口后重试');popup.opener=null;popup.document.title='正在准备人员打印预览';popup.document.body.textContent='正在读取当前授权人员，请稍候…';}
        await Store.flushServerSync();if(!current()) return;
        var response;try{response=await fetch('/api/employees/export',{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});}catch(_){throw new Error('无法连接导出服务，请检查网络后重试');}
        if(!current()) return;
        var payload;try{payload=await response.json();}catch(_){throw new Error('导出服务返回异常，请刷新页面后重试');}
        if(!current()) return;
        if(!response.ok||!payload||payload.ok!==true) throw new Error((payload&&payload.message)||(response.status===401?'登录已失效，请重新登录':response.status===403?'当前账号没有导出权限':'人员信息读取失败'));
        payload=normalize(payload);
        if(payload.scope.role!==startUser.role||JSON.stringify(payload.scope.buildings.slice().sort())!==JSON.stringify((startUser.role==='leader'?startUser.buildings||[]:[]).slice().sort())) throw new Error('账号权限已变化，请重新登录后导出');
        if(!current()) return;
        if(format==='pdf') {this._print(popup,payload);popup=null;App.toast('已打开打印预览，请选择另存为 PDF','success');}
        else {var file=makeFile(format,payload);if(!current()) return;this._download(file);App.toast('已导出 '+file.count+' 名人员','success');}
        App.closeModal();
      } catch(error) {if(current()) App.toast(error.message||'导出失败，请稍后重试','error');}
      finally {if(popup&&!popup.closed)popup.close();this._busy=false;if(document.getElementById('personnelExportSubmit')===button){button.disabled=false;button.textContent='导出';}}
    }
  };
  return api;
});
