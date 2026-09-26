// ext/polydraw/text-rt.js —— **画布上的文字那一族**（`printf`/`printg`/`printchar`/`setfont`）
//
// 为什么在语言这一侧（而不是给三台设备各加一格）：
//
// 1. 这一族的实参里**有串**（`printf(fmt, …)`、`printg(x,y,col,fmt,…)`），而设备那一面
//    只收 double（`(gfxcall 名字 double…)`）—— 串压根过不去。
// 2. 画出来的东西就是**一堆 setpix**：设备已经有这一格。所以按"只有一个模型"
//    （`docs/design/eval-realtime-gpu.md` 第 9 节）写在这儿，三台设备（帧缓冲、WebGL2、
//    本机 GL）**一次全有**，而且三条腿出来的图逐像素相同。
//
// ## 字模
//
// 6×8 那张（`src/core/host/font6x8.js`，照 `polydraw.c:713` 的 `font6x8[]` 抄的
// DOSAPP.FON 256 格）。这儿把每格字的 6 个竖列**打包成一个数**（48 位，double 里精确）：
// `gt_f[c] = col0 + col1*256 + … + col5*256^5`，`col` 的 bit r 是第 r 行（0 在上）。
// 打包不是省事，是省产物：1536 格要 1536 句 `aset`，打包之后 256 句。
//
// ## 与正本的差（写出来，不装作照到）
//
// * `setfont(w,h)` 在 EvalDraw 里是"选一张内建位图字体"（例子里是 9×16）；我们只有
//   6×8 这一张，所以**按最近邻缩放**到 w×h。版式（每格多宽、行距多高）是对的，
//   笔形在非 6×8 的尺寸上是放大的点阵。
// * `setfont(w,h,dofill)` 那一档正本是**贝塞尔字体**（可填充/只描边）—— 我们没有那份
//   字形数据，收下 `dofill` 不用，照位图那条路画。
// * PolyDraw 的 `printg` 是拿字模贴纹理四边形画的（`myprintg`），6×8、不换行、
//   `\t` 当三个空格 —— 这几条我们逐条照着做。
// * 表里只有 32..126 那 95 格可打印字符（`gt_str` 靠 `(sfind …)` 查）。高位那些
//   DOS 画线符按"空一格"处理 —— 语料里没有一份脚本画它们。

import { FONT6X8, FONT_W, FONT_H } from '../../src/core/host/font6x8.js';
import {
  ARR, num, str, nm, bin, call, bi, rm, set, letR, letI, inum, ret, iff, whil, ex,
  aset, aget, fn, fnT, glob, anew,
} from './ir.js';
import { d2 } from './gfx3-rt.js';

const STR = { kind: 'string' };

/** 文字那一族的模块级量（名字都带 `gt_` 前缀 —— 脚本里的名字不会撞）。 */
export const TEXT_GLOBALS = [
  'gt_on',                       /* 默认值摆过没有 */
  'gt_fon',                      /* 字模那一块建过没有（第一格字要画的时候才建） */
  'gt_w', 'gt_h',                /* 一格字多宽多高（`setfont` 设的） */
  'gt_x', 'gt_y',                /* 光标（EvalDraw 里 `moveto` 设的就是它） */
  'gt_x0',                       /* 这一行的左边（`\n` 回到这儿） */
  'gt_col', 'gt_ucol',           /* `printg` 那一档自带颜色：`gt_ucol!=0` 时用 `gt_col` */
];

export function textGlobalDecls() {
  return [...TEXT_GLOBALS.map((n) => glob(n)), glob('gt_f', ARR)];
}

/**
 * **宿主名字/元数 -> 生成出来的那格函数**（EvalDraw 那一侧的文字家族）。
 *
 * `printf` 与 `printg` 不在这张表里：它们的格式串是编译期切开的，所以在 adapter 里
 * 落成"几段 `gt_str` + `gt_nl`"（见 `printfOf`）。
 */
export const EVALDRAW_TEXT = new Map([
  ['setfont/2', 'gt_setfont2'],
  ['setfont/3', 'gt_setfont3'],
  ['printchar/1', 'gt_char'],
  ['printnum/1', 'gt_num'],
  /* `moveto(x,y)` 摆的是**同一个光标**（`evaldraw.txt:1481`："Set current position for
     lineto() or print*()"）—— 所以这一格也归这儿：摆好 `gt_x/gt_y` 再原样递给设备。 */
  ['moveto/2', 'gt_moveto'],
]);

/** 32..126 那 95 格可打印字符，头上多一格 `\t`（`gt_str` 用 `(sfind …)` 反查码位）。 */
const CHAR_TAB = `\t${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')}`;

/** 每格字的 6 个竖列打包成一个数（小端：第 0 列在最低那一字节）。 */
function packed() {
  const out = [];
  for (let c = 0; c < 256; c += 1) {
    let v = 0;
    for (let x = FONT_W - 1; x >= 0; x -= 1) v = v * 256 + (FONT6X8[c * FONT_W + x] & 255);
    out.push(v);
  }
  return out;
}

/** `floor(a / b)`（这门语言里除法是浮点的）。 */
const fdiv = (a, b) => rm('floor', [bin('/', a, b)]);
/** `a mod b`（`b` 是正整数字面量那一档：`a - floor(a/b)*b`）。 */
const fmod = (a, b) => bin('-', a, bin('*', fdiv(a, b), b));

export function textFnDecls(host = false) {
  const D = d2(host);
  return [
    /** 默认值：6×8、光标在左上、颜色跟当前 `setcol`。 */
    fn('gt_need', [], [
      iff(bin('!=', nm('gt_on'), num(0)), [ret(num(0))]),
      set('gt_on', num(1)),
      set('gt_w', num(FONT_W)),
      set('gt_h', num(FONT_H)),
      set('gt_x', num(0)), set('gt_y', num(0)), set('gt_x0', num(0)),
      set('gt_col', num(0xffffff)), set('gt_ucol', num(0)),
      ret(num(0)),
    ]),
    /** 字模那一块：**第一格字要画的时候才建**（只 `moveto` 的脚本一句都不用转）。 */
    fn('gt_fneed', [], [
      iff(bin('!=', nm('gt_fon'), num(0)), [ret(num(0))]),
      set('gt_fon', num(1)),
      set('gt_f', anew(num(256))),
      ...packed().map((v, c) => aset('gt_f', num(c), num(v))),
      ret(num(0)),
    ]),
    /* `setfont(w,h)`：一格字的尺寸。小于 1 的当 1（否则 `while tx < gt_w` 一格都不画，
       而正本上那是"字很小"不是"字没了"）。 */
    fn('gt_setfont2', ['w', 'h'], [
      ex(call('gt_need', [])),
      set('gt_w', rm('floor', [nm('w')])),
      set('gt_h', rm('floor', [nm('h')])),
      iff(bin('<', nm('gt_w'), num(1)), [set('gt_w', num(1))]),
      iff(bin('<', nm('gt_h'), num(1)), [set('gt_h', num(1))]),
      ret(num(0)),
    ]),
    /* `setfont(w,h,dofill)`：正本是贝塞尔字体那一档，我们没有那份字形 —— `dofill` 收下
       不用（见文件头那三条差）。 */
    fn('gt_setfont3', ['w', 'h', 'fill'], [
      ex(call('gt_setfont2', [nm('w'), nm('h')])),
      ret(num(0)),
    ]),
    /* `moveto(x,y)`：光标 + 这一行的左边，之后原样递给设备（`lineto` 走笔要它）。 */
    fn('gt_moveto', ['x', 'y'], [
      ex(call('gt_need', [])),
      set('gt_x', nm('x')),
      set('gt_y', nm('y')),
      set('gt_x0', nm('x')),
      ex(D.moveto(nm('x'), nm('y'))),
      ret(num(0)),
    ]),
    /* `printg(x,y,col,…)` 那一档：光标摆到 (x,y)、颜色用它自己那格（画完复原，
       **不动脚本的当前色** —— `myprintg` 也是 push/pop 的）。 */
    fn('gt_at', ['x', 'y', 'c'], [
      ex(call('gt_need', [])),
      set('gt_x', nm('x')), set('gt_y', nm('y')), set('gt_x0', nm('x')),
      set('gt_col', nm('c')), set('gt_ucol', num(1)),
      ret(num(0)),
    ]),
    /** `printg` 画完：回到"跟当前 `setcol`"那一档。 */
    fn('gt_atend', [], [set('gt_ucol', num(0)), ret(num(0))]),
    /** 换行：回到这一行的左边、往下一格字高。 */
    fn('gt_nl', [], [
      ex(call('gt_need', [])),
      set('gt_x', nm('gt_x0')),
      set('gt_y', bin('+', nm('gt_y'), nm('gt_h'))),
      ret(num(0)),
    ]),
    /**
     * **一格字**：字模 6×8 按最近邻铺到 `gt_w`×`gt_h`，点亮的格子发一次 `setpix`。
     *
     * 两处"顺着走"而不是每格重算：源列 `floor(tx*6/gt_w)` 与源行 `floor(ty*8/gt_h)`
     * 都是**不减的**，所以打包那个数只往右挪（`/256`）、列里那几位只往下挪（`/2`）——
     * 一格字最多挪 6 + 8 次，不用 `pow`。
     */
    fn('gt_char', ['code'], [
      ex(call('gt_need', [])),
      ex(call('gt_fneed', [])),
      letR('c', fmod(rm('floor', [nm('code')]), num(256))),
      iff(bin('<', nm('c'), num(0)), [set('c', num(0))]),
      letR('oc', num(0)),
      iff(bin('!=', nm('gt_ucol'), num(0)), [
        set('oc', D.getcol()),
        ex(D.setcol1(nm('gt_col'))),
      ]),
      letR('v', aget('gt_f', nm('c'))),
      letR('sc', num(0)),
      letR('tx', num(0)),
      whil(bin('<', nm('tx'), nm('gt_w')), [
        letR('si', fdiv(bin('*', nm('tx'), num(FONT_W)), nm('gt_w'))),
        whil(bin('<', nm('sc'), nm('si')), [
          set('v', fdiv(nm('v'), num(256))),
          set('sc', bin('+', nm('sc'), num(1))),
        ]),
        letR('br', fmod(nm('v'), num(256))),
        letR('sr', num(0)),
        letR('ty', num(0)),
        whil(bin('<', nm('ty'), nm('gt_h')), [
          letR('sj', fdiv(bin('*', nm('ty'), num(FONT_H)), nm('gt_h'))),
          whil(bin('<', nm('sr'), nm('sj')), [
            set('br', fdiv(nm('br'), num(2))),
            set('sr', bin('+', nm('sr'), num(1))),
          ]),
          iff(bin('!=', fmod(nm('br'), num(2)), num(0)), [
            ex(D.setpix(bin('+', nm('gt_x'), nm('tx')), bin('+', nm('gt_y'), nm('ty')))),
          ]),
          set('ty', bin('+', nm('ty'), num(1))),
        ]),
        set('tx', bin('+', nm('tx'), num(1))),
      ]),
      iff(bin('!=', nm('gt_ucol'), num(0)), [ex(D.setcol1(nm('oc')))]),
      set('gt_x', bin('+', nm('gt_x'), nm('gt_w'))),
      ret(num(0)),
    ]),
    /**
     * **一段串**：一格一格查表（`(sfind 表 那一格)`）再画。
     *
     * 为什么走 `sfind`：方言里没有"取一格字的码位"那一格算子，而串那一族
     * （`slen`/`ssub`/`sfind`）四条腿都已经有 —— 一张 95 格的表就够把可打印字符变回码位，
     * 不用给方言加 op（加一格 op 要动四条腿）。
     *
     * `\t` 是表的第 0 格：照 `myprintg` 里那句 `if (ich == 9) { intab = 2; ich = ' '; }`
     * 走三个空格。表里没有的（`\r`、高位那些）**空一格**。
     */
    fnT('gt_str', [['s', STR]], [
      ex(call('gt_need', [])),
      letI('n', bi('slen', [nm('s')])),
      letI('i', inum(0)),
      whil(bin('<', nm('i'), nm('n')), [
        letI('k', bi('sfind', [str(CHAR_TAB), bi('ssub', [nm('s'), nm('i'), inum(1)])])),
        iff(bin('==', nm('k'), inum(0)), [
          ex(call('gt_char', [num(32)])),
          ex(call('gt_char', [num(32)])),
          ex(call('gt_char', [num(32)])),
        ], [
          iff(bin('>', nm('k'), inum(0)),
            [ex(call('gt_char', [bi('toreal', [bin('+', inum(31), nm('k'))])]))],
            [set('gt_x', bin('+', nm('gt_x'), nm('gt_w')))]),
        ]),
        set('i', bin('+', nm('i'), inum(1))),
      ]),
      ret(num(0)),
    ]),
    /* `printnum(v)`：一格数 + **换行**（`evaldraw.txt:523`："printnum() now moves text
       position to next line"）。数的样子照 `%g`（说明书那句 "Display number in floating
       point"，`sgen` 就是 `%g` 那一格）。 */
    fn('gt_num', ['v'], [
      ex(call('gt_str', [bi('sgen', [nm('v'), inum(6)])])),
      ex(call('gt_nl', [])),
      ret(num(0)),
    ]),
  ];
}

/**
 * **一份空的同名运行时**（一格像素都不画）。
 *
 * 谁要它：`printf` 在 EvalDraw 里是画在画布上的，可**一份从头到尾不画图的脚本没有画布**
 * —— 那一档我们照旧只落 stdout（语料里几十份 `.kc` 就是拿 `printf` 当输出的算题程序，
 * 判据是 stdout 逐字节）。调用点两档一模一样，差的只是这一份函数体：
 * 于是"用过别的画图动作"那一档拿到真的文字，另一档一句多余的都不发。
 *
 * 明写成偏差：正本里那种脚本也是画在画布上的（见 `docs/design/eval-realtime-gpu.md` 11.x）。
 */
export function textStubDecls() {
  const z = [ret(num(0))];
  return [
    fn('gt_need', [], z), fn('gt_fneed', [], z),
    fn('gt_setfont2', ['w', 'h'], z), fn('gt_setfont3', ['w', 'h', 'fill'], z),
    fn('gt_moveto', ['x', 'y'], z), fn('gt_at', ['x', 'y', 'c'], z), fn('gt_atend', [], z),
    fn('gt_nl', [], z), fn('gt_char', ['code'], z), fn('gt_num', ['v'], z),
    fnT('gt_str', [['s', STR]], z),
  ];
}
