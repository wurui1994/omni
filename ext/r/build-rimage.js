#!/usr/bin/env node
// ext/r/build-rimage.js —— **R 的开机镜像**：base 装完之后那块线性内存，存下来。
//
// 为什么要它：整份 base（1500 多句 R）要 17 秒，而"一趟不许超过 30 秒"，而且每次开机
// 都重装 17 秒本来就说不过去 —— 浏览器那一趟更不能。装完的结果**全在内存里**
// （堆、SEXP、符号表、brk 都是字节），所以存一份、下次铺回去。
//
// **按需装载那条路上的难处**：镜像里的指针是绝对地址，所以铺像那一趟每份模块的数据段
// 必须落回同一个基址。所以存像时把 `RT.baseLog()`（模块记号 -> 基址，连堆那一页的
// `$heap` 一起）与**装载次序**一并存下来；铺像那一趟先 `setBaseMap`、再按同样的次序
// 把那几份装进来，然后把字节铺回去。
//
//   node ext/r/build-rimage.js           # 装一轮（600 句）并存像；反复跑直到装完
//   node ext/r/build-rimage.js --cap 400 # 一轮少装点
//   node ext/r/build-rimage.js --reset   # 从头造
//   装完之后再跑一次 = "铺像 + 问几句 R" 那一趟（验的就是这个）
//
// 产物（都在 .omni-cache/r-rt/jsall/）：
//   base.img.gz —— 线性内存那一块（gzip level 1）
//   base.json   —— { bump, bytes, stmts, errs, bases, order }

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT = join(ROOT, '.omni-cache', 'r-rt', 'jsall');
const IMG = join(OUT, 'base.img.gz');
const METAF = join(OUT, 'base.json');
const HOME = join(ROOT, '.omni-cache', 'r-rt', 'libR', 'home');
const RT = join(ROOT, 'src/core/mir/js_rt.js');
const LOG = join(OUT, 'base-build.log');
/* 开机那 18 步，与 `tests/r/rtc.js` 的 `INIT_SEQ` 一字不差（次序不是可选的）。 */
const INIT = ['omni_env_init', 'Rf_InitArithmetic', 'Rf_InitTempDir', 'Rf_InitMemory', 'Rf_InitStringHash',
  'Rf_InitBaseEnv', 'Rf_InitNames', 'InitParser', 'Rf_InitGlobalEnv', 'InitDynload',
  'Rf_InitOptions', 'Rf_InitGraphics', 'Rf_InitTypeTables', 'Rf_InitS3DefaultTypes',
  'R_InitConditions', 'Rf_InitConnections', 'omni_console_init', 'omni_toplevel_init', 'omni_locale_init'];
/* 铺完像之后问这几句 —— 身子都在 base 的 R 代码里，所以它们答对就是"像是活的"。 */
const CHECK = [['mean(1:10)', 5.5], ['nchar("hello")', 5], ['sum(sapply(1:5, function(i) i * i))', 55],
  ['as.numeric(paste0("1", "2"))', 12], ['sum(duplicated(c(1, 2, 2, 3)))', 1]];
/* 一轮装多少句 —— 一轮一个进程，而一趟不许超过 30 秒（装 600 句 6~8 秒 + 压像几秒）。 */
const capArg = process.argv.indexOf('--cap');
const CAP = capArg >= 0 ? Number(process.argv[capArg + 1]) : 600;

if (process.argv.includes('--reset')) {
  for (const f of [IMG, METAF]) if (existsSync(f)) unlinkSync(f);
  process.stdout.write('从头造：像与账都删了\n');
}
if (!existsSync(join(OUT, 'omni__omni_rhost.mjs'))) {
  process.stdout.write('先跑：timeout 30 node tests/r/rtc.js jsrun（要那 251 份 .mjs）\n');
  process.exit(1);
}
/* **像与那几份 .mjs 是一对**：像里存的是绝对地址，模块一重发，里头的布局就动了。
   量出来的症状（2026-09-29，改完 `omni_rhost.c` 重发之后撞的）是**铺回去每一句 R 都回 -1**，
   而账上写着 `errs: 0, done: true` —— 看账像是好的，这正是不许留的那种缝。
   判据很便宜：**有哪份 .mjs 比 base.json 新**，那份像就作废，从头装。 */
if (existsSync(METAF)) {
  const t = statSync(METAF).mtimeMs;
  const newer = readdirSync(OUT)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('$'))     // `$…mjs` 是这个脚本自己写的胶水，不算
    .filter((f) => statSync(join(OUT, f)).mtimeMs > t);
  if (newer.length > 0) {
    for (const f of [IMG, METAF]) if (existsSync(f)) unlinkSync(f);
    process.stdout.write(`有 ${newer.length} 份 .mjs 比像新（${newer[0]} …）—— 像作废，从头装\n`);
  }
}

/** 两个子进程共用的开头：按需装载那套胶水。 */
const head = (extra) => [
  "import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';",
  "import { createRequire } from 'node:module';",
  `import { RT as $RT } from ${JSON.stringify(RT)};`,
  `const LOG = ${JSON.stringify(LOG)};`,
  'const say = (s) => appendFileSync(LOG, s + "\\n");',
  'const $req = createRequire(import.meta.url);',
  `const SYMS = $req(${JSON.stringify(join(OUT, '.syms.json'))});`,
  'const order = [];',
  extra,
  `const $load = (f) => { const m = $req(f); if (m.$init !== undefined) m.$init(); order.push(f); };`,
  '$RT.setLinkMap(new Map(Object.entries(SYMS)), $load);',
  'const F = (s) => $RT.needFn(s);',
].join('\n');

const run = (src, tag) => {
  const entry = join(OUT, `$${tag}.mjs`);
  writeFileSync(entry, `${src}\n`);
  const r = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    timeout: 28000,
    killSignal: 'SIGKILL',
    env: { ...process.env, R_HOME: HOME, NODE_COMPILE_CACHE: join(OUT, '.v8cache') },
  });
  return r;
};

writeFileSync(LOG, '');
const meta0 = existsSync(METAF) ? JSON.parse(readFileSync(METAF, 'utf8')) : null;
if (meta0 === null || meta0.done !== true) {
  /* ---- 一、造像：**一轮一轮**（一轮不许超过 30 秒）。有上一轮的像就先铺回去、接着装。 */
  const src = `${head(meta0 === null ? '' : `const META = ${JSON.stringify({
    bump: meta0.bump, bases: meta0.bases, order: meta0.order, pos: meta0.pos, stmts: meta0.stmts,
  })};\n$RT.setBaseMap(META.bases);`)}
const t0 = Date.now();
let pos = 0; let stmts = 0;
${meta0 === null ? `for (const s of ${JSON.stringify(INIT)}) F(s)();
say('开机 17 步：' + (Date.now() - t0) + 'ms、起来 ' + $RT.linkStats().mods + ' 份');`
    : `for (const f of META.order) $load(f);
{
  const { gunzipSync } = await import('node:zlib');
  const bytes = new Uint8Array(gunzipSync(readFileSync(${JSON.stringify(IMG)})));
$RT.memImageLoad({ bytes, bump: META.bump });
/* 像里没有环境变量：那一摞在宿主那一侧的 Map 里（interp/libc.js 的 envCache），
   memImageSave 只存线性内存。所以铺完像要把"住在宿主那边"的那一步补上 ——
   现在只有 etc/Renviron 这一格。不补的症状：Sys.getenv("EDITOR") 回空串，
   于是 loadNamespace("utils") 报 invalid value for editor。
   （这段在模板串里，所以一个反引号都不能有 —— 有就把模板提前收了。） */
F('omni_env_init')();
  pos = META.pos; stmts = META.stmts;
  say('铺回上一轮：' + META.order.length + ' 份 + ' + bytes.length + ' 字节、'
    + (Date.now() - t0) + 'ms、上一轮走到字节 ' + pos);
}`}
const step = F('omni_base_step');
const p = F('omni_src_ptr')();
const t1 = Date.now();
let errs = 0; let more = 1; let n = 0;
while (more === 1 && n < ${CAP}) {
  more = step(BigInt(pos), 100, p, p + 8n);
  pos = Number($RT.memLoadFn('i64')(p, 0));
  errs += Number($RT.memLoadFn('i32s')(p + 8n, 0));
  n += 100;
  if (more < 0) { say('base_step 回了 ' + more); break; }
}
stmts += n;
/* base 装完那一轮顺手把系统 Rprofile 也跑一遍（第三十六格）：那份文件里的
   options(warn = 0) 一族不设上，table() 一类就报 option 'warn' cannot be deleted。 */
if (more === 0) say('Rprofile：错 ' + F('omni_profile_init')());
say('这一轮装 base：' + n + ' 句、到字节 ' + pos + '、错 ' + errs + '、' + (Date.now() - t1)
  + 'ms、还有=' + more);
const img = $RT.memImageSave();
const { gzipSync } = await import('node:zlib');
const t2 = Date.now();
writeFileSync(${JSON.stringify(IMG)}, gzipSync(img.bytes, { level: 1 }));
writeFileSync(${JSON.stringify(METAF)}, JSON.stringify({
  bump: img.bump, bytes: img.bytes.length, stmts, pos, errs: ${meta0 === null ? 0 : meta0.errs} + errs,
  done: more === 0, bases: $RT.baseLog(), order,
}));
say('存像：' + img.bytes.length + ' 字节、压 ' + (Date.now() - t2) + 'ms、bump=' + img.bump
  + '、钉住 ' + Object.keys($RT.baseLog()).length + ' 个基址、次序 ' + order.length + ' 份');
`;
  const r = run(src, 'rimage-save');
  process.stdout.write(readFileSync(LOG, 'utf8'));
  process.stdout.write((r.stdout ?? '').slice(0, 1000));
  process.stdout.write((r.stderr ?? '').split('\n').slice(0, 8).join('\n'));
  const now = existsSync(METAF) ? JSON.parse(readFileSync(METAF, 'utf8')) : null;
  if (now === null) { process.stdout.write('\n这一轮没存下像\n'); process.exit(1); }
  process.stdout.write(`\n账：${JSON.stringify({
    stmts: now.stmts, pos: now.pos, errs: now.errs, done: now.done, bytes: now.bytes,
    bases: Object.keys(now.bases).length, order: now.order.length,
  })}\n`);
  process.stdout.write(now.done ? '装完了 —— 再跑一次这个命令就是"铺像 + 验"那一趟\n'
    : '还没装完 —— 再跑一次接着装\n');
  process.exit(0);
}

/* ---- 二、铺像：先钉基址、按原次序装那几份、把字节铺回去，再问那几句 R */
const meta = JSON.parse(readFileSync(METAF, 'utf8'));
writeFileSync(LOG, '');
const src2 = `${head(`const META = ${JSON.stringify({ bump: meta.bump, bases: meta.bases, order: meta.order })};
$RT.setBaseMap(META.bases);`)}
const t0 = Date.now();
for (const f of META.order) $load(f);
const tLoad = Date.now() - t0;
const { gunzipSync } = await import('node:zlib');
const bytes = new Uint8Array(gunzipSync(readFileSync(${JSON.stringify(IMG)})));
$RT.memImageLoad({ bytes, bump: META.bump });
F('omni_env_init')();       /* 像里没有环境变量 —— 见上面造像那一段的注释 */
say('铺像：装 ' + META.order.length + ' 份 ' + tLoad + 'ms、铺 ' + bytes.length + ' 字节、共 '
  + (Date.now() - t0) + 'ms');
const st = $RT.memStoreFn('i8');
const ptr = F('omni_src_ptr')();
const ev = F('omni_eval_buf');
for (const [src, want] of ${JSON.stringify(CHECK)}) {
  const bs = new TextEncoder().encode(src);
  for (let i = 0; i < bs.length; i++) st(ptr, i, BigInt(bs[i]));
  st(ptr, bs.length, 0n);
  let got;
  try { got = ev(); } catch (e) { got = '炸了：' + String(e && e.message).slice(0, 120); }
  say((got === want ? 'ok  ' : 'BAD ') + src + ' -> ' + got + '（要 ' + want + '）');
}
say('铺完到答完：' + (Date.now() - t0) + 'ms');
`;
const r2 = run(src2, 'rimage-load');
const out = readFileSync(LOG, 'utf8');
process.stdout.write(out);
process.stdout.write((r2.stdout ?? '').slice(0, 1000));
process.stdout.write((r2.stderr ?? '').split('\n').slice(0, 10).join('\n'));
const bad = out.split('\n').filter((l) => l.startsWith('BAD'));
process.stdout.write(`\n账：${JSON.stringify({
  bytes: meta.bytes, stmts: meta.stmts, errs: meta.errs, done: meta.done,
  bases: Object.keys(meta.bases).length, order: meta.order.length, bad: bad.length,
})}\n`);
process.exit(bad.length > 0 || out.indexOf('铺完到答完') < 0 ? 1 : 0);
