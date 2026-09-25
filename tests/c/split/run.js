// tests/c/split/run.js —— `omni c split` 的判据（ADR-0046 §4）
//
// 硬线只有一条：**拆开再接回去逐字节等于原文**。这一条在 `--check` 里，而这台判据要做的是
// 把它压在**我们自己仓库里真实尺寸的 C** 上 —— 让"C 解析能力"的缺口暴露在我们的代码上，
// 而不是等 polydraw 那三份报错。
//
// 顺带验两件结构性的事（不靠外部工具）：
//   * 划分完整：全部切片是 `[0, len)` 的一个划分（`scanTopLevel` 里那句 assert）；
//   * 名字可用：`func` 那一族不许出现 `struct` / `__declspec` / 空名字这种"扫错了"的名字
//     —— 这三样都是真踩过的坑（见 split.js 里那两段注）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanTopLevel, joinChunks, KIND, readPlan, applyPlan, checkRejoin, contiguity, stitchFile,
  ppBalance } from '../../../src/core/frontend-c/split.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const P = (s) => process.stdout.write(s);
let pass = 0;
let fail = 0;

/* 拿**真实尺寸**的那几份（runtime 与 jit 下面的 .c）。小文件证明不了什么。 */
const dirs = ['src/runtime', 'src/jit'];
const files = [];
for (const d of dirs) {
  for (const f of readdirSync(join(ROOT, d))) {
    if (!f.endsWith('.c')) continue;
    const p = join(ROOT, d, f);
    if (statSync(p).size >= 4096) files.push(p);
  }
}
if (files.length < 5) {
  P(`  FAIL 判据自己的前提不成立：只找到 ${files.length} 份够大的 .c\n`);
  process.exit(1);
}

const BAD_NAME = new Set(['struct', 'union', 'enum', 'typedef', '__declspec', '__attribute__', '']);
for (const p of files) {
  const src = readFileSync(p, 'latin1');
  const rel = p.slice(ROOT.length + 1);
  let chunks = null;
  try {
    chunks = scanTopLevel(src);
  } catch (e) {
    fail++;
    P(`  FAIL ${rel} 扫得完\n       ${e.message}\n`);
    continue;
  }
  if (joinChunks(src, chunks) !== src) {
    fail++;
    P(`  FAIL ${rel} 接回去逐字节相同\n`);
    continue;
  }
  const bad = chunks.filter((c) => c.kind === KIND.func && BAD_NAME.has(c.name));
  if (bad.length > 0) {
    fail++;
    P(`  FAIL ${rel} 函数名都像名字\n       ${bad.length} 个可疑：`
      + `${bad.slice(0, 5).map((c) => c.name || '(空)').join(' ')}\n`);
    continue;
  }
  pass++;
  const n = chunks.filter((c) => c.kind === KIND.func).length;
  P(`  ok   ${rel} ${chunks.length} 格 / ${n} 个函数，接回去逐字节相同\n`);
}

/* ── 第二段：**整条路**（描述文件 -> 切 -> 缝合 -> 接回来）在一份真实文件上走一趟 ──
 *
 * 前面那一段只验扫描器。这一段把 `--map` 那条路也压上：拿 `omni_r3.c`（76 个函数）
 * 按行段切成四份，验三件事 —— 复原逐字节、**每份是一段连续区间**（不然缝合会重排
 * 声明次序）、缝合文件里那几份 `#include` 接起来等于原文。 */
{
  const p = join(ROOT, 'src/runtime/omni_r3.c');
  const src = readFileSync(p, 'latin1');
  const chunks = scanTopLevel(src);
  const cuts = [[0, 'r3/a.c'], [0.25, 'r3/b.c'], [0.5, 'r3/c.c'], [0.75, 'r3/d.c']];
  const rows = chunks.map((c, i) => {
    let f = cuts[0][1];
    for (const [frac, m] of cuts) if (i >= Math.floor(frac * chunks.length)) f = m;
    const at = src.slice(0, c.start).split('\n').length;
    return `${f}\t${c.kind}\t${c.name}\t${at}`;
  });
  const r = applyPlan(src, chunks, readPlan(rows.join('\n')));
  const chk = checkRejoin(src, r.manifest, r.files);
  const bad = contiguity(r.manifest);
  const st = stitchFile('omni_r3.c', r.manifest);
  const incs = [...st.matchAll(/#include "([^"]+)"/g)].map((m) => m[1]);
  const cat = incs.map((f) => r.files.get(f) ?? '').join('');
  const ok = r.missing.length === 0 && chk.ok && bad.size === 0 && cat === src
    && incs.length === 4 && ppBalance(r.files).size === 0;
  if (ok) {
    pass++;
    P(`  ok   整条路（omni_r3.c -> 4 份 -> 缝合）：复原逐字节、每份一段连续、缝合等于原文\n`);
  } else {
    fail++;
    P(`  FAIL 整条路：未指派 ${r.missing.length}、复原 ${chk.ok}、不连续 ${bad.size}`
      + `、缝合 ${incs.length} 份 ${cat === src}、条件没配平 ${ppBalance(r.files).size}\n`);
  }
}

/* ── 第三段：**条件编译要自己配平**那道闸 ──
 *
 * 这是真踩过的坑：`eval.c` 的 `#ifdef _MSC_VER`（`kasm_state.c` 末尾）与它的
 * `#else/#endif`（`kasm_cpu.c` 开头）被切点劈成两半 —— `#include` 的边界劈不开一个
 * 条件段，于是 `unterminated conditional directive` + `#else without #if`，
 * 四对文件一条命令都编不过。这里正反各压一次：劈开要报，不劈开要过。 */
{
  const src = 'static int a;\n#ifdef X\nstatic int f (void) { return 1; }\n#else\n'
    + 'static int f (void) { return 2; }\n#endif\nstatic int b;\n';
  const chunks = scanTopLevel(src);
  const mk = (pick) => {
    const rows = chunks.map((c, i) => {
      const at = src.slice(0, c.start).split('\n').length;
      return `${pick(i)}\t${c.kind}\t${c.name}\t${at}`;
    });
    return applyPlan(src, chunks, readPlan(rows.join('\n')));
  };
  /* 劈开：`#ifdef` 落在前一份、`#else/#endif` 落在后一份。 */
  const cut = chunks.findIndex((c) => c.kind === KIND.pp && c.name === 'ifdef');
  const split = mk((i) => (i <= cut ? 'x/a.c' : 'x/b.c'));
  const whole = mk((i) => (i < cut ? 'x/a.c' : 'x/b.c'));
  const b1 = ppBalance(split.files);
  const b2 = ppBalance(whole.files);
  const ok = cut > 0 && b1.size === 2 && b1.get('x/a.c') === 1 && b1.get('x/b.c') === -1
    && b2.size === 0 && checkRejoin(src, whole.manifest, whole.files).ok;
  if (ok) {
    pass++;
    P('  ok   条件编译配平那道闸：劈开 #ifdef 报 +1/-1，整段归一份就过\n');
  } else {
    fail++;
    P(`  FAIL 条件编译配平那道闸：切点 ${cut}、劈开报 ${[...b1]}、整段报 ${[...b2]}\n`);
  }
}

P(`\n${pass} passed, ${fail} failed（omni c split：划分完整 + 逐字节复原）\n`);
process.exit(fail === 0 ? 0 : 1);