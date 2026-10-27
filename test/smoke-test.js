/* 冒烟测试脚本：由 smoke.html 在 app.js 之后加载，验证真实浏览器行为 */
(function () {
  var out = null;
  var log = [];
  function ok(name, cond, extra) {
    log.push((cond ? 'PASS' : 'FAIL') + ' :: ' + name + (extra != null ? ' :: ' + extra : ''));
    flush();
  }
  function flush() {
    if (!out) return;
    out.textContent = log.join('\n') + '\nERRORS:' +
      ((window.__smokeErrs && window.__smokeErrs.length) ? window.__smokeErrs.join(' | ') : 'none');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function F(path, content) {
    return { relPath: path, file: new File([content], path.split('/').pop(), { type: 'text/plain' }) };
  }
  function visibleRows(key) {
    var layer = document.getElementById('rows' + key);
    return Array.prototype.map.call(layer.querySelectorAll('.row'), function (r) {
      return r.getAttribute('data-path');
    });
  }
  /** 虚拟滚动里「已渲染的第一行」的渲染路径，用来验证两侧顶部对齐 */
  function topRendered(key) {
    var r = document.getElementById('rows' + key).querySelector('.row');
    return r ? r.getAttribute('data-path') : null;
  }
  function mkSet(prefix, extraOnlyFiles) {
    var arr = [];
    for (var i = 0; i < 120; i++) {
      arr.push(F(prefix + '/f' + String(i).padStart(3, '0') + '.txt', 'content ' + i + '\n'));
    }
    (extraOnlyFiles || []).forEach(function (name) {
      arr.push(F(prefix + '/' + name, 'extra in A\n'));
    });
    return arr;
  }

  async function main() {
    out = document.getElementById('smoke-out');
    var FD = window.__folderDiff;

    ok('core.js 已加载', !!window.Core);
    ok('app.js 已初始化', !!FD);
    if (!FD) { flush(); return; }

    var A = [
      F('rootA/same.txt', 'line1\nline2\nline3\n'),
      F('rootA/dir/modified.txt', 'alpha\nbeta\ngamma\n'),
      F('rootA/only_a.txt', 'hello A\n'),
      F('rootA/nested/deep/keep.txt', 'deep content\n'),
      F('rootA/node_modules/junk.js', 'should be ignored\n')
    ];
    var B = [
      F('rootB/same.txt', 'line1\nline2\nline3\n'),
      F('rootB/dir/modified.txt', 'alpha\nBETA-CHANGED\ngamma\n'),
      F('rootB/only_b.txt', 'hello B\n'),
      F('rootB/nested/deep/keep.txt', 'deep content\n'),
      F('rootB/node_modules/junk.js', 'should be ignored\n')
    ];

    FD.setRaw('A', A, 'rootA');
    FD.setRaw('B', B, 'rootB');
    await FD.runCompare();

    var m = FD.state.map;
    ok('比对结束（非忙碌）', !FD.state.busy);
    if (!m) { log.push('FAIL :: state.map 为空'); flush(); return; }

    ok('same.txt = 相同', m.get('same.txt').status === 'same', m.get('same.txt').status);
    ok('dir/modified.txt = 内容不同', m.get('dir/modified.txt').status === 'modified', m.get('dir/modified.txt').status);
    ok('only_a.txt = 仅A有', m.get('only_a.txt').status === 'onlyA', m.get('only_a.txt').status);
    ok('only_b.txt = 仅B有', m.get('only_b.txt').status === 'onlyB', m.get('only_b.txt').status);
    ok('两侧根目录名不同也能配对', m.has('nested/deep/keep.txt'));
    ok('node_modules 被忽略规则过滤', !m.has('node_modules/junk.js'));
    ok('差异清单 = 3 项', FD.state.diffList.length === 3, 'n=' + FD.state.diffList.length);

    ok('A 树有渲染行', document.getElementById('rowsA').children.length > 0);
    ok('B 树有渲染行', document.getElementById('rowsB').children.length > 0);
    ok('统计栏已更新', /内容不同/.test(document.getElementById('stats').textContent));
    ok('自动展开到差异：dir/modified.txt 可见',
       visibleRows('A').indexOf('dir/modified.txt') >= 0, visibleRows('A').join(','));

    /* --- 1) 同步联动 ON --- */
    document.getElementById('syncToggle').checked = true;
    await FD.openEntry('A', 'dir/modified.txt');
    await sleep(250);
    ok('联动：渲染出左右双栏',
       !!document.getElementById('diffLeft') && !!document.getElementById('diffRight'));
    ok('联动：左栏标出删除行',
       document.querySelectorAll('#diffLeft .dl.del').length >= 1,
       'del=' + document.querySelectorAll('#diffLeft .dl.del').length);
    ok('联动：右栏标出新增行',
       document.querySelectorAll('#diffRight .dl.ins').length >= 1,
       'ins=' + document.querySelectorAll('#diffRight .dl.ins').length);
    ok('联动：右侧同步选中', FD.panes.B.selected === 'dir/modified.txt', String(FD.panes.B.selected));

    /* --- 统一视图切换 --- */
    await FD.setViewMode('unified');
    await sleep(200);
    ok('切换统一视图', FD.state.viewMode === 'unified' && !document.getElementById('diffLeft'));
    await FD.setViewMode('side');
    await sleep(200);
    ok('切回并排视图', FD.state.viewMode === 'side' && !!document.getElementById('diffLeft'));

    /* --- 2) 同步联动 OFF --- */
    document.getElementById('syncToggle').checked = false;
    await FD.openEntry('A', 'same.txt');
    await sleep(300);
    ok('关闭联动：只有单栏', !document.getElementById('diffRight'));
    ok('关闭联动：不联动选中另一侧', FD.panes.B.selected === null, String(FD.panes.B.selected));
    ok('关闭联动：内容仍可读', /line1/.test(document.getElementById('drawerBody').textContent));

    /* --- 3) 仅一侧存在的文件 --- */
    await FD.openEntry('A', 'only_a.txt');
    await sleep(300);
    ok('仅A文件可单独预览', /hello A/.test(document.getElementById('drawerBody').textContent));

    /* --- 3b) 分栏归属：左栏恒为 A、右栏恒为 B，与「点的是哪一侧」无关 --- */
    // 曾经的实现把「被点击的一侧」固定当左栏，导致点 B 侧列表时两侧内容整体调换，
    // 连红（A 删除）/ 绿（B 新增）的语义都跟着反过来。这里把该行为锁死。
    document.getElementById('syncToggle').checked = true;
    await FD.openEntry('A', 'dir/modified.txt');
    await sleep(300);
    var lFromA = document.getElementById('diffLeft').textContent;
    var rFromA = document.getElementById('diffRight').textContent;
    await FD.openEntry('B', 'dir/modified.txt');
    await sleep(300);
    var lFromB = document.getElementById('diffLeft').textContent;
    var rFromB = document.getElementById('diffRight').textContent;

    ok('点 B 侧：左栏内容与点 A 侧时完全一致', lFromA === lFromB, JSON.stringify(lFromB.slice(0, 60)));
    ok('点 B 侧：右栏内容与点 A 侧时完全一致', rFromA === rFromB, JSON.stringify(rFromB.slice(0, 60)));
    ok('左栏 = A 版本（beta）', /beta/.test(lFromB) && !/BETA-CHANGED/.test(lFromB));
    ok('右栏 = B 版本（BETA-CHANGED）', /BETA-CHANGED/.test(rFromB) && !/beta/.test(rFromB));
    ok('点 B 侧：删除行仍标在左栏（红）',
       document.querySelectorAll('#diffLeft .dl.del').length >= 1,
       'n=' + document.querySelectorAll('#diffLeft .dl.del').length);
    ok('点 B 侧：左栏不出现绿色新增', document.querySelectorAll('#diffLeft .dl.ins').length === 0);
    ok('点 B 侧：右栏不出现红色删除', document.querySelectorAll('#diffRight .dl.del').length === 0);
    ok('点 B 侧：另一侧仍被联动选中', FD.panes.A.selected === 'dir/modified.txt', String(FD.panes.A.selected));

    // 关联动时，点哪一侧就只展示哪一侧
    document.getElementById('syncToggle').checked = false;
    await FD.openEntry('B', 'dir/modified.txt');
    await sleep(300);
    ok('联动关/点 B 侧：只展示 B 版本',
       !document.getElementById('diffRight') &&
       /BETA-CHANGED/.test(document.getElementById('drawerBody').textContent) &&
       !/beta/.test(document.getElementById('drawerBody').textContent));
    await FD.openEntry('A', 'dir/modified.txt');
    await sleep(300);
    ok('联动关/点 A 侧：只展示 A 版本',
       !document.getElementById('diffRight') &&
       /beta/.test(document.getElementById('drawerBody').textContent) &&
       !/BETA-CHANGED/.test(document.getElementById('drawerBody').textContent));

    /* --- 4) 二进制 -> 只显示元信息 --- */
    FD.setRaw('A', [{
      relPath: 'rootC/logo.png',
      file: new File([new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3, 4])], 'logo.png', { type: 'image/png' })
    }], 'rootC');
    await FD.runCompare();
    await FD.openEntry('A', 'logo.png');
    await sleep(300);
    ok('二进制：只显示元信息（含 SHA-256）',
       /SHA-256/.test(document.getElementById('drawerBody').textContent));

    /* --- 5) 搜索过滤 --- */
    FD.setRaw('A', A, 'rootA');
    FD.setRaw('B', B, 'rootB');
    await FD.runCompare();
    FD.state.query = 'only_a';
    FD.panes.A.dirty = true;
    FD.panes.B.dirty = true;
    FD.renderTree(FD.panes.A);
    FD.renderTree(FD.panes.B);
    ok('搜索过滤：A 侧仅 1 条可见', FD.rowCount('A') === 1, 'rows=' + FD.rowCount('A'));
    ok('搜索过滤：B 侧 0 条', FD.rowCount('B') === 0, 'rows=' + FD.rowCount('B'));

    /* --- 7) docx 容器：提取段落文本做行级 diff --- */
    // 页面内构造最小可用 docx（deflate 压缩的 word/document.xml）
    function docXml(paras) {
      return '<?xml version="1.0"?><w:document><w:body>' +
        paras.map(function (t) { return '<w:p><w:r><w:t>' + t + '</w:t></w:r></w:p>'; }).join('') +
        '</w:body></w:document>';
    }
    async function buildDocx(xml) {
      var enc = new TextEncoder();
      var name = enc.encode('word/document.xml');
      var raw = enc.encode(xml);
      var cs = new CompressionStream('deflate-raw');
      var data = new Uint8Array(await new Response(
        new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer());
      var u16 = function (v) { return [v & 255, (v >> 8) & 255]; };
      var u32 = function (v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; };
      var local = [80, 75, 3, 4].concat(u16(20), u16(0), u16(8), u16(0), u16(0),
        u32(0), u32(data.length), u32(raw.length), u16(name.length), u16(0));
      var central = [80, 75, 1, 2].concat(u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
        u32(0), u32(data.length), u32(raw.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(0));
      var lhLen = local.length + name.length + data.length;
      var eocd = [80, 75, 5, 6].concat(u16(0), u16(0), u16(1), u16(1),
        u32(central.length + name.length), u32(lhLen), u16(0));
      return new Uint8Array(local.concat(Array.from(name), Array.from(data),
        central, Array.from(name), eocd));
    }
    var docxA = await buildDocx(docXml(['第一段：承诺书', '甲方名称：张三', '金额：1000 元']));
    var docxB = await buildDocx(docXml(['第一段：承诺书', '甲方名称：李四', '金额：1000 元']));
    FD.setRaw('A', [{ relPath: 'rtA/tpl/合同模板.docx', file: new File([docxA], '合同模板.docx') }], 'rtA');
    FD.setRaw('B', [{ relPath: 'rtB/tpl/合同模板.docx', file: new File([docxB], '合同模板.docx') }], 'rtB');
    await FD.runCompare();
    document.getElementById('syncToggle').checked = true;   // 前面步骤关过，双栏 diff 需要先开回来
    await FD.openEntry('A', 'tpl/合同模板.docx');
    await sleep(400);
    // 默认是文档视图：段落流式排版 + 字符级差异
    ok('docx：默认走文档视图', !!document.querySelector('.docwrap') && !document.getElementById('diffRight'));
    var cdel = document.querySelector('.docwrap .cdel');
    var cins = document.querySelector('.docwrap .cins');
    ok('docx 文档视图：字符级删除标记', !!cdel && cdel.textContent === '张三', cdel && cdel.textContent);
    ok('docx 文档视图：字符级新增标记', !!cins && cins.textContent === '李四', cins && cins.textContent);
    ok('docx 文档视图：相同文本正常显示',
       /甲方名称：/.test(document.getElementById('drawerBody').textContent));
    ok('docx：副标题注明提取方式', /docx/.test(document.getElementById('drawerSub').textContent));
    // 并排文档视图：A 侧看不到 B 新增的字符（张三只在 cdel 里，李四只在 cins 里）
    var modRow = cdel && cdel.closest('.docrow');
    ok('docx 文档视图：A 侧单元格不含 B 的新增字',
       !!modRow && !/李四/.test(modRow.children[0].textContent) && !/张三/.test(modRow.children[1].textContent));
    // 从 B 侧点开同一个 docx，左右单元格必须与从 A 侧点开时完全一致
    await FD.openEntry('B', 'tpl/合同模板.docx');
    await sleep(300);
    var modRowB = document.querySelector('.docwrap .cdel');
    modRowB = modRowB && modRowB.closest('.docrow');
    ok('docx 从 B 侧点开：左格仍是 A（张三）、右格仍是 B（李四）',
       !!modRowB && /张三/.test(modRowB.children[0].textContent) && /李四/.test(modRowB.children[1].textContent),
       modRowB ? modRowB.textContent : 'no row');
    // Redline 统一视图：删除与新增同段内联
    await FD.setViewMode('unified');
    await sleep(250);
    ok('docx Redline：单栏且删增同段并存',
       !!document.querySelector('.docwrap.uni') &&
       document.querySelectorAll('.docwrap.uni .docrow .docp .cdel').length >= 1 &&
       document.querySelectorAll('.docwrap.uni .docrow .docp .cins').length >= 1);
    await FD.setViewMode('side');
    await sleep(250);
    // 切到逐行视图（回到代码式 diff）
    await FD.setDocxView('line');
    await sleep(300);
    ok('docx 逐行视图：回到行级 diff', !!document.getElementById('diffRight'));
    ok('docx 逐行视图：差异行左右都有高亮',
       document.querySelectorAll('#diffLeft .dl.del').length >= 1 &&
       document.querySelectorAll('#diffRight .dl.ins').length >= 1);
    ok('docx 逐行视图：能看到段落文本', /甲方名称：张三/.test(document.getElementById('drawerBody').textContent));
    // 切回文档视图，不影响后续用例
    await FD.setDocxView('doc');
    await sleep(300);
    ok('docx：可切回文档视图', !!document.querySelector('.docwrap'));


    /* --- 6) 两侧滚动联动 --- */
    // A 比 B 多 3 个「仅 A 有」的文件（夹在 f050 之后），用来验证行数不同时的锚点补偿
    FD.state.query = '';
    FD.setRaw('A', mkSet('rtA', ['f050a.txt', 'f050b.txt', 'f050c.txt']), 'rtA');
    FD.setRaw('B', mkSet('rtB', []), 'rtB');
    await FD.runCompare();
    var scA = document.getElementById('scrollA');
    var scB = document.getElementById('scrollB');
    var scSync = document.getElementById('scrollSyncToggle');
    ok('滚动数据已就绪（A 比 B 多 3 行）',
       FD.rowCount('A') - FD.rowCount('B') === 3, FD.rowCount('A') + '/' + FD.rowCount('B'));

    scSync.checked = true;
    scA.scrollTop = 600;
    await sleep(400);
    ok('同步滚动开：B 跟随滚动', scB.scrollTop > 0, 'B.top=' + scB.scrollTop);
    ok('同步滚动开：两侧顶部行一致', topRendered('A') === topRendered('B'),
       topRendered('A') + ' vs ' + topRendered('B'));

    // 滚过那 3 个「仅 A 有」文件之后，两侧仍应停在同一文件上（而不是同一像素）
    scA.scrollTop = 1500;
    await sleep(400);
    ok('行数不同时按路径锚点补偿（非按像素硬对齐）',
       topRendered('A') === topRendered('B') && Math.abs(scA.scrollTop - scB.scrollTop) >= 24,
       topRendered('A') + ' vs ' + topRendered('B') + ' / A=' + scA.scrollTop + ' B=' + scB.scrollTop);

    // 反向：滚 B 带动 A
    scB.scrollTop = 300;
    await sleep(400);
    ok('反向联动：滚 B 带动 A', Math.abs(scA.scrollTop - 300) < 2, 'A.top=' + scA.scrollTop);

    // 关掉开关后应各滚各的
    scSync.checked = false;
    scB.scrollTop = 900;
    await sleep(400);
    ok('同步滚动关：A 不跟随', Math.abs(scA.scrollTop - 300) < 2, 'A.top=' + scA.scrollTop);

    log.push('==SMOKE-END==');
    flush();
  }

  setTimeout(function () {
    try {
      main().catch(function (e) {
        if (out) out.textContent = log.join('\n') + '\nTHREW: ' + ((e && e.stack) || e);
      });
    } catch (e) {
      if (out) out.textContent = 'SYNC-THREW: ' + ((e && e.stack) || e);
    }
  }, 80);
})();
