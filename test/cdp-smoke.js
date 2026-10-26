/* =====================================================================
 * 浏览器端冒烟驱动：无头启动 Edge -> 打开 test/smoke.html -> 取回测试结果
 * 用法：node test/cdp-smoke.js "file:///绝对路径/test/smoke.html"
 *
 * 为什么用 CDP 而不是 --dump-dom --virtual-time-budget：
 * 虚拟时间会把 setTimeout 瞬间跑完，导致断言早于真实的 FileReader 回调执行，
 * 结果会被截断；CDP 走真实时间，结果完整。
 *
 * 为什么连 browser 级 WS 而不是 page 级：page 级连接在本机环境会被立刻断开（1006）。
 * 另：Edge 的 GPU 进程在受限环境下会崩溃并拖垮整个浏览器，必须显式禁掉 GPU 相关沙盒。
 * ===================================================================== */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const target = process.argv[2];
if (!target) { console.error('用法：node test/cdp-smoke.js <页面 URL>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取一个当前空闲的端口，避免多个实例抢同一个调试端口 */
function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

/** 用 http 模块直连，绕开全局代理对 localhost 的干扰 */
function httpGetJson(host, port, path) {
  return new Promise((res) => {
    const req = http.get({ host: host, port: port, path: path, timeout: 1500 }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
}

(async function () {
  const PORT = await freePort();
  const PROFILE = '/tmp/edge-cdp-' + process.pid;
  let proc = null, ws = null;

  try {
    proc = spawn(EDGE, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox',
      '--disable-software-rasterizer', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
      '--remote-allow-origins=*', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      ver = await httpGetJson('127.0.0.1', PORT, '/json/version');
      if (!ver) await sleep(200);
    }
    if (!ver) throw new Error('调试端口未就绪');

    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('WebSocket 连接超时')), 8000);
      ws.addEventListener('open', () => { clearTimeout(to); res(); });
      ws.addEventListener('error', () => { clearTimeout(to); rej(new Error('WebSocket 连接失败')); });
    });

    let seq = 0;
    const waiting = new Map();
    const logs = [];
    ws.onmessage = function (ev) {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        logs.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
      }
    };
    function send(method, params, sessionId) {
      const id = ++seq;
      const msg = { id: id, method: method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      return new Promise((r) => waiting.set(id, r));
    }
    async function evalIn(sid, expression) {
      const r = await send('Runtime.evaluate', { expression: expression, returnByValue: true }, sid);
      return (r.result && r.result.result && r.result.result.value) || '';
    }

    const created = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget',
      { targetId: created.result.targetId, flatten: true });
    const sid = attached.result.sessionId;

    await send('Runtime.enable', {}, sid);
    await send('Page.enable', {}, sid);
    await send('Page.navigate', { url: target }, sid);
    await sleep(1500);

    // 轮询直到测试自己报告结束
    let value = '';
    for (let i = 0; i < 120; i++) {
      value = await evalIn(sid,
        "document.getElementById('smoke-out') ? document.getElementById('smoke-out').textContent : ''");
      if (value.indexOf('==SMOKE-END==') >= 0) break;
      await sleep(500);
    }
    console.log(value || '(页面未产生结果)');

    /* ---- 额外验证：真实滚轮（页面内合成事件不会滚动，必须走 CDP 输入） ---- */
    await evalIn(sid, "document.getElementById('scrollSyncToggle').checked = true;" +
      "document.getElementById('scrollA').scrollTop = 0;");
    await sleep(300);
    const rect = JSON.parse(await evalIn(sid,
      "JSON.stringify(document.getElementById('scrollA').getBoundingClientRect())"));
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + Math.min(rect.height, 300) / 2),
      deltaX: 0, deltaY: 400, pointerType: 'mouse'
    }, sid);
    await sleep(600);
    const tops = await evalIn(sid,
      "document.getElementById('scrollA').scrollTop + ' / ' + document.getElementById('scrollB').scrollTop" +
      " + ' | 顶部行: ' + (document.querySelector('#rowsA .row')||{getAttribute:function(){return '-'}}).getAttribute('data-path')" +
      " + ' vs ' + (document.querySelector('#rowsB .row')||{getAttribute:function(){return '-'}}).getAttribute('data-path')");
    console.log('\n真实滚轮联动：A / B scrollTop = ' + tops);

    if (logs.length) console.log('\n--- 控制台 ---\n' + logs.join('\n'));
  } catch (e) {
    console.error('驱动失败: ' + e.message);
    process.exitCode = 1;
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
    if (proc) proc.kill();
  }
})();
