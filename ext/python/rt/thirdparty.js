#!/usr/bin/env node
// ext/python/rt/thirdparty.js —— **第六格判据：拿借来的整份运行时跑真的第三方库**
//
//   node ext/python/rt/thirdparty.js            # 三问都过才算过
//
// ## 为什么要这一把尺子
//
// 前五把量的是"编得出 / 链得上 / 起得来 / 答得对四行 / omni build 接得上"。可用户要的是
// **能正常使用第三方库**（原话点了 asyncio / requests / lxml / httpx 四个名字），
// 而那件事会在前五把尺子全绿的时候仍然不成立 —— 量到过两回：
//
//   * `__thread` 被当成普通全局量（所有线程共用一格）：`threading` 一起线程就
//     `Fatal Python error: _PyThreadState_Attach: non-NULL old thread state`；
//   * 十六进制字面量的类型错一格（`FIONBIO` 符号扩展）：asyncio 的 self-pipe 起不来。
//
// 两次都是**C 前端的账**，而症状在 python 那一头，离现场十万八千里。所以这一格的被试者
// 是"真库真代码"：asyncio 起一个本机 TCP server、requests / httpx 真发一次请求。
//
// ## 口径
//
//   * 跑法是 `pyrun.c`（我们自己编的那层薄皮，与 `embed-boot.c` 共用 boot）+ `libomnipython.a`
//     —— 先跑 `npm run py:embed -- --runtime`，那一步会把 `.a` 打出来；
//   * 期望值**不写死**：同一份 `.py` 交给本机 python3，逐字节相同才算过；
//   * 第三方那一问要本机装了那几个包（探 `sys.path` 里的 site-packages）—— 探不到就
//     说清并跳过那一问，不假装绿；
//   * 出网一格都不碰：HTTP 那一问自己用 `http.server` 在 127.0.0.1 上起一个。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagsFor, incDirFor, perFileFlags, externalLinkArgs } from './scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const CLI = join(root, 'src', 'cli.js');
const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? d : argv[i + 1];
};
const SRC = argOf('--src', process.env.OMNI_CPYTHON
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython'));
const WORK = join(root, '.omni-cache', 'py-rt');
const INC = join(WORK, 'inc-rt');
const OUT = join(WORK, '3rd');
const A = join(WORK, 'embed', 'libomnipython.a');
const CC = argOf('--cc', process.env.CC ?? 'clang');
const say = (s) => process.stdout.write(`${s}\n`);
const skip = (why) => { say(`py-rt/3rd: ${why} —— 跳过`); process.exit(0); };
if (!existsSync(join(SRC, 'Include', 'Python.h'))) skip(`参考树不在（${SRC}）`);
if (!existsSync(A)) skip('还没打出 libomnipython.a（先 `npm run py:embed -- --runtime`）');
if (spawnSync(CC, ['--version'], { encoding: 'utf8' }).status !== 0) skip(`本机没有 ${CC}`);
if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) skip('本机没有 python3');
mkdirSync(OUT, { recursive: true });

/* 1) 那层薄皮过**我们自己的 C 前端**（这一格与 embed 同一条纪律：被试者是它）。 */
const PO = join(OUT, 'pyrun.o');
const BIN = join(OUT, 'pyrun');
const co = spawnSync(process.execPath, [CLI,
  ...flagsFor(PO, INC, SRC, perFileFlags('Programs/_freeze_module.c', SRC)),
  join(here, 'pyrun.c')], { encoding: 'utf8' });
if (co.status !== 0 || !existsSync(PO)) {
  say(`py-rt/3rd: 我们编不出 pyrun.c：\n${(co.stderr ?? '').split('\n').filter((l) => /error:/.test(l)).slice(0, 4).join('\n')}`);
  process.exit(1);
}
const SYS = process.platform === 'darwin'
  ? ['-framework', 'SystemConfiguration', '-framework', 'CoreFoundation', '-lm',
    ...externalLinkArgs()]
  : ['-lm', ...externalLinkArgs()];
const ld = spawnSync(CC, ['-o', BIN, PO, A, ...SYS], { encoding: 'utf8' });
if (ld.status !== 0 || !existsSync(BIN)) {
  say(`py-rt/3rd: 链不起来：\n${(ld.stderr ?? '').split('\n').slice(0, 6).join('\n')}`);
  process.exit(1);
}
const LIB = join(SRC, 'Lib');

/** 同一份 `.py` 两边跑，逐字节比。回 `{ ok, ours, want }`。 */
function both(name, src, args = []) {
  const p = join(OUT, name);
  writeFileSync(p, src);
  const a = spawnSync(BIN, [LIB, p, ...args], { encoding: 'utf8', cwd: root });
  const b = spawnSync('python3', [p, ...args], { encoding: 'utf8', cwd: root });
  const ours = (a.stdout ?? '').trimEnd();
  const want = (b.stdout ?? '').trimEnd();
  return { ok: a.status === 0 && ours === want, ours, want, err: a.stderr ?? '' };
}
let bad = 0;

/* 门一：asyncio —— 不是只 import，是**真跑**（事件循环、本机 TCP、并发、超时）。 */
const G1 = `import asyncio

async def work():
    await asyncio.sleep(0)
    return 6 * 7

async def echo():
    async def handle(r, w):
        w.write((await r.read(100))[::-1])
        await w.drain()
        w.close()
        await w.wait_closed()
    srv = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    async with srv:
        r, w = await asyncio.open_connection("127.0.0.1", port)
        w.write(b"hello-asyncio")
        await w.drain()
        got = await r.read(100)
        w.close()
        await w.wait_closed()
    return got

async def many():
    xs = await asyncio.gather(*[asyncio.sleep(0.001 * (i % 3), i * i) for i in range(6)])
    try:
        await asyncio.wait_for(asyncio.sleep(1), timeout=0.02)
        return xs, "没超时"
    except TimeoutError:
        return xs, "超时了"

print("run     ", asyncio.run(work()))
print("echo    ", asyncio.run(echo()))
print("gather  ", asyncio.run(many()))
print("默认选择器", asyncio.new_event_loop()._selector.__class__.__name__)
`;
const g1 = both('gate1-asyncio.py', G1);
if (!g1.ok) {
  bad += 1;
  say(`门一：**asyncio 真跑一趟** —— 没过\n      我们：${JSON.stringify(g1.ours.slice(0, 300))}`
    + `\n      py  ：${JSON.stringify(g1.want.slice(0, 300))}`
    + `${g1.err === '' ? '' : `\n      stderr：${g1.err.split('\n').slice(0, 3).join(' / ')}`}`);
} else {
  say(`门一：**asyncio 真跑一趟** —— 事件循环 / 本机 TCP 一来一回 / gather / wait_for`
    + `，四行与 python3 逐字节相同`);
}
/* 门二：标准库那一族 import。缺的必须**都在账上**（`scope.js` 的 external 那一档还没开的
   那几格），一格"本该有却没有"都不许。 */
const MODS = ['asyncio', 'selectors', 'socket', 'ssl', 'json', 're', 'hashlib', 'zlib',
  'email', 'http.client', 'urllib.request', 'unicodedata', 'decimal', 'threading',
  'concurrent.futures', 'subprocess', 'xml.etree.ElementTree', 'typing', 'dataclasses',
  'mmap', 'struct', 'pickle', 'datetime', 'queue'];
const G2 = `mods = ${JSON.stringify(MODS)}
no = []
for m in mods:
    try:
        __import__(m)
    except BaseException as e:
        no.append(m)
print("缺", len(no), sorted(no))
`;
const g2 = both('gate2-stdlib.py', G2);
if (!g2.ok) {
  bad += 1;
  say(`门二：**标准库那 ${MODS.length} 格 import** —— 没过`
    + `\n      我们：${g2.ours}\n      py  ：${g2.want}`);
} else {
  say(`门二：**标准库那 ${MODS.length} 格 import** —— 与 python3 一格不差（${g2.want}）`);
}

/* 门三：第三方。本机装了才量（探 python3 自己的 site-packages）—— 探不到就说清、不假装。 */
const sp = spawnSync('python3', ['-c',
  'import sys;print([p for p in sys.path if p.endswith("site-packages")][:1] and '
  + '[p for p in sys.path if p.endswith("site-packages")][0] or "")'],
{ encoding: 'utf8' });
const SITE = (sp.stdout ?? '').trim();
const has3rd = SITE !== '' && existsSync(join(SITE, 'requests')) && existsSync(join(SITE, 'httpx'));
if (!has3rd) {
  say('门三：跳过（本机没装 requests / httpx —— 那两格是第三方，不在参考树里）');
} else {
  const G3 = `import json, sys, threading, zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, sys.argv[1])

BODY = json.dumps({"who": "omni", "n": 42}).encode()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        raw = zlib.compress(BODY)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Encoding", "deflate")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = "http://127.0.0.1:%d/" % srv.server_port

import requests
r = requests.get(url, timeout=5)
print("requests", r.status_code, r.json())

import httpx
r2 = httpx.get(url, timeout=5)
print("httpx   ", r2.status_code, r2.json())
srv.shutdown()
print("ssl     ", __import__("ssl").OPENSSL_VERSION.split()[0])
print("zlib 往返", zlib.decompress(zlib.compress(b"x" * 1000)) == b"x" * 1000)
`;
  const g3 = both('gate3-http.py', G3, [SITE]);
  if (!g3.ok) {
    bad += 1;
    say(`门三：**requests / httpx 真发一次请求** —— 没过`
      + `\n      我们：${JSON.stringify(g3.ours.slice(0, 300))}\n      py  ：${JSON.stringify(g3.want.slice(0, 300))}`
      + `${g3.err === '' ? '' : `\n      stderr：${g3.err.split('\n').slice(0, 4).join(' / ')}`}`);
  } else {
    say('门三：**requests / httpx 真发一次请求**（本机 http.server + deflate）'
      + ' —— 四行与 python3 逐字节相同');
  }
}

say('');
say(bad === 0 ? '门：三问都过才算过 —— 过' : `门：三问都过才算过 —— 没过（${bad} 问）`);
process.exit(bad === 0 ? 0 : 1);



