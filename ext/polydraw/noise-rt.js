// ext/polydraw/noise-rt.js —— **噪声那一族**（`NOISE(x)` / `NOISE(x,y)` / `NOISE(x,y,z)` /
// `NOISE3D(x,y,z)`），落成**生成出来的 IR**。
//
// ## 为什么在语言这一侧，不在设备那一侧
//
// 它是**纯函数**（给几个数、回一个数），与画布、上下文、GPU 都无关。落在语言这一侧
// ⇒ 四条腿（js / interp / c / 原生）跑的是同一份代码、逐字节相同，也不必给三档设备
// 各写一份。`pd_rnd`/`pd_fact` 是同一条路。
//
// ## 正本
//
// `polydraw_src/polydraw.c:852-960`（Tom Dobrowolski 的噪声）：
//   * `fgrad(h,x,y,z)`：`h&15` 那张 16 格梯度表（四个一组，两两取和/差）；
//   * `noise1d/2d/3d`：格点上取梯度、`t = (3-2p)·p²` 平滑、按维数逐层线性插值；
//   * 置换表 `noisep[512]`：`noiseinit()`（`polydraw.c:3538`，开机一次）用 **C 库的
//     `rand()`** 洗出来的 —— 与脚本能看见的 `SRAND` 无关。MSVC 的 `rand()` 就是
//     `pd_rnd` 已经照抄的那台 LCG（`s = s*214013 + 2531011`、取 `(s>>16)&0x7fff`、
//     起始 1），所以这张表能一位不差地重算：入口里发一格 `pd_noiseinit()` 填它。
//
// ## 两处**明写的偏差**（照不到的地方不装作照到）
//
// 1. 原版中间量是 `float`，我们是 `double` —— 值差在 1e-7 量级；
// 2. `dtol()` 在 MSVC 上是 `fistp`（就近偶数），我们用 `floor(x+0.5)`（就近、遇 .5 往上）。
//    非 Windows 上原版那一格**本身是坏的**（`a = (int)f;` 写到了指针变量上），所以
//    没有第二份"正确答案"可以对。
import { ARR, num, nm, bin, call, rm, set, letR, ret, iff, whil, ex, aset, aget, fn, glob, anew, tern } from './ir.js';

/** 宿主名字/元数 -> 生成出来的那格函数。 */
export const NOISE_FNS = new Map([
  ['noise/1', 'pd_noise1'],
  ['noise/2', 'pd_noise2'],
  ['noise/3', 'pd_noise3'],
  ['noise3d/3', 'pd_noise3'],
]);

export function noiseGlobalDecls() {
  return [glob('pd_np', ARR), glob('pd_nseed')];
}

/** `pd_np[i]`。 */
const np = (i) => aget('pd_np', i);

/** 就近取整（见文件头那条偏差）。 */
const rnd0 = (e) => rm('floor', [bin('+', e, num(0.5))]);

/**
 * `fgrad(h,x,y,z)`：`h&15` 那张表。照源码一格一格写 —— 16 条里有两对是重复的
 * （12/13 与 0/1、14/15 与 10/11），那是原版的样子，不"顺手改对"。
 */
function fgradDecl() {
  const T = [
    ['+x', '+y', ''], ['-x', '+y', ''], ['+x', '-y', ''], ['-x', '-y', ''],
    ['+x', '', '+z'], ['-x', '', '+z'], ['+x', '', '-z'], ['-x', '', '-z'],
    ['', '+y', '+z'], ['', '-y', '+z'], ['', '+y', '-z'], ['', '-y', '-z'],
    ['+x', '+y', ''], ['-x', '+y', ''], ['', '+y', '-z'], ['', '-y', '-z'],
  ];
  const term = (s) => {
    if (s === '') return null;
    const v = nm(s.slice(1));
    return s[0] === '-' ? bin('-', num(0), v) : v;
  };
  const sum = (row) => {
    const ts = row.map(term).filter((t) => t !== null);
    return ts.reduce((a, b) => bin('+', a, b));
  };
  /* `h & 15`：h 已经是 0..255 的整数，取模就够（方言里没有位运算的 double 版）。 */
  const body = [letR('k', rm('fmod', [nm('h'), num(16)]))];
  for (let i = 0; i < 16; i++) {
    body.push(iff(bin('==', nm('k'), num(i)), [ret(sum(T[i]))]));
  }
  body.push(ret(num(0)));
  return fn('pd_fgrad', ['h', 'x', 'y', 'z'], body);
}

/**
 * 置换表：`for(i=255..0) p[i]=i;` 再 `for(i=255..1) j=(rand()*(i+1))>>15; swap(p[i],p[j]);`
 * 最后 `p[i+256] = p[i]`。`rand()` 是 MSVC 那台 LCG（见文件头）。
 */
function noiseInitDecl() {
  const nextRand = [
    set('pd_nseed', rm('fmod', [bin('+', bin('*', nm('pd_nseed'), num(214013)), num(2531011)),
      num(4294967296)])),
    letR('r', rm('fmod', [rm('floor', [bin('/', nm('pd_nseed'), num(65536))]), num(32768)])),
  ];
  return fn('pd_noiseinit', [], [
    set('pd_np', anew(num(512))),
    set('pd_nseed', num(1)),
    letR('i', num(0)),
    whil(bin('<', nm('i'), num(256)), [
      aset('pd_np', nm('i'), nm('i')),
      set('i', bin('+', nm('i'), num(1))),
    ]),
    set('i', num(255)),
    whil(bin('>', nm('i'), num(0)), [
      ...nextRand,
      letR('j', rm('floor', [bin('/', bin('*', nm('r'), bin('+', nm('i'), num(1))), num(32768))])),
      letR('k', np(nm('i'))),
      aset('pd_np', nm('i'), np(nm('j'))),
      aset('pd_np', nm('j'), nm('k')),
      set('i', bin('-', nm('i'), num(1))),
    ]),
    set('i', num(0)),
    whil(bin('<', nm('i'), num(256)), [
      aset('pd_np', bin('+', nm('i'), num(256)), np(nm('i'))),
      set('i', bin('+', nm('i'), num(1))),
    ]),
    ret(num(0)),
  ]);
}

/** 一格坐标的三件事：格点 `l`、格内 `p`、平滑 `t`（照源码那三句）。 */
const axis = (name, src) => [
  letR(`l${name}`, rm('fmod', [rnd0(bin('-', src, num(0.5))), num(256)])),
  /* `l &= 255` 之前 `p = fx - (float)l` 用的是**没取模**的那个 l —— 取模只影响查表。
     所以这儿先算 p（用没取模的），再把 l 夹到 0..255。 */
  letR(`p${name}`, bin('-', src, rnd0(bin('-', src, num(0.5))))),
  iff(bin('<', nm(`l${name}`), num(0)), [set(`l${name}`, bin('+', nm(`l${name}`), num(256)))]),
  letR(`t${name}`, bin('*', bin('*', bin('-', num(3), bin('*', num(2), nm(`p${name}`))),
    nm(`p${name}`)), nm(`p${name}`))),
];

export function noiseFnDecls() {
  const g = (h, x, y, z) => call('pd_fgrad', [h, x, y, z]);
  const lerp = (a, b, t) => bin('+', bin('*', bin('-', b, a), t), a);
  return [
    fgradDecl(),
    noiseInitDecl(),
    /* 一维：两个格点。 */
    fn('pd_noise1', ['fx'], [
      ...axis('0', nm('fx')),
      letR('f0', g(np(np(np(nm('l0')))), nm('p0'), num(0), num(0))),
      letR('f1', g(np(np(np(bin('+', nm('l0'), num(1))))), bin('-', nm('p0'), num(1)),
        num(0), num(0))),
      ret(lerp(nm('f0'), nm('f1'), nm('t0'))),
    ]),
    /* 二维：四个格点（`a[0..3]` 照源码的算法取）。 */
    fn('pd_noise2', ['fx', 'fy'], [
      ...axis('0', nm('fx')),
      ...axis('1', nm('fy')),
      letR('i0', np(nm('l0'))),
      letR('i1', np(bin('+', nm('l0'), num(1)))),
      letR('a0', np(bin('+', nm('i0'), nm('l1')))),
      letR('a2', np(bin('+', bin('+', nm('i0'), nm('l1')), num(1)))),
      letR('a1', np(bin('+', nm('i1'), nm('l1')))),
      letR('a3', np(bin('+', bin('+', nm('i1'), nm('l1')), num(1)))),
      letR('f0', g(np(nm('a0')), nm('p0'), nm('p1'), num(0))),
      letR('f1', g(np(nm('a1')), bin('-', nm('p0'), num(1)), nm('p1'), num(0))),
      letR('f2', g(np(nm('a2')), nm('p0'), bin('-', nm('p1'), num(1)), num(0))),
      letR('f3', g(np(nm('a3')), bin('-', nm('p0'), num(1)), bin('-', nm('p1'), num(1)), num(0))),
      letR('g0', lerp(nm('f0'), nm('f1'), nm('t0'))),
      letR('g1', lerp(nm('f2'), nm('f3'), nm('t0'))),
      ret(lerp(nm('g0'), nm('g1'), nm('t1'))),
    ]),
    /* 三维：八个格点。 */
    fn('pd_noise3', ['fx', 'fy', 'fz'], [
      ...axis('0', nm('fx')),
      ...axis('1', nm('fy')),
      ...axis('2', nm('fz')),
      letR('i0', np(nm('l0'))),
      letR('i1', np(bin('+', nm('l0'), num(1)))),
      letR('a0', np(bin('+', nm('i0'), nm('l1')))),
      letR('a2', np(bin('+', bin('+', nm('i0'), nm('l1')), num(1)))),
      letR('a1', np(bin('+', nm('i1'), nm('l1')))),
      letR('a3', np(bin('+', bin('+', nm('i1'), nm('l1')), num(1)))),
      letR('f0', g(np(bin('+', nm('a0'), nm('l2'))), nm('p0'), nm('p1'), nm('p2'))),
      letR('f1', g(np(bin('+', nm('a1'), nm('l2'))), bin('-', nm('p0'), num(1)), nm('p1'), nm('p2'))),
      letR('f2', g(np(bin('+', nm('a2'), nm('l2'))), nm('p0'), bin('-', nm('p1'), num(1)), nm('p2'))),
      letR('f3', g(np(bin('+', nm('a3'), nm('l2'))), bin('-', nm('p0'), num(1)),
        bin('-', nm('p1'), num(1)), nm('p2'))),
      letR('q2', bin('-', nm('p2'), num(1))),
      letR('f4', g(np(bin('+', bin('+', nm('a0'), nm('l2')), num(1))), nm('p0'), nm('p1'), nm('q2'))),
      letR('f5', g(np(bin('+', bin('+', nm('a1'), nm('l2')), num(1))), bin('-', nm('p0'), num(1)),
        nm('p1'), nm('q2'))),
      letR('f6', g(np(bin('+', bin('+', nm('a2'), nm('l2')), num(1))), nm('p0'),
        bin('-', nm('p1'), num(1)), nm('q2'))),
      letR('f7', g(np(bin('+', bin('+', nm('a3'), nm('l2')), num(1))), bin('-', nm('p0'), num(1)),
        bin('-', nm('p1'), num(1)), nm('q2'))),
      letR('g0', lerp(nm('f0'), nm('f1'), nm('t0'))),
      letR('g1', lerp(nm('f2'), nm('f3'), nm('t0'))),
      letR('g2', lerp(nm('f4'), nm('f5'), nm('t0'))),
      letR('g3', lerp(nm('f6'), nm('f7'), nm('t0'))),
      letR('h0', lerp(nm('g0'), nm('g1'), nm('t1'))),
      letR('h1', lerp(nm('g2'), nm('g3'), nm('t1'))),
      ret(lerp(nm('h0'), nm('h1'), nm('t2'))),
    ]),
  ];
}
