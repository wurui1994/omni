// ext/evaldraw/adapter.js —— **EvalDraw（`.kc`）的入口**
//
// 语言那一半**一个字都不重写**：EvalDraw 与 PolyDraw 是同一门语言（Ken Silverman 的 EVAL）——
// `ext/polydraw/polydraw.grammar` 不改一条规则就读下了 141/142 份 `.kc`（`demos/` 44 +
// `geeky/` 41 + `games/` + `voxes/` + `insts/`），所以这两门共用那份语法与
// `ext/polydraw/adapter.js` 的 `evalToIR`。这一份只提供**那张宿主表**。
//
// ## 口径：**没有源码**
//
// `/Users/wurui/Downloads/evaldraw` 里只有 `evaldraw.exe`（Windows，这台机器跑不了）。
// 所以正确性照文档：`evaldraw_ref.md`（4.8KB 速查，先读它）、`evaldraw.txt`（101KB 正本）、
// `RScript.htm`、`EVALDRAW programming reference.doc`。语言核心那一半仍可以查 PolyDraw 那棵树里的
// `polydraw_src/eval.c`（同一个编译器）。
//
// ## 与 PolyDraw 那张表的差别
//
// EvalDraw 的绘图 API **比 GL 立即模式更贴我们的帧缓冲设备**（`ext/js/lib/ege.js` 那套）：
//
//   2D  cls(r,g,b) / setcol(r,g,b) / setpix(x,y) / moveto(x,y) / lineto(x,y)
//       drawsph(x,y,r)（圆，**半径为负是描边**）/ drawcone(x,y,r,x2,y2,r2)（粗线）
//       setfont(w,h,isfill) / printnum(x) / printf(…)（**画在画布上**）/ refresh()
//   3D  clz(far) / setcam(x,y,z,hang,vang) / drawsph(x,y,z,r) / drawcone(8 参)
//       moveto,lineto 的三参版 / drawspr("x.kv6",…) / gl 那个子集
//   声音 playsound / playtext / playsong —— 这条腿上没有落点，明着拒。
//
// 这一版只接**只算不画**那一半（与 PolyDraw 同一档）：上面那些名字碰到就当场报一句
// "要渲染那一侧"（任务 #20），不悄悄当普通函数调用。

import { evalToIR } from '../polydraw/adapter.js';
import { EVALDRAW_2D } from '../polydraw/gfx-rt.js';
import { GL_CONSTS } from '../polydraw/gl-rt.js';

/**
 * **`drawcone` 的那几格旗子**（`evaldraw.txt:1586-1590` 那张名单）。
 *
 * 那份说明书**只给了名字、没给值**（evaldraw 没有源码，见文件头）。所以这几格的数
 * 是**我们定的**：一格一位、`+` 起来正好是按位或。这么定是自洽的 —— 脚本读到的常量
 * 与设备那一侧认的是同一张表；真要与原版逐位对齐，得先有一份能问出值的参照。
 *
 * 成对的那两格（`NOCAP` / `FLAT`）照说明书那句"select both ends"，是两端那两位之和。
 */
export const DRAWCONE_CONSTS = new Map([
  ['drawcone_nocap0', 1], ['drawcone_nocap1', 2], ['drawcone_nocap', 3],
  ['drawcone_flat0', 4], ['drawcone_flat1', 8], ['drawcone_flat', 12],
  ['drawcone_cent', 16], ['drawcone_nophong', 32], ['drawcone_nocone', 64],
  ['drawcone_cull_back', 128], ['drawcone_cull_front', 256], ['drawcone_cull_none', 512],
]);

/** EvalDraw 那张宿主表。名字照 `evaldraw_ref.md` 那几节抄，**不是前缀猜的**。 */
export const EVALDRAW_HOST = {
  who: 'evaldraw',
  spec: 'evaldraw_ref.md / evaldraw.txt（那棵树里没有源码）',
  /** **已经接上设备的那几格**（`gfx-rt.js` 的 `EVALDRAW_2D`）：名字/元数 -> 生成出来的函数。 */
  draw: EVALDRAW_2D,
  /** GL 那几格常量（`GL_QUADS` / `GL_TEXTURE0` …）—— EvalDraw 的脚本里也有 GL 子集，
      所以这张表两门语言共用（语料里 `demos/sprite2d.kc` 就写 `glbegin(GL_QUADS)`）；
      再加上 `drawcone` 那几格旗子（上头那张表）。 */
  consts: new Map([...GL_CONSTS, ...DRAWCONE_CONSTS]),
  gfx: [
    /* 2D */
    'cls', 'setcol', 'setpix', 'moveto', 'lineto', 'drawsph', 'drawcone', 'drawspr',
    'setfont', 'printnum', 'refresh', 'drawpix', 'drawrect', 'fillpoly',
    /* 画布上的文字与杂项（`printchar`/`printg` 那一族） */
    'printchar', 'printg', 'noise',
    /* 3D 与相机 */
    'clz', 'setcam', 'setview', 'setzrange',
    /* 体素那一族（KV6） */
    'drawkv6', 'drawvox',
    /* 输入那一族里"一次读一整组"的那格（`readmouse(&x,&y,&b)`）与磁力计那格 */
    'readmouse', 'readmag6d',
    /* 时间与杂项（`sleep(ms)`；网络那一族在这条腿上没有落点，撞上会说清楚） */
    'sleep', 'net_', 'pic',
    /* GL 子集 */
    'gl',
    /* 声音 */
    'playsound', 'playtext', 'playsong', 'playnote',
  ],
};

export function evaldrawToIR(cst, opts = {}) {
  return evalToIR(cst, EVALDRAW_HOST, opts.src ?? '');
}
