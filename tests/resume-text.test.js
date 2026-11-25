'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {deflateRawSync, inflateRawSync} = require('node:zlib');
const {ReadableStream, WritableStream, TransformStream} = require('node:stream/web');
let nativeRaw = false;
try { new globalThis.DecompressionStream('deflate-raw'); nativeRaw = true; } catch (_) {}
class TestDecompressionStream {
  constructor(format) {
    assert.equal(format, 'deflate-raw'); const chunks = [];
    return new TransformStream({transform(chunk) { chunks.push(Buffer.from(chunk)); }, flush(controller) { controller.enqueue(new Uint8Array(inflateRawSync(Buffer.concat(chunks)))); }});
  }
}

// All ZIPs, XML and personnel records below are synthetic, generated in memory.
const XML = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>示例姓名与工作经历</w:t></w:r></w:p></w:body></w:document>';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries = [{}]) {
  const locals = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name || 'word/document.xml');
    const content = Buffer.from(entry.xml === undefined ? XML : entry.xml);
    const method = entry.method === undefined ? 8 : entry.method;
    const compressed = method === 0 ? content : deflateRawSync(content);
    const flags = entry.flags || 0, checksum = entry.crc === undefined ? crc32(content) : entry.crc;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!(flags & 8)) {
      local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22);
    }
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const descriptor = flags & 8 ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(content.length, 12);
    }
    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(entry.compressedSize === undefined ? compressed.length : entry.compressedSize, 20);
    directory.writeUInt32LE(entry.size === undefined ? content.length : entry.size, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(entry.offset === undefined ? offset : entry.offset, 42); name.copy(directory, 46);
    locals.push(local, compressed, descriptor); central.push(directory); offset += local.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function arrayBuffer(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
function environment(overrides = {}) {
  const state = {toasts: [], reads: [], requests: [], saves: [], flushes: 0, closed: 0};
  let user = {username: 'synthetic-admin', role: 'admin'};
  let employees = [{id: 1, name: '合成人员', building: '演示楼栋'}];
  const elements = {empAiProfile: {value: '', isConnected: true}, empId: {value: '1'}, modalOverlay: {classList: {contains: () => true}}};
  class FileReader {
    readAsArrayBuffer(file) { state.reads.push(['array', file.name]); this.deliver(file, arrayBuffer(file.bytes || Buffer.from(''))); }
    readAsText(file) { state.reads.push(['text', file.name]); this.deliver(file, (file.bytes || Buffer.from('')).toString()); }
    readAsDataURL(file) { state.reads.push(['data', file.name]); this.deliver(file, file.data || 'data:application/octet-stream;base64,UEsDBA=='); }
    deliver(file, value) {
      queueMicrotask(() => {
        if (file.error) { this.error = new Error('synthetic read failure'); if (this.onerror) this.onerror({target: this}); }
        else { this.result = value; if (this.onload) this.onload({target: this}); }
      });
    }
  }
  const context = vm.createContext({console, TextDecoder, TextEncoder, Uint8Array, Uint32Array, ArrayBuffer, DataView,
    Blob, Response, ReadableStream, TransformStream, AbortController, Node: {ELEMENT_NODE: 1, TEXT_NODE: 3, CDATA_SECTION_NODE: 4}, DecompressionStream: nativeRaw ? globalThis.DecompressionStream : TestDecompressionStream, FileReader, setTimeout, clearTimeout,
    Auth: {currentUser: () => user, isAdmin: () => !!user && user.role === 'admin', canManageEmployee: () => !!user, canAccessEmployee: () => !!user},
    Store: {getEmployees: () => structuredClone(employees), set: (key, value) => { state.saves.push({key, value: structuredClone(value)}); employees = structuredClone(value); }, flushServerSync: async () => { state.flushes++; }},
    App: {currentPage: 'employees', toast: (...args) => state.toasts.push(args), closeModal: () => { state.closed++; }, openModal() {}},
    document: {getElementById: id => elements[id] || null, contains: node => Object.values(elements).includes(node)},
    AI: {getConfig: () => ({endpoint: '/api/ai/chat', model: 'synthetic-model'})},
    window: {location: {protocol: 'https:', hostname: 'synthetic.invalid'}},
    fetch: async (url, options) => { state.requests.push({url, options}); return {ok: true, json: async () => ({choices: [{message: {content: '合成AI简介'}}]})}; },
    ...overrides});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/employees.js'), 'utf8') + '\nthis.Employees = Employees;', context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/employee-profile.js'), 'utf8') + '\nthis.EmpProfile = EmpProfile;', context);
  return {context, api: context.Employees, profile: context.EmpProfile, state, elements, logout() { user = null; }, rows: () => employees};
}
function textNode(text) { return {nodeType: 3, textContent: text, nodeValue: text, data: text, childNodes: []}; }
function element(name, children = [], namespaceURI = WORD_NS) {
  const node = {nodeType: 1, localName: name, nodeName: 'w:' + name, namespaceURI, childNodes: children, firstChild: children[0] || null,
    get textContent() { return children.map(child => child.textContent).join(''); },
    getElementsByTagName(name) { return descendants(this).filter(node => name === '*' || node.nodeName === name || node.localName === name); },
    getElementsByTagNameNS(ns, name) { return descendants(this).filter(node => (ns === '*' || node.namespaceURI === ns) && (name === '*' || node.localName === name)); },
    querySelector(name) { return this.getElementsByTagName(name)[0] || null; }};
  children.forEach((child, index) => { child.parentNode = node; child.nextSibling = children[index + 1] || null; }); return node;
}
function descendants(node) { return node.childNodes.flatMap(child => child.nodeType === 1 ? [child, ...descendants(child)] : []); }
function xmlDocument(root) {
  const doc = element('document', [root]); doc.nodeType = 9; doc.documentElement = root; doc.doctype = null;
  return doc;
}

test('native DEFLATE supports central-directory sizes when bit 3 leaves local header sizes zero', {skip: !nativeRaw}, async () => {
  const f = environment(); const observed = []; f.api._docxXmlText = xml => { observed.push(xml); return '解压后的简历正文'; };
  const result = await f.api._extractDocx(arrayBuffer(zip([{name: '[Content_Types].xml', xml: '<Types/>'}, {flags: 8}])));
  assert.equal(result, '解压后的简历正文'); assert.deepEqual(observed, [XML]);
  assert.equal(typeof new Blob(['data']).stream().arrayBuffer, 'undefined', 'ReadableStream has no arrayBuffer shortcut');
});

test('stored DOCX works without DecompressionStream; compressed DOCX returns an explicit callback error once', async () => {
  const f = environment({DecompressionStream: undefined}); f.api._docxXmlText = xml => xml;
  assert.equal(await f.api._extractDocx(arrayBuffer(zip([{method: 0}]))), XML);
  const calls = []; const result = await f.api._extractDocx(arrayBuffer(zip()), (...args) => calls.push(args));
  assert.equal(result, ''); assert.equal(calls.length, 1); assert.equal(calls[0][0], ''); assert.ok(calls[0][1]);
});

test('malformed ZIP metadata cannot feed XML parsing or leave the callback unsettled', async () => {
  const truncated = zip().subarray(0, 45), wrongDirectory = zip(); wrongDirectory.writeUInt32LE(0xfffffff0, wrongDirectory.length - 6);
  const longName = zip(); longName.writeUInt16LE(0xffff, longName.readUInt32LE(longName.length - 6) + 28);
  const longExtra = zip(); longExtra.writeUInt16LE(0xffff, 28);
  const cases = [Buffer.from('not a ZIP'), truncated, wrongDirectory, longName, longExtra, zip([{name: 'word/settings.xml'}]), zip([{}, {}]),
    zip([{flags: 1}]), zip([{method: 99}]), zip([{offset: 0xfffffff0}]), zip([{compressedSize: 0xffffffff}]),
    zip([{size: 0xffffffff}]), zip([{size: 64 * 1024 * 1024}]), zip([{crc: 1}])];
  for (const bytes of cases) {
    const f = environment(); let parsed = false; const calls = []; f.api._docxXmlText = () => { parsed = true; return 'invalid'; };
    assert.equal(await f.api._extractDocx(arrayBuffer(bytes), (...args) => calls.push(args)), '');
    assert.equal(parsed, false); assert.equal(calls.length, 1); assert.ok(calls[0][1]);
  }
});

test('DOCX decompression failures and successful callbacks settle exactly once', async () => {
  const f = environment(); f.api._docxXmlText = () => '简历正文'; const good = [];
  assert.equal(await f.api._extractDocx(arrayBuffer(zip()), (...args) => good.push(args)), '简历正文'); assert.equal(good.length, 1); assert.equal(good[0][0], '简历正文');
  const broken = zip(); const start = 30 + Buffer.byteLength('word/document.xml'); broken.fill(0xff, start, start + 8); const bad = [];
  assert.equal(await f.api._extractDocx(arrayBuffer(broken), (...args) => bad.push(args)), ''); assert.equal(bad.length, 1); assert.ok(bad[0][1]);
});

test('decompression stops and cancels a lying entry before expanded output can exceed safe bounds', async () => {
  let emitted = 0, cancelled = false, parsed = false;
  class OversizeStream {
    constructor() {
      return {writable: new WritableStream(), readable: new ReadableStream({
        pull(controller) { if (++emitted <= 16) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); },
        cancel() { cancelled = true; }
      })};
    }
  }
  const f = environment({DecompressionStream: OversizeStream}); f.api._docxXmlText = () => { parsed = true; return 'invalid'; };
  const calls = []; assert.equal(await f.api._extractDocx(arrayBuffer(zip()), (...args) => calls.push(args)), '');
  assert.equal(calls.length, 1); assert.ok(calls[0][1]); assert.equal(parsed, false); assert.equal(cancelled, true); assert.ok(emitted < 16);
});

test('Word XML traversal preserves text, paragraph boundaries, tabs and breaks while omitting field instructions', () => {
  const root = element('document', [element('body', [
    element('p', [element('r', [element('t', [textNode('姓名 <示例> & 内容')]), element('tab'), element('t', [textNode('岗位')]), element('br'), element('t', [textNode('技能')])]), element('instrText', [textNode('HYPERLINK secret')]), element('del', [element('r', [element('delText', [textNode('已删除')])])])]),
    element('p', [element('r', [element('t', [textNode('工作经历')])]), element('t', [textNode('其他命名空间')], 'urn:unrelated')])
  ])]);
  const f = environment({DOMParser: class {parseFromString(xml, type) { assert.match(type, /^(?:application|text)\/xml$/); return xmlDocument(root); }}});
  const result = f.api._docxXmlText(XML);
  assert.match(result, /姓名 <示例> & 内容/); assert.match(result, /岗位/); assert.match(result, /技能/); assert.match(result, /工作经历/);
  assert.match(result, /内容\t岗位\n技能\n工作经历/); assert.doesNotMatch(result, /HYPERLINK|secret|已删除|其他命名空间|<w:/);
});

test('XML parser errors and document type declarations fail explicitly', () => {
  const f = environment({DOMParser: class {parseFromString() { return xmlDocument(element('parsererror', [textNode('invalid XML')], 'http://www.mozilla.org/newlayout/xml/parsererror.xml')); }}});
  assert.throws(() => f.api._docxXmlText('<bad>'));
  assert.throws(() => f.api._docxXmlText('<!DOCTYPE document [<!ENTITY value SYSTEM "file:///synthetic">]><document/>'));
});

test('shared reader accepts TXT and DOCX with exact suffix matching and never treats other attachments as text', async () => {
  const f = environment(); f.api._docxXmlText = xml => { assert.equal(xml, XML); return 'DOCX 简历正文'; };
  assert.match(await f.api._readResumeText({name: '示例.TXT', bytes: Buffer.from('示例姓名与工作经历'), size: 30}), /示例姓名与工作经历/);
  assert.equal(await f.api._readResumeText({name: '示例.DOCX', bytes: zip([{flags: 8}]), size: 300}), 'DOCX 简历正文');
  const readCount = f.state.reads.length;
  for (const name of ['简历.pdf', '简历.doc', '简历.png', '简历.xls', '简历.docx.pdf', '简历.txt.exe']) {
    await assert.rejects(f.api._readResumeText({name, bytes: Buffer.from('binary'), size: 6}), /手动|粘贴|不支持|仅支持|读取/);
  }
  assert.equal(f.state.reads.length, readCount);
  await assert.rejects(f.api._readResumeText({name: '损坏.txt', error: true, size: 20}), /读取/);
});

test('a late DataURL read from an earlier selection cannot replace the current attachment or start extraction', () => {
  const readers = [], extracted = [];
  const f = environment({FileReader: class {readAsDataURL() { readers.push(this); }}});
  const input = {files: [{name: '旧简历.docx', size: 100}], value: 'old', isConnected: true}; f.elements.empResume = input;
  f.api._extractResumeText = file => extracted.push(file.name);
  f.api.pickResume({target: input}); input.files = [{name: '新简历.docx', size: 100}]; f.api.pickResume({target: input});
  readers[1].result = 'data:application/octet-stream;base64,TkVX'; readers[1].onload({target: readers[1]});
  readers[0].result = 'data:application/octet-stream;base64,T0xE'; readers[0].onload({target: readers[0]});
  assert.equal(f.api._pendingResume.name, '新简历.docx'); assert.equal(f.api._pendingResume.data, readers[1].result); assert.deepEqual(extracted, ['新简历.docx']);
});

test('late form extraction after close, replacement or logout cannot trigger AI or overwrite resume text', async () => {
  for (const reason of ['close', 'replace', 'logout']) {
    const f = environment(); let release; const calls = [];
    f.api._readResumeText = () => new Promise(resolve => { release = resolve; });
    f.api.autoGenerateProfile = () => calls.push('AI');
    const pending = f.api._extractResumeText({name: '示例.docx', size: 100});
    if (reason === 'close') f.elements.modalOverlay.classList.contains = () => false;
    if (reason === 'replace') f.elements.empAiProfile = {value: '新表单内容', isConnected: true};
    if (reason === 'logout') f.logout();
    release('已有十个字以上的合成简历正文'); await pending;
    assert.equal(calls.length, 0, reason); assert.notEqual(f.api._resumeText, '已有十个字以上的合成简历正文', reason);
  }
});

test('only the latest selected resume may supply text and invoke form AI', async () => {
  const f = environment(), releases = [], calls = [];
  f.api._readResumeText = () => new Promise(resolve => releases.push(resolve)); f.api.autoGenerateProfile = () => calls.push(f.api._resumeText);
  const first = f.api._extractResumeText({name: '旧简历.docx', size: 100});
  const second = f.api._extractResumeText({name: '新简历.docx', size: 100});
  releases[1]('最新选择且超过十个字的简历正文'); await second;
  releases[0]('旧附件晚返回且超过十个字的正文'); await first;
  assert.deepEqual(calls, ['最新选择且超过十个字的简历正文']); assert.equal(f.api._resumeText, calls[0]);
});

test('failed extraction clears earlier resume text and offers manual entry without AI', async () => {
  const f = environment(); let analyzed = false; f.api._resumeText = '上一份附件留下的旧简历正文';
  f.api._readResumeText = async () => { throw new Error('无法读取，请手动粘贴简历正文'); }; f.api.autoGenerateProfile = () => { analyzed = true; };
  await f.api._extractResumeText({name: '不可读.docx', size: 100});
  assert.equal(f.api._resumeText, ''); assert.equal(analyzed, false); assert.match(f.state.toasts.map(args => args[0]).join('\n'), /手动|粘贴/);
});

test('a short extracted body does not block a later manual paste from reaching form AI', async () => {
  const f = environment(); f.api._readResumeText = async () => '短正文';
  await f.api._extractResumeText({name: '短正文.docx', size: 100});
  assert.equal(f.state.requests.length, 0); assert.equal(f.api._resumeText, '');
  f.elements.empAiProfile.value = '手动粘贴的完整简历正文具有足够长度'; await f.api.autoGenerateProfile();
  assert.equal(f.state.requests.length, 1); assert.match(JSON.parse(f.state.requests[0].options.body).messages[0].content, /手动粘贴的完整简历正文/);
  assert.equal(f.elements.empAiProfile.value, '合成AI简介');
});

test('form AI sends extracted text through the relative server proxy without browser credentials', async () => {
  const f = environment(); f.context.AI.getConfig = () => ({endpoint: '/api/ai/chat', model: 'synthetic-model', apiKey: 'synthetic-never-send-key'});
  f.api._resumeText = '具有十个字以上的解压后简历内容';
  await f.api.autoGenerateProfile(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.requests.length, 1); const request = f.state.requests[0];
  assert.equal(request.url, '/api/ai/chat'); assert.doesNotMatch(JSON.stringify(request.options), /synthetic-never-send-key|Authorization/);
  assert.match(JSON.parse(request.options.body).messages[0].content, /解压后简历内容/); assert.equal(f.elements.empAiProfile.value, '合成AI简介');
});

test('late form AI replies cannot fill a replacement modal', async () => {
  const f = environment(); let release; const original = f.elements.empAiProfile;
  f.context.fetch = () => new Promise(resolve => { release = resolve; }); f.api._resumeText = '具有十个字以上的解压后简历内容';
  const pending = f.api.autoGenerateProfile(); await new Promise(resolve => setImmediate(resolve));
  f.elements.empAiProfile = {value: '新表单已填写内容', isConnected: true};
  release({ok: true, json: async () => ({choices: [{message: {content: '旧表单的AI返回值'}}]})});
  await pending; await new Promise(resolve => setImmediate(resolve));
  assert.equal(original.value, ''); assert.equal(f.elements.empAiProfile.value, '新表单已填写内容');
});

test('profile uploads share extraction, persist the attachment first and pass only extracted text to AI', async () => {
  const f = environment(), input = {files: [{name: '示例.docx', size: 100, bytes: zip()}], isConnected: true};
  f.elements.resumeFileInput = input; const analyzed = []; let finishSave;
  f.context.Store.flushServerSync = () => new Promise(resolve => { f.state.flushes++; finishSave = resolve; });
  f.api._readResumeText = async file => { assert.equal(file, input.files[0]); return '具有十个字以上的合成简历文本'; };
  f.profile._doAutoAnalyze = async (id, text) => { assert.ok(f.state.flushes > 0); analyzed.push({id, text}); };
  const pending = f.profile.uploadResume(1); await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishSave, 'function'); assert.deepEqual(analyzed, []); finishSave();
  await pending; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.rows()[0].resumeName, '示例.docx'); assert.equal(f.rows()[0]._resumeText, '具有十个字以上的合成简历文本');
  assert.deepEqual(analyzed, [{id: 1, text: '具有十个字以上的合成简历文本'}]);
  assert.deepEqual(f.state.reads.map(read => read[0]), ['data']); assert.equal(f.state.requests.length, 0);
});

test('profile AI waits for persistence and closes only the modal that initiated analysis', async () => {
  for (const replace of [false, true]) {
    const f = environment(); let finishSave; f.elements.resumeFileInput = {id: 'resumeFileInput', isConnected: true};
    f.context.Store.flushServerSync = () => new Promise(resolve => { f.state.flushes++; finishSave = resolve; });
    const pending = f.profile._doAutoAnalyze(1, '超过十个字的合成简历分析正文'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finishSave, 'function'); assert.equal(f.rows()[0].aiProfile, '合成AI简介'); assert.equal(f.state.closed, 0);
    if (replace) f.elements.resumeFileInput = {id: 'resumeFileInput', isConnected: true};
    finishSave(); await pending;
    assert.equal(f.state.closed, replace ? 0 : 1); assert.equal(f.state.toasts.some(args => /AI简介已生成/.test(args[0])), !replace);
    assert.equal(f.state.reads.length, 0);
  }
});

test('unsupported or corrupt profile attachments stay downloadable and request manual text without AI', async () => {
  for (const name of ['示例.pdf', '损坏.docx']) {
    const f = environment(); f.elements.resumeFileInput = {files: [{name, size: 10}], isConnected: true}; let analyzed = false;
    f.api._readResumeText = async () => { throw new Error('无法读取，请手动粘贴简历正文'); };
    f.profile._doAutoAnalyze = async () => { analyzed = true; };
    await f.profile.uploadResume(1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.rows()[0].resumeName, name); assert.ok(f.rows()[0].resumeData); assert.equal(f.rows()[0]._resumeText, '');
    assert.ok(f.state.flushes > 0); assert.equal(analyzed, false); assert.match(f.state.toasts.map(args => args[0]).join('\n'), /手动|粘贴/);
    assert.deepEqual(f.state.reads.map(read => read[0]), ['data']);
  }
});

test('legacy binary DOCX text caches open manual entry without sending AI or changing the attachment', () => {
  const f = environment(), modals = [], analyzed = [];
  const resumeData = 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==';
  f.context.Store.set('employees', [{id: 1, name: '合成人员', resumeName: '旧缓存.docx', resumeData, _resumeText: 'PK\x03\x04旧版误读的二进制简历缓存'}]);
  f.context.App.openModal = (...args) => modals.push(args); f.profile._doAutoAnalyze = (...args) => analyzed.push(args);
  f.profile.analyzeResume(1);
  assert.deepEqual(analyzed, []); assert.equal(f.state.requests.length, 0); assert.equal(f.state.reads.length, 0);
  assert.equal(modals.length, 1); assert.match(modals[0][1], /粘贴/); assert.match(modals[0][1], /id="resumeText"/);
  assert.equal(f.rows()[0].resumeData, resumeData); assert.equal(f.rows()[0].resumeName, '旧缓存.docx');
});
