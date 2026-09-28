#!/usr/bin/env node
/**
 * tests/r/rweb —— **R 在真浏览器里跑起来**（ADR-0047 第二十八格）。
 *
 * 为什么另起一节而不是在 `rtc.js` 里加：这一节问的不是"答案对不对"（那是 `img` 那一节），
 * 是**换宿主之后还成不成立**。浏览器上没有 `process`、没有 `node:fs`、`import` 只能是
 * 异步的 —— 这三条在 node 上一条都看不见。
 *
 * 一件运气好的事：发出来那 251 份 `.mjs` 里的模块说明符是**绝对路径**
 * （`/Users/…/jsall/main__names.mjs`），所以只要起一格"URL 路径 = 文件路径"的静态服务，
 * 浏览器就能原样 `import` 它们 —— 一个字节都不用改写。
 *
 * 判两件事：
 *   1. 控制台一条错都没有；
 *   2. 铺开机镜像之后那几句 R（身子在 base 的 R 代码里）与 `Rscript` 逐位对得上。
 *
 * `playwright-cli` 是台机器上的工具，没装就**明着跳过**（不假红也不假绿）。
 */
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';

const execFile = promisify(execFileCb);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, '.omni-cache', 'r-rt', 'jsall');
const WORK = join(ROOT, '.omni-cache', 'work', 'r-web');
/* 与 `rtc.js img` 同一批句子 —— 换宿主不许换答案。 */
const EVAL = [
  'mean(1:10)',
  'nchar("hello")',
  'sum(sapply(1:5, function(i) i * i))',
  'as.numeric(paste0("1", "2"))',
  'sum(duplicated(c(1, 2, 2, 3)))',
  'as.numeric(strsplit("1,2,3", ",")[[1]][2])',
  'sum(vapply(list(1:3, 1:5), length, 1L))',
];

let pass = 0;
let fail = 0;
const ok = (name, note) => { pass += 1; process.stdout.write(`  ok   ${name}${note ? ` [${note}]` : ''}\n`); };
const no = (name, note) => { fail += 1; process.stdout.write(`  FAIL ${name}\n       ${note}\n`); };

const metaF = join(DIR, 'base.json');
const imgF = join(DIR, 'base.img.gz');
if (!existsSync(metaF) || !existsSync(imgF)) {
  no('浏览器里铺开机镜像', '还没有像 —— 先跑 node ext/r/build-rimage.js（反复跑到"装完了"）');
  process.stdout.write(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
let havePw = true;
try { execFileSync('playwright-cli', ['--version'], { encoding: 'utf8', timeout: 20000 }); }
catch { havePw = false; }
if (!havePw) {
  process.stdout.write('  skip 真浏览器那一趟（这台机器上没有 playwright-cli）\n');
  process.exit(0);
}

mkdirSync(WORK, { recursive: true });
/* 页面：`import` 走绝对路径（服务把 URL 路径当文件路径），像用 `fetch` + 浏览器自带的
   `DecompressionStream('gzip')` 解开 —— 不借 node 的 zlib。
   **异步预热**那一格：`needFn` 是同步的（线性内存那条腿上函数指针必须同步调得到），
   而浏览器的 `import` 是异步的。所以先把镜像里记着的那几份 `await import` 进来，
   跑的时候要是还差一份，就按链接图 `await import` 那一份再重来一遍。 */
const page = `<!doctype html><meta charset="utf-8"><title>R on the web</title>
<body><pre id="out">跑着…</pre><script type="module">
const DIR = ${JSON.stringify(DIR)};
const say = (s) => { document.getElementById('out').textContent += '\\n' + s; };
const { RT } = await import(${JSON.stringify(`${join(ROOT, 'src/core/mir/js_rt.js')}`)});
const SYMS = await (await fetch(DIR + '/.syms.json')).json();
const META = await (await fetch(DIR + '/base.json')).json();
RT.setBaseMap(META.bases);
const loaded = new Set();
const load = async (f) => {
  if (loaded.has(f)) return;
  loaded.add(f);
  const m = await import(f);
  if (m.$init !== undefined) m.$init();
};
/* 同步那一侧只认"已经装进来的" —— 缺的那一份由外头的重试圈补。 */
RT.setLinkMap(new Map(Object.entries(SYMS)), (f) => {
  if (!loaded.has(f)) throw new Error('要异步装：' + f);
});
const t0 = performance.now();
for (const f of META.order) await load(f);
const tLoad = performance.now() - t0;
/* 像：fetch + DecompressionStream（浏览器自带的 gzip 解码） */
const res = await fetch(DIR + '/base.img.gz');
const ds = new DecompressionStream('gzip');
const raw = new Uint8Array(await new Response(res.body.pipeThrough(ds)).arrayBuffer());
RT.memImageLoad({ bytes: raw, bump: META.bump });
const tImg = performance.now() - t0;
const st = RT.memStoreFn('i8');
const out = {};
const tries = [];
const ask = async (src) => {
  /* 重来的次数就是"异步预热最多补装几份"：一圈补一份（缺的那份要的别人还可能没到），
     一句 R 拉起一串是常事 —— strsplit 那一句在 6 圈里装不齐（量出来的）。 */
  for (let round = 0; round < 60; round += 1) {
    try {
      const ptr = RT.needFn('omni_src_ptr')();
      const ev = RT.needFn('omni_eval_buf');
      const bs = new TextEncoder().encode(src);
      for (let i = 0; i < bs.length; i++) st(ptr, i, BigInt(bs[i]));
      st(ptr, bs.length, 0n);
      return ev();
    } catch (e) {
      /* 缺哪一份就装哪一份（异步预热），再来一遍 */
      const m = /要异步装：(.+)$/.exec(String(e && e.message));
      if (m === null) return '炸了：' + String(e && e.message).slice(0, 160);
      tries.push(m[1]);
      await load(m[1]);
    }
  }
  return '装不齐';
};
for (const src of ${JSON.stringify(EVAL)}) out[src] = await ask(src);
window.__R_WEB = { out, tLoad: Math.round(tLoad), tImg: Math.round(tImg),
  mods: RT.linkStats().mods, warm: tries.length, bytes: raw.length };
say('装 ' + META.order.length + ' 份 ' + Math.round(tLoad) + 'ms、铺像到 '
  + Math.round(tImg) + 'ms、起来 ' + RT.linkStats().mods + ' 份');
for (const k of Object.keys(out)) say(k + ' -> ' + out[k]);
</script>`;
writeFileSync(join(WORK, 'r.html'), page);

/* URL 路径 = 文件路径的静态服务（发出来那 251 份里的说明符就是绝对路径）。 */
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json',
  '.html': 'text/html', '.gz': 'application/octet-stream' };
const srv = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = p === '/' ? join(WORK, 'r.html') : p;
  try {
    if (!statSync(f).isFile()) throw new Error('not a file');
    const ext = f.slice(f.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(f));
  } catch { res.writeHead(404); res.end('no'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;
const S = '-s=r-web-judge';
const pw = async (args) => (await execFile('playwright-cli', args,
  { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })).stdout;
try {
  try { await pw([S, 'open', url]); } catch { /* 这个名字的会话已经开着也行 */ }
  await pw([S, 'goto', url]);
  /* 页面里那一串 await 走完要几秒 —— 等它把结果挂上 window */
  const wait = 'async () => { for (let i = 0; i < 120; i++) {'
    + ' if (window.__R_WEB !== undefined) return window.__R_WEB;'
    + ' await new Promise((r) => setTimeout(r, 250)); } return null; }';
  const got = JSON.parse(await pw([S, '--raw', 'eval', wait]));
  const con = await pw([S, 'console', 'error']);
  ok0(got, con);
} catch (e) {
  no('真浏览器里跑起来', String(e && e.message).slice(0, 300));
}
srv.close();
process.stdout.write(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);

function ok0(got, con) {
  if (got === null) {
    no('真浏览器里跑起来', `页面没把结果挂上 window.__R_WEB —— 控制台说：\n       ${
      con.trim().split('\n').slice(0, 12).join('\n       ').slice(0, 1200)}`);
    return;
  }
  if (!/Errors: 0/.test(con)) no('控制台一条错都没有', con.trim().slice(0, 300));
  else ok('控制台一条错都没有');
  const rs = spawnSync('Rscript', ['-e',
    EVAL.map((e) => `cat(sprintf("%.17g", {${e}}), "\\n")`).join(';')], { encoding: 'utf8' });
  const refs = (rs.stdout ?? '').trim().split('\n').map((x) => Number(x));
  if (rs.status !== 0 || refs.length !== EVAL.length) {
    no('浏览器里那几句 R 与 Rscript 同值', `Rscript 那把尺子没量出来（${(rs.stderr ?? '').split('\n')[0]}）`);
    return;
  }
  const bad = [];
  EVAL.forEach((src, i) => {
    const v = Number(got.out[src]);
    const w = refs[i];
    if (!Number.isFinite(v)) { bad.push(`${src}: 我们 ${got.out[src]}、R ${w}`); return; }
    const rel = Math.abs(v - w) / Math.max(Math.abs(w), 1e-300);
    if (rel > 1e-12) bad.push(`${src}: 我们 ${v}、R ${w}`);
  });
  if (bad.length > 0) no('浏览器里那几句 R 与 Rscript 同值', bad.slice(0, 5).join('\n       '));
  else {
    ok('浏览器里那几句 R 与 Rscript 同值', `${EVAL.length} 句、装 ${got.mods} 份模块 `
      + `${got.tLoad}ms、铺 ${got.bytes} 字节的像到 ${got.tImg}ms、`
      + `异步预热补装 ${got.warm} 份`);
  }
}
