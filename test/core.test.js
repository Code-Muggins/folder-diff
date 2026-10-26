// core.js 单元测试：node test/core.test.js（不依赖浏览器，纯逻辑）
const crypto = require('crypto');
const C = require('../core.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n     got : ' + JSON.stringify(got) + '\n     want: ' + JSON.stringify(want)); }
}

console.log('\n[1] SHA-256 已知向量');
eq("sha256('')", new C.Sha256().digest(), crypto.createHash('sha256').update('').digest('hex'));
eq("sha256('abc')", new C.Sha256().update(new TextEncoder().encode('abc')).digest(),
   'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

console.log('\n[2] 分片 / 边界长度（对照 node crypto）');
function refHash(bytes) { return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'); }
function chunked(bytes, size) {
  const sha = new C.Sha256();
  for (let i = 0; i < bytes.length; i += size) sha.update(new Uint8Array(bytes.slice(i, i + size)));
  return sha.digest();
}
const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 4096, 100000];
let ok = true, bad = null;
for (const n of sizes) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const a = chunked(bytes, n === 0 ? 1 : [1, 3, 7, 64, 1024][n % 5]);
  if (a !== refHash(bytes)) { ok = false; bad = { n, a, b: refHash(bytes) }; break; }
}
eq('各种长度 + 各种分片都一致（含 padding 边界）', bad, null);
eq('上述用例全部通过', ok, true);

console.log('\n[3] 流式 hashFile（模拟 File）');
function fakeFile(text) {
  const buf = Buffer.from(text, 'utf8');
  return {
    size: buf.length,
    slice(a, b) { return { arrayBuffer: async () => buf.slice(a, b).buffer.slice(buf.slice(a,b).byteOffset, buf.slice(a,b).byteOffset + buf.slice(a,b).byteLength) }; }
  };
}
(async function () {
  const f = fakeFile('你好, world!'.repeat(5000));
  const h = await C.hashFile(f, 512);
  eq('hashFile 分片读取结果与 node crypto 一致', h,
     crypto.createHash('sha256').update(Buffer.from('你好, world!'.repeat(5000), 'utf8')).digest('hex'));
  eq('空文件哈希', await C.hashFile(fakeFile('')), crypto.createHash('sha256').update('').digest('hex'));

  console.log('\n[4] 忽略规则');
  const rules = C.parseIgnoreRules(C.DEFAULT_IGNORE + '\nbuild/**\n!important.log');
  eq('跳过 node_modules 下任意层级', C.isIgnored('a/node_modules/x/y.js', rules), true);
  eq('匹配带斜杠规则 build/**', C.isIgnored('svc/build/out.o', rules), true);
  eq('普通源码不被忽略', C.isIgnored('src/main/java/A.java', rules), false);
  eq('*.log 被忽略', C.isIgnored('logs/run.log', rules), true);
  eq('!important.log 反选生效', C.isIgnored('src/important.log', rules), false);

  console.log('\n[5] 目录树 & 状态汇总');
  const entries = [
    { relPath: 'dir/sub/a.txt', size: 3, mtime: 1, file: null },
    { relPath: 'dir/b.txt', size: 5, mtime: 1, file: null },
    { relPath: 'top.txt', size: 1, mtime: 1, file: null }
  ];
  const tree = C.buildTree(entries, 'ROOT');
  eq('根节点汇总文件数', tree.files, 3);
  eq('根节点汇总体积', tree.size, 9);
  eq('目录排在文件前', tree.children.map(c => c.dir), [true, false]);
  function find(root, path) {
    let hit = null;
    (function w(n) { if (hit) return; if (n.path === path) { hit = n; return; } if (n.dir) n.children.forEach(w); })(root);
    return hit;
  }
  find(tree, 'dir/sub/a.txt').status = 'onlyA';
  find(tree, 'dir/b.txt').status = 'modified';
  find(tree, 'top.txt').status = 'same';
  eq('含改动 -> 父目录 modified', C.rollupStatus(tree), 'modified');
  eq('含改动的子目录也标为 modified', find(tree, 'dir').status, 'modified');
  find(tree, 'dir/b.txt').status = 'onlyA';
  C.rollupStatus(tree);
  eq('子项全部只在一侧 -> 父目录 onlyA', find(tree, 'dir').status, 'onlyA');
  eq('同级仍有 same 的顶层 -> 不能整体判 onlyA', find(tree, 'dir').status + '/' + find(tree, 'top.txt').status, 'onlyA/same');

  console.log('\n[6] 比对模型');
  const mk = (p, size, tail) => ({ relPath: p, size: size, mtime: 1, file: null, tag: tail });
  const A = [mk('x.txt', 10), mk('same.txt', 5), mk('big.bin', 100), mk('onlyA.txt', 1)];
  const B = [mk('x.txt', 11), mk('same.txt', 5), mk('big.bin', 100), mk('onlyB.txt', 1)];
  const model = C.buildCompareModel(A, B, 50);
  eq('体积不同 -> 直接 modified（不读内容）', model.get('x.txt').status, 'modified');
  eq('体积相同 -> pending（待哈希）', model.get('same.txt').status, 'pending');
  eq('超大且体积相同 -> same 但 unverified', [model.get('big.bin').status, model.get('big.bin').verified], ['same', false]);
  eq('仅 A', model.get('onlyA.txt').status, 'onlyA');
  eq('仅 B', model.get('onlyB.txt').status, 'onlyB');
  eq('pending 数量', C.pendingEntries(model).length, 1);
  eq('哈希一致 -> same', C.finalizeEntry(model.get('same.txt'), 'dead', 'dead'), 'same');
  eq('哈希不一致 -> modified', C.finalizeEntry(model.get('x.txt'), 'dead', 'beef'), 'modified');

  console.log('\n[7] 逐行 diff');
  const a = ['a', 'b', 'c', 'd', 'e'].join('\n');
  const b = ['a', 'B', 'c', 'd', 'e', 'f'].join('\n');
  const rows = C.buildSideBySide(C.diffLines(C.splitLines(a), C.splitLines(b), {}));
  eq('前后缀被裁剪，只在中间产生改动', rows.filter(r => r.type !== 'eq').map(r => r.type), ['mod', 'ins']);
  eq('改动计数', C.countChanges(rows), { add: 2, del: 1 });
  eq('总行数对齐', rows.length, 6);
  const small = C.diffLines(['1', '2', '3'], ['1', '3'], {});
  eq('纯删除', small.filter(o => o.t === 'del').length, 1);
  const wsRows = C.buildSideBySide(C.diffLines(['x   '], ['x'], { ignoreTrailingSpace: true }));
  eq('忽略行尾空白后视为相同', wsRows.map(r => r.type), ['eq']);
  const bigA = Array.from({ length: 300 }, (_, i) => 'a' + i);
  const bigB = Array.from({ length: 300 }, (_, i) => (i >= 100 && i < 200 ? 'B' + i : 'a' + i));
  const bigRows = C.buildSideBySide(C.diffLines(bigA, bigB, { maxCells: 10 }));
  eq('超大差异区块走降级分支：行数对齐且改动行数正确',
     [bigRows.length, bigRows.filter(r => r.type === 'mod').length], [300, 100]);
  // 左右两侧的行号必须各自严格递增且不重复，保证并排视图不错位
  const lIdx = bigRows.map(r => r.l).filter(x => x != null);
  const rIdx = bigRows.map(r => r.r).filter(x => x != null);
  eq('左侧行号完整且递增', lIdx.length === 300 && lIdx.every((v, i) => v === i), true);
  eq('右侧行号完整且递增', rIdx.length === 300 && rIdx.every((v, i) => v === i), true);

  console.log('\n[8] 文件类型嗅探');
  eq('扩展名命中视为二进制', C.isProbablyBinary(new Uint8Array([1, 2, 3]), 'a.png'), true);
  eq('含 \\0 视为二进制', C.isProbablyBinary(new Uint8Array([104, 0, 105]), 'a.bin'), true);
  eq('纯文本不判为二进制', C.isProbablyBinary(new TextEncoder().encode('hello 中文'), 'a.txt'), false);

  console.log('\n[9] 格式化');
  eq('fmtSize KB', C.fmtSize(2048), '2.0 KB');
  eq('fmtSize B', C.fmtSize(512), '512 B');
  const hexLines = C.toHexPreview(new Uint8Array([65, 66, 0, 67]), 256).trim().split('\n');
  eq('十六进制预览一行且含 ASCII 列', hexLines.length, 1);
  eq('不可见字符用 . 代替', /\|AB\.C\|/.test(hexLines[0]), true);

  console.log('\n[10] 树的先序位置比较（滚动联动的锚点基础）');
  const ord = (pa, da, pb, db) => Math.sign(C.cmpTreeOrder(pa, da, pb, db));
  eq('同一路径视为同位', ord('a/b.txt', false, 'a/b.txt', false), 0);
  eq('祖先排在后代之前', ord('a', true, 'a/b.txt', false), -1);
  eq('后代排在祖先之后', ord('a/b/c.txt', false, 'a', true), 1);
  eq('根排在最前', ord('', true, 'a', true), -1);
  eq('目录 a 的子项排在 a.txt 之前', ord('a/b.txt', false, 'a.txt', false), -1);
  eq('目录排在同名前缀的文件前', ord('a/b', true, 'a/b.txt', false), -1);
  eq('自然序：f2 在 f10 之前', ord('f2.txt', false, 'f10.txt', false), -1);
  eq('自然序：f10 在 f2 之后', ord('f10.txt', false, 'f2.txt', false), 1);
  eq('分叉层目录优先', ord('x/b.txt', false, 'x/c', true), 1);

  // 与真实先序遍历序列逐对对拍：比较结果必须和它们在序列里的先后完全一致
  const seqTree = C.buildTree([
    { relPath: 'a.txt', size: 0, mtime: 0, file: null },
    { relPath: 'a/b.txt', size: 0, mtime: 0, file: null },
    { relPath: 'a/b/c.txt', size: 0, mtime: 0, file: null },
    { relPath: 'f2.txt', size: 0, mtime: 0, file: null },
    { relPath: 'f10.txt', size: 0, mtime: 0, file: null },
    { relPath: 'z.txt', size: 0, mtime: 0, file: null },
    { relPath: 'a/b2/d.txt', size: 0, mtime: 0, file: null },
    { relPath: 'a/b2/e.txt', size: 0, mtime: 0, file: null }
  ], 'root');
  const seq = [];
  (function walk(n) {
    if (n.path) seq.push({ path: n.path, dir: !!n.dir });
    if (n.dir && n.children) for (const c of n.children) walk(c);
  })(seqTree);
  let agree = true, badPair = null;
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      const c = ord(seq[i].path, seq[i].dir, seq[j].path, seq[j].dir);
      if (c !== Math.sign(i - j)) { agree = false; badPair = [seq[i].path, seq[j].path, c, i - j]; break; }
    }
  }
  eq('比较结果与真实先序序列完全一致', badPair, null);
  eq('上述对拍覆盖的节点数', seq.length >= 8, true);

  // 用真实的行序列验证：A 比 B 多 3 个「仅 A 有」文件时，两侧仍应锚定到同一个文件
  const mkRows = (names) => names.map((n) => ({ node: { path: n, dir: false } }));
  const bNames = [];
  for (let i = 0; i < 120; i++) bNames.push('f' + String(i).padStart(3, '0') + '.txt');
  const aNames = bNames.slice(0, 51)
    .concat(['f050a.txt', 'f050b.txt', 'f050c.txt'])
    .concat(bNames.slice(51));
  const aRows = mkRows(aNames), bRows = mkRows(bNames);
  // A 的第 62 行是 f059.txt，它在 B 里的行号应为 59（少了 3 行）
  eq('A 第 62 行 = f059.txt', aRows[62].node.path, 'f059.txt');
  eq('同一文件在 B 中的行号 = 59', C.locateRow(bRows, 'f059.txt', false, (r) => r.node), 59);
  eq('精确存在的路径可被定位', C.locateRow(aRows, 'f059.txt', false, (r) => r.node), 62);
  eq('不存在的路径落在它应处的位置（f050 之后、f051 之前）',
     C.locateRow(bRows, 'f050b.txt', false, (r) => r.node), 51);
  eq('定位结果单调（越靠后越大）',
     C.locateRow(bRows, 'f010.txt', false, (r) => r.node) < C.locateRow(bRows, 'f090.txt', false, (r) => r.node),
     true);

  console.log('\n[11] ZIP 解析与 docx 文本提取');
  // 手工构造最小 ZIP：local header + data + 中央目录 + EOCD（CRC 不参与本实现校验，填 0）
  const le16 = (v) => [v & 255, (v >> 8) & 255];
  const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  async function buildZip(parts) {
    const enc2 = new TextEncoder();
    const chunks = [], centrals = [];
    let offset = 0;
    for (const p of parts) {
      const nameBytes = enc2.encode(p.name);
      let data = p.data;
      if (p.method === 8) {
        const cs = new CompressionStream('deflate-raw');
        data = new Uint8Array(await new Response(new Blob([p.data]).stream().pipeThrough(cs)).arrayBuffer());
      }
      const local = new Uint8Array([
        0x50, 0x4B, 0x03, 0x04, ...le16(20), ...le16(0), ...le16(p.method),
        ...le16(0), ...le16(0), ...le32(0), ...le32(data.length), ...le32(p.data.length),
        ...le16(nameBytes.length), ...le16(0)]);
      chunks.push(local, nameBytes, data);
      centrals.push(new Uint8Array([
        0x50, 0x4B, 0x01, 0x02, ...le16(20), ...le16(20), ...le16(0), ...le16(p.method),
        ...le16(0), ...le16(0), ...le32(0), ...le32(data.length), ...le32(p.data.length),
        ...le16(nameBytes.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
        ...le32(0), ...le32(offset), ...nameBytes]));
      offset += local.length + nameBytes.length + data.length;
    }
    const cdStart = offset;
    const cdSize = centrals.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array([
      0x50, 0x4B, 0x05, 0x06, ...le16(0), ...le16(0), ...le16(parts.length), ...le16(parts.length),
      ...le32(cdSize), ...le32(cdStart), ...le16(0)]);
    const all = chunks.concat(centrals).concat([eocd]);
    const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let at = 0;
    for (const c of all) { out.set(c, at); at += c.length; }
    return out;
  }

  const xml1 = '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>第一段：你好</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">第二段 &amp; 含实体 &lt;tag&gt;</w:t></w:r></w:p>' +
    '<w:p></w:p>' +
    '<w:p><w:r><w:t>甲乙</w:t></w:r><w:r><w:t>丙丁</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const enc = new TextEncoder();

  const zipStored = await buildZip([{ name: 'word/document.xml', data: enc.encode(xml1), method: 0 }]);
  eq('stored zip 识别为 ZIP', C.isZip(zipStored), true);
  const ent1 = await C.readZipEntries(zipStored);
  eq('stored zip 解析出条目名', ent1[0].name, 'word/document.xml');
  eq('stored zip 数据还原', new TextDecoder().decode(ent1[0].data), xml1);

  const zipDeflate = await buildZip([{ name: 'word/document.xml', data: enc.encode(xml1), method: 8 }]);
  eq('deflate 解压后内容一致', new TextDecoder().decode((await C.readZipEntries(zipDeflate))[0].data), xml1);

  const docxLns = await C.docxLines(zipDeflate);
  eq('docx 提取出 4 段', docxLns.length, 4);
  eq('多 run 文本拼接', docxLns[3], '甲乙丙丁');
  eq('XML 实体被反转义', docxLns[1], '第二段 & 含实体 <tag>');
  eq('空段落保留（行号对齐用）', docxLns[2], '');

  const zipOther = await buildZip([{ name: 'xl/workbook.xml', data: enc.encode('<x/>'), method: 0 }]);
  eq('没有 word/document.xml 的 zip 返回 null', await C.docxLines(zipOther), null);
  eq('非 zip 返回 null', await C.docxLines(new Uint8Array([1, 2, 3, 4])), null);
  eq('xmlUnescape 数字引用', C.xmlUnescape('&#x4F60;&#22909;&#65;'), '你好A');

  /* == 字符级 diff（diffChars）：docx 文档视图的核心 == */
  function spanText(spans, t) {
    return spans.filter(function (s) { return s.t === t; }).map(function (s) { return s.s; }).join('');
  }
  let sp = C.diffChars('诉讼管辖地法院为河北省石家庄市裕华区人民法院。',
    '诉讼管辖地法院为乙方所在地法院。');
  eq('字符 diff：删除的部分', spanText(sp, 'del'), '河北省石家庄市裕华区人民');
  eq('字符 diff：新增的部分', spanText(sp, 'ins'), '乙方所在地');
  eq('字符 diff：相同部分拼接后 = 公共文本',
    spanText(sp, 'eq'), '诉讼管辖地法院为' + '法院。');

  sp = C.diffChars('第九条 合同终止与解除', '第九条 合同终止与解除');
  eq('完全相同的段落只有 eq', sp.length === 1 && sp[0].t === 'eq', true);

  sp = C.diffChars('abc', 'abcdef');
  eq('尾部追加', spanText(sp, 'ins'), 'def');
  eq('尾部追加时 eq 部分', spanText(sp, 'eq'), 'abc');

  sp = C.diffChars('abcdef', 'abc');
  eq('尾部删除', spanText(sp, 'del'), 'def');

  sp = C.diffChars('', '新增整段');
  eq('空 -> 非空：纯 ins', sp.length === 1 && sp[0].t === 'ins' && sp[0].s === '新增整段', true);

  sp = C.diffChars('删除整段', '');
  eq('非空 -> 空：纯 del', sp.length === 1 && sp[0].t === 'del' && sp[0].s === '删除整段', true);

  // 代理对（emoji）不能被拆坏
  sp = C.diffChars('甲😀乙', '甲😀丙');
  eq('emoji 按码点处理不拆坏', spanText(sp, 'eq'), '甲😀');
  eq('emoji 场景 del/ins 各一字', spanText(sp, 'del') + '/' + spanText(sp, 'ins'), '乙/丙');

  // 超长退化：maxCells 触发整段 del+ins，不报错
  const longA = '长'.repeat(2000), longB = '长'.repeat(1999) + '短';
  sp = C.diffChars(longA, longB, { maxCells: 100 });
  eq('超 maxCells 退化但仍返回 spans', sp.length >= 1 && spanText(sp, 'del').length > 0, true);

  console.log('\n==== 通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
  process.exit(fail ? 1 : 0);
})();
