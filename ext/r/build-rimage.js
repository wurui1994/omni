#!/usr/bin/env node
// ext/r/build-rimage.js —— **R 的开机镜像**：base 装完之后那块线性内存，存下来。
//
// 为什么要它：装整份 base（1400 多句 R）要一分钟，而"一趟不许超过一分钟"，而且
// 每次开机都重装一分钟本来就说不过去 —— 浏览器那一趟更不能。装完的结果**全在内存里**
// （堆、SEXP、符号表、brk 都是字节），所以存一份、下次铺回去。
//
// 装载分**一轮一轮**：一轮从上一轮停下的字节偏移接着跑 `--cap` 句，跑完存像。
// 于是"一次一分钟"变成"几次各四十秒"，而结果是同一份像。
//
//   node ext/r/build-rimage.js            # 接着上一轮跑一轮（400 句）
//   node ext/r/build-rimage.js --cap 200  # 一轮少跑点
//   node ext/r/build-rimage.js --reset    # 从头来
//
// 产物（都在 .omni-cache/r-rt/jsall/）：
//   base.img   —— 线性内存那一块（原始字节）
//   base.json  —— { bump, pos, stmts, errs, done }

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';

const ROOT = process.cwd();
const OUT = join(ROOT, '.omni-cache', 'r-rt', 'jsall');
const IMG = join(OUT, 'base.img.gz');
const META = join(OUT, 'base.json');
const HOME = join(ROOT, '.omni-cache', 'r-rt', 'libR', 'home');

const argv = process.argv.slice(2);
const capArg = argv.indexOf('--cap');
const CAP = capArg >= 0 ? Number(argv[capArg + 1]) : 200;
if (argv.includes('--reset')) {
  for (const f of [IMG, META]) if (existsSync(f)) unlinkSync(f);
  process.stdout.write('从头来：像与账都删了\n');
}
if (!existsSync(join(OUT, 'omni__omni_rhost.mjs'))) {
  process.stdout.write('先跑：timeout 60 node tests/r/rtc.js jsrun（要那 251 份 .mjs）\n');
  process.exit(1);
}

const meta = existsSync(META)
  ? JSON.parse(readFileSync(META, 'utf8'))
  : { bump: 0, pos: 0, stmts: 0, errs: 0, done: false };
if (meta.done) {
  process.stdout.write(`已经装完了：${meta.stmts} 句、错 ${meta.errs}、像 ${meta.bytes} 字节\n`);
  process.exit(0);
}

const mods = readdirSync(OUT).filter((n) => n.endsWith('.mjs') && !n.startsWith('$')).sort();
const L = [];
L.push("import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';");
L.push(`import { RT as $RT } from ${JSON.stringify(join(ROOT, 'src/core/mir/js_rt.js'))};`);
L.push(`const LOG = ${JSON.stringify(join(OUT, 'base-build.log'))};`);
L.push('const say = (s) => appendFileSync(LOG, s + "\\n");');
L.push(`const $M = ${JSON.stringify(mods.map((n) => join(OUT, n)))};`);
L.push('const mods = []; for (const p of $M) mods.push(await import(p));');
L.push('for (const m of mods) m.$init();');
L.push('const $F = (s) => { for (const m of mods) if (m["$fn_" + s]) return m["$fn_" + s]; return null; };');
/* 有像就铺回去（连 R 的那 16 步初始化一起省了 —— 那一串的结果也在像里）；
   没有就照 R 自己的次序初始化一遍。 */
L.push(`const META = ${JSON.stringify(meta)};`);
L.push(`if (META.pos > 0) {
  const { gunzipSync } = await import('node:zlib');
  const bytes = new Uint8Array(gunzipSync(readFileSync(${JSON.stringify(IMG)})));
  $RT.memImageLoad({ bytes, bump: META.bump });
  say('铺回上一轮的像：' + bytes.length + ' 字节');
} else {
  for (const s of ['Rf_InitArithmetic', 'Rf_InitTempDir', 'Rf_InitMemory', 'Rf_InitStringHash',
    'Rf_InitBaseEnv', 'Rf_InitNames', 'InitParser', 'Rf_InitGlobalEnv', 'Rf_InitOptions',
    'Rf_InitGraphics', 'Rf_InitTypeTables', 'Rf_InitS3DefaultTypes', 'R_InitConditions',
    'Rf_InitConnections', 'omni_console_init', 'omni_toplevel_init']) {
    const f = $F(s);
    if (f === null) { say(s + ' 没这个符号'); continue; }
    try { f(); } catch (e) { say(s + ' 炸了: ' + String(e && e.message).slice(0, 120)); }
  }
  say('初始化完');
}`);
/* 一轮：从 META.pos 开始跑 CAP 句 */
L.push(`{
  const step = $F('omni_base_step');
  const p = $F('omni_src_ptr')();
  const t0 = Date.now();
  let pos = META.pos;
  let errs = 0;
  let more = 1;
  let n = 0;
  /* 一轮里**反复**跑 ${CAP} 句，直到自己那点时间预算用完 —— 装载那 30 秒已经付过了，
     能多跑几句就多跑几句。存像只在最后一次（290 MB 压一次要几秒）。 */
  while (more === 1 && Date.now() - t0 < 12000) {
    more = step(BigInt(pos), ${CAP}, p, p + 8n);
    pos = Number($RT.memLoadFn('i64')(p, 0));
    errs += Number($RT.memLoadFn('i32s')(p + 8n, 0));
    n += ${CAP};
    if (more < 0) { say('base_step 回了 ' + more); break; }
  }
  say('一轮：走到字节 ' + pos + '、错 ' + errs + '、' + (Date.now() - t0) + 'ms、还有=' + more);
  const img = $RT.memImageSave();
  const { gzipSync } = await import('node:zlib');
  writeFileSync(${JSON.stringify(IMG)}, gzipSync(Buffer.from(img.bytes), { level: 1 }));
  writeFileSync(${JSON.stringify(META)}, JSON.stringify({
    bump: img.bump, pos, stmts: META.stmts + n, errs: META.errs + errs,
    done: more === 0, bytes: img.bytes.length,
  }));
  say('像存了：' + img.bytes.length + ' 字节、bump=' + img.bump);
}`);

const entry = join(OUT, '$rimage.mjs');
writeFileSync(entry, `${L.join('\n')}\n`);
writeFileSync(join(OUT, 'base-build.log'), '');
const r = spawnSync(process.execPath, [entry], {
  encoding: 'utf8',
  maxBuffer: 1 << 26,
  timeout: 55000,
  killSignal: 'SIGKILL',
  env: { ...process.env, R_HOME: HOME, NODE_COMPILE_CACHE: join(OUT, '.v8cache') },
});
process.stdout.write(readFileSync(join(OUT, 'base-build.log'), 'utf8'));
process.stdout.write((r.stdout ?? '').slice(0, 2000));
process.stdout.write((r.stderr ?? '').split('\n').slice(0, 10).join('\n'));
const now = existsSync(META) ? JSON.parse(readFileSync(META, 'utf8')) : null;
process.stdout.write(`\n账：${JSON.stringify(now)}\n`);
