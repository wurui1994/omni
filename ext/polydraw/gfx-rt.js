// ext/polydraw/gfx-rt.js —— **EVAL 那两门语言的图形设备，写成一段"生成出来的标准 IR"**
//
// 为什么在这儿生成、而不是给方言加一格新 op：加 op 要同时动方言 + 四条宿主腿
// （JS emit / C emit / 解释器 / 原生运行时），而这一层要的全是**普通算术与数组** ——
// 生成出来的 IR 在每条腿上都已经能跑。真到了"慢得受不了"那天再换成 C 运行时（那是优化）。
//
// ## 设备就是一块帧缓冲
//
// 模块级一格 `(arr real)`：`gfx_fb`，长度 `w*h`，每格装一个 `0xRRGGBB` 的数。
// 画图元 = 往那块里写数（Bresenham 画线、中点画圆），**一个字节都不过 stdout**。
// `gfx_present` 把这一帧交给方言那一格 `(gfxframe …)`，它按落点后缀写 **PNG**（默认）
// 或裸表面（`#rgba <w> <h>\n` + 裸字节，`.rgba` 那个备选），
// stdout 上只印一行指针 `#gfx <种类> <路径> <宽> <高>` —— 与 `ext/js/lib/ege.js`
// **同一个出口**，所以 Studio 贴 canvas、glfw 贴窗口两边都不用改。
//
// ## 口径
//
// EvalDraw 的 2D 语义照 `evaldraw_ref.md`：`cls(r,g,b)` 清屏、`setcol(r,g,b)` 换当前色、
// `setpix(x,y)` 点、`moveto`/`lineto` 走笔、`drawsph(x,y,r)` 画圆（**半径为负是描边**）、
// `drawcone(x,y,r,x2,y2,r2)` 粗线。颜色分量 0..255；坐标左上角原点、y 往下。

import {
  REAL, ARR, num, str, nm, bin, call, bi, rm, set, letR, ret, iff, whil, ex, aset, ix, fn, glob, anew,
} from './ir.js';

/** 设备的模块级那几格（名字都带 `gfx_` 前缀 —— 脚本里的名字不会撞）。 */
export const GFX_GLOBALS = ['gfx_w', 'gfx_h', 'gfx_col', 'gfx_x', 'gfx_y', 'gfx_on'];

export function gfxGlobalDecls() {
  return [...GFX_GLOBALS.map((n) => glob(n)), glob('gfx_fb', ARR)];
}

/**
 * **宿主名字/元数 -> 生成出来的那格函数**（EvalDraw 的 2D 那一档）。
 *
 * 一律落成**普通调用** —— 于是它在语句位置与值位置都成立（EVAL 里这些函数回 0），
 * adapter 那边一个特例都不用开。认不出的元数照旧当场报，不猜。
 */
export const EVALDRAW_2D = new Map([
  ['cls/3', 'gfx_cls'],
  /* `cls(打包好的颜色)` —— EvalDraw 里最常见的那个写法（`cls(0)` 清成黑，
     语料里 14 份 `.kc` 头一句就是它）。与 `setcol/1` 同一档：一格 0xRRGGBB 的数。 */
  ['cls/1', 'gfx_cls1'],
  ['setcol/3', 'gfx_setcol'],
  ['setcol/1', 'gfx_setcol1'],
  ['setpix/2', 'gfx_setpix'],
  ['moveto/2', 'gfx_moveto'],
  ['lineto/2', 'gfx_lineto'],
  ['drawsph/3', 'gfx_sph'],
  ['drawcone/6', 'gfx_cone'],
  ['refresh/0', 'gfx_present'],
  ['rgb/3', 'gfx_rgb'],
]);

/**
 * 交出这一帧：帧缓冲整块过 `(gfxframe PATH W H FB)`（那一格在公共层，`lower/sx.js`），
 * stdout 上只印一行指针 `#gfx <种类> <路径> <宽> <高>`。种类**按落点的后缀**：
 * 默认 `png`（编码那一层在 `(gfxframe …)` 那一格里），`.rgba` 是备选那个裸表面。
 *
 * **不在语言里拼字节串**：那要 320×240 次串拼接，而且 `(writetext …)` 按 UTF-8 写 ——
 * 大于 127 的字节会被编成两个字节，图当场就坏。宽高按运行期的 `gfx_w`/`gfx_h` 报
 * （`gfx_open` 换过尺寸也对得上），`defW`/`defH` 只用来在第一次画之前开那一块。
 */
export function gfxPresentDecl(path) {
  const sint = (e) => bi('tostr', [ix(e)]);
  const kind = path.endsWith('.rgba') ? 'rgba' : 'png';
  return {
    kind: 'fn',
    name: 'gfx_present',
    params: [],
    ret: REAL,
    body: [
      ex(call('gfx_need', [])),
      ex(bi('gfxframe', [str(path), ix(nm('gfx_w')), ix(nm('gfx_h')), nm('gfx_fb')])),
      {
        kind: 'print',
        values: [bin('+', bin('+', bin('+', str(`#gfx ${kind} ${path} `), sint(nm('gfx_w'))),
          str(' ')), sint(nm('gfx_h')))],
      },
      ret(num(0)),
    ],
  };
}

/**
 * 设备那十几格函数（生成出来的标准 IR）。
 *
 * `gfx_need` 是"第一次画之前自动开一块"—— EvalDraw 的脚本里没有"开设备"那一句
 * （窗口是宿主给的 `xres`/`yres`），所以开设备这件事不能等脚本来说。
 */
export function gfxFnDecls(defW, defH) {
  return [
    fn('gfx_open', ['w', 'h'], [
      set('gfx_w', nm('w')),
      set('gfx_h', nm('h')),
      set('gfx_fb', anew(bin('*', nm('w'), nm('h')))),
      set('gfx_on', num(1)),
      set('gfx_col', num(0xffffff)),
      set('gfx_x', num(0)),
      set('gfx_y', num(0)),
      ret(num(0)),
    ]),
    fn('gfx_need', [], [
      iff(bin('==', nm('gfx_on'), num(0)), [ex(call('gfx_open', [num(defW), num(defH)]))]),
      ret(num(0)),
    ]),
    /* 坐标是 double：四舍五入到最近的整数。 */
    fn('gfx_round', ['v'], [ret(rm('floor', [bin('+', nm('v'), num(0.5))]))]),
    fn('gfx_clamp255', ['v'], [
      letR('i', call('gfx_round', [nm('v')])),
      iff(bin('<', nm('i'), num(0)), [ret(num(0))]),
      iff(bin('>', nm('i'), num(255)), [ret(num(255))]),
      ret(nm('i')),
    ]),
    fn('gfx_rgb', ['r', 'g', 'b'], [
      ret(bin('+', bin('+',
        bin('*', call('gfx_clamp255', [nm('r')]), num(65536)),
        bin('*', call('gfx_clamp255', [nm('g')]), num(256))),
      call('gfx_clamp255', [nm('b')]))),
    ]),
    /* 一格像素：越界丢掉（**裁剪只在这一处做**，上头的图元都不用再判）。 */
    fn('gfx_px', ['x', 'y', 'c'], [
      ex(call('gfx_need', [])),
      letR('xi', call('gfx_round', [nm('x')])),
      letR('yi', call('gfx_round', [nm('y')])),
      iff(bin('||', bin('||', bin('<', nm('xi'), num(0)), bin('<', nm('yi'), num(0))),
        bin('||', bin('>=', nm('xi'), nm('gfx_w')), bin('>=', nm('yi'), nm('gfx_h')))),
      [ret(num(0))]),
      aset('gfx_fb', bin('+', bin('*', nm('yi'), nm('gfx_w')), nm('xi')), nm('c')),
      ret(num(0)),
    ]),
    fn('gfx_cls', ['r', 'g', 'b'], [
      ex(call('gfx_need', [])),
      letR('c', call('gfx_rgb', [nm('r'), nm('g'), nm('b')])),
      letR('i', num(0)),
      whil(bin('<', nm('i'), bin('*', nm('gfx_w'), nm('gfx_h'))), [
        aset('gfx_fb', nm('i'), nm('c')),
        set('i', bin('+', nm('i'), num(1))),
      ]),
      ret(num(0)),
    ]),
    fn('gfx_setcol', ['r', 'g', 'b'], [
      ex(call('gfx_need', [])),
      set('gfx_col', call('gfx_rgb', [nm('r'), nm('g'), nm('b')])),
      ret(num(0)),
    ]),
    /* `setcol(0xc0c0c0)` 那一档（语料里很常见）：整数就是打包好的颜色。 */
    fn('gfx_setcol1', ['c'], [
      ex(call('gfx_need', [])),
      set('gfx_col', nm('c')),
      ret(num(0)),
    ]),
    /* `cls(c)`：一格打包好的颜色清整块（与 `gfx_cls` 同一段循环，只是颜色不用拼）。 */
    fn('gfx_cls1', ['c'], [
      ex(call('gfx_need', [])),
      letR('i', num(0)),
      whil(bin('<', nm('i'), bin('*', nm('gfx_w'), nm('gfx_h'))), [
        aset('gfx_fb', nm('i'), nm('c')),
        set('i', bin('+', nm('i'), num(1))),
      ]),
      ret(num(0)),
    ]),
    fn('gfx_setpix', ['x', 'y'], [
      ex(call('gfx_px', [nm('x'), nm('y'), nm('gfx_col')])),
      ret(num(0)),
    ]),
    fn('gfx_moveto', ['x', 'y'], [
      ex(call('gfx_need', [])),
      set('gfx_x', nm('x')),
      set('gfx_y', nm('y')),
      ret(num(0)),
    ]),
    fn('gfx_lineto', ['x', 'y'], [
      ex(call('gfx_line', [nm('gfx_x'), nm('gfx_y'), nm('x'), nm('y')])),
      set('gfx_x', nm('x')),
      set('gfx_y', nm('y')),
      ret(num(0)),
    ]),
    /* Bresenham。两头都画（与 EvalDraw 的 `lineto` 一样是闭区间）。 */
    fn('gfx_line', ['x0', 'y0', 'x1', 'y1'], [
      letR('x', call('gfx_round', [nm('x0')])),
      letR('y', call('gfx_round', [nm('y0')])),
      letR('xe', call('gfx_round', [nm('x1')])),
      letR('ye', call('gfx_round', [nm('y1')])),
      letR('dx', rm('fabs', [bin('-', nm('xe'), nm('x'))])),
      letR('dy', rm('fabs', [bin('-', nm('ye'), nm('y'))])),
      letR('sx', num(1)),
      letR('sy', num(1)),
      iff(bin('>', nm('x'), nm('xe')), [set('sx', num(-1))]),
      iff(bin('>', nm('y'), nm('ye')), [set('sy', num(-1))]),
      letR('err', bin('-', nm('dx'), nm('dy'))),
      letR('go', num(1)),
      whil(bin('!=', nm('go'), num(0)), [
        ex(call('gfx_px', [nm('x'), nm('y'), nm('gfx_col')])),
        iff(bin('&&', bin('==', nm('x'), nm('xe')), bin('==', nm('y'), nm('ye'))),
          [set('go', num(0))],
          [
            letR('e2', bin('*', num(2), nm('err'))),
            iff(bin('>', nm('e2'), bin('-', num(0), nm('dy'))), [
              set('err', bin('-', nm('err'), nm('dy'))),
              set('x', bin('+', nm('x'), nm('sx'))),
            ]),
            iff(bin('<', nm('e2'), nm('dx')), [
              set('err', bin('+', nm('err'), nm('dx'))),
              set('y', bin('+', nm('y'), nm('sy'))),
            ]),
          ]),
      ]),
      ret(num(0)),
    ]),
    /* `drawsph(x,y,r)`：**半径为负是描边**（`evaldraw_ref.md` 那句 "Use negative radius
       to draw circle outline"）。 */
    fn('gfx_sph', ['cx', 'cy', 'r'], [
      iff(bin('<', nm('r'), num(0)),
        [ex(call('gfx_circ', [nm('cx'), nm('cy'), bin('-', num(0), nm('r'))]))],
        [ex(call('gfx_disc', [nm('cx'), nm('cy'), nm('r')]))]),
      ret(num(0)),
    ]),
    /* 填充圆：逐行算半弦长，一行一段。 */
    fn('gfx_disc', ['cx', 'cy', 'r'], [
      letR('ri', call('gfx_round', [nm('r')])),
      letR('dy', bin('-', num(0), nm('ri'))),
      whil(bin('<=', nm('dy'), nm('ri')), [
        letR('dx', rm('floor', [rm('sqrt', [bin('-',
          bin('*', nm('ri'), nm('ri')), bin('*', nm('dy'), nm('dy')))])])),
        letR('x', bin('-', num(0), nm('dx'))),
        whil(bin('<=', nm('x'), nm('dx')), [
          ex(call('gfx_px', [bin('+', nm('cx'), nm('x')), bin('+', nm('cy'), nm('dy')), nm('gfx_col')])),
          set('x', bin('+', nm('x'), num(1))),
        ]),
        set('dy', bin('+', nm('dy'), num(1))),
      ]),
      ret(num(0)),
    ]),
    /* 描边圆：中点画圆 + 八分对称。 */
    fn('gfx_circ', ['cx', 'cy', 'r'], [
      letR('x', call('gfx_round', [nm('r')])),
      letR('y', num(0)),
      letR('err', bin('-', num(1), nm('x'))),
      whil(bin('>=', nm('x'), nm('y')), [
        ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].flatMap(([sx, sy]) => ([
          ex(call('gfx_px', [bin('+', nm('cx'), bin('*', num(sx), nm('x'))),
            bin('+', nm('cy'), bin('*', num(sy), nm('y'))), nm('gfx_col')])),
          ex(call('gfx_px', [bin('+', nm('cx'), bin('*', num(sx), nm('y'))),
            bin('+', nm('cy'), bin('*', num(sy), nm('x'))), nm('gfx_col')])),
        ])),
        set('y', bin('+', nm('y'), num(1))),
        iff(bin('<', nm('err'), num(0)),
          [set('err', bin('+', nm('err'), bin('+', bin('*', num(2), nm('y')), num(1))))],
          [
            set('x', bin('-', nm('x'), num(1))),
            set('err', bin('+', nm('err'),
              bin('+', bin('*', num(2), bin('-', nm('y'), nm('x'))), num(1)))),
          ]),
      ]),
      ret(num(0)),
    ]),
    /* `drawcone(x,y,r,x2,y2,r2)` 是**粗线**：这一版沿线铺圆（形状对、边缘比真梯形略毛）。
       要逐像素对上旧实现得按 `evaldraw.txt` 那一格补 —— 记在任务 #20 里。 */
    fn('gfx_cone', ['x0', 'y0', 'r0', 'x1', 'y1', 'r1'], [
      letR('dx', bin('-', nm('x1'), nm('x0'))),
      letR('dy', bin('-', nm('y1'), nm('y0'))),
      letR('n', rm('floor', [bin('+', rm('hypot', [nm('dx'), nm('dy')]), num(1))])),
      letR('i', num(0)),
      whil(bin('<=', nm('i'), nm('n')), [
        letR('t', bin('/', nm('i'), nm('n'))),
        ex(call('gfx_disc', [
          bin('+', nm('x0'), bin('*', nm('t'), nm('dx'))),
          bin('+', nm('y0'), bin('*', nm('t'), nm('dy'))),
          bin('+', nm('r0'), bin('*', nm('t'), bin('-', nm('r1'), nm('r0')))),
        ])),
        set('i', bin('+', nm('i'), num(1))),
      ]),
      ret(num(0)),
    ]),
  ];
}
