// src/core/lower/sx.js —— **公共降级器的算子契约**（ADR-0044，搬自 src/lang/common/sx.js）
//
// ADR-0031 轴 A。先前每门语言都在**拼字符串**：`(pfield ${base} ${name})`、`(expr ${v})`、
// `(call ${f}${args.map((x) => ' ' + x).join('')})`。后果不是"不好看"，是**错得很晚**：
// 少一个括号、忘了裹 `(expr …)`、`(pfield)` 与 `(pload (pfield))` 混了 —— 这些要等跑起来
// 印错数才看见（这一轮量出来的真错里有三处正是它）。
//
// 所以这一份把方言的形状**说一次**：一张表（名字 → 元数），加一格构造器。规矩三条：
//   1. 元数当场校验（`(sel c a b)` 少一格立刻炸，不发一段坏文本出去）；
//   2. 每一格操作数必须是**已经建好的一段代码**（非空字符串）—— 传 undefined 立刻炸；
//   3. 这一层**只管形状，不管语义**：类型对不对是各语言自己的表的事（`int-table.js` 那些）。
//
// 这不是最终形态。最终形态是"前端不发文本、发一棵 IR"（ADR-0031 轴 C 长完之后）；
// 在那之前，先把"这一层怎么说话"收成一处 —— 191 处裸模板收成一张表。

/**
 * 方言那几格的**元数**。`n` 是定数；`[min, max]` 是区间（`max` 为 `Infinity` 就是变长）。
 * 名字与形状的出处是核心那一侧的读法（`src/core/sexpr/lower.js`）与六条腿的真输出。
 */
export const SX_ARITY = {
  /* 值 */
  int: 1, real: 1, bool: 1, str: 1, var: 1, chr: 1,
  null: 1, pnull: 1, fnref: 1,
  /* 内存 */
  pnew: 2, pload: 1, pstore: 2, pfield: 2, padd: 2, psub: 2, pelem: 1,
  peq: 2, pisnull: 1, pthin: 1,
  /* 算子 */
  bin: 3, un: 2, sel: 3,
  /* 调用 */
  call: [1, Infinity], callfn: [1, Infinity], ccall: [1, Infinity],
  /* **协程那一族**（python 的 `async def` / `await` 那一刀）：
     `(afn …)` 是协程函数（调用不执行体、返回协程对象）；`(await E)` 是挂起点；
     `(asyncio_run C)` / `(asyncio_sleep T)` 是 asyncio 最小 shim 的两格算子。
     js 后端：afn -> `function*`、await -> `yield`、asyncio_* -> prelude 的
     同步就绪驱动器（`$asyncio_*`）。解释器那一腿还没接。 */
  afn: [4, Infinity], await: 1, asyncio_run: 1, asyncio_sleep: 1,
  /* **异常那一族**（python 的 `try/except/finally` 与 `raise` 那一刀）：
     `(try BODY (catch CLS BIND HANDLER) … (else …) (fin …))` —— 子格按头分派
     （catch/else/fin），BIND 可省；CLS 是**类名字符串**（"ValueError"）。
     `(raise CLS V)` 抛一格带类名的异常。js 后端：try/catch/finally +
     `$omni_exc` 异常对象（prelude 的 `$rt_throw` / `$exc_is`）。 */
  try: [1, Infinity], raise: [1, 2],
  catch: [1, 3], else: [0, Infinity], fin: [0, Infinity],
  /* **闭包那一族**（`src/core/sexpr/lower.js` 里本来就有）：
     `(cfn 名 ((c T)…) ((p T)…) R 语句…)` 声明一格、`(mkclo 名 v…)` 造一格、`(cap c)` 读捕获。
     提供者不止一门：go 的接口（方法闭包的记录，ADR-0040）、cpp 的 lambda、jnc 的函数值 ——
     所以摆在公共这一层，不在某一门的钩子里。 */
  cfn: [4, Infinity], mkclo: [1, Infinity], cap: 1,
  /* 语句 */
  set: 2, expr: 1, ret: [0, 1], let: 3, if: [2, 3], while: 2, do: [0, Infinity],
  /* **借外头那份 C 的库**（`(lib "libomnigo")` 说去哪儿找、`(cabi 符号 返回 (形参…))`
     说它长什么样）。go 的并发与宿主入口、cpp 的外部符号走的是同一格。 */
  lib: 1, cabi: 3,
  /* `(fail 串)` —— **停下来**（断言不成立那一路：方言里没有 assert，按口径拼）。 */
  fail: 1,
  /* **把一帧交出去**（`(gfxframe PATH W H FB)`）：图形设备那一层唯一的出口 —— 帧缓冲
     FB（`(arr real)`，一格一个打包好的 0xRRGGBB）按 W×H 写成 `#rgba <w> <h>\n` + 裸 RGBA。
     图元全在内存里画，一趟只过一帧（putpixel **不走 stdout** —— 那是几百万行）。
     提供者不止一门：EVAL 那两门（polydraw / evaldraw）的 2D 落这一格，往后 c / js
     两侧的 ege 库也是同一格 —— 所以摆在公共这一层。 */
  gfxframe: 4,
  /* **图形设备的宿主面**（`(gfxcall "名字" 实参…)` -> real）：EVAL 两门语言的宿主调用
     全从这一格过去（画图、矩阵、着色器、纹理、输入）。名字是字面串、实参是 real。
     设备有三档（浏览器 WebGL2 / 本机 OpenGL / CPU 备选），**默认是 GPU** ——
     口径在 `docs/design/eval-realtime-gpu.md`。 */
  gfxcall: [1, Infinity],
  /* **一段顶点批交给设备**（`(gfxbatch 类 数 (arr real))` -> real）。
     只有一个模型：命令 -> 顶点 -> 合批 -> 几个 draw call（`docs/design/eval-realtime-gpu.md`
     第 9 节）。变换、拆 mode、2D 图元变顶点、合批**全在语言那一侧**（生成出来的 IR，
     四条腿共用一份）；设备只管"收一段就上传 + 一次 draw"（CPU 备选那一档软件光栅化同一批）。
     一格顶点 **12 个 float**（位置 4 / 颜色 4 / 纹理坐标 4），所以数组长度 = 12 × 数。
     为什么要数组：`gfxcall` 那一格只收 double —— 与 `gfxframe` 同一条先例。 */
  gfxbatch: 3,
  /* **一张纹理交给设备**（`(gfxtex 槽 宽 高 层 格 (arr real))` -> real）。
     与 `gfxbatch` 同一条先例：宿主面只收 double，所以数组走自己这一格 op
     （口径在 `docs/design/eval-realtime-gpu.md` 第 11 节）。
     `格` 是 `KGL_*` 那个打包好的数（低 4 位像素格式 / `0xf0` 过滤 / `0xf00` 环绕，
     照 `polydraw.c:190-193` 的位定义）；一格像素占几个 double 也照它（`VEC4` 四个、别的一个）。 */
  gfxtex: 6,
  /* **带一整块数组的宿主调用**（`(gfxarr "名字" a0 a1 a2 a3 (arr real))` -> real）。
     与 `gfxtex` 同一条先例：`gfxcall` 只收 double，而宿主面里有一族要"一整块"
     （`polydraw.c:2070` 那张表里带 `&` 的那几个：`gluniform{1..4}{f,i}v` / `glgettex`）。
     **四格 double 定死**（用不满的递 0）—— 每一层只写一条固定形状的判断，
     变长那一套要在七处各写一遍"最后一格是数组"。口径：§19.1。 */
  gfxarr: 6,
  /* **把"每帧那一格函数"交给设备**（`(gfxframefn (str "名字"))`）：名字是**编译期的串**，
     发射那一侧直接把函数引用交出去（不走函数值/闭包那一层）。
     谁用它：浏览器那一档 —— 页面拿到帧函数之后用 `requestAnimationFrame` 反复调它
     （产物在主线程里同步跑，`while` 会把页面卡死）。本机那两档照旧靠 `nextframe` 驱动。 */
  gfxframefn: 1,
  /* **往设备上登记一格有名字的串**（`(gfxdef 种类 名字 内容)` -> int）：
     种类 `vert`/`frag`/`geom` 是**着色器原文**（`.pss` 后半那些 `@v` / `@f` 区段），
     种类 `name` 是一格**内部到的字符串常量**（`glgetuniformloc("x")` 那种名字，
     `名字` 是它的下标）—— 于是运行期的宿主调用仍然只收 double（`gfxcall` 那一格）。
     三个实参都是串，而且都是**编译期就知道的**：登记发在入口里，一趟只做一次。 */
  gfxdef: 3,
  brk: [0, 1], cont: [0, 1], print: 1, write: 1,
  /* 字符串那一族 */
  tostr: 1, slen: 1, sfind: 2, ssub: 3, srep: 2, supper: 1,
  /* `(slower S)` —— 与 `supper` 对称（只动 ASCII 的 A-Z）。python 的 `.lower()` 要它。 */
  slower: 1,
  /* 环境变量（`(getenv E)`，方言那侧是 `get_env`）：R 的 `Sys.getenv("HOME")` 落这一格。
     没设时回空串 —— 与 R 同解，所以不必再包一层。 */
  getenv: 1,
  sfix: 2, ssci: 2, sgen: 2, sgenk: 2, sbase: 2,
  /* **往返无损的 real 文本**（`(srepr E)`）：与 `tostr` 的 %.6g 是两条不同规则。
     python 的 `str(float)` / `repr(float)` 要的正是这一格。 */
  srepr: 1,
  /* `(sreal S)` —— 串 -> real（python 的 `float(s)`），与 `srepr` 互为反向。
     三条腿的实现早就在（`real_of_string`：JS 的 `Number` / C 的 `strtod`），
     缺的只是这一层的口。 */
  sreal: 1,
  /* 整数与实数之间（**无符号 64 位要走 `torealu`**：那一格的位当有符号读是负数） */
  toreal: 1, torealu: 1, toint: 1,
  /* **实数上的数学函数**（`(rmath "sqrt" A [B [C]])`）：名单是 C99 math.h 与 ECMA-262 Math 的
     交集（正本在 `src/core/sexpr/lower.js` 的 `RMATH`）。go 的 `math.Sqrt`、V 的 `math.sqrt`、
     lua 的 `math.floor` 都落这一格 —— 所以摆在公共这一层。
     上界是 **4**（名字 + 三格）而不是 3：`fma` 是三元的（ADR-0014 第十五节那条例外）。
     这儿只管"几格操作数"，**每个名字到底收几格由方言那张 `RMATH` 把关**
     （`(rmath "fma") 要 3 个参数` 那句话是它报的），所以放宽这一格不会让错元数漏过去。 */
  rmath: [2, 4],
  /* **整数的整数次幂**（`(ipow A B)`，精确）：`rmath "pow"` 是 double 上的，只有 53 位
     有效位，而 int 是 64 位 —— python 的 `3 ** 39` 走 pow 就静静答错。两边都要 int、
     不收负指数（那是 real 的事）、溢出 64 位报话。 */
  ipow: 2,
  /* UTF-8 算术：按码点数长度 / 按码点切片（python 的 len / 下标 / 切片要它）。 */
  scplen: 1,
  scpsub: 3,
  scpfind: 2,
  scpord: 1,

  /* 截到 N 位（ADR-0031 §8.2）：`(trunc N E)` = asUintN、`(sext N E)` = asIntN、
     `(zext N E)` 与 trunc 同值（分开写只为让读的人看出意图）。N 是 1..64 的字面量。 */
  trunc: 2, sext: 2, zext: 2,
  /* 字典那一族（`src/core/sexpr/lower.js` 的 `dnew` / `dget` / `dset` / `dhas` / `dlen`）：
     lua / awk / go / V / nim 的 map 全落这五格。**`dnew` 收的是一格类型**（空字典的键值
     类型在方言这一层必须写出来 —— 那一层不推导，只检查）。
     `dkeys` 是第六格：交**所有的键**，一格 `(arr K)`，次序是插入序（与 Python 3.7+ 同）。
     交 arr 而不是 list：方言里 `list` 这个词根本没有。
     `ddel` 是第七格：删一格，答"原先在不在"（运行时那个 `_remove` 早就在）。 */
  dnew: 1, dget: 2, dset: 3, dhas: 2, dlen: 1, dkeys: 1, ddel: 2,
  /* 数组那一族：`(anew (arr T) N)` 造、`aget` / `aset` 取写、`apush` 追加、`alen` 长度、
     `apop` 弹出。**下标从 0 起、上界不含**（各语言的差别由它自己的 adapter 摆平）。 */
  anew: 2, aget: 2, aset: 3, apush: 2, alen: 1, apop: 1,
  /* **线性内存那三格**（方言的 `(memory MIN MAX)` / `(data OFF 字节…)` / `(mload KIND ADDR [OFF])`）
     —— 这一层从前没有它们，于是"一张编译期就定下来的表"在借来的那几门里根本表达不出来：
     `T = [1, 2, …]` 只能落成 `anew` + 一条 `aset` 一格（`adapter/expr.js` 的列表字面量），
     几万格就是几万条语句，而且写在函数体里**每次调用重建一遍**。
     `(data …)` 的字节要在**编译期**算好（与 wasm 的 data 段同一条），装载时一次搬进去；
     四条腿都认（C 是 `static const unsigned char` + `omni_lin_data`、JS 是 `$lin_data`、
     解释器是 ArrayBuffer）。KIND 是 `i8s/i8u/i16s/i16u/i32s/i32u/i64/f32/f64` 之一。
     只加"读"这一格：静态常量表用不着 `mstore`，而写要牵动"谁拥有这块内存"那笔账。 */
  memory: 2, data: [2, Infinity], mload: [2, 3],
  /* 记录那一族：`new` 造**值**（struct）、`cnew` 造**引用**（class），
     `fld` / `fldset` 按名字取写一格字段（字段名是**名字**，不是值 —— 与字典正相反）。 */
  new: 1, cnew: 1, fld: 2, fldset: 3,
  /* 类型 */
  ptr: 1, tptr: 1, blk: 2, arr: 1, fnty: 2, dict: 2,
  /* **真动态那一族**（方言那一侧早就有，见 `src/core/sexpr/lower.js` 的 dyn 那一段与
     `tests/sexpr/cases/48-dyn.sx`）—— 这一层从前没写下它，于是借来的那几门
     （python / lua / awk / Scheme / CL）一格都用不上，只能在 adapter 里"推不出来就报错"。
     那是个错结论：**推得出来最好，推不出来退到 dyn**（ADR-0008「异质 ⇒ 统一降为
     dynamic」；JS 那一门整门都跑在这条道上，而 js→C 是自举主干）。

     `(dyn E)` 装箱、`(dtag E)` 问标签（回串）、`(asint/asreal/asbool/asstr E)` 带检查拆箱。
     `asfn` / `asdict` **多收一格类型**（箱子里只记着"这是函数/字典"，签名与键值类型
     得由拆的那一侧给）—— 与 `anew` / `dnew` 同一条先例，类型走 `{ kind: 'type' }`。

     装得进的只有 int / real / bool / string / 函数 / `(dict string dyn)` 六档
     （`DYN_BOXABLE`）；**没有"动态取属性 / 动态下标 / 动态调用"这三格 op** ——
     要那些得先拆箱（动态调用 = `(callfn (asfn …) …)`）。算术也一样：dyn 上没有 `+`，
     要按 `(dtag …)` 分派（这是各门 adapter 自己的账，不是这一层的）。 */
  dyn: 1, dtag: 1, asint: 1, asreal: 1, asbool: 1, asstr: 1, asfn: 2, asdict: 2,
  /* `(dnull)` —— 标签是 `"null"` 的那一格 dyn（python 的 `None`、lua 的 `nil`）。
     **不收参数**："没有值"不属于哪个类型，所以不走 `(null TYPE)` 那一格。 */
  dnull: 0,
};

/**
 * `(mload KIND …)` 认得的种类词。与 `src/core/sexpr/lower.js` 的 `MEM_LOAD_KINDS`
 * **逐字相同**（那一层是正本，这一层不 import 它 —— 公共降级器不依赖方言的实现）。
 * 值是"读出来的是 int 还是 real"，`typeOf` 那一侧要它。
 */
export const MEM_KINDS = new Map([
  ['i8s', 'int'], ['i8u', 'int'], ['i16s', 'int'], ['i16u', 'int'],
  ['i32s', 'int'], ['i32u', 'int'], ['i64', 'int'], ['f32', 'real'], ['f64', 'real'],
]);

/** 一格算子发出来的文字。元数不对、操作数不是一段代码，**当场炸** —— 那是这一层的全部价值。 */export function op(name, ...args) {
  const a = SX_ARITY[name];
  if (a === undefined) throw new Error(`方言里没有这一格算子：'${name}'（要先在 SX_ARITY 里写下它）`);
  const [lo, hi] = Array.isArray(a) ? a : [a, a];
  if (args.length < lo || args.length > hi) {
    throw new Error(`'${name}' 要 ${lo === hi ? lo : `${lo}~${hi === Infinity ? '任意' : hi}`} 格操作数，给了 ${args.length}`);
  }
  for (const [i, x] of args.entries()) {
    if (typeof x !== 'string' || x === '') {
      throw new Error(`'${name}' 的第 ${i + 1} 格操作数不是一段代码：${String(x)}`);
    }
  }
  return args.length === 0 ? `(${name})` : `(${name} ${args.join(' ')})`;
}

/* ─── 值 ────────────────────────────────────────────────────────────────── */
/** 整数字面量。**收 BigInt**（`intLitKind` 那一层就是 BigInt —— 双精度会少最后几位）。 */
export const int = (v) => op('int', String(v));
export const real = (v) => op('real', String(v));
export const bool = (v) => op('bool', v === true || v === 'true' ? 'true' : 'false');
/**
 * 字符串字面量：**收正文**，这一层负责编码（记号的 `value` 是解好转义的正文）。
 *
 * **不能用 `JSON.stringify`**：方言那侧认得的转义只有 `\t` `\n` `\r` `\"` `\'` `\\`
 * 与 `\u{…}` / 两位十六进制（`src/core/sexpr/read.js`），而 JSON 会写出 `\f` / `\u000b`
 * 那种它不认的形状 —— 症状是"unknown escape '\u'"（go 的 `strings` 桩里 `'\v'` 量出来的）。
 * 别的控制字符一律写成 `\u{…}`；`\n` `\t` `\r` `\"` `\\` 与 JSON 写出来的一样，
 * 所以这一刀对已有的 `.sx` 是**逐字节中性**的。
 */
export const str = (s) => op('str', quoteSx(String(s)));
function quoteSx(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '\\') { out += '\\\\'; continue; }
    if (ch === '"') { out += '\\"'; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) { out += `\\u{${c.toString(16)}}`; continue; }
    out += ch;
  }
  return `${out}"`;
}
export const varOf = (name) => op('var', String(name));
export const chr = (v) => op('chr', v);

/* ─── 内存（第九 / 十二 / 二十四刀那一摊） ─────────────────────────────── */
export const pnew = (ty, count) => op('pnew', ty, count);
export const pload = (p) => op('pload', p);
export const pstore = (p, v) => op('pstore', p, v);
export const pfield = (base, name) => op('pfield', base, String(name));
export const padd = (p, i) => op('padd', p, i);
export const pelem = (a) => op('pelem', a);
export const pnull = (ty) => op('pnull', ty);
export const nullFn = (ty) => op('null', ty);

/* ─── 算子 ──────────────────────────────────────────────────────────────── */
/** 二元：算子名要**带引号**发出去（方言那一侧收的是一格字符串）。 */
export const bin = (o, a, b) => op('bin', JSON.stringify(String(o)), a, b);
export const un = (o, a) => op('un', JSON.stringify(String(o)), a);
export const sel = (c, a, b) => op('sel', c, a, b);

/* ─── 调用 ──────────────────────────────────────────────────────────────── */
export const call = (name, args = []) => op('call', String(name), ...args);
export const callfn = (v, args = []) => op('callfn', v, ...args);
/** 叫外头那份 C 里的一格符号（要先有 `(lib …)` 与 `(cabi …)`）。 */
export const ccall = (sym, args = []) => op('ccall', String(sym), ...args);
/** 去哪儿找那份 C 库（逻辑名 —— `cli.js` 的 `resolveLib` 认它）。 */
export const lib = (name) => op('lib', JSON.stringify(String(name)));
/** 一格外部符号长什么样：`(cabi 符号 返回 (形参…))`。 */
export const cabi = (sym, ret, params = []) => op('cabi', String(sym), String(ret), `(${params.join(' ')})`);
export const fnref = (name) => op('fnref', String(name));
/** 造一格闭包：`(mkclo 名 捕获…)` —— 捕获**按值抓**（方言那一侧的规矩）。 */
export const mkclo = (name, caps = []) => op('mkclo', String(name), ...caps);
/** 读当前 `(cfn …)` 的一格捕获。 */
export const cap = (name) => op('cap', String(name));

/* ─── 语句 ──────────────────────────────────────────────────────────────── */
export const set = (name, v) => op('set', String(name), v);
export const exprStmt = (v) => op('expr', v);
export const ret = (v = null) => (v === null ? op('ret') : op('ret', v));

/* ─── 字符串那一族（格式化用它们拼） ──────────────────────────────────── */
export const tostr = (v) => op('tostr', v);
/** `(rmath "NAME" A [B])` —— 函数名是**字面的串**（不是一格 `(str …)` 值）。 */
export const rmath = (fn, args = []) => op('rmath', JSON.stringify(String(fn)), ...args);
/** `(ipow A B)` —— 整数的整数次幂（精确；两边都要 int，指数非负）。 */
export const ipow = (a, b) => op('ipow', a, b);
/** `(scplen S)` / `(scpsub S I N)` —— 按**码点**（不是字节）。 */
export const scplen = (v) => op('scplen', v);
export const scpsub = (v, a, b) => op('scpsub', v, a, b);
export const scpfind = (v, t) => op('scpfind', v, t);
export const scpord = (v) => op('scpord', v);

export const slen = (v) => op('slen', v);
export const sfind = (v, x) => op('sfind', v, x);
export const ssub = (v, a, b) => op('ssub', v, a, b);
export const srep = (v, n) => op('srep', v, n);
export const supper = (v) => op('supper', v);
export const slower = (v) => op('slower', v);
export const sfix = (v, n) => op('sfix', v, n);
export const ssci = (v, n) => op('ssci', v, n);
export const sgen = (v, n, keep = false) => op(keep ? 'sgenk' : 'sgen', v, n);
export const sbase = (v, n) => op('sbase', v, n);

/* ─── 字典那一族（五格，键是**值**不是名字） ──────────────────────────────── */
/** 空字典：**要一格类型**（`(dnew (dict string int))`）—— 方言这一层不推导键值类型。 */
export const dnew = (ty) => op('dnew', ty);
export const dget = (d, k) => op('dget', d, k);
export const dset = (d, k, v) => op('dset', d, k, v);
export const dhas = (d, k) => op('dhas', d, k);
export const dlen = (d) => op('dlen', d);
/** 所有的键，一格 `(arr K)`。次序是插入序 —— `for k in d` 靠的就是这一条。 */
export const dkeys = (d) => op('dkeys', d);
/** 删一格；答的是**原先在不在**（`del d[k]` 的 KeyError 靠它判）。 */
export const ddel = (d, k) => op('ddel', d, k);

/* ─── 数组那一族（下标 0 起、上界不含） ──────────────────────────────────── */
/** 造一格数组：**要类型与长度**（`(anew (arr int) (int 3))`）。 */
export const anew = (ty, n) => op('anew', ty, n);
export const aget = (a, i) => op('aget', a, i);
export const aset = (a, i, v) => op('aset', a, i, v);
export const apush = (a, v) => op('apush', a, v);
export const alen = (a) => op('alen', a);

/* ─── 记录那一族（字段名是**名字**，不是值） ─────────────────────────────── */
/** 值语义的记录（`(struct …)` 声明的那种）。 */
export const newVal = (ty) => op('new', ty);
/** 引用语义的记录（`(class …)` 声明的那种 —— 两个名字指同一格）。 */
export const cnew = (ty) => op('cnew', ty);
export const fld = (obj, name) => op('fld', obj, String(name));
export const fldset = (obj, name, v) => op('fldset', obj, String(name), v);

/* ─── 类型 ──────────────────────────────────────────────────────────────── */
export const ptr = (t) => op('ptr', t);
export const blk = (t, n) => op('blk', t, String(n));
export const dict = (k, v) => op('dict', k, v);
export const arr = (t) => op('arr', t);

/* ─── 真动态那一族 ──────────────────────────────────────────────────────── */
/** 装箱。**再装一次是恒等**（方言那一侧自己认），所以这一层不必先问类型。 */
export const dyn = (v) => op('dyn', v);
/** 问标签：回一格串（`"int"` / `"real"` / `"bool"` / `"string"` / `"function"` / …）。 */
export const dtag = (v) => op('dtag', v);
export const asint = (v) => op('asint', v);
export const asreal = (v) => op('asreal', v);
export const asbool = (v) => op('asbool', v);
export const asstr = (v) => op('asstr', v);
/** 拆回函数值：**要给签名**（箱子里只记着"这是函数"）。 */
export const asfn = (ty, v) => op('asfn', ty, v);
/** 拆回字典：**要给键值类型**（同上）。 */
export const asdict = (ty, v) => op('asdict', ty, v);
/** 标签是 `"null"` 的那一格 dyn（python 的 `None`）。 */
export const dnull = () => op('dnull');
