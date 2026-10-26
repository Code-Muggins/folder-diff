/* =====================================================================
 * core.js —— 纯逻辑层（不依赖 DOM，可在 Node 下做单元测试）
 * 1) Sha256：流式 SHA-256 纯 JS 实现
 *    —— 为什么不用 crypto.subtle？它只在"安全上下文"里可用，
 *       而本工具要求双击 index.html（file:// 协议）也能跑稳妥起见自己实现。
 * 2) Ignore：忽略规则的解析与匹配
 * 3) Tree：扁平文件列表 -> 目录树
 * 4) Diff：差异比对模型（先看大小，大小相同再比哈希）
 * 5) LineDiff：逐行 LCS 文本差异
 * ===================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------- SHA-256 ---------------------------- */

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function Sha256() { this.reset(); }

  Sha256.prototype.reset = function () {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.w = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.total = 0;
    this.done = false;
    return this;
  };

  Sha256.prototype.update = function (bytes) {
    if (this.done) throw new Error('Sha256：摘要已结束，不能再写入数据');
    let data = bytes;
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    let off = 0;
    const len = data.length;
    this.total += len;

    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, len);
      if (take > 0) {
        this.buf.set(data.subarray(0, take), this.bufLen);
        this.bufLen += take;
        off = take;
      }
      if (this.bufLen === 64) {
        this._block(this.buf);
        this.bufLen = 0;
      }
    }
    while (len - off >= 64) {
      this._block(data.subarray(off, off + 64));
      off += 64;
    }
    if (off < len) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = len - off;
    }
    return this;
  };

  Sha256.prototype._block = function (b) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) {
      w[i] = (((b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3])) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & bb) ^ (a & c) ^ (bb & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = bb; bb = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + bb) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  };

  Sha256.prototype.digest = function () {
    if (this.done) throw new Error('Sha256：摘要已结束');
    const bitLenHi = Math.floor(this.total / 0x20000000); // total * 8 / 2^32
    const bitLenLo = (this.total * 8) % 0x100000000;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    const lp = padLen;
    tail[lp] = (bitLenHi >>> 24) & 0xff; tail[lp + 1] = (bitLenHi >>> 16) & 0xff;
    tail[lp + 2] = (bitLenHi >>> 8) & 0xff; tail[lp + 3] = bitLenHi & 0xff;
    tail[lp + 4] = (bitLenLo >>> 24) & 0xff; tail[lp + 5] = (bitLenLo >>> 16) & 0xff;
    tail[lp + 6] = (bitLenLo >>> 8) & 0xff; tail[lp + 7] = bitLenLo & 0xff;
    this.done = false; // 临时放行：digest 还要再喂一次填充块
    this.update(tail);
    this.done = true;
    const HEX = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 8; i++) {
      const v = this.h[i];
      out += HEX[(v >>> 28) & 15] + HEX[(v >>> 24) & 15] + HEX[(v >>> 20) & 15] + HEX[(v >>> 16) & 15] +
             HEX[(v >>> 12) & 15] + HEX[(v >>> 8) & 15] + HEX[(v >>> 4) & 15] + HEX[v & 15];
    }
    return out;
  };

  /**
   * 流式计算文件哈希：分片读取，避免把大文件一次性读进内存。
   * @param {File|{size:number, slice:(a:number,b:number)=>{arrayBuffer:()=>Promise<ArrayBuffer>}}} file
   * @param {number} chunkSize 分片大小，默认 1 MiB
   */
  async function hashFile(file, chunkSize) {
    const size = chunkSize || (1 << 20);
    const sha = new Sha256();
    if (!file || !file.size) return sha.digest();
    let pos = 0;
    while (pos < file.size) {
      const end = Math.min(pos + size, file.size);
      const buf = await file.slice(pos, end).arrayBuffer();
      sha.update(new Uint8Array(buf));
      pos = end;
    }
    return sha.digest();
  }

  /* --------------------------- 忽略规则 --------------------------- */

  const DEFAULT_IGNORE = [
    'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.DS_Store',
    'Thumbs.db', '__pycache__', '.cache', '*.log', '*.tmp'
  ].join('\n');

  function wildcardToRegExp(pat) {
    let p = String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    p = p.replace(/\*\*/g, '\u0000');
    p = p.replace(/\*/g, '[^/]*');
    p = p.replace(/\u0000/g, '.*');
    p = p.replace(/\?/g, '[^/]');
    return new RegExp('^' + p + '$');
  }

  /** @param {string} text 换行或逗号分隔的规则；以 ! 开头表示“取消忽略” */
  function parseIgnoreRules(text) {
    const raw = String(text || '').split(/[\n,]/).map(s => s.trim().replace(/^\/|\/$/g, '')).filter(Boolean);
    return raw.map(item => {
      const neg = item.charAt(0) === '!';
      const pat = neg ? item.slice(1).trim() : item;
      return { raw: item, neg, hasSlash: pat.indexOf('/') >= 0, re: wildcardToRegExp(pat) };
    });
  }

  function ruleMatches(rule, relPath) {
    if (rule.re.test(relPath)) return true;
    if (rule.hasSlash) {
      // 带斜杠的规则：允许命中任意中间层级，例如 build/** 也能匹配 svc/build/out.o
      var i = relPath.indexOf('/');
      while (i >= 0) {
        if (rule.re.test(relPath.slice(i + 1))) return true;
        i = relPath.indexOf('/', i + 1);
      }
      return false;
    }
    var segs = relPath.split('/');
    for (var j = 0; j < segs.length; j++) if (rule.re.test(segs[j])) return true;
    return false;
  }

  function isIgnored(relPath, rules) {
    let ignored = false;
    for (let i = 0; i < rules.length; i++) {
      if (!rules[i].neg && ruleMatches(rules[i], relPath)) ignored = true;
    }
    if (ignored) {
      for (let i = 0; i < rules.length; i++) {
        if (rules[i].neg && ruleMatches(rules[i], relPath)) return false; // 反选优先
      }
    }
    return ignored;
  }

  /* ----------------------------- 目录树 ----------------------------- */

  function cmpName(a, b) {
    return a === b ? 0 : String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  }

  /**
   * 比较两个节点在树「先序遍历」中的先后位置（与树内排序一致：目录优先，其次名称自然序）。
   * 两侧行数不同时（存在仅单侧文件），用它定位某个路径在另一侧「应处的位置」，
   * 从而让滚动联动按路径锚点对齐，而不是按行号硬对齐。
   * @param {string} pa 相对路径（根为 ''）
   * @param {boolean} da 是否为目录
   * @returns {number} <0 表示 a 在前，0 表示同一节点，>0 表示 a 在后
   */
  function cmpTreeOrder(pa, da, pb, db) {
    if (pa === pb) return 0;
    // 祖先始终排在后代之前（根在最前）
    if (pa === '' || pb.indexOf(pa + '/') === 0) return -1;
    if (pb === '' || pa.indexOf(pb + '/') === 0) return 1;
    const sa = pa.split('/'), sb = pb.split('/');
    let i = 0;
    while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
    // 分叉层：中间层必然是目录，只有末端才可能是文件
    const ca = i === sa.length - 1 ? !!da : true;
    const cb = i === sb.length - 1 ? !!db : true;
    if (ca !== cb) return ca ? -1 : 1;   // 目录排在文件前面
    return cmpName(sa[i], sb[i]);
  }

  /**
   * 在已扁平化的行序列里二分定位 path 所在（或应插入的）行下标。
   * @param {Array<{node:{path:string,dir:boolean}}>|Array<{path:string,dir:boolean}>} rows
   * @param {(r:any)=>{path:string,dir:boolean}} [getNode]
   */
  function locateRow(rows, path, isDir, getNode) {
    const get = getNode || function (r) { return r; };
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const n = get(rows[mid]);
      if (cmpTreeOrder(n.path, !!n.dir, path, !!isDir) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 扁平文件列表 -> 树。约定：目录排在前，其次按名称自然序。
   * @param {Array<{relPath:string,size:number,mtime:number,file:File}>} entries
   * @param {string} rootName
   */
  function buildTree(entries, rootName) {
    const root = { name: rootName || '/', path: '', dir: true, children: [], size: 0, files: 0, status: 'same' };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const segs = e.relPath.split('/');
      let cur = root;
      let acc = '';
      for (let j = 0; j < segs.length - 1; j++) {
        acc = acc ? acc + '/' + segs[j] : segs[j];
        let next = null;
        for (let k = 0; k < cur.children.length; k++) {
          const c = cur.children[k];
          if (c.dir && c.name === segs[j]) { next = c; break; }
        }
        if (!next) {
          next = { name: segs[j], path: acc, dir: true, children: [], size: 0, files: 0, status: 'same' };
          cur.children.push(next);
        }
        cur = next;
      }
      const node = {
        name: segs[segs.length - 1], path: e.relPath, dir: false,
        children: null, size: e.size, mtime: e.mtime, files: 1, entry: e, status: 'same'
      };
      cur.children.push(node);
    }
    rollAggregate(root);
    return root;
  }

  function rollAggregate(node) {
    if (!node.dir) { node.files = 1; node.size = node.size || 0; return; }
    let size = 0, files = 0;
    for (let i = 0; i < node.children.length; i++) {
      rollAggregate(node.children[i]);
      size += node.children[i].size;
      files += node.children[i].files;
    }
    node.size = size;
    node.files = files;
    node.children.sort(function (a, b) {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return cmpName(a.name, b.name);
    });
  }

  /**
   * 自底向上汇总目录状态：任一子项有差异 -> modified；子项全部只在一侧 -> onlyX；否则 same。
   * 好处：折叠状态下也能一眼看出"哪个目录有问题"。
   */
  function rollupStatus(node) {
    if (!node.dir) return node.status;
    if (!node.children.length) { node.status = 'same'; return node.status; }
    let hasMod = false, allA = true, allB = true;
    for (let i = 0; i < node.children.length; i++) {
      const s = rollupStatus(node.children[i]);
      if (s === 'modified') hasMod = true;
      if (s !== 'onlyA') allA = false;
      if (s !== 'onlyB') allB = false;
    }
    if (hasMod) node.status = 'modified';
    else if (allA) node.status = 'onlyA';
    else if (allB) node.status = 'onlyB';
    else node.status = 'same';
    return node.status;
  }

  /* ============================ 差异比对 ============================ */
  // 状态：onlyA / onlyB / same / modified / pending（待算哈希）

  /**
   * 建立比对模型。
   * 策略：路径+文件名配对 -> 先比 size（不同则说明一定变了，不必读内容）
   *       -> size 相同且未超限：待算哈希（pending）
   *       -> size 相同但超过单文件上限：不读内容，标 verified=false（保守判为相同）
   */
  function buildCompareModel(listA, listB, maxHashBytes) {
    const mapA = new Map(), mapB = new Map();
    for (let i = 0; i < listA.length; i++) mapA.set(listA[i].relPath, listA[i]);
    for (let i = 0; i < listB.length; i++) mapB.set(listB[i].relPath, listB[i]);

    const map = new Map();
    mapA.forEach(function (ea, p) {
      const eb = mapB.get(p) || null;
      if (!eb) { map.set(p, { path: p, a: ea, b: null, status: 'onlyA', verified: true, reason: 'missing' }); return; }
      if (ea.size !== eb.size) {
        map.set(p, { path: p, a: ea, b: eb, status: 'modified', verified: true, reason: 'size' });
      } else if (maxHashBytes > 0 && ea.size > maxHashBytes) {
        map.set(p, { path: p, a: ea, b: eb, status: 'same', verified: false, reason: 'oversize' });
      } else {
        map.set(p, { path: p, a: ea, b: eb, status: 'pending', verified: false, reason: '' });
      }
    });
    mapB.forEach(function (eb, p) {
      if (!mapA.has(p)) map.set(p, { path: p, a: null, b: eb, status: 'onlyB', verified: true, reason: 'missing' });
    });
    return map;
  }

  function pendingEntries(map) {
    const out = [];
    map.forEach(function (e) { if (e.status === 'pending') out.push(e); });
    return out;
  }

  function finalizeEntry(e, hashA, hashB) {
    e.hashA = hashA; e.hashB = hashB;
    e.verified = true;
    e.status = (hashA && hashB && hashA === hashB) ? 'same' : 'modified';
    e.reason = e.status === 'modified' ? 'hash' : '';
    return e.status;
  }

  /* ============================ 文本差异 ============================ */

  function splitLines(text) { return String(text).split(/\r\n|\r|\n/); }

  const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'svgz',
    'pdf', 'zip', 'jar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'iso',
    'class', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'wasm',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'vsdx',
    'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'wav', 'mp4', 'mov', 'avi',
    'webm', 'sqlite', 'sqlite3', 'db', 'dat', 'bin', 'pyc', 'obj'
  ]);

  function guessExt(name) {
    const i = String(name).lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }

  /** 先按常见扩展名判，再看前若干字节里的控制字符比例 */
  function isProbablyBinary(headBytes, name) {
    const ext = guessExt(name);
    if (BINARY_EXT.has(ext)) return true;
    const u8 = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes || 0);
    const n = Math.min(u8.length, 4096);
    if (!n) return false;
    let suspicious = 0;
    for (let i = 0; i < n; i++) {
      const c = u8[i];
      if (c === 0) return true;
      if (c < 9 || (c > 13 && c < 32)) suspicious++;
    }
    return suspicious / n > 0.02;
  }

  /* ------------------------- ZIP 容器 / docx ------------------------- */

  /** ZIP 魔数 PK（docx / xlsx / pptx / jar / apk 都是 ZIP 容器） */
  function isZip(u8) {
    return !!u8 && u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B &&
      (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07);
  }

  /** 用浏览器/Node 自带的 DecompressionStream 做 raw-deflate 解压（零第三方依赖） */
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前环境不支持 DecompressionStream');
    }
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * 解析 ZIP 容器，返回 [{ name, data }]。思路：
   * 1) 从文件末尾找 End Of Central Directory（签名 PK\x05\x06），拿到中央目录偏移；
   * 2) 逐个中央目录条目拿元信息；真正数据的位置要看对应 local header 的名字/额外字段长度
   *    （两者可能与中央目录里的不一致）。
   * 支持 stored(0) 与 deflate(8)；不支持 Zip64 / 加密（docx 用不到）。
   */
  async function readZipEntries(u8) {
    if (!isZip(u8)) throw new Error('不是 ZIP 文件');
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    const back = Math.max(0, u8.length - 22 - 65535);
    for (let i = u8.length - 22; i >= back; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 ZIP 目录（EOCD）');
    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const out = [];
    for (let i = 0; i < count; i++) {
      if (view.getUint32(off, true) !== 0x02014b50) throw new Error('中央目录损坏 @' + off);
      const method = view.getUint16(off + 10, true);
      const csize = view.getUint32(off + 20, true);
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const lho = view.getUint32(off + 42, true);
      const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
      const dataOff = lho + 30 + view.getUint16(lho + 26, true) + view.getUint16(lho + 28, true);
      const raw = u8.subarray(dataOff, dataOff + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('不支持的压缩方式 method=' + method);
      out.push({ name: name, data: data });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /** XML 实体反转义（docx 文本里会遇到 lt/gt/amp/quot/apos 与数字引用） */
  function xmlUnescape(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, function (m, e) {
      switch (e) {
        case 'lt': return '<'; case 'gt': return '>'; case 'amp': return '&';
        case 'quot': return '"'; case 'apos': return "'";
      }
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code ? String.fromCodePoint(code) : m;
    });
  }

  /**
   * 从 word/document.xml 提取段落文本：每个 <w:p> 算「一行」，行内拼接所有 <w:t>。
   * 空段落也保留，保证两侧行号能对齐，diff 才不会错位。
   */
  function extractDocxLines(xml) {
    const lines = [];
    const reP = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
    const reT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let mp;
    while ((mp = reP.exec(xml))) {
      let text = '', mt;
      reT.lastIndex = 0;
      while ((mt = reT.exec(mp[1]))) text += mt[1];
      lines.push(xmlUnescape(text));
    }
    return lines;
  }

  /** docx → 段落文本数组；不是 docx（没有 word/document.xml）返回 null，由调用方回退元信息 */
  async function docxLines(u8) {
    if (!isZip(u8)) return null;
    const entries = await readZipEntries(u8);
    let doc = null;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].name === 'word/document.xml') { doc = entries[i]; break; }
    }
    if (!doc) return null;
    return extractDocxLines(new TextDecoder('utf-8').decode(doc.data));
  }

  /**
   * 逐行 LCS。先砍掉公共前后缀（真实修改通常只占中间一小段），
   * 再对中间段做 DP；规模过大时退化为“整块替换”，避免 O(n*m) 卡死。
   * @returns {Array<{t:'eq'|'del'|'ins', ai:number, bj:number}>}
   */
  function diffLines(aLines, bLines, opts) {
    const o = opts || {};
    const maxCells = o.maxCells || 4000000;
    const key = o.ignoreTrailingSpace
      ? function (s) { return s.replace(/[ \t]+$/, ''); }
      : function (s) { return s; };

    let start = 0;
    while (start < aLines.length && start < bLines.length && key(aLines[start]) === key(bLines[start])) start++;
    let end = 0;
    while (end < aLines.length - start && end < bLines.length - start &&
           key(aLines[aLines.length - 1 - end]) === key(bLines[bLines.length - 1 - end])) end++;

    const ops = [];
    for (let i = 0; i < start; i++) ops.push({ t: 'eq', ai: i, bj: i });

    const A = aLines.slice(start, aLines.length - end);
    const B = bLines.slice(start, bLines.length - end);
    const mid = middleOps(A, B, key, maxCells);
    for (let i = 0; i < mid.length; i++) {
      const op = mid[i];
      if (op.t === 'del') ops.push({ t: 'del', ai: start + op.i });
      else if (op.t === 'ins') ops.push({ t: 'ins', bj: start + op.j });
      else ops.push({ t: 'eq', ai: start + op.i, bj: start + op.j });
    }

    const ta = aLines.length - end, tb = bLines.length - end;
    for (let i = 0; i < end; i++) ops.push({ t: 'eq', ai: ta + i, bj: tb + i });
    return ops;
  }

  function middleOps(A, B, key, maxCells) {
    const n = A.length, m = B.length;
    const res = [];
    if (n === 0) { for (let j = 0; j < m; j++) res.push({ t: 'ins', j: j }); return res; }
    if (m === 0) { for (let i = 0; i < n; i++) res.push({ t: 'del', i: i }); return res; }

    const ka = [], kb = [];
    for (let i = 0; i < n; i++) ka.push(key(A[i]));
    for (let j = 0; j < m; j++) kb.push(key(B[j]));

    if ((n + 1) * (m + 1) > maxCells) {
      for (let i = 0; i < n; i++) res.push({ t: 'del', i: i });
      for (let j = 0; j < m; j++) res.push({ t: 'ins', j: j });
      return res;
    }

    const W = m + 1;
    const dp = new Int32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = ka[i] === kb[j]
          ? dp[(i + 1) * W + (j + 1)] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ka[i] === kb[j]) { res.push({ t: 'eq', i: i, j: j }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { res.push({ t: 'del', i: i }); i++; }
      else { res.push({ t: 'ins', j: j }); j++; }
    }
    while (i < n) { res.push({ t: 'del', i: i }); i++; }
    while (j < m) { res.push({ t: 'ins', j: j }); j++; }
    return res;
  }

  /** ops -> 左右对齐的行（缺失的一侧补空行，保证两边视觉对齐） */
  function buildSideBySide(ops) {
    const rows = [];
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.t === 'eq') { rows.push({ l: op.ai, r: op.bj, type: 'eq' }); i++; continue; }
      const dels = [], ins = [];
      while (i < ops.length && ops[i].t !== 'eq') {
        if (ops[i].t === 'del') dels.push(ops[i].ai); else ins.push(ops[i].bj);
        i++;
      }
      const len = Math.max(dels.length, ins.length);
      for (let k = 0; k < len; k++) {
        const hasL = k < dels.length, hasR = k < ins.length;
        rows.push({
          l: hasL ? dels[k] : null,
          r: hasR ? ins[k] : null,
          type: hasL && hasR ? 'mod' : (hasL ? 'del' : 'ins')
        });
      }
    }
    return rows;
  }

  function countChanges(rows) {
    let add = 0, del = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].type === 'ins') add++;
      else if (rows[i].type === 'del') del++;
      else if (rows[i].type === 'mod') { add++; del++; }
    }
    return { add: add, del: del };
  }

  /**
   * 字符级 diff（中文按字对比），复用行级 LCS 引擎——字符数组就是「每行一个字符」。
   * 用 Array.from 按码点切分，避免 emoji / 生僻字（代理对）被拆坏。
   * @returns {Array<{t:'eq'|'del'|'ins', s:string}>} 连续同类已合并；del 文本属于 a，ins 属于 b。
   *   超过 maxCells 时引擎退化为「整段 del + 整段 ins」，由调用方决定如何展示。
   */
  function diffChars(a, b, opts) {
    const o = opts || {};
    const maxCells = o.maxCells || 1000000;
    const ac = Array.from(String(a));
    const bc = Array.from(String(b));
    const ops = diffLines(ac, bc, { maxCells: maxCells });
    const spans = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const ch = op.t === 'ins' ? bc[op.bj] : ac[op.ai];
      const last = spans[spans.length - 1];
      if (last && last.t === op.t) last.s += ch;
      else spans.push({ t: op.t, s: ch });
    }
    return spans;
  }

  /* ----------------------------- 格式化 ----------------------------- */

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDuration(ms) {
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  function toHexPreview(u8, maxBytes) {
    const n = Math.min(u8.length, maxBytes || 256);
    let out = '';
    for (let i = 0; i < n; i += 16) {
      let hex = '', ascii = '';
      const stop = Math.min(i + 16, n);
      for (let j = i; j < stop; j++) {
        const c = u8[j];
        hex += (c < 16 ? '0' : '') + c.toString(16) + ' ';
        ascii += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      const lineNo = i.toString(16).padStart(8, '0');
      out += lineNo + '  ' + hex.padEnd(48, ' ') + ' |' + ascii + '|\n';
    }
    return out;
  }

  const Core = {
    Sha256: Sha256,
    hashFile: hashFile,
    DEFAULT_IGNORE: DEFAULT_IGNORE,
    parseIgnoreRules: parseIgnoreRules,
    isIgnored: isIgnored,
    cmpName: cmpName,
    cmpTreeOrder: cmpTreeOrder,
    locateRow: locateRow,
    buildTree: buildTree,
    rollAggregate: rollAggregate,
    rollupStatus: rollupStatus,
    buildCompareModel: buildCompareModel,
    pendingEntries: pendingEntries,
    finalizeEntry: finalizeEntry,
    splitLines: splitLines,
    isProbablyBinary: isProbablyBinary,
    isZip: isZip,
    readZipEntries: readZipEntries,
    xmlUnescape: xmlUnescape,
    extractDocxLines: extractDocxLines,
    docxLines: docxLines,
    guessExt: guessExt,
    diffLines: diffLines,
    diffChars: diffChars,
    buildSideBySide: buildSideBySide,
    countChanges: countChanges,
    fmtSize: fmtSize,
    fmtTime: fmtTime,
    fmtDuration: fmtDuration,
    toHexPreview: toHexPreview
  };

  global.Core = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
