#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""由 index.html 生成 test/smoke.html（自动冒烟页）。

为什么需要：冒烟页要用真实页面结构，但又要额外注入错误监听与测试脚本；
每次手改 index.html 后重新生成一次，测试才不会测到过期的 DOM。

用法：python3 test/make-smoke.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
    base = f.read()

# 错误监听必须在 core.js / app.js 之前注册，否则抓不到加载期的报错
guard = '''<script>
window.__smokeErrs=[];
window.addEventListener('error',function(e){window.__smokeErrs.push((e.message||'resource-error')+' @ '+(e.filename||'?')+':'+(e.lineno||0));},true);
window.addEventListener('unhandledrejection',function(e){window.__smokeErrs.push('unhandled: '+((e.reason&&e.reason.message)||e.reason));});
</script>
'''
inject = '<div id="smoke-out" style="display:none">RUNNING</div>\n<script src="smoke-test.js"></script>\n'

out = base.replace('<link rel="stylesheet"', guard + '<link rel="stylesheet"', 1)
# 页面挪到 test/ 下，资源路径回指一层
out = out.replace('href="styles.css"', 'href="../styles.css"')
out = out.replace('src="core.js"', 'src="../core.js"')
out = out.replace('src="app.js"', 'src="../app.js"')
out = out.replace('</body>', inject + '</body>', 1)

banner = '<!-- 自动生成：由 index.html 复制而来，仅用于自动化冒烟测试，请勿手改 -->\n'
with open(os.path.join(HERE, 'smoke.html'), 'w', encoding='utf-8') as f:
    f.write(banner + out)

print('已生成 test/smoke.html（字节数 %d）' % (len(out) + len(banner)))
