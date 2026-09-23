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

/** EvalDraw 那张宿主表。名字照 `evaldraw_ref.md` 那几节抄，**不是前缀猜的**。 */
export const EVALDRAW_HOST = {
  who: 'evaldraw',
  spec: 'evaldraw_ref.md / evaldraw.txt（那棵树里没有源码）',
  /** **已经接上设备的那几格**（`gfx-rt.js` 的 `EVALDRAW_2D`）：名字/元数 -> 生成出来的函数。 */
  draw: EVALDRAW_2D,
  gfx: [
    /* 2D */
    'cls', 'setcol', 'setpix', 'moveto', 'lineto', 'drawsph', 'drawcone', 'drawspr',
    'setfont', 'printnum', 'refresh', 'drawpix', 'drawrect', 'fillpoly',
    /* 3D 与相机 */
    'clz', 'setcam', 'setview', 'setzrange',
    /* GL 子集 */
    'gl',
    /* 声音 */
    'playsound', 'playtext', 'playsong', 'playnote',
  ],
};

export function evaldrawToIR(cst, opts = {}) {
  return evalToIR(cst, EVALDRAW_HOST, opts.src ?? '');
}
