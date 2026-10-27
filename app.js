/* =====================================================================
 * app.js —— 交互层（文件夹导入 / 异步比对 / 虚拟滚动树 / 并排差异预览）
 * 依赖：core.js（window.Core）
 * ===================================================================== */
(function () {
  'use strict';

  var C = window.Core;
  var ROW_H = 24;               // 必须与 styles.css 中 --row-h 保持一致
  var MAX_RENDER_LINES = 8000;  // 单侧最多渲染多少行，超出截断并提示

  /* ------------------------------ 配置 ------------------------------ */
  var cfg = {
    ignore: C.DEFAULT_IGNORE,
    maxHashMB: 20,
    maxPreviewMB: 4,
    maxDiffLines: 4000,
    maxFiles: 200000,
    ignoreTrailingWS: false
  };
  try {
    var saved = localStorage.getItem('folderDiffCfg');
    if (saved) {
      var o = JSON.parse(saved);
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) cfg[k] = o[k];
    }
  } catch (e) { /* file:// 下 localStorage 可能不可用，忽略 */ }
  function saveCfg() { try { localStorage.setItem('folderDiffCfg', JSON.stringify(cfg)); } catch (e) {} }

  /* ------------------------------ 状态 ------------------------------ */
  var state = {
    busy: false, cancel: false,
    map: null, stat: null,
    query: '',
    show: { onlyA: true, onlyB: true, modified: true, same: true },
    viewMode: 'side',
    docxView: 'doc',          // docx 专用：'doc' 文档视图（默认）/ 'line' 逐行代码视图
    currentPath: null,
    allowBigPreview: false,
    diffList: [],
    imgUrl: null
  };

  function newPane(key) {
    return {
      key: key, raw: [], entries: [], tree: null,
      map: new Map(), rootName: '', ignored: 0, truncated: 0,
      rows: [], index: new Map(), expanded: new Set(),
      selected: null, dirty: false
    };
  }
  var panes = { A: newPane('A'), B: newPane('B') };

  /* ------------------------------ DOM ------------------------------ */
  function $(id) { return document.getElementById(id); }
  var els = {};
  ['syncToggle', 'scrollSyncToggle', 'btnSettings', 'btnRecompare', 'btnClear', 'search', 'filters', 'chipOnlyDiff',
   'btnExpandDiff', 'btnExpandAll', 'btnCollapseAll', 'stats', 'progress', 'progressBar',
   'progressText', 'btnCancel', 'main', 'paneA', 'paneB', 'pickA', 'pickB', 'clrA', 'clrB',
   'rootNameA', 'rootNameB', 'countA', 'countB', 'scrollA', 'scrollB', 'sizerA', 'sizerB',
   'rowsA', 'rowsB', 'emptyA', 'emptyB', 'inputA', 'inputB', 'vsplit', 'hsplit', 'drawer',
   'drawerTitle', 'drawerSub', 'drawerBody', 'btnCloseDrawer', 'btnPrevDiff', 'btnNextDiff',
   'btnViewMode', 'btnDocView', 'settingsModal', 'ignoreInput', 'inpMaxHash', 'inpMaxPreview', 'inpMaxLines',
   'inpMaxFiles', 'inpIgnoreWS', 'btnSaveSettings', 'btnCloseSettings', 'btnResetIgnore'
  ].forEach(function (id) { els[id] = $(id); });

  function paneEls(key) {
    return {
      scroll: key === 'A' ? els.scrollA : els.scrollB,
      sizer: key === 'A' ? els.sizerA : els.sizerB,
      rows: key === 'A' ? els.rowsA : els.rowsB,
      empty: key === 'A' ? els.emptyA : els.emptyB,
      count: key === 'A' ? els.countA : els.countB,
      rootName: key === 'A' ? els.rootNameA : els.rootNameB
    };
  }

  /* ---------------------------- 小工具函数 ---------------------------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  /**
   * 让出一帧，保证进度条能被画出来。
   * rAF 在无头/后台标签页里可能不触发，所以用定时器兜底，避免比对流程卡死。
   */
  function yieldFrame() {
    return new Promise(function (r) {
      var done = false;
      function finish() { if (!done) { done = true; r(); } }
      try { requestAnimationFrame(function () { setTimeout(finish, 0); }); } catch (e) { /* 忽略 */ }
      setTimeout(finish, 20);
    });
  }
  var STATUS_LABEL = { onlyA: '仅 A 有', onlyB: '仅 B 有', modified: '两边都有但内容不同', same: '两边相同', pending: '待比对' };

  /* ---------------------------- 进度与忙碌 ---------------------------- */
  function showProgress(pct, text) {
    els.progress.hidden = false;
    els.progressText.textContent = text;
    if (pct == null || pct < 0) els.progress.classList.add('indet');
    else {
      els.progress.classList.remove('indet');
      els.progressBar.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
    }
  }
  function hideProgress() { els.progress.hidden = true; }

  /* =================================================================
   *  一、导入：input webkitdirectory + 拖拽
   * ================================================================= */

  /** 统一剥掉最外层目录名：两边根目录名不同也能按相对路径配对 */
  function stripRoot(list) {
    return list.map(function (it) {
      var rp = it.relPath;
      var slash = rp.indexOf('/');
      return { relPath: slash >= 0 ? rp.slice(slash + 1) : rp, file: it.file };
    });
  }

  function setRaw(key, list, rootName) {
    if (!list.length) return false;
    var stripped = stripRoot(list);
    var p = panes[key];
    p.raw = stripped;
    p.rootName = rootName || guessRootName(stripped) || '（所选内容）';
    rebuildEntries(p);
    var e = paneEls(key);
    e.rootName.textContent = p.rootName;
    e.rootName.classList.remove('empty');
    e.empty.hidden = stripped.length > 0;
    return true;
  }

  function guessRootName(list) {
    var first = list[0] && list[0].relPath;
    if (!first) return '';
    var s = first.indexOf('/');
    return s > 0 ? first.slice(0, s) : '';
  }

  /** 应用忽略规则 + 数量上限，生成参与比对的条目并建树 */
  function rebuildEntries(p) {
    var rules = C.parseIgnoreRules(cfg.ignore);
    var entries = [], ignored = 0, truncated = 0;
    for (var i = 0; i < p.raw.length; i++) {
      var it = p.raw[i];
      if (entries.length >= cfg.maxFiles) { truncated++; continue; }
      if (C.isIgnored(it.relPath, rules)) { ignored++; continue; }
      entries.push({
        relPath: it.relPath, file: it.file, size: it.file.size,
        mtime: it.file.lastModified || 0
      });
    }
    p.entries = entries;
    p.ignored = ignored;
    p.truncated = truncated;
    p.map = new Map();
    for (var j = 0; j < entries.length; j++) p.map.set(entries[j].relPath, entries[j]);
    p.tree = C.buildTree(entries, p.rootName);
    p.expanded = new Set();
    p.selected = null;
    p.dirty = true;
  }

  function clearPane(key) {
    var p = panes[key];
    p.raw = []; p.entries = []; p.tree = null; p.map = new Map();
    p.rows = []; p.index = new Map(); p.expanded = new Set();
    p.selected = null; p.dirty = true; p.rootName = '';
    docxCache.clear();   // 释放旧 File 引用（缓存以 File 对象为键，重新导入后不再命中）
    var e = paneEls(key);
    e.rootName.textContent = '未导入';
    e.rootName.classList.add('empty');
    e.empty.hidden = false;
    e.count.textContent = '';
    e.rows.innerHTML = '';
    e.sizer.style.height = '0px';
    e.scroll.scrollTop = 0;
    closeDrawer();
    refreshToolbar();
  }

  function onPickChange(key, input) {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';   // 允许再次选择同一个文件夹
    if (!files.length) return;
    var list = files.map(function (f) {
      return { relPath: f.webkitRelativePath || f.name, file: f };
    });
    var rootName = '';
    if (files[0].webkitRelativePath) rootName = files[0].webkitRelativePath.split('/')[0];
    if (setRaw(key, list, rootName)) maybeCompare();
  }

  function bindPick(key) {
    els['pick' + key].addEventListener('click', function () { els['input' + key].click(); });
    els['input' + key].addEventListener('change', function () { onPickChange(key, els['input' + key]); });
    els['clr' + key].addEventListener('click', function () { clearPane(key); });

    // 拖拽导入
    var pane = key === 'A' ? els.paneA : els.paneB;
    ['dragenter', 'dragover'].forEach(function (ev) {
      pane.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        pane.classList.add('dropzone-on');
      });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      pane.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        if (ev === 'dragleave' && pane.contains(e.relatedTarget)) return;
        pane.classList.remove('dropzone-on');
      });
    });
    pane.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      pane.classList.remove('dropzone-on');
      var dt = e.dataTransfer;
      if (!dt) return;
      readDropped(dt).then(function (list) {
        if (!list.length) { toast('没有读取到可读文件'); return; }
        if (setRaw(key, list, '')) maybeCompare();
      }).catch(function (err) {
        console.error(err);
        toast('读取拖拽内容失败：' + err.message);
      });
    });
  }

  /** DataTransfer -> [{relPath, file}]，递归读取目录 */
  function readDropped(dt) {
    var out = [];
    var entries = [];
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    items.forEach(function (it) {
      if (it.webkitGetAsEntry) {
        var en = it.webkitGetAsEntry();
        if (en) entries.push(en);
      }
    });
    if (!entries.length) {
      var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
      return Promise.resolve(files.map(function (f) { return { relPath: f.name, file: f }; }));
    }
    return walkEntries(entries, out).then(function () { return out; });
  }

  function walkEntries(entries, out) {
    var chain = Promise.resolve();
    entries.forEach(function (en) { chain = chain.then(function () { return collectEntry(en, '', out); }); });
    return chain;
  }

  function collectEntry(entry, prefix, out) {
    if (entry.isFile) {
      return new Promise(function (res, rej) {
        entry.file(function (f) { out.push({ relPath: prefix + entry.name, file: f }); res(); }, rej);
      });
    }
    if (entry.isDirectory) {
      var reader = entry.createReader();
      var readBatch = function () {
        return new Promise(function (res, rej) { reader.readEntries(res, rej); }).then(function (batch) {
          if (!batch.length) return null;
          return walkEntries(batch, out).then(readBatch);
        });
      };
      return readBatch();
    }
    return Promise.resolve();
  }

  /* =================================================================
   *  二、比对（异步 + 进度）
   * ================================================================= */

  function maybeCompare() {
    refreshToolbar();
    if (panes.A.tree && panes.B.tree) runCompare();
    else { renderTree(panes.A); renderTree(panes.B); }
  }

  /** 重复调用时返回同一次在途比对的 Promise，方便外部 await */
  var runningCompare = null;
  function runCompare() {
    if (state.busy && runningCompare) return runningCompare;
    runningCompare = doCompare();
    return runningCompare;
  }

  async function doCompare() {
    if (state.busy) return;
    if (!panes.A.tree || !panes.B.tree) return;
    state.busy = true;
    state.cancel = false;
    refreshToolbar();
    var t0 = performance.now();

    showProgress(-1, '建立比对索引…');
    await yieldFrame();

    var maxHashBytes = cfg.maxHashMB > 0 ? cfg.maxHashMB * 1024 * 1024 : 0;
    var map = C.buildCompareModel(panes.A.entries, panes.B.entries, maxHashBytes);
    var pending = C.pendingEntries(map);

    var bytesTotal = 0;
    pending.forEach(function (e) { bytesTotal += (e.a ? e.a.size : 0) + (e.b ? e.b.size : 0); });
    var bytesDone = 0, doneCount = 0, last = performance.now();

    for (var i = 0; i < pending.length; i++) {
      var e = pending[i];
      if (state.cancel) {
        e.status = 'same'; e.verified = false; e.reason = 'cancelled';
        continue;
      }
      try {
        var ha = await C.hashFile(e.a.file); bytesDone += e.a.size;
        var hb = await C.hashFile(e.b.file); bytesDone += e.b.size;
        C.finalizeEntry(e, ha, hb);
      } catch (err) {
        console.warn('读取失败', e.path, err);
        e.status = 'modified'; e.verified = false; e.reason = 'read-error';
      }
      doneCount++;
      var now = performance.now();
      if (now - last > 90) {
        var pct = bytesTotal ? (bytesDone / bytesTotal * 100) : (doneCount / pending.length * 100);
        showProgress(pct, '内容哈希比对 ' + doneCount + ' / ' + pending.length + ' 个文件（' + C.fmtSize(bytesDone) + ' / ' + C.fmtSize(bytesTotal) + '）');
        await yieldFrame();
        last = now;
      }
    }

    state.map = map;
    annotate(panes.A, map);
    annotate(panes.B, map);

    panes.A.dirty = true; panes.B.dirty = true;
    panes.A.selected = null; panes.B.selected = null;
    renderTree(panes.A);
    renderTree(panes.B);

    buildDiffList(map);
    renderStats(map, performance.now() - t0, doneCount);
    hideProgress();
    state.busy = false;
    refreshToolbar();

    if (state.cancel) toast('已取消：未参与哈希的文件按“相同”处理');
  }

  /** 把比对结果写回到树的每个节点上（叶子来自 map，目录自底向上汇总） */
  function annotate(p, map) {
    if (!p.tree) return;
    (function walk(n) {
      if (!n.dir) {
        var it = map.get(n.path);
        if (it) { n.status = it.status; n.unverified = !it.verified; n.diff = it; }
        return;
      }
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
    })(p.tree);
    C.rollupStatus(p.tree);
  }

  function buildDiffList(map) {
    var list = [];
    map.forEach(function (e, p) { if (e.status !== 'same') list.push(p); });
    list.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    state.diffList = list;
    els.btnNextDiff.disabled = !list.length;
    els.btnPrevDiff.disabled = !list.length;
  }

  function renderStats(map, elapsed, hashedCount) {
    var st = { onlyA: 0, onlyB: 0, modified: 0, same: 0, unverified: 0 };
    map.forEach(function (e) { st[e.status] = (st[e.status] || 0) + 1; if (!e.verified) st.unverified++; });
    state.stat = st;
    els.stats.innerHTML =
      '<span>A 侧 <b>' + panes.A.entries.length + '</b> 个文件</span><span class="sep">·</span>' +
      '<span>B 侧 <b>' + panes.B.entries.length + '</b> 个文件</span><span class="sep">·</span>' +
      '<span class="s-mod">内容不同 <b>' + st.modified + '</b></span><span class="sep">·</span>' +
      '<span class="s-a">仅 A 有 <b>' + st.onlyA + '</b></span><span class="sep">·</span>' +
      '<span class="s-b">仅 B 有 <b>' + st.onlyB + '</b></span><span class="sep">·</span>' +
      '<span>相同 <b>' + st.same + '</b></span>' +
      '<span class="note">（其中 <b title="体积超过上限或未完成读取，未校验内容">' + st.unverified + '</b> 项未校验内容；本次哈希 ' +
      hashedCount + ' 对文件，耗时 ' + C.fmtDuration(Math.round(elapsed)) + '）</span>';

    var extra = [];
    if (panes.A.ignored || panes.B.ignored) extra.push('忽略命中 ' + (panes.A.ignored + panes.B.ignored) + ' 项');
    if (panes.A.truncated || panes.B.truncated) extra.push('超出数量上限被跳过 ' + (panes.A.truncated + panes.B.truncated) + ' 项（可调设置）');
    if (extra.length) els.stats.innerHTML += '<span class="note">｜' + extra.join('；') + '</span>';

    paneEls('A').count.textContent = panes.A.entries.length + ' 个文件';
    paneEls('B').count.textContent = panes.B.entries.length + ' 个文件';
    expandToDiff(false);   // 默认展开到有差异的目录
  }

  /* =================================================================
   *  三、虚拟滚动树渲染
   * ================================================================= */

  function activeAllowed() {
    var s = new Set();
    if (state.show.onlyA) s.add('onlyA');
    if (state.show.onlyB) s.add('onlyB');
    if (state.show.modified) s.add('modified');
    if (state.show.same) s.add('same');
    return s;
  }

  /** 自底向上标记可见性：目录只要有一个后代可见就可见 */
  function computeVisibility(p) {
    var q = state.query.trim().toLowerCase();
    var allowed = activeAllowed();
    (function vis(n) {
      if (!n.dir) {
        n._vis = allowed.has(n.status) && (q === '' || n.path.toLowerCase().indexOf(q) >= 0);
        return n._vis;
      }
      var any = false;
      for (var i = 0; i < n.children.length; i++) if (vis(n.children[i])) any = true;
      n._vis = any;
      return any;
    })(p.tree);
  }

  function recomputeRows(p) {
    p.rows = []; p.index.clear();
    if (!p.tree) return;
    computeVisibility(p);
    var forceExpand = state.query.trim() !== '';
    var root = p.tree;
    (function walk(n, depth) {
      if (!n._vis) return;
      if (n !== root) {
        p.index.set(n.path, p.rows.length);
        p.rows.push({ node: n, depth: depth - 1 });
      }
      if (n.dir && (n === root || forceExpand || p.expanded.has(n.path))) {
        for (var i = 0; i < n.children.length; i++) walk(n.children[i], depth + 1);
      }
    })(root, 0);
  }

  function badgeHtml(n) {
    if (n.status === 'modified') return '<span class="badge b-mod">≠</span>';
    if (n.status === 'onlyA') return '<span class="badge b-a">A</span>';
    if (n.status === 'onlyB') return '<span class="badge b-b">B</span>';
    return '';
  }

  function rowHtml(item, p) {
    var n = item.node;
    var cls = ['row', n.dir ? 'is-dir' : 'is-file', 'st-' + (n.status || 'same')];
    if (n.status && n.status !== 'same') cls.push('hl');
    if (n.unverified) cls.push('unverified');
    if (p.selected === n.path) cls.push('sel');

    var caret = n.dir
      ? '<span class="caret">' + (p.expanded.has(n.path) ? '▾' : '▸') + '</span>'
      : '<span class="caret"></span>';
    var icon = n.dir ? '📁' : '📄';
    var right = n.dir
      ? '<span class="sz">' + n.files + ' 项 · ' + C.fmtSize(n.size) + '</span>'
      : '<span class="sz">' + C.fmtSize(n.size) + '</span>';

    var tip = n.path + '\n' + (STATUS_LABEL[n.status] || '') +
      (n.unverified ? '（未校验内容）' : '') +
      (n.dir ? '' : '\n' + C.fmtSize(n.size) + ' · ' + C.fmtTime(n.mtime));

    return '<div class="' + cls.join(' ') + '" data-path="' + escAttr(n.path) + '"' +
      ' data-kind="' + (n.dir ? 'dir' : 'file') + '" title="' + escAttr(tip) + '">' +
      '<span class="gap" style="width:' + (item.depth * 14) + 'px"></span>' +
      caret + '<span class="ico">' + icon + '</span>' +
      '<span class="nm">' + esc(n.name) + '</span>' + badgeHtml(n) + right +
      '</div>';
  }

  function renderTree(p) {
    if (!p.tree) return;
    if (p.dirty) { recomputeRows(p); p.dirty = false; }
    var e = paneEls(p.key);
    var sc = e.scroll, sz = e.sizer, layer = e.rows;
    var total = p.rows.length * ROW_H;
    sz.style.height = total + 'px';
    var vh = sc.clientHeight || 400;
    var start = Math.floor(sc.scrollTop / ROW_H) - 4;
    if (start < 0) start = 0;
    var end = Math.min(p.rows.length, Math.ceil((sc.scrollTop + vh) / ROW_H) + 4);
    var buf = [];
    for (var i = start; i < end; i++) buf.push(rowHtml(p.rows[i], p));
    layer.style.transform = 'translateY(' + (start * ROW_H) + 'px)';
    layer.innerHTML = buf.join('');
  }

  function scheduleRender(p) {
    if (p._raf) return;
    p._raf = requestAnimationFrame(function () { p._raf = 0; renderTree(p); });
  }

  /* -------------------------- 两侧滚动联动 -------------------------- */
  // 只让「用户正在操作的那侧」当驱动方，否则两侧会互相拉扯抖动
  var scrollOwner = null, scrollOwnerUntil = 0;
  var SCROLL_GRAB_MS = 150;
  // 程序设置的滚动（联动过去的、点击定位过去的）不该再反向驱动对方
  var progScroll = { A: 0, B: 0 };

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /** 程序性设置某一侧的滚动位置，短时间内抑制它反向驱动对方 */
  function setScrollTop(key, top, left) {
    var sc = paneEls(key).scroll;
    if (left != null) sc.scrollLeft = left;
    sc.scrollTop = top;
    progScroll[key]++;
    setTimeout(function () { if (progScroll[key] > 0) progScroll[key]--; }, 60);
  }

  /** 把 key 侧的位置按「顶部行的路径」映射到另一侧，两侧行数不同也不会错位 */
  function mirrorScroll(key) {
    var src = panes[key], dst = panes[key === 'A' ? 'B' : 'A'];
    if (!src.tree || !dst.tree || !src.rows.length || !dst.rows.length) return;
    var scS = paneEls(src.key).scroll, scD = paneEls(dst.key).scroll;

    var top = scS.scrollTop;
    var idx = Math.floor(top / ROW_H);
    if (idx < 0) idx = 0;
    if (idx > src.rows.length - 1) idx = src.rows.length - 1;
    var n = src.rows[idx] && src.rows[idx].node;
    if (!n) return;

    // 另一侧有同一路径就用精确行号；没有（仅单侧文件）就找它「应处的位置」
    var di = dst.index.get(n.path);
    if (di == null) di = C.locateRow(dst.rows, n.path, n.dir, function (r) { return r.node; });

    var max = Math.max(0, dst.rows.length * ROW_H - scD.clientHeight);
    // 保留行内像素偏移，连续滚动才平滑，不会一格一格跳
    var target = di * ROW_H + (top - idx * ROW_H);
    if (target < 0) target = 0;
    if (target > max) target = max;

    if (Math.abs(scD.scrollTop - target) < 0.5 && scD.scrollLeft === scS.scrollLeft) return;
    setScrollTop(dst.key, target, scS.scrollLeft);
    scheduleRender(dst);
  }

  function onTreeScroll(key) {
    scheduleRender(panes[key]);
    if (!els.scrollSyncToggle || !els.scrollSyncToggle.checked) return;
    if (progScroll[key] > 0) return;                                  // 这是联动带过去的，别再传回去
    var t = nowMs();
    if (scrollOwner && scrollOwner !== key && t < scrollOwnerUntil) return;  // 对侧刚驱动过，先不还手
    scrollOwner = key; scrollOwnerUntil = t + SCROLL_GRAB_MS;
    mirrorScroll(key);
  }

  function bindTree(key) {
    var e = paneEls(key);
    e.scroll.addEventListener('scroll', function () { onTreeScroll(key); });
    e.rows.addEventListener('click', function (ev) {
      var row = ev.target.closest ? ev.target.closest('.row') : null;
      if (!row) return;
      var path = row.getAttribute('data-path');
      if (row.getAttribute('data-kind') === 'dir') toggleDir(key, path);
      else openEntry(key, path);
    });
    window.addEventListener('resize', function () { renderTree(panes[key]); });
  }

  /* --------------------------- 展开 / 折叠 --------------------------- */
  function toggleDir(key, path) {
    var p = panes[key];
    if (p.expanded.has(path)) p.expanded.delete(path); else p.expanded.add(path);
    p.dirty = true;
    renderTree(p);
    if (els.syncToggle.checked) {
      var o = panes[key === 'A' ? 'B' : 'A'];
      if (o.tree && findNode(o, path)) {
        if (p.expanded.has(path)) o.expanded.add(path); else o.expanded.delete(path);
        o.dirty = true; renderTree(o);
      }
    }
    // 展开/折叠会让两侧行数变化（目录里可能有仅单侧文件），重新对齐一次
    if (els.scrollSyncToggle && els.scrollSyncToggle.checked) mirrorScroll(key);
  }

  function findNode(p, path) {
    if (!p.tree) return null;
    return (function search(n) {
      if (n.path === path) return n;
      if (!n.dir) return null;
      for (var i = 0; i < n.children.length; i++) {
        var r = search(n.children[i]);
        if (r) return r;
      }
      return null;
    })(p.tree);
  }

  function expandEach(p, fn) {
    if (!p.tree) return;
    (function walk(n) {
      if (!n.dir) return;
      if (fn(n)) p.expanded.add(n.path);
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
    })(p.tree);
    p.dirty = true;
  }

  function expandToDiff(alsoCollapseOthers) {
    ['A', 'B'].forEach(function (k) {
      var p = panes[k];
      if (!p.tree) return;
      if (alsoCollapseOthers) p.expanded.clear();
      expandEach(p, function (n) { return n.status === 'modified' || n.status === 'onlyA' || n.status === 'onlyB'; });
      renderTree(p);
    });
  }

  function expandAll(key) {
    var p = panes[key];
    if (!p.tree) return;
    expandEach(p, function () { return true; });
    renderTree(p);
    if (els.syncToggle.checked) {
      var o = panes[key === 'A' ? 'B' : 'A'];
      if (o.tree) { expandEach(o, function () { return true; }); renderTree(o); }
    }
  }

  function collapseAll(key) {
    var p = panes[key];
    if (!p.tree) return;
    p.expanded.clear();
    p.dirty = true;
    renderTree(p);
    p.scrollTop = 0;
    paneEls(key).scroll.scrollTop = 0;
    renderTree(p);
    if (els.syncToggle.checked) {
      var o = panes[key === 'A' ? 'B' : 'A'];
      if (o.tree) { o.expanded.clear(); o.dirty = true; renderTree(o); }
    }
  }

  /* =================================================================
   *  四、选中 / 联动 / 预览
   * ================================================================= */

  function revealPath(p, path) {
    if (!p.tree || p.map.get(path) == null) return false;
    var segs = path.split('/');
    var cur = '';
    for (var i = 0; i < segs.length - 1; i++) { cur = cur ? cur + '/' + segs[i] : segs[i]; p.expanded.add(cur); }
    p.dirty = true;
    recomputeRowsIfDirty(p);
    var idx = p.index.get(path);
    if (idx != null) {
      var sc = paneEls(p.key).scroll;
      setScrollTop(p.key, Math.max(0, idx * ROW_H - sc.clientHeight / 2 + ROW_H / 2), null);
    }
    return idx != null;
  }

  function recomputeRowsIfDirty(p) { if (p.dirty) { recomputeRows(p); p.dirty = false; } }

  // 每次打开文件时自增；渲染前校验，避免快速连点导致旧渲染覆盖新内容
  var renderSeq = 0;

  async function openEntry(key, path) {
    var seq = ++renderSeq;
    var p = panes[key];
    var other = panes[key === 'A' ? 'B' : 'A'];
    var sync = els.syncToggle.checked;

    p.selected = path;
    other.selected = null;
    revealPath(p, path);
    var shownOnOther = false;
    if (sync) {
      if (other.map.get(path) != null) { other.selected = path; shownOnOther = revealPath(other, path); }
    }
    recomputeRowsIfDirty(p); recomputeRowsIfDirty(other);
    renderTree(p); renderTree(other);

    state.currentPath = path;
    state.allowBigPreview = false;
    if (state.imgUrl) { URL.revokeObjectURL(state.imgUrl); state.imgUrl = null; }
    openDrawer();
    els.drawerTitle.textContent = path;
    els.drawerSub.textContent = sync && shownOnOther ? 'A / B 双栏联动' : (key === 'A' ? '仅 A 侧' : '仅 B 侧');
    els.drawerBody.innerHTML = '<div class="center-tip">读取中…</div>';

    // 分栏只认文件「属于哪一侧」，不认「点的是哪一侧」：
    // 左栏恒为 A 侧内容、右栏恒为 B 侧内容。否则点 B 侧列表时两侧会被整体调换，
    // 连 diff 的红（A 删除）/ 绿（B 新增）语义也会跟着反过来。
    var ea = panes.A.map.get(path) || null;
    var eb = panes.B.map.get(path) || null;
    if (!sync) { if (key === 'A') eb = null; else ea = null; }   // 关联动：只展示被点击的一侧
    try {
      var ia = ea ? await inspect(ea) : null;
      var ib = eb ? await inspect(eb) : null;
      if (ia) ia.side = 'A';
      if (ib) ib.side = 'B';
      if (seq !== renderSeq) return;
      if (ia && ib) await renderPair(ia, ib, seq);
      else if (ia) await renderSingle('A', ia, seq);
      else if (ib) await renderSingle('B', ib, seq);
      else els.drawerBody.innerHTML = '<div class="center-tip">两侧都没有这个文件的内容。</div>';
    } catch (err) {
      console.error(err);
      els.drawerBody.innerHTML = '<div class="center-tip">读取失败：' + esc(err.message) + '</div>';
    }
  }

  async function inspect(entry) {
    var headLen = Math.min(entry.size, 8192);
    var ab = headLen ? await entry.file.slice(0, headLen).arrayBuffer() : new ArrayBuffer(0);
    var u8 = new Uint8Array(ab);
    var item = state.map ? state.map.get(entry.relPath) : null;
    return {
      entry: entry,
      u8: u8,
      side: null,
      binary: C.isProbablyBinary(u8, entry.file.name),
      over: entry.size > cfg.maxPreviewMB * 1048576 && !state.allowBigPreview,
      hash: item ? (item.a && item.a.file === entry.file ? item.hashA : item.hashB) : null
    };
  }

  /* --------------------------- docx 容器文本提取 --------------------------- */
  // docx 本质是 ZIP：提取 word/document.xml 里的段落文本再走行级 diff，
  // 比「只能看元信息」有用得多。解析失败时回退到元信息，不影响其他文件。
  var DOCX_MAX_BYTES = 50 * 1048576;   // 再大的 docx 不解压（内嵌图片等会放大内存占用）
  var docxCache = new Map();           // File -> Promise<段落数组|null>

  function isDocxLike(info) {
    return !!info && info.binary && C.isZip(info.u8) && /\.docx$/i.test(info.entry.file.name);
  }

  function loadDocxLines(entry) {
    var p = docxCache.get(entry.file);
    if (!p) {
      p = (async function () {
        try { return await C.docxLines(new Uint8Array(await entry.file.arrayBuffer())); }
        catch (e) { return null; }
      })();
      docxCache.set(entry.file, p);
    }
    return p;
  }

  /* --------------------------- 文本内容读取 --------------------------- */
  async function readText(file) {
    var buf = await file.arrayBuffer();
    var u8 = new Uint8Array(buf);
    try { return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(u8)); } catch (e) { /* 非 UTF-8，继续尝试 */ }
    try { return stripBom(new TextDecoder('gbk').decode(u8)); } catch (e2) { /* 浏览器不支持 GBK */ }
    return stripBom(new TextDecoder('latin1').decode(u8));
  }
  function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

  async function renderPair(ia, ib, seq) {
    var path = ia ? ia.entry.relPath : ib.entry.relPath;
    if (!ia || !ib) { await renderSingle(ia ? ia.side : ib.side, ia || ib, seq); return; }

    // docx 容器：提取段落文本再走行级 diff；解压失败才落到下面的元信息分支
    if (isDocxLike(ia) && isDocxLike(ib) &&
        ia.entry.size <= DOCX_MAX_BYTES && ib.entry.size <= DOCX_MAX_BYTES) {
      var da = await loadDocxLines(ia.entry);
      var db = await loadDocxLines(ib.entry);
      if (seq !== renderSeq) return;
      if (da && db) {
        els.btnDocView.hidden = false;
        els.btnDocView.textContent = state.docxView === 'doc' ? '逐行视图' : '文档视图';
        els.btnViewMode.hidden = false;
        els.btnViewMode.textContent = state.viewMode === 'side' ? '统一视图' : '并排视图';
        var rows0 = (da.length > cfg.maxDiffLines || db.length > cfg.maxDiffLines) ? null :
          C.buildSideBySide(C.diffLines(da, db, { ignoreTrailingSpace: cfg.ignoreTrailingWS }));
        if (state.docxView === 'doc' && rows0) {
          renderDocView(da, db, rows0, path, seq);
          els.drawerSub.textContent += ' ｜ docx 已按段落提取文本';
        } else {
          // 逐行视图（或段落数超限时的退化展示）
          renderTextView(da, db, rows0, rows0 == null, path, seq);
          els.drawerSub.textContent += ' ｜ docx 已按段落提取文本';
        }
        return;
      }
    }

    var bothIncomplete = ia.binary || ib.binary || ia.over || ib.over;
    if (bothIncomplete) {
      var notice = (ia.binary || ib.binary)
        ? '至少一侧是二进制文件，只显示元信息' + ((ia.binary && ib.binary) ? '。' : '（另一侧仍可对比文本，但你选择了双栏对比，故统一按元信息展示）。')
        : '文件体积超过预览上限（' + cfg.maxPreviewMB + ' MB），未读取内容。';
      renderMetaPair(ia, ib, notice);
      return;
    }

    var ta = await readText(ia.entry.file);
    var tb = await readText(ib.entry.file);
    if (seq !== renderSeq) return;
    var al = C.splitLines(ta), bl = C.splitLines(tb);

    els.btnDocView.hidden = true;   // 纯文本没有「文档视图」
    els.btnViewMode.hidden = false;
    els.btnViewMode.textContent = state.viewMode === 'side' ? '统一视图' : '并排视图';

    if (al.length > cfg.maxDiffLines || bl.length > cfg.maxDiffLines) {
      renderTextView(al, bl, null, true, path, seq);
      return;
    }
    var ops = C.diffLines(al, bl, { ignoreTrailingSpace: cfg.ignoreTrailingWS });
    var rows = C.buildSideBySide(ops);
    renderTextView(al, bl, rows, false, path, seq);
  }

  async function renderSingle(sideKey, info, seq) {
    els.btnViewMode.hidden = true;
    els.btnDocView.hidden = true;
    if (info.binary || info.over) {
      // docx 单栏：同样提取段落文本展示
      if (isDocxLike(info) && info.entry.size <= DOCX_MAX_BYTES) {
        var lines0 = await loadDocxLines(info.entry);
        if (seq !== renderSeq) return;
        if (lines0) { renderSingleLines(sideKey, info, lines0, 'docx 已按段落提取文本'); return; }
      }
      renderMetaPair(sideKey === 'A' ? info : null, sideKey === 'B' ? info : null,
        info.binary ? '该文件是二进制文件，只显示元信息。' :
          '文件体积超过预览上限（' + cfg.maxPreviewMB + ' MB），未读取内容。');
      return;
    }
    var text = await readText(info.entry.file);
    if (seq !== renderSeq) return;
    renderSingleLines(sideKey, info, C.splitLines(text), null);
  }

  function renderSingleLines(sideKey, info, lines, kindLabel) {
    var lim = Math.min(lines.length, MAX_RENDER_LINES);
    var html = '';
    for (var i = 0; i < lim; i++) html += lineHtml(i, lines, 'l', 'eq');
    var truncated = lines.length > MAX_RENDER_LINES;
    els.drawerTitle.textContent = info.entry.relPath;
    els.drawerSub.textContent = (sideKey || '?') + ' 侧 · ' + C.fmtSize(info.entry.size) +
      (kindLabel ? ' ｜ ' + kindLabel : '');
    els.drawerBody.innerHTML =
      '<div class="diff-wrap">' +
        '<div class="diff-pane">' +
          '<div class="cap"><span class="tag ' + sideKey.toLowerCase() + '">' + sideKey + '</span>' + esc(info.entry.relPath) +
          ' · ' + lines.length + ' 行 · ' + C.fmtSize(info.entry.size) + '</div>' +
          '<div class="diff-content">' + html + (truncated ? '<div class="dl pad"><span class="ln">…</span><span class="tx">已省略后续 ' + (lines.length - MAX_RENDER_LINES) + ' 行</span></div>' : '') + '</div>' +
        '</div>' +
      '</div>';
  }

  function renderTextView(al, bl, rows, tooBig, path, seq) {
    if (seq != null && seq !== renderSeq) return;   // 已被更新的打开请求取代
    var stat = rows ? C.countChanges(rows) : { add: 0, del: 0 };
    els.drawerSub.textContent = rows
      ? ('A / B 双栏联动 · 新增 ' + stat.add + ' 行，删除 ' + stat.del + ' 行')
      : (tooBig ? '文件行数超过 ' + cfg.maxDiffLines + ' 行，未做行级对比' : 'A / B 双栏联动');

    if (!rows) {
      // 退化展示：左右各自原样输出
      rows = [];
      var len = Math.max(al.length, bl.length);
      for (var i = 0; i < len; i++) {
        rows.push({ l: i < al.length ? i : null, r: i < bl.length ? i : null, type: 'eq' });
      }
    }

    var left = [], right = [], unified = [];
    var limit = rows.length;
    var truncatedRows = 0;
    if (limit > MAX_RENDER_LINES) { truncatedRows = limit - MAX_RENDER_LINES; limit = MAX_RENDER_LINES; }

    for (var k = 0; k < limit; k++) {
      var r = rows[k];
      left.push(lineHtml(r.l, al, 'l', r.type));
      right.push(lineHtml(r.r, bl, 'r', r.type));
      if (r.type === 'del') unified.push(lineHtml(r.l, al, 'u', 'del'));
      else if (r.type === 'ins') unified.push(lineHtml(r.r, bl, 'u', 'ins'));
      else if (r.type === 'mod') {
        unified.push(lineHtml(r.l, al, 'u', 'del'));
        unified.push(lineHtml(r.r, bl, 'u', 'ins'));
      } else unified.push(lineHtml(r.l, al, 'u', 'eq'));
    }
    if (truncatedRows) {
      var more = '<div class="dl pad"><span class="ln">…</span><span class="tx">已省略后续 ' + truncatedRows + ' 行</span></div>';
      left.push(more); right.push(more); unified.push(more);
    }

    if (state.viewMode === 'side') {
      els.drawerBody.innerHTML =
        '<div class="diff-wrap">' +
          '<div class="diff-pane"><div class="cap"><span class="tag a">A</span>' + esc(path) + ' · ' + al.length + ' 行</div>' +
          '<div class="diff-content" id="diffLeft">' + left.join('') + '</div></div>' +
          '<div class="diff-pane"><div class="cap"><span class="tag b">B</span>' + esc(path) + ' · ' + bl.length + ' 行</div>' +
          '<div class="diff-content" id="diffRight">' + right.join('') + '</div></div>' +
        '</div>';
      bindDiffScrollSync();
    } else {
      els.drawerBody.innerHTML =
        '<div class="diff-wrap"><div class="diff-pane">' +
          '<div class="cap"><span class="tag a">A</span>/<span class="tag b">B</span>' + esc(path) + ' · 统一视图</div>' +
          '<div class="diff-content">' + unified.join('') + '</div>' +
        '</div></div>';
    }
  }

  function lineHtml(idx, lines, paneKind, type) {
    if (idx == null || idx >= lines.length) {
      return '<div class="dl pad"><span class="ln"></span><span class="tx">&nbsp;</span></div>';
    }
    var cls = '';
    if (paneKind === 'l') cls = (type === 'del' || type === 'mod') ? 'del' : '';
    else if (paneKind === 'r') cls = (type === 'ins' || type === 'mod') ? 'ins' : '';
    else cls = type === 'del' ? 'del' : (type === 'ins' ? 'ins' : '');

    var prefix = paneKind === 'u' ? (type === 'del' ? '− ' : type === 'ins' ? '+ ' : '  ') : '';
    var tx = esc(lines[idx]);
    if (tx === '') tx = '&nbsp;';
    return '<div class="dl ' + cls + '"><span class="ln">' + (idx + 1) + '</span><span class="tx">' + prefix + tx + '</span></div>';
  }

  /* --------------------- docx 文档视图（字符级差异） --------------------- */
  // 段落流式排版 + 字符级 diff：mod 段只标真正不同的几个字（红删除线 / 绿下划线），
  // 而不是整段染色。并排 = 双列对齐（CSS Grid 天然保证行高一致）；统一 = Redline 单栏。
  var CHAR_DIFF_MAX_CELLS = 1000000;   // 单段字符数乘积上限，超出退化为整段标记

  /** 把字符级 spans 渲染成 html。side='A' 只显示 eq+del；'B' 只显示 eq+ins；'u' 全显示（Redline）。 */
  function spansHtml(spans, side) {
    var out = '';
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      var t = esc(sp.s);
      if (sp.t === 'eq') out += t;
      else if (sp.t === 'del' && (side === 'A' || side === 'u')) out += '<span class="cdel">' + t + '</span>';
      else if (sp.t === 'ins' && (side === 'B' || side === 'u')) out += '<span class="cins">' + t + '</span>';
      // 另一侧独有的字符在本侧不渲染（A 侧看不到 B 新增的字符）
    }
    return out;
  }

  /** 成对段落（mod）的字符级对比结果，带超长退化 */
  function charSpans(aText, bText) {
    if ((aText.length + 1) * (bText.length + 1) > CHAR_DIFF_MAX_CELLS) return null;
    return C.diffChars(aText, bText);
  }

  function renderDocView(al, bl, rows, path, seq) {
    if (seq != null && seq !== renderSeq) return;
    var nMod = 0, nDel = 0, nIns = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].type === 'mod') nMod++;
      else if (rows[i].type === 'del') nDel++;
      else if (rows[i].type === 'ins') nIns++;
    }
    els.drawerSub.textContent = '文档视图 · 修改 ' + nMod + ' 段，新增 ' + nIns + ' 段，删除 ' + nDel + ' 段';

    var uni = state.viewMode === 'unified';
    var body = [];
    var limit = rows.length, truncatedRows = 0;
    if (limit > MAX_RENDER_LINES) { truncatedRows = limit - MAX_RENDER_LINES; limit = MAX_RENDER_LINES; }
    for (var k = 0; k < limit; k++) {
      var r = rows[k];
      if (r.type === 'eq') {
        var t = esc(al[r.l]); if (t === '') t = '&nbsp;';
        body.push(uni
          ? '<div class="docrow"><div class="docp">' + t + '</div></div>'
          : '<div class="docrow"><div class="docp">' + t + '</div><div class="docp">' + esc(bl[r.r]) + '</div></div>');
      } else if (r.type === 'mod') {
        var spans = charSpans(al[r.l], bl[r.r]);
        if (uni) {
          body.push('<div class="docrow"><div class="docp">' +
            (spans ? spansHtml(spans, 'u')
                   : '<span class="cdel">' + esc(al[r.l]) + '</span><span class="cins">' + esc(bl[r.r]) + '</span>') +
            '</div></div>');
        } else {
          body.push('<div class="docrow">' +
            '<div class="docp">' + (spans ? spansHtml(spans, 'A') : '<span class="cdel">' + esc(al[r.l]) + '</span>') + '</div>' +
            '<div class="docp">' + (spans ? spansHtml(spans, 'B') : '<span class="cins">' + esc(bl[r.r]) + '</span>') + '</div>' +
            '</div>');
        }
      } else if (r.type === 'del') {
        body.push(uni
          ? '<div class="docrow"><div class="docp pdel"><span class="cdel">' + esc(al[r.l]) + '</span></div></div>'
          : '<div class="docrow"><div class="docp pdel"><span class="cdel">' + esc(al[r.l]) + '</span></div><div class="docp empty">&nbsp;</div></div>');
      } else { // ins
        body.push(uni
          ? '<div class="docrow"><div class="docp pins"><span class="cins">' + esc(bl[r.r]) + '</span></div></div>'
          : '<div class="docrow"><div class="docp empty">&nbsp;</div><div class="docp pins"><span class="cins">' + esc(bl[r.r]) + '</span></div></div>');
      }
    }

    if (truncatedRows) {
      body.push('<div class="docrow"><div class="docp empty">已省略后续 ' + truncatedRows +
        ' 段（超过渲染上限 ' + MAX_RENDER_LINES + '）</div>' + (uni ? '' : '<div class="docp empty">&nbsp;</div>') + '</div>');
    }

    var cap = '<div class="docrow"><div class="doccap"><span class="tag a">A</span> ' + esc(path) + ' · ' + al.length + ' 段</div>' +
      '<div class="doccap"><span class="tag b">B</span> ' + esc(path) + ' · ' + bl.length + ' 段</div></div>';
    els.drawerBody.innerHTML = '<div class="docwrap' + (uni ? ' uni' : '') + '">' +
      (uni
        ? '<div class="docrow"><div class="doccap"><span class="tag a">A</span>/<span class="tag b">B</span> ' + esc(path) + ' · Redline 合并视图</div></div>'
        : cap) +
      body.join('') + '</div>';
  }

  function bindDiffScrollSync() {
    var l = $('diffLeft'), r = $('diffRight');
    if (!l || !r) return;
    var lock = false;
    function sync(a, b) {
      return function () {
        if (lock) { lock = false; return; }
        lock = true;
        b.scrollTop = a.scrollTop;
        requestAnimationFrame(function () { lock = false; });
      };
    }
    l.addEventListener('scroll', sync(l, r));
    r.addEventListener('scroll', sync(r, l));
  }

  /* --------------------------- 元信息 / 二进制 --------------------------- */
  function renderMetaPair(ia, ib, notice) {
    els.btnViewMode.hidden = true;
    els.btnDocView.hidden = true;
    if (state.imgUrl) { URL.revokeObjectURL(state.imgUrl); state.imgUrl = null; }
    var path = ia ? ia.entry.relPath : ib.entry.relPath;
    els.drawerSub.textContent = '二进制 / 超大文件：仅元信息';

    var html = '<div class="meta-wrap">';
    if (notice) html += '<div style="flex:1 0 100%;"><div class="notice">' + esc(notice) +
      ' <button class="btn sm" id="btnForcePreview">仍要加载</button></div></div>';
    html += metaCard('A', ia, path) + metaCard('B', ib, path);
    html += '</div>';
    els.drawerBody.innerHTML = html;

    var btn = $('btnForcePreview');
    if (btn) {
      btn.addEventListener('click', function () {
        state.allowBigPreview = true;
        reopenCurrent();
      });
    }
    buildMetaAttach(ia, ib);
  }

  /** 图片预览：只有 image/* 才生成 blob 预览，其余留空（已有十六进制预览兜底） */
  function buildMetaAttach(ia, ib) {
    ['A', 'B'].forEach(function (side) {
      var info = side === 'A' ? ia : ib;
      var box = $('img-' + side);
      if (!info || !box) return;
      if (info.entry.file.type && info.entry.file.type.indexOf('image/') === 0) {
        var im = document.createElement('img');
        im.className = 'imgpreview';
        im.src = URL.createObjectURL(info.entry.file);
        state.imgUrl = im.src;
        box.appendChild(im);
      }
    });
  }

  function metaCard(sideKey, info, path) {
    if (!info) {
      return '<div class="meta-card missing"><h4><span class="side-tag ' + sideKey.toLowerCase() + '">' + sideKey + '</span>不存在</h4>' +
        '<div class="kv"><dt>路径</dt><dd>' + esc(path) + '</dd></div>' +
        '<p class="notice info" style="margin-top:10px">这一侧没有同名文件。</p></div>';
    }
    var e = info.entry;
    return '<div class="meta-card">' +
      '<h4><span class="side-tag ' + sideKey.toLowerCase() + '">' + sideKey + '</span>' + esc(e.file.name) + '</h4>' +
      '<dl class="kv">' +
        '<dt>相对路径</dt><dd>' + esc(e.relPath) + '</dd>' +
        '<dt>大小</dt><dd>' + C.fmtSize(e.size) + '（' + e.size + ' 字节）</dd>' +
        '<dt>类型</dt><dd>' + esc(e.file.type || C.guessExt(e.file.name) || '未知') + '</dd>' +
        '<dt>修改时间</dt><dd>' + C.fmtTime(e.mtime) + '</dd>' +
        '<dt>SHA-256</dt><dd>' + esc(info.hash || '—（未参与内容哈希）') + '</dd>' +
      '</dl>' +
      '<div id="img-' + sideKey + '"></div>' +
      '<div class="hexview">' + esc(C.toHexPreview(info.u8, 256)) + '</div>' +
      '</div>';
  }

  function reopenCurrent() {
    if (!state.currentPath) return Promise.resolve();
    var key = panes.A.map.get(state.currentPath) ? 'A' : 'B';
    return openEntry(key, state.currentPath);
  }

  /* --------------------------- 抽屉控制 --------------------------- */
  function openDrawer() { els.drawer.style.height = (drawerHeight || 320) + 'px'; }
  function closeDrawer() {
    els.drawer.style.height = '0px';
    state.currentPath = null;
    els.drawerTitle.textContent = '未选择文件';
    els.drawerSub.textContent = '';
    els.drawerBody.innerHTML = '<div class="center-tip">点击任意文件查看内容 / 差异。<br />点目录可展开折叠；橙 / 玫红 / 红色行 = 差异项。</div>';
    els.btnViewMode.hidden = true;
    els.btnDocView.hidden = true;
  }
  var drawerHeight = 320;

  function gotoDiff(dir) {
    var list = state.diffList;
    if (!list.length) return;
    var i = state.currentPath ? list.indexOf(state.currentPath) : -1;
    if (i < 0) i = dir > 0 ? -1 : 0;
    i = (i + dir + list.length * 2) % list.length;
    var path = list[i];
    var key = panes.A.map.get(path) ? 'A' : 'B';
    if (els.syncToggle.checked) key = panes.A.map.get(path) ? 'A' : 'B';
    openEntry(key, path);
  }

  /* =================================================================
   *  五、工具栏 / 设置 / 事件绑定
   * ================================================================= */

  function refreshToolbar() {
    var ready = panes.A.tree && panes.B.tree;
    els.btnRecompare.disabled = !ready || state.busy;
  }

  function toast(msg) {
    els.progressText.textContent = msg;
    els.progress.hidden = false;
    els.progress.classList.add('indet');
    setTimeout(function () { if (!state.busy) hideProgress(); }, 2600);
  }

  var applySearch = debounce(function () {
    state.query = els.search.value || '';
    ['A', 'B'].forEach(function (k) { panes[k].dirty = true; renderTree(panes[k]); paneEls(k).scroll.scrollTop = 0; renderTree(panes[k]); });
  }, 200);

  function bindToolbar() {
    els.search.addEventListener('input', applySearch);

    els.filters.addEventListener('click', function (ev) {
      var chip = ev.target.closest('.chip');
      if (!chip) return;
      var st = chip.getAttribute('data-status');
      if (st) {
        state.show[st] = !state.show[st];
        chip.classList.toggle('active', state.show[st]);
        if (st === 'same' && !state.show.same) {
          els.chipOnlyDiff.classList.add('active');
        } else if (st === 'same' && state.show.same) {
          els.chipOnlyDiff.classList.remove('active');
        }
      } else if (chip === els.chipOnlyDiff) {
        state.onlyDiff = !state.onlyDiff;
        els.chipOnlyDiff.classList.toggle('active', state.onlyDiff);
        ['onlyA', 'onlyB', 'modified', 'same'].forEach(function (s) {
          state.show[s] = s === 'same' ? !state.onlyDiff : true;
        });
        Array.prototype.forEach.call(els.filters.querySelectorAll('[data-status]'), function (c) {
          c.classList.toggle('active', state.show[c.getAttribute('data-status')]);
        });
      }
      ['A', 'B'].forEach(function (k) { panes[k].dirty = true; renderTree(panes[k]); });
    });

    els.btnExpandDiff.addEventListener('click', function () { expandToDiff(true); });
    els.btnExpandAll.addEventListener('click', function () { expandAll('A'); });
    els.btnCollapseAll.addEventListener('click', function () { collapseAll('A'); });

    els.btnRecompare.addEventListener('click', function () {
      if (!state.busy) runCompare();
    });
    els.btnClear.addEventListener('click', function () { clearPane('A'); clearPane('B'); });
    els.btnCancel.addEventListener('click', function () { state.cancel = true; });

    els.btnNextDiff.addEventListener('click', function () { gotoDiff(1); });
    els.btnPrevDiff.addEventListener('click', function () { gotoDiff(-1); });
    els.btnCloseDrawer.addEventListener('click', closeDrawer);
    els.btnViewMode.addEventListener('click', function () {
      state.viewMode = state.viewMode === 'side' ? 'unified' : 'side';
      reopenCurrent();
    });
    els.btnDocView.addEventListener('click', function () {
      state.docxView = state.docxView === 'doc' ? 'line' : 'doc';
      reopenCurrent();
    });

    els.btnSettings.addEventListener('click', openSettings);
    els.btnCloseSettings.addEventListener('click', function () { els.settingsModal.hidden = true; });
    els.btnResetIgnore.addEventListener('click', function () { els.ignoreInput.value = C.DEFAULT_IGNORE; });
    els.btnSaveSettings.addEventListener('click', function () {
      cfg.ignore = els.ignoreInput.value;
      cfg.maxHashMB = Math.max(0, Number(els.inpMaxHash.value) || 0);
      cfg.maxPreviewMB = Math.max(1, Number(els.inpMaxPreview.value) || 1);
      cfg.maxDiffLines = Math.max(100, Number(els.inpMaxLines.value) || 100);
      cfg.maxFiles = Math.max(1000, Number(els.inpMaxFiles.value) || 1000);
      cfg.ignoreTrailingWS = els.inpIgnoreWS.checked;
      saveCfg();
      els.settingsModal.hidden = true;
      // 忽略规则变了 -> 重建两侧条目再比对
      ['A', 'B'].forEach(function (k) { if (panes[k].raw.length) rebuildEntries(panes[k]); });
      closeDrawer();
      if (panes.A.tree && panes.B.tree) runCompare();
      else ['A', 'B'].forEach(function (k) { renderTree(panes[k]); });
    });

    els.settingsModal.addEventListener('click', function (e) {
      if (e.target === els.settingsModal) els.settingsModal.hidden = true;
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!els.settingsModal.hidden) els.settingsModal.hidden = true;
        else closeDrawer();
      }
    });

    window.addEventListener('resize', function () { renderTree(panes.A); renderTree(panes.B); });
  }

  function openSettings() {
    els.ignoreInput.value = cfg.ignore;
    els.inpMaxHash.value = cfg.maxHashMB;
    els.inpMaxPreview.value = cfg.maxPreviewMB;
    els.inpMaxLines.value = cfg.maxDiffLines;
    els.inpMaxFiles.value = cfg.maxFiles;
    els.inpIgnoreWS.checked = cfg.ignoreTrailingWS;
    els.settingsModal.hidden = false;
  }

  /* --------------------------- 分隔条拖拽 --------------------------- */
  function bindSplitters() {
    var dragging = null;
    els.vsplit.addEventListener('mousedown', function (e) { dragging = 'v'; e.preventDefault(); });
    els.hsplit.addEventListener('mousedown', function (e) { dragging = 'h'; e.preventDefault(); });
    els.hsplit.addEventListener('dblclick', closeDrawer);
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      if (dragging === 'v') {
        var rect = els.main.getBoundingClientRect();
        var pct = (e.clientX - rect.left) / rect.width * 100;
        pct = Math.max(15, Math.min(85, pct));
        els.paneA.style.width = pct + '%';
        renderTree(panes.A); renderTree(panes.B);
      } else {
        var h = window.innerHeight - e.clientY;
        h = Math.max(0, Math.min(window.innerHeight - 160, h));
        drawerHeight = h;
        els.drawer.style.height = h + 'px';
      }
    });
    window.addEventListener('mouseup', function () { dragging = null; });
  }

  /* --------------------------- 启动 --------------------------- */
  bindPick('A'); bindPick('B');
  bindTree('A'); bindTree('B');
  bindToolbar();
  bindSplitters();
  refreshToolbar();
  els.btnRecompare.disabled = true;
  els.btnNextDiff.disabled = true;
  els.btnPrevDiff.disabled = true;

  // 冒烟自检钩子：供自动化测试驱动（不影响正常使用）
  window.__folderDiff = {
    panes: panes, state: state, cfg: cfg, Core: C,
    setRaw: setRaw, openEntry: openEntry, renderTree: renderTree,
    runCompare: runCompare, rebuildEntries: rebuildEntries, reopen: reopenCurrent,
    rowCount: function (k) { return panes[k].rows.length; },
    setViewMode: function (mode) { state.viewMode = mode; return reopenCurrent(); },
    setDocxView: function (mode) { state.docxView = mode; return reopenCurrent(); }
  };
})();
