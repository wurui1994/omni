/**
 * 核心 S 表达式方言 -> OIR。ADR-0014 决策 1 的那**一份**降级。
 *
 * WAT 前端证明了「s-expr 能当前端汇聚点」，但它降的是别人的方言（wasm 的指令表），
 * 语言特有的东西（栈机、位宽、br 的层数）全在那份降级里。所以它不是汇聚点本身，
 * 是汇聚点的第一个使用者。这个文件才是汇聚点：一套**语言中立**的节点形状，
 * 一份降级，谁都能往里发。
 *
 * 于是「加一门语言 = grammar + 映射标注」第一次成立且可测：语法文件的动作模板直接
 * 拼出这些节点（`(bin "+" $1 $3)` 这种），`omni glr` 把它印出来，`omni run` 把它跑掉 ——
 * 中间**没有一行为那门语言写的 JS**。这条是决策 1 验收门槛的硬指标。
 *
 * 方言（刻意小；不够用时加节点，而不是在某门语言的前端里偷偷补语义）：
 *
 *   (module FORM...)
 *   FORM  = (fn NAME ((p TYPE)...) TYPE STMT...)   函数
 *         | (cfn NAME ((c TYPE)...) ((p TYPE)...) TYPE STMT...)  闭包（捕获按值抓）
 *         | (kernel NAME ((p TYPE)...) STMT...)     GPU 核（隐含第一个形参是 gid）
 *         | (struct NAME (字段 TYPE)...)            结构体（值语义，ADR-0005）
 *         | (class NAME (字段 TYPE)...)             类（引用语义）
 *         | (global NAME TYPE)                      模块级变量（零初始化，跨函数共享）
 *         | (main STMT...)                          入口体
 *   TYPE  = int | real | bool | string | void | (vec int|real 2|4|8) | (buf int|real)
 *         | (arr T) | (fnty (TYPE...) TYPE) | 结构体名 | 类名
 *   STMT  = (let NAME TYPE E) | (set NAME E) | (do STMT...)
 *         | (if E (do ...) [(do ...)]) | (while E (do ...))
 *         | (brk) | (cont)
 *         | (ret [E]) | (print E) | (expr E)
 *         | (bset E E E) | (dispatch NAME E E...)
 *         | (aset E E E) | (apush E E) | (fldset E 字段 E)
 *   E     = (int TEXT) | (real TEXT) | (bool TEXT) | (str "…") | (tostr E) | (tostr E N)
 *         | (rmath "NAME" A [B])
 *         | (slen E) | (ssub E I N) | (sfind E T)
 *         | (toreal E) | (toint E)
 *         | (var NAME) | (bin "OP" E E) | (un "OP" E) | (call NAME E...)
 *         | (splat TYPE E) | (vlit TYPE E...) | (lane E N) | (hsum E)
 *         | (bnew TYPE E) | (bget E E) | (blen E) | (gid)
 *         | (anew TYPE E) | (aget E E) | (alen E) | (apop E)
 *         | (new NAME) | (fld E 字段) | (cnew NAME)
 *         | (fnref NAME) | (mkclo NAME E...) | (cap NAME) | (callfn E E...)
 *
 * 向量那四条是 ADR-0014 门槛 6 的第一阶段，见 vecExpr 的注释；
 * 缓冲与 kernel/dispatch 是门槛 7 的第一阶段，见 bufExpr 与 dispatch 的注释；
 * 数组那六条是门槛 2 的第四刀（asy 的 `T[]`），见 arrExpr 的注释；
 * 结构体那三条是门槛 2 的第十二刀（asy 的 struct），见 structDec 的注释；
 * 类是第十三刀 —— 与结构体**只差值语义/引用语义**这一条，asy 的 struct 是引用的那种。
 * `(global …)` 是第二十四刀（asy 的文件级变量、也是模块那一刀的前置）：它**没有初值** ——
 * 零初始化，真正的赋值就是 `(main …)` 或某个函数里的一句 `(set …)`。这样定是因为
 * 「初值什么时候求」在有模块以后是门语言设计（asy 是按文件顺序、在那一行求），
 * 汇聚层不替谁定；而零初始化在六条腿上都是现成的（见 zeroValue）。
 * 读写就用现成的 `(var NAME)` / `(set NAME E)`：没有局部量遮盖时它们落到全局上。
 *
 * 类型不推导，只**检查**：声明处写死，表达式自底向上定型，两边类型不一致就报错 ——
 * 不插隐式转换。理由与 ADR-0008 一致：这一层的职责是把树接进 OIR，
 * 而"什么能悄悄转成什么"是语言设计决定，不该由汇聚层替某门语言定。
 */

import { INT, REAL, BOOL, STRING, VOID, vecType, bufType, arrType, structType, classType, fnType, typeKey, zeroValue,
  ptrType, tptrType, ptrTargetOk, blkType, structLayout, sizeOf } from '../hir/types.js';
import { readSexpr, isList, isAtom, isStr, head } from './read.js';
import { SourceFile } from '../source/diag.js';
import { utf8Bytes } from '../host/utf8.js';

const TYPES = new Map([['int', INT], ['real', REAL], ['bool', BOOL], ['string', STRING], ['void', VOID]]);

/* 线性内存的访问描述符（ADR-0017 第二刀）。名字与 mir/ir.js 的 MLOAD_KINDS / MSTORE_KINDS
 * 逐字相同 —— 这一层不 import 那两张表（方言不依赖 MIR），但两处的名字是同一套约定，
 * 而 from_oir 会把这里的名字翻成那里的号。值是"读出来/写进去的是 int 还是 real"。 */
const MEM_LOAD_KINDS = new Map([
  ['i8s', INT], ['i8u', INT], ['i16s', INT], ['i16u', INT], ['i32s', INT], ['i32u', INT],
  ['i64', INT], ['f32', REAL], ['f64', REAL],
]);
const MEM_STORE_KINDS = new Map([
  ['i8', INT], ['i16', INT], ['i32', INT], ['i64', INT], ['f32', REAL], ['f64', REAL],
]);

/** 向量宽度：2 的幂，上界 8。放宽之前先想清楚 C 那条腿要展开多少行。 */
const VEC_LANES = new Set([2, 4, 8]);

/** 算术/位运算：两边同型，结果同型。字符串只允许 `+`（拼接，与 Omni 一致）。 */
const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const LOGIC = new Set(['&&', '||']);

/**
 * 无符号那一半（ADR-0016 第六十一刀）。方言只有**一格**整数、规范形是有符号 64 位；
 * 无符号性挂在**算子**上而不是类型上 —— 与 LLVM 的 `udiv`/`sdiv`、`icmp ult`/`icmp slt`
 * 同一条路子，也与方言里早就有的 `(sbase E 进制)`（那一条明写着"E 的位当无符号 64 位读"）
 * 一致：位是一份，怎么读是算子的事。
 *
 * 只有这七个要分开。补码下 `+ - * & | ^ <<` 两种解释算出来的**位一模一样**，`==` / `!=`
 * 比的也是位 —— 那些一个都不用加。真正分岔的是除、取余（商与余数的符号）、右移（补符号位
 * 还是补零）与四个大小比较。
 */
const UARITH = new Set(['u/', 'u%', 'u>>']);
const UCOMPARE = new Set(['u<', 'u<=', 'u>', 'u>=']);

/** `(rmath "NAME" …)` 的名单与参数个数：C99 math.h 与 ECMA-262 Math 的**交集**。
 *  这一层只是转手宿主的数学库（C 走 libm、JS 走 Math.*），没有自己写的实现 ——
 *  标准库有的东西不重造。哪些逐字节、哪些只保证容差，见 runtime/omni_math.c 的头注。 */
const RMATH = new Map([
  ['sqrt', 1], ['fabs', 1], ['floor', 1], ['ceil', 1], ['round', 1],
  ['pow', 2], ['fmod', 2],
  ['sin', 1], ['cos', 1], ['tan', 1], ['asin', 1], ['acos', 1], ['atan', 1],
  ['atan2', 2], ['sinh', 1], ['cosh', 1], ['tanh', 1],
  ['asinh', 1], ['acosh', 1], ['atanh', 1],
  ['exp', 1], ['expm1', 1], ['log', 1], ['log10', 1], ['log1p', 1],
  ['cbrt', 1], ['hypot', 2],
  /* **这一条是那个交集的例外**（ADR-0019 路 2）：`nextafter` 在 C99 math.h 里有，
   * 在 `Math.*` 里**没有** —— 所以 JS 那侧是手写的（`$js_math` 的 'W'：把 f64 的位模式
   * 当 i64 加减一）。为什么还是收它：GraphEq 的区间算术靠「往上/往下挪一个 ulp」保证
   * 结果是真超集，而那件事**用别的算符做不出来**。所以这不是「标准库有的东西重造一遍」，
   * 是「标准库只有一半」。权威是 C 的 libm，JS 那侧要与它逐字节对上。 */
  ['nextafter', 2],
]);

class CoreLowerer {
  constructor(diags) {
    this.diags = diags;
    this.funcs = new Map();   // 名字 -> {name, mangled, ret, params}
    this.scopes = [];         // 名字 -> OIR 类型
    // `(unsafe …)` 里面吗（ADR-0016 决策三）。thin 指针那一族只在这一格开着时过得去。
    this.unsafe = false;
    /** @type {Map[]|null} REPL 的常驻顶层作用域（每批入口共用）；整程序降级时一直是 null */
    this.topScope = null;
    // kernel 与函数分开登记：kernel 只能被 (dispatch ...) 启动，(call ...) 要报错说清这件事。
    // 它在 OIR 里就是一个普通函数，第一个形参是隐含的 gid —— 于是「同一份 MIR 在 CPU 上跑」
    // 不需要任何新机制（门槛 7 要比的就是这个 CPU 结果），dispatch 只是一个循环。
    this.kernels = new Map();
    this.inKernel = false;
    // 模块级变量（第二十四刀）：名字 -> OIR 类型。查名字时它是**最外层的兜底** ——
    // 局部量与形参先赢，所以同名的局部量是遮蔽而不是错。
    this.globals = new Map();
    // 线性内存（ADR-0017 第二刀）：`null` = 这份模块不用内存。一个模块**一块**（wasm MVP
    // 就是这样），所以这里是一个字段而不是一张表。`emitted` 记的是"这一批产物里发过了吗" ——
    // REPL 一批一份产物，内存只该在声明它的那一批里被建起来，后面几批要接着用同一块。
    this.mem = null;
    this.memEmitted = false;
    this.tmpNo = 0;           // dispatch 展开出来的临时量编号，保证名字唯一
    this.loopDepth = 0;       // (brk) / (cont) 只在循环里合法，跟 hir/check.js 同一条规矩
    // 结构体：名字 -> OIR 的 struct 类型对象。**声明就是类型**（hir/types.js 的 structType），
    // 所以这张表里的对象和每个 (fld …) 节点上挂的 `type` 是同一个对象，与 hir/check.js 一致。
    this.structs = new Map();
    // 类：**引用**语义的聚合。跟 struct 的区别只有一条 —— 赋值/传参/返回**不复制**
    // （from_oir 的 rvalue 只给 struct 与 enum 发 OP.COPY）。asy 的 struct 就是这种
    // （量过：`A b = a; b.x = 7;` 之后 `a.x` 是 7），所以这两种都要有，不是重复。
    this.classes = new Map();
    // 名字先坐下、字段还空着的那些类（同一遍里用来分开"重复定义"与"这条声明的后半截"）
    this.preClass = new Set();
    // 同上，结构体那一份（第十七刀）。它还兼着"这个名字是自己/后面那个"这一问 ——
    // 直接内嵌看它（零值会无限递归），隔一层指针不看（指针是三个字，与目标布局无关）。
    this.preStruct = new Set();
    // 函数值（`(fnty …)` / `(cfn …)` / `(mkclo …)` / `(callfn …)`）。OIR 那边这一套早就有
    // （ADR-0010：闭包记录是 `{fp, c_*}`，第一个实参是记录自己），方言这边只是说得出来。
    // closures 是**闭包记录**表（名字 -> {id, mangled, make, captures}），lifted 是它们的
    // 函数体（发到 funcs 的末尾，跟 hir/check.js 一样）；fnUsed 收用到的签名 ——
    // C 后端要为每个签名发一个类型化的调用助手，少一个就编不过。
    this.closures = new Map();
    this.lifted = [];
    this.fnUsed = new Map();
    // 正在降 (cfn …) 的那一份的捕获表（名字 -> 类型）。`(cap c)` 只在这里面查 ——
    // 不许它退回去查外层的局部量：那个帧早就返回了，读它就是读失效的栈。
    this.caps = null;
    // 只**声明**、不定义的那些名字（`(sig …)`，第七十五刀）。一个库文件编成一份自己的 JS，
    // 靠的就是这个：它引到的别人家的类/全局/函数/闭包在这里只报个签名，正文由**那一份**
    // 产物发。这几张表记着"谁是只声明的"，assemble 于是不把它们发第二遍。
    this.sigOnly = {
      fns: new Set(), globals: new Set(), aggs: new Set(), clos: new Set(),
    };
    // 带出处的那些 `(sig "谁" …)`：`{from, kind, name}`。后端按它发真的 import。
    this.sigImports = [];
  }

  err(node, msg) {
    this.diags.error(node === undefined || node === null ? null : node.span, msg);
    return null;
  }

  /** 类型名 -> OIR 类型。写错就报错，不猜。 */
  ty(node, what) {
    // `(buf int|real)`：一段连续的元素 + 一个运行期长度（门槛 7 第一阶段）
    if (isList(node) && head(node) === 'buf') {
      const e = isAtom(node.items[1]) ? TYPES.get(node.items[1].value) : undefined;
      if (e === undefined || (e !== INT && e !== REAL)) {
        return this.err(node, `${what}：(buf 元素) 的元素只能是 int 或 real`);
      }
      return bufType(e);
    }
    // `(arr int|real|bool|string)`、`(arr (vec T N))` 或 `(arr 类名)`：可增长数组（门槛 2
    // 第四刀）。元素比 buf 宽 —— asy 的 `string[]` 到处都是，而数组不用上 GPU，没有
    // "只能是数"的约束。向量元素是第八刀加的（asy 的 `pair[]`）：运行时那一份按字节的
    // 实现管长度与增长，元素的读写由各条腿自己 load/store，见 omni_arr.c 尾部。
    // **类元素是第十八刀加的**（asy 的 `A[]`）：类是引用语义，格子里躺的就是一个句柄，
    // 所以走的还是那份 blob（步长 8），"存进去要不要拷"这个问题在引用语义下不存在。
    // **结构体元素还不收**：那是值语义，格子里躺的是内容，于是 `aset`/`apush`/`anew`
    // 三处都要按元素类型拷一份 —— JS 与解释器那两条腿的 `arrCopy` 是**类型擦除**的
    // （只认 Array.isArray），拷不动一个普通对象。`tests/sexpr/bad/arr-elem-struct.sx` 钉着。
    if (isList(node) && head(node) === 'arr') {
      const en = node.items[1];
      if (isList(en) && head(en) === 'vec') {
        const e = this.ty(en, what);
        return e === null ? null : arrType(e);
      }
      // **数组套数组**（多维数组那一刀）：元素是引用语义，格子里躺一个句柄，与类元素同一套
      // 表示（arrIsBlob，步长 8）。原先不收的理由是 `(anew T N)` 的零值求一次、复制 N 遍，
      // 于是 N 行共用同一条 —— 解法不是新开一条指令，而是让**行的零值是空引用**
      // （见 arrExpr 的 anew）：空引用没法共享，谁要用哪一行谁先造。这与 asy 一致，
      // 量过：`new real[3][]` 之后 `a[0][0]` 在真 asy 那边是运行期错误。
      if (isList(en) && head(en) === 'arr') {
        const e = this.ty(en, what);
        return e === null ? null : arrType(e);
      }
      // **函数值的数组**（第三十七刀）：格子里躺一个函数句柄（C 侧是 `omni_fn`，一个指针），
      // 与类元素同一档 —— 走 arrIsBlob 那条按字节的路，零值是空引用（NullFn）。
      // 量出来的理由：`plain_picture.asy:95` 的 `boundRoutine[] bound;`
      // （boundRoutine 是 `void(…)` 的 typedef），plain 里这一族躲不开。
      if (isList(en) && head(en) === 'fnty') {
        const e = this.ty(en, what);
        return e === null ? null : arrType(e);
      }
      const nm = isAtom(en) ? en.value : null;
      if (nm !== null && this.classes.has(nm)) return arrType(this.classes.get(nm));
      if (nm !== null && this.structs.has(nm)) {
        return this.err(node, `${what}：数组的元素是结构体 '${nm}'（值语义）这一刀还不收 ——`
          + ` 类（引用语义）可以，见 sexpr/lower.js 的 ty`);
      }
      const e = nm === null ? undefined : TYPES.get(nm);
      if (e === undefined || e === VOID) {
        return this.err(node, `${what}：(arr 元素) 的元素只能是 int / real / bool / string / (vec T N) / 类名`);
      }
      return arrType(e);
    }
    // `(ptr T)` / `(tptr T)`：数据指针（ADR-0016 决策一）。fat 带范围、thin 只有地址。
    // 目标类型那张名单在 hir/types.js 的 ptrTargetOk 上，理由也写在那儿。
    if (isList(node) && (head(node) === 'ptr' || head(node) === 'tptr')) {
      const thin = head(node) === 'tptr';
      const tn = node.items[1];
      const what2 = `${what} 的 (${head(node)} T) 的 T`;
      // `(blk T N)` 只在**这里**认（第十八刀）：它不是一个值，只能当指针的目标。
      const t = isList(tn) && head(tn) === 'blk' ? this.blkTy(tn, what2) : this.ty(tn, what2);
      if (t === null) return null;
      if (!ptrTargetOk(t)) {
        return this.err(node, `${what}：(${head(node)} T) 的 T 只能是 int / real / bool /`
          + ` 结构体名 / 另一个指针 / (blk T N)，这里是 ${coreTypeText(t)}`);
      }
      if (t.k === 'struct' && structLayout(t) === null) {
        return this.err(node, `${what}：结构体 '${t.name}' 里有落不进内存的字段，`
          + '指不到它身上（见 hir/types.js 的 structLayout）');
      }
      return thin ? tptrType(t) : ptrType(t);
    }
    // `(vec int 4)`：元素只能是 int/real（bool/string 的向量没有意义，也没有硬件对应）
    if (isList(node) && head(node) === 'vec') {
      const e = isAtom(node.items[1]) ? TYPES.get(node.items[1].value) : undefined;
      const n = isAtom(node.items[2]) ? Number(node.items[2].value) : NaN;
      if (e === undefined || (e !== INT && e !== REAL)) {
        return this.err(node, `${what}：(vec 元素 宽度) 的元素只能是 int 或 real`);
      }
      if (!VEC_LANES.has(n)) return this.err(node, `${what}：向量宽度只能是 2 / 4 / 8`);
      return vecType(e, n);
    }
    // `(fnty (int real) bool)`：函数值的类型（asy 的 `real f(real)` 形参要它 ——
    // 量过：真 base 在场时 304 个 examples 里 203 个第一个撞的就是 math.asy:446 的
    // `real findroot(real f(real), …)`）。OIR 那边这一条早就有（ADR-0010 的 `{fp, c_*}`，
    // Omni 语法的 lambda 走的就是它），所以方言这边只是把它**说得出来**：
    // 类型一条、`(cfn …)` 声明一条、`(mkclo …)` 造一条、`(callfn …)` 调一条。
    if (isList(node) && head(node) === 'fnty') {
      const pn = node.items[1];
      if (!isList(pn)) return this.err(node, `${what}：(fnty (形参类型...) 返回类型)`);
      const ps = [];
      for (const p of pn.items) {
        const t = this.ty(p, `${what} 的形参类型`);
        if (t === null) return null;
        if (t === VOID) return this.err(p, `${what}：形参类型不能是 void`);
        ps.push(t);
      }
      const r = this.ty(node.items[2], `${what} 的返回类型`);
      if (r === null) return null;
      // 过一遍 useFnType：C 后端要按签名发一个类型化的调用助手，而"用到"的第一处
      // 往往就是某个形参的类型（`(fn f ((g (fnty (real) real))) real …)`）—— 只在
      // callfn 那里登记就会漏掉"只是传来传去、没在这一份里调"的那些签名。
      return this.useFnType(fnType(ps, r));
    }
    if (!isAtom(node) || !TYPES.has(node.value)) {
      // 结构体名（第十二刀）与类名（第十三刀）：方言里用户能起的类型名只有这两种，
      // 所以放在内建名单后面查 —— 内建名字不可能被遮蔽（那两遍会拒掉重名）。
      if (isAtom(node) && this.structs.has(node.value)) return this.structs.get(node.value);
      if (isAtom(node) && this.classes.has(node.value)) return this.classes.get(node.value);
      return this.err(node, `${what} 的类型只能是 int / real / bool / string / void / (vec T N) / (buf T) / (arr T) / (fnty (T...) R) / 结构体名 / 类名`);
    }
    return TYPES.get(node.value);
  }

  /**
   * `(blk T N)`：**一段 N 格的定长内存**（ADR-0016 第十八刀）。它不是一个值 —— 没有"整块的
   * load/store"，所以不从 `ty()` 里走，只在两处认：`(ptr …)` / `(tptr …)` 的目标（第十八刀），
   * 与**结构体的字段**（第二十二刀 —— 那一处是真的内嵌那 N 格，`(fld …)` / `(fldset …)`
   * 在它上面照样是拒的，见 blkNotAValue）。
   *
   * 元素本身可以再是 `(blk …)`：`int a[10][20]` 是 `(ptr (blk int 20))` 上有 10 格
   * （`padd` 一步跨一整行），而三维 `int a[2][3][4]` 的元素是 `int[3][4]`，
   * 也就是 `(ptr (blk (blk int 4) 3))` —— 所以这里要能递归下去。
   */
  blkTy(node, what) {
    if (node.items.length !== 3) return this.err(node, `${what}：(blk T N) 要两个参数`);
    const el = isList(node.items[1]) && head(node.items[1]) === 'blk'
      ? this.blkTy(node.items[1], `${what} 的 (blk T N) 的 T`)
      : this.ty(node.items[1], `${what} 的 (blk T N) 的 T`);
    if (el === null) return null;
    if (!ptrTargetOk(el)) {
      return this.err(node, `${what}：(blk T N) 的 T 只能是能落进内存的那些，`
        + `这里是 ${coreTypeText(el)}`);
    }
    if (el.k === 'struct' && structLayout(el) === null) {
      return this.err(node, `${what}：结构体 '${el.name}' 里有落不进内存的字段，`
        + '排不成一段定长内存');
    }
    // 元素是**自己或后面才声明**的那个结构体也收（第二十三刀，与直接内嵌同一条）：
    // 那时候它的字段还空着、尺寸算出来是 0，所以"排不排得成一段内存"这一问挪到
    // chunk 里字段都填完之后那一遍。绕回自己那一格由 cutValueCycles 报。
    const cnt = isAtom(node.items[2]) ? Number(node.items[2].value) : NaN;
    if (!Number.isInteger(cnt) || cnt <= 0) {
      return this.err(node, `${what}：(blk T N) 的 N 要是一个正整数字面量`);
    }
    return blkType(el, cnt);
  }

  lookup(name) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
      i--;
    }
    return null;
  }

  /**
   * 名字的类型：先局部再全局（第二十四刀）。回 `{type, global}` 而不是光一个类型，
   * 因为发出去的 OIR 节点是两种（`VarRef` / `GlobalRef`），调用方要分得开。
   */
  nameRef(name) {
    const local = this.lookup(name);
    if (local !== null) return { type: local, global: false };
    if (this.globals.has(name)) return { type: this.globals.get(name), global: true };
    return null;
  }

  /* -------------------------------------------------------------- 模块 */

  /**
   * 一批顶层项 -> 这一批**新增**的 OIR。整份文件就是"只有一批"的特例（run 调它）。
   * REPL 里一个 CoreLowerer 活着，每批调一次：结构体表、函数表、模块级变量表都留着，
   * 所以后一批看得见前一批的名字，而返回的 delta 只有这一批新出来的东西。
   */
  chunk(nodes, entryName = 'omni_main') {
    const base = {
      structs: this.structs.size, classes: this.classes.size, globals: this.globals.size,
      closures: this.closures.size, lifted: this.lifted.length, fnUsed: this.fnUsed.size,
    };
    const top = nodes.length === 1 && head(nodes[0]) === 'module' ? nodes[0] : null;
    if (top === null) {
      this.err(nodes[0], '一份核心方言的源文件是恰好一个 (module ...)');
      return null;
    }
    const rawForms = top.items.slice(1);
    // `(sig 一条声明)` = **只声明、不定义**（第七十五刀）。摊成里面那一条走原来的三遍，
    // 只是把名字记进 sigOnly：签名照收（函数体里调它、拿它的字段都照常查得到），
    // assemble 不再为它发一份正文/一格全局/一份类 —— 那些由**定义它的那份产物**发。
    // 一个库文件编成一份自己的 JS、几份拼起来是整个程序，靠的就是这一条。
    //
    // 前面可以带出处：`(sig "plain_pens" (fn …))`。带了出处，OIR 上就多一条
    // `imports` 记录，后端于是能发真的 `import { … } from './plain_pens.js'` ——
    // 不带就只是"这个名字在别处"，靠拼接解决。
    const forms = [];
    for (const f of rawForms) {
      if (head(f) !== 'sig') { forms.push(f); continue; }
      const hasFrom = f.items.length > 2 && f.items[1] !== undefined
        && f.items[1].kind === 'string';
      const from = hasFrom ? f.items[1].value : null;
      const inner = hasFrom ? f.items[2] : f.items[1];
      if (!isList(inner) || !isAtom(inner.items[1])) {
        this.err(f, '(sig [出处] (fn …) / (global …) / (class …) / (cfn …))');
        continue;
      }
      const ih = head(inner);
      const inm = inner.items[1].value;
      if (ih === 'fn') this.sigOnly.fns.add(inm);
      else if (ih === 'global') this.sigOnly.globals.add(inm);
      else if (ih === 'class' || ih === 'struct') this.sigOnly.aggs.add(inm);
      else if (ih === 'cfn') this.sigOnly.clos.add(inm);
      else { this.err(f, `(sig …) 里只能是 fn / cfn / global / class / struct，见到 '${ih}'`); continue; }
      if (from !== null) this.sigImports.push({ from: from, kind: ih, name: inm });
      forms.push(inner);
    }

    // 三遍。第一遍收结构体：函数签名与字段类型都可能提到它，所以它必须最先成型。
    // 字段类型里**可以**提到别的结构体/类（第十七刀）。
    //
    // **结构体**只能提**前面已经声明过**的那个：它是值语义、内嵌是真的内嵌，自引用
    // （`(struct A (n A))`）与前向引用的零值会无限递归。先把所有结构体名扫出来，
    // 好让"提到的是后面那个"给出准的诊断而不是"认不出的类型"。
    //
    // **类不受这一条约束**（第六十二刀）：类在四条腿上都是**一个指针**
    // （LLVM 的 `t.k === 'class'` -> `ptr`、零值 -> `null`；两个解释器按名字存 JS 对象），
    // 所以互相引用与自引用都摊得开 —— 零值是空引用，没有递归。落法是"名字先坐下、
    // 字段后填"：先给每个 `(class …)` 建一格空的类型对象（同一个对象，字段数组是
    // 原地填的），再逐条填字段，于是提到后面那个类的字段拿到的就是那一格。
    // 逼出这一刀的是 `import plain;`：plain_bounds.asy 的 freezableBounds 与
    // transformedBounds 是**互相**引用的（`(link freezableBounds)` 与
    // `(tlinks (arr transformedBounds))`），plain_picture.asy 的 node3 拿 picture 当形参
    // 类型而 picture 声明在它后面 —— 一遍收记录时这三条无论怎么排都有一条落在后面。
    // 那一格塌了之后 picture 整个类就没建起来，`形参 this/pic 的类型认不出` 跟着刷了
    // 三百多条（量过：526 条里 281 条是这一串）。
    // 结构体的名字先坐下（第十七刀）：**指针字段**隔了一层，`(ptr Node)` 是三个字、
    // 与 Node 的布局无关，所以自引用与互相引用在指针后面是摊得开的（链表那一族要它）。
    // 直接内嵌仍旧只收前面声明过的那个 —— 那一条问的是 preStruct（还空着字段的那些），
    // 填完一个就从里面划掉，于是"自己"与"后面那个"都落在同一问上。
    for (const f of forms) {
      if (head(f) !== 'struct') continue;
      const sn = isAtom(f.items[1]) ? f.items[1].value : null;
      if (sn === null) continue;                       // 缺名字：下面那一遍报
      if (TYPES.has(sn)) continue;                     // 内建类型名：下面那一遍报
      if (this.structs.has(sn) || this.classes.has(sn)) continue;   // 重名：下面那一遍报
      this.structs.set(sn, structType(sn, []));
      this.preStruct.add(sn);
    }
    // 类的名字先坐下（字段还空着）
    for (const f of forms) {
      if (head(f) !== 'class') continue;
      const cn = isAtom(f.items[1]) ? f.items[1].value : null;
      if (cn === null) continue;                       // 缺名字：下面那一遍报
      if (TYPES.has(cn)) continue;                     // 内建类型名：下面那一遍报
      if (this.structs.has(cn) || this.classes.has(cn)) continue;   // 重名：下面那一遍报
      this.classes.set(cn, classType(cn, []));
      this.preClass.add(cn);
    }
    for (const f of forms) {
      if (head(f) === 'struct') this.structDec(f, 'struct');
      else if (head(f) === 'class') this.structDec(f, 'class');
    }
    // 闭环先剪掉（第二十三刀）：下面这一遍与 structLayout / sizeOf 都是顺着字段往下走的，
    // 绕回自己那一格会一直走下去 —— 所以剪在问"落得进内存吗"之前。
    this.cutValueCycles(forms);
    // 字段都填完了才问得动"指得到它身上吗"：`(ptr S)` 收下来的那一刻 S 可能还空着
    // （自引用），而 S 里躺一个 string 时它就落不进内存了 —— 那一问挪到这儿补。
    // `(blk S N)` 的元素同一条（第二十三刀）：收下来的那一刻 S 也可能还空着。
    for (const s of this.structs.values()) {
      for (const f of s.fields) {
        let inner = null;
        if (f.type.k === 'ptr' || f.type.k === 'tptr') inner = f.type.target;
        else if (f.type.k === 'blk') { inner = f.type; while (inner.k === 'blk') inner = inner.el; }
        else continue;
        if (inner.k !== 'struct' || structLayout(inner) !== null) continue;
        this.err(forms[0], `字段 ${s.name}.${f.name}：结构体 '${inner.name}' 里有`
          + (f.type.k === 'blk' ? '落不进内存的字段，排不成一段定长内存'
            : '落不进内存的字段，指不到它身上（见 hir/types.js 的 structLayout）'));
      }
    }
    // 换一格空的，不用 `.clear()`：Set/Map 的 clear 不在封闭 ABI 的成员表里
    // （js_abi.js 的 JS_PROPS 没有 clear），自举出来的那两代到这一句才炸 ——
    // 症状是 `dynamic value is Set, expected dict`（成员查不到就退成通用取属性）。
    this.preClass = new Set();
    // 第二遍收模块级变量（第二十四刀）：函数体与 (main …) 都可能提到它，所以要在
    // 那些体降级之前成型。**聚合也收**（第三十刀，绘图层要 currentpicture/defaultpen
    // 这种模块级的单件）：MIR 那边全局的类型是一个 8 位类型码，装不下聚合的身份 ——
    // 但那个身份在这里根本不需要，因为 class/数组在四条腿上都是**一个指针**
    // （LLVM 的 T_AGG/T_ARR 都是 `ptr`，两个解释器按名字存 JS 对象，C 那条腿拿的是
    // OIR 的完整类型）。字段/元素的身份是从**表达式**的 OIR 类型来的，不是从全局的类型码
    // 来的，所以 `(fld (var g) x)` 一直是准的。
    for (const f of forms) {
      if (head(f) !== 'global') continue;
      const nm = isAtom(f.items[1]) ? f.items[1].value : null;
      if (nm === null) { this.err(f, '(global 名字 类型)'); continue; }
      if (this.globals.has(nm)) { this.err(f, `模块级变量 '${nm}' 重复定义`); continue; }
      const t = this.ty(f.items[2], `模块级变量 ${nm}`);
      if (t === null) continue;
      if (t === VOID) {
        this.err(f, `模块级变量 ${nm} 不能是 void`);
        continue;
      }
      this.globals.set(nm, t);
    }
    // 第二遍半：线性内存与 data 段（ADR-0017 第二刀）。要在函数体之前收，因为
    // `(mload …)` 的合法性取决于"这份模块有没有内存"。
    for (const f of forms) {
      const h = head(f);
      if (h === 'memory') this.memDecl(f);
      else if (h === 'data') this.dataDecl(f);
    }
    // 第三遍收函数签名，函数才能互相调用（也才能递归）
    for (const f of forms) {
      const h = head(f);
      if (h === 'cfn') { this.cfnSig(f); continue; }
      if (h !== 'fn' && h !== 'kernel') continue;
      const nm = isAtom(f.items[1]) ? f.items[1].value : null;
      if (nm === null) { this.err(f, `(${h} NAME ...) 缺名字`); continue; }
      if (this.funcs.has(nm) || this.kernels.has(nm)) { this.err(f, `'${nm}' 重复定义`); continue; }
      if (h === 'kernel') {
        const ps = this.params(f.items[2]);
        if (ps === null) continue;
        // 隐含的第一个形参就是 gid。名字带 `$` 是刻意的：方言里写不出这个标识符，
        // 所以它不可能被用户的名字遮蔽，(gid) 是读它的唯一途径。
        const all = [{ name: '$gid', type: INT }];
        for (const p of ps) all.push(p);
        this.kernels.set(nm, { name: nm, mangled: `k_${nm}`, ret: VOID, params: all });
        continue;
      }
      const ps = this.params(f.items[2]);
      const ret = this.ty(f.items[3], `函数 ${nm} 的返回值`);
      if (ps === null || ret === null) continue;
      this.funcs.set(nm, { name: nm, mangled: `s_${nm}`, ret: ret, params: ps });
    }
    return this.assemble(forms, entryName, base);
  }

  /**
   * `(cfn NAME ((c T)...) ((p T)...) R 语句...)` 的签名那一半：登记闭包记录。
   *
   * 为什么闭包函数与普通 `(fn …)` 分成两个头而不是一个：捕获表是**记录的字段**，
   * 不是形参 —— 调用约定上第一个实参是记录自己，捕获从记录里读（`(cap c)`），
   * 这与"多几个形参"在 ABI 上是两件事（ADR-0010）。写成两个头，方言里就看得出
   * "这一份是要当值传的"，而不是靠某个标注去猜。
   *
   * 捕获是**按值**抓的（`(mkclo …)` 那一刻求值一次存进记录）。所以循环里造的闭包各自
   * 拿到自己那一份 —— 这条与 hir/check.js 的 lambda 是同一套语义，不是新规矩。
   */
  cfnSig(f) {
    const nm = isAtom(f.items[1]) ? f.items[1].value : null;
    if (nm === null) return this.err(f, '(cfn NAME (捕获...) (形参...) 返回类型 语句...) 缺名字');
    if (this.funcs.has(nm) || this.kernels.has(nm) || this.closures.has(nm)) {
      return this.err(f, `'${nm}' 重复定义`);
    }
    const caps = this.params(f.items[2]);
    const ps = this.params(f.items[3]);
    const ret = this.ty(f.items[4], `闭包 ${nm} 的返回值`);
    if (caps === null || ps === null || ret === null) return null;
    for (const c of caps) if (c.type === VOID) return this.err(f, `闭包 ${nm} 的捕获不能是 void`);
    const id = this.closures.size;
    const pts = [];
    for (const p of ps) pts.push(p.type);
    const t = this.useFnType(fnType(pts, ret));
    this.closures.set(nm, {
      // 发出去的名字**只由 `(cfn NAME …)` 的名字决定**，不是"第几个收到的"（从前是
      // `omni_clo_${id}`）。一份源码一份产物、几份产物拼起来是整个程序，就要求同一个
      // 闭包在哪一趟编译里都叫同一个名字 —— 按顺序编号做不到（换个入口顺序就变）。
      id, mangled: `omni_clo_${nm}`, make: `omni_mk_${nm}`,
      captures: caps, params: ps, ret: ret, type: t, node: f,
    });
    return null;
  }

  /** 登记一个用到的函数签名（C 后端要按签名发调用助手），返回那个类型本身 */
  useFnType(t) {
    const k = typeKey(t);
    if (!this.fnUsed.has(k)) this.fnUsed.set(k, t);
    return this.fnUsed.get(k);
  }

  /** `((p int) (q real))` -> OIR 形参表。 */
  params(node) {
    if (!isList(node)) return this.err(node, '形参表要写成 ((名字 类型) ...)');
    const out = [];
    for (const p of node.items) {
      if (!isList(p) || p.items.length !== 2 || !isAtom(p.items[0])) {
        this.err(p, '一个形参是 (名字 类型)');
        return null;
      }
      const t = this.ty(p.items[1], `形参 ${p.items[0].value}`);
      if (t === null) return null;
      out.push({ name: p.items[0].value, type: t });
    }
    return out;
  }

  /**
   * `(struct Point (x real) (y real))` -> 一个 OIR struct 类型，登记进 this.structs。
   *
   * **值语义**（ADR-0005）：赋值、传参、返回都是复制。这一层不为它写任何代码 ——
   * OIR 的消费者早就各有一份（解释器的 copyOf、JS 后端的 `$cp_S`、C 后端的原生 `=`、
   * MIR 的 `OP.COPY`），方言这边只要把节点发对。
   *
   * **字段类型这一刀收 int / real / bool / string、`(vec T N)`、`(arr T)`、
   * `(ptr T)` / `(tptr T)` 与另一个结构体/类**
   * （第十五刀放进向量：asy 的 `struct { pair p; }` 与门槛 3 的 transform 要它；
   * 第十六刀放进数组：`path` 那种"一串控制点"要它；第十七刀放进聚合本身）。
   * 向量字段是**值语义**（跟标量一样），数组字段是**引用语义** —— 复制结构体时搬的是
   * 句柄，两个副本共用同一条数组，与"数组当形参"那条规则是同一件事（ADR-0005）。
   * 每条腿的"结构体零值"都是一个**独立**的小函数
   * （JS 后端的 `zero`、C 后端的 `zeroExpr`、解释器的 `zeroOf`、LLVM 的 `fieldInit`），
   * 四处各补了向量与数组两条臂；JS 那条腿还要在 `$cp_S` 里对向量字段发 `$vcopy` ——
   * 不发的话它拷出来的是同一个宿主数组，而 C/LLVM 拷的是 16 字节的副本。
   *
   * **结构体套结构体是第十七刀放进来的**：内嵌字段在 LLVM 那条腿上就是那个命名类型本身
   * （`%s_Point`），所以 `FLD` 是一条光秃秃的 `getelementptr`，而 COPY 的
   * `load %s_Point` / `store %s_Point` 是头等聚合的复制 —— 递归是 LLVM 展开的，
   * 发射器里没有第二份"逐字段递归"。**直接内嵌不看顺序**（第二十三刀）：声明在后面的那个
   * 也收，因为名字先坐下、字段就地填。剩下真的解不出来的只有"按值绕回自己"，那一问在
   * cutValueCycles 那一遍上（`tests/sexpr/bad/struct-self.sx` 与 `struct-mutual.sx`
   * 钉着两半，`tests/sexpr/cases/34-embed-order.sx` 钉着"在后面"那一半是过的）。
   *
   * **指针字段是这一刀（ADR-0016 第十七刀）放进来的**：`(ptr T)` / `(tptr T)`。它与上一刀的
   * `ptrTargetOk` 是**两处**闸门 —— 那一刀开的是"指针能指向指针"，这一刀开的是"指针能躺在
   * 结构体里"。零值是空指针，五条腿各补一格（C 的 `zeroExpr`、LLVM 的 `fieldTy`/`fieldZero`；
   * JS 与两个解释器走的是通用的 `zeroValue`，本来就有 PtrNull）。**自引用不受"前面声明过"
   * 那一条约束**：指针是三个字、与目标的布局无关，所以 `(struct Node (next (ptr Node)))`
   * 摊得开 —— 落法与类同一套"名字先坐下、字段后填"（preStruct）。链表那一族要它。
   */
  structDec(n, kind) {
    const what = kind === 'struct' ? '结构体' : '类';
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.err(n, `(${kind} NAME (字段 类型)...) 缺名字`);
    if (TYPES.has(nm)) return this.err(n, `'${nm}' 是内建类型名，不能当${what}名`);
    // 上面那一遍替这个类/结构体先占了一格（preClass / preStruct）：那不是"重复定义"，
    // 是同一条声明的前半截。
    const pre = kind === 'class'
      ? (this.preClass.has(nm) ? this.classes.get(nm) : null)
      : (this.preStruct.has(nm) ? this.structs.get(nm) : null);
    if (pre === null && (this.structs.has(nm) || this.classes.has(nm))) {
      return this.err(n, `'${nm}' 重复定义`);
    }
    const fields = [];
    const seen = new Map();
    for (const fd of n.items.slice(2)) {
      if (!isList(fd) || fd.items.length !== 2 || !isAtom(fd.items[0])) {
        return this.err(fd, '一个字段是 (名字 类型)');
      }
      const fn = fd.items[0].value;
      if (seen.has(fn)) return this.err(fd, `${what} '${nm}' 里有两个字段叫 '${fn}'`);
      // 直接内嵌**不看顺序**（第二十三刀）：结构体的名字第十七刀起就"先坐下"了，所以
      // 后面才声明的那个在这一遍里查得着，字段数组是**就地填**的、指的是同一个对象，
      // 于是等这一遍走完布局自然就算得出来。绕回自己那一格由 cutValueCycles 那一遍报 ——
      // 它报完还会把闭环那条字段摘掉，好让后面的 structLayout / sizeOf 走在无环的图上。
      // 定长内存的字段（第二十二刀）：`(blk T N)` 是**真的内嵌**那 N 格 —— 布局那边
      // alignOf/sizeOf/structLayout 从第十八刀起就已经会算它了，缺的只有这张白名单与
      // 下面这一句分发（`(blk …)` 不在 ty 的表里，它只在指针目标那一处被认过）。
      const fty = fd.items[1];
      const t = isList(fty) && head(fty) === 'blk'
        ? this.blkTy(fty, `字段 ${nm}.${fn}`)
        : this.ty(fty, `字段 ${nm}.${fn}`);
      if (t === null) return null;
      if (t.k === 'blk' && kind !== 'struct') {
        return this.err(fd, `字段 ${nm}.${fn}：${what}的字段还不收定长内存 ——`
          + ' 类是引用、字段在堆上那一格里，内嵌一段定长内存要另一套零值');
      }
      if (t !== INT && t !== REAL && t !== BOOL && t !== STRING
          && t.k !== 'vec' && t.k !== 'arr' && t.k !== 'struct' && t.k !== 'class'
          && t.k !== 'ptr' && t.k !== 'tptr' && t.k !== 'fn' && t.k !== 'blk') {
        return this.err(fd, `字段 ${nm}.${fn}：这一刀的字段只能是 int / real / bool / string、`
          + `(vec T N)、(arr T)、(ptr T)、(tptr T)、(blk T N)、(fnty (T...) R) 或另一个结构体/类，`
          + `这里是 ${coreTypeText(t)}`);
      }
      seen.set(fn, true);
      fields.push({ name: fn, type: t });
    }
    if (fields.length === 0) return this.err(n, `${what} '${nm}' 至少要有一个字段`);
    // 结构体也是"名字先坐下、字段后填"了（第十七刀）：那一格得**原地**填 —— 指针字段
    // 拿到的是同一个对象，换一格新的就有两份 Node 了（`(pfield p next)` 回来的
    // `(ptr Node)` 与 `(struct Node …)` 那一格对不上，sameCoreType 按名字比才没露）。
    if (kind === 'struct') {
      if (pre !== null) { for (const f of fields) pre.fields.push(f); this.preStruct.delete(nm); }
      else this.structs.set(nm, structType(nm, fields));
    } else if (pre !== null) for (const f of fields) pre.fields.push(f);   // 原地填那一格
    else this.classes.set(nm, classType(nm, fields));
    return null;
  }

  /**
   * 按值内嵌绕回自己那一格：报掉，并把闭环那条字段**摘掉**（第二十三刀）。
   *
   * 第二十三刀把"直接内嵌只收前面声明过的那个"这一条撤了 —— 名字第十七刀起就先坐下、
   * 字段数组是就地填的，所以 `(struct A (b B) …)` 里的 B 声明在后面也查得着，等这一遍
   * 走完布局自然算得出来。撤掉那一条之后剩下的**真**毛病只有一种：绕回自己。
   * `(struct S (v S))` 与 `(struct A (b B)) (struct B (a A))` 的大小都是"自己加一点"，
   * 解不出来；`(blk S 2)` 也算内嵌（那是真的排 N 格），所以要剥掉 blk 再看。
   * 指针、类、`(arr T)` 都隔了一层（指针三个字、类与数组是一个引用），不是内嵌。
   *
   * 摘掉那条字段不是为了"修好"，是因为 `chunk()` 从来不在第一条诊断上停 ——
   * 报完还要往下走 structLayout / sizeOf / 各后端的排序，那几处都顺着字段往下递归，
   * 图上留着环就不是报错而是挂住。摘完这张图无环，后面那些照常走。
   */
  cutValueCycles(forms) {
    // 报在**这个结构体自己那条声明**上（不是提到它的那一处）：环没有"第一处"，
    // 而声明是用户改的那一行。REPL 前几批里的结构体在这一批的 forms 里没有声明，
    // 那时候退回 forms[0] —— 它们早就过过这一遍，不会真的报出来。
    const decl = new Map();
    for (const f of forms) {
      if (head(f) !== 'struct') continue;
      const sn = isAtom(f.items[1]) ? f.items[1].value : null;
      if (sn !== null && !decl.has(sn)) decl.set(sn, f);
    }
    const state = new Map();
    const stack = [];
    const visit = (st) => {
      if (state.get(st.name) === 'done') return;
      state.set(st.name, 'busy');
      stack.push(st.name);
      for (let i = 0; i < st.fields.length; i++) {
        const fd = st.fields[i];
        let ft = fd.type;
        while (ft.k === 'blk') ft = ft.el;
        if (ft.k !== 'struct') continue;
        if (state.get(ft.name) === 'busy') {
          const at = decl.has(st.name) ? decl.get(st.name) : forms[0];
          this.err(at, `字段 ${st.name}.${fd.name}：按值内嵌绕回了 '${ft.name}'`
            + `（${stack.join(' -> ')} -> ${ft.name}）—— 直接内嵌与一段定长内存都是真的内嵌，`
            + `那一格的大小算不出来；隔一层指针（写成 (ptr ${ft.name})）可以`);
          st.fields.splice(i, 1);
          i--;
          continue;
        }
        visit(ft);
      }
      stack.pop();
      state.set(st.name, 'done');
    };
    for (const st of this.structs.values()) visit(st);
    return null;
  }

  assemble(forms, entryName, base) {
    const funcs = [];
    const mainStmts = [];
    let sawMain = false;
    // 模块级变量的零初始化就是 `(main …)` 最前面的几句赋值（第二十四刀）。放在这一层
    // 而不是让六个后端各写一份"这个类型的零长什么样"：零值节点 OIR 里现成（zeroValue），
    // 而后端只要会存取一个全局就够。顺序是声明序，所以两次降级出来的文本一样。
    // 只初始化**这一批**新出来的（REPL：前面几批的全局已经在它们自己那个入口里初始化过了）。
    let gi = 0;
    for (const [nm, t] of this.globals) {
      if (gi++ < base.globals) continue;
      if (this.sigOnly.globals.has(nm)) continue;   // 只声明的：那一格由别人家的产物发
      mainStmts.push({
        kind: 'ExprStmt',
        expr: {
          kind: 'Assign', target: { kind: 'GlobalRef', name: nm, type: t },
          value: zeroValue(t), type: t,
        },
      });
    }
    for (const f of forms) {
      const h = head(f);
      if (h === 'fn') {
        const nm = isAtom(f.items[1]) ? f.items[1].value : null;
        const d = nm === null ? undefined : this.funcs.get(nm);
        if (d === undefined) continue;
        if (this.sigOnly.fns.has(nm)) continue;   // 只声明的：正文由定义它的那份产物发
        this.scopes = [new Map()];
        for (const p of d.params) this.scopes[0].set(p.name, p.type);
        const body = this.block(f.items.slice(4), d.ret);
        // 掉出函数体：非 void 补一个零值 return，与 WAT 前端同一处理（那边也是这样）
        if (d.ret !== VOID) body.push({ kind: 'Return', value: zeroValue(d.ret) });
        else body.push({ kind: 'Return', value: null });
        funcs.push({ name: d.name, mangled: d.mangled, ret: d.ret, params: d.params, body: { kind: 'Block', stmts: body } });
        continue;
      }
      if (h === 'kernel') {
        const nm = isAtom(f.items[1]) ? f.items[1].value : null;
        const d = nm === null ? undefined : this.kernels.get(nm);
        if (d === undefined) continue;
        this.scopes = [new Map()];
        for (const p of d.params) this.scopes[0].set(p.name, p.type);
        this.inKernel = true;
        const body = this.block(f.items.slice(3), VOID);
        this.inKernel = false;
        body.push({ kind: 'Return', value: null });
        // kernel 在 OIR 里就是一个普通 void 函数。`kernel: true` 是给后端的**标注**，
        // 不改语义：SPIR-V 那条腿按它挑要发的函数，其余五条腿完全不看它。
        funcs.push({ name: d.name, mangled: d.mangled, ret: VOID, params: d.params, kernel: true, body: { kind: 'Block', stmts: body } });
        continue;
      }
      if (h === 'cfn') {
        const nm = isAtom(f.items[1]) ? f.items[1].value : null;
        const d = nm === null ? undefined : this.closures.get(nm);
        if (d === undefined) continue;
        if (this.sigOnly.clos.has(nm)) continue;   // 同上
        this.scopes = [new Map()];
        for (const p of d.params) this.scopes[0].set(p.name, p.type);
        this.caps = new Map();
        for (const c of d.captures) this.caps.set(c.name, c.type);
        const body = this.block(f.items.slice(5), d.ret);
        this.caps = null;
        if (d.ret !== VOID) body.push({ kind: 'Return', value: zeroValue(d.ret) });
        else body.push({ kind: 'Return', value: null });
        // 提升出来的函数体挂 closureId：后端按它知道"第一个实参是闭包记录"（ADR-0010）。
        this.lifted.push({
          name: nm, mangled: d.mangled, ret: d.ret, params: d.params,
          body: { kind: 'Block', stmts: body }, closureId: d.id,
        });
        continue;
      }
      if (h === 'main') {
        if (sawMain) { this.err(f, '(main ...) 只能有一个'); continue; }
        sawMain = true;
        // REPL：入口的顶层作用域跨批留住（第一批 `(let t …)` 之后第二批还看得见 t）。
        // 运行期那边对应 InterpSession 里那个常驻 Env —— 两边必须一起在。
        if (entryName === 'omni_main') this.scopes = [new Map()];
        else {
          if (this.topScope === null) this.topScope = [new Map()];
          this.scopes = this.topScope;
        }
        for (const s of this.block(f.items.slice(1), VOID)) mainStmts.push(s);
        continue;
      }
      if (h === 'struct' || h === 'class') continue;   // 第一遍已经收过了
      if (h === 'global') continue;                    // 第二遍已经收过了
      if (h === 'memory' || h === 'data') continue;    // 第二遍半已经收过了
      this.err(f, `(module ...) 里只能是 (struct ...) / (class ...) / (global ...) / (memory ...) / (data ...) / (fn ...) / (cfn ...) / (kernel ...) / (main ...)，见到 '${h}'`);
    }
    // REPL 的一批里没有 `(main …)` 是正常的（只写了个函数定义）；整程序时必须有入口。
    if (!sawMain && entryName === 'omni_main') this.err(null, '缺入口：加一个 (main ...)');
    mainStmts.push({ kind: 'Return', value: null });
    funcs.push({
      name: entryName === 'omni_main' ? 'main' : entryName,
      mangled: entryName, ret: VOID, params: [], body: { kind: 'Block', stmts: mainStmts },
    });
    // 结构体按**声明顺序**发出去：C 后端会按值嵌套关系拓扑排序，但字段里不许再有结构体，
    // 所以这里的顺序就是最终顺序 —— 同一份输入两次降出来的文本因此逐字节相同。
    // `base` 之前的那些是前面几批发过的，不再重发（Map 记的就是插入序）。
    const structs = [];
    let si = 0;
    for (const s of this.structs.values()) {
      if (si++ >= base.structs && !this.sigOnly.aggs.has(s.name)) structs.push(s);
    }
    const classes = [];
    let ci = 0;
    for (const c of this.classes.values()) {
      if (ci++ >= base.classes && !this.sigOnly.aggs.has(c.name)) classes.push(c);
    }
    // 模块级变量按**声明顺序**发出去（Map 记的就是插入序）：MIR 的全局号按这个顺序分配，
    // 所以同一份输入两次编译出来的字节与哈希都一样。
    const globals = [];
    let gj = 0;
    for (const [nm, t] of this.globals) {
      if (gj++ < base.globals) continue;
      if (this.sigOnly.globals.has(nm)) continue;
      globals.push({ name: nm, mangled: `g_${nm}`, type: t });
    }
    // 闭包提升出来的函数体排在最后（跟 hir/check.js 一样：合成的东西放在用户函数之后）。
    const lifted = [];
    let li = base.lifted;
    while (li < this.lifted.length) { lifted.push(this.lifted[li]); li++; }
    const clos = [];
    let qi = 0;
    for (const [nm, c] of this.closures) {
      if (qi++ < base.closures) continue;
      if (this.sigOnly.clos.has(nm)) continue;   // 造它的那个小函数由定义它的那份产物发
      clos.push({ id: c.id, mangled: c.mangled, make: c.make, captures: c.captures });
    }
    const fnTys = [];
    let fi = 0;
    for (const t of this.fnUsed.values()) if (fi++ >= base.fnUsed) fnTys.push(t);
    // 线性内存：只有声明它的那一批产物负责把它建起来（见构造器里的 memEmitted）。
    let memOut = null;
    if (this.mem !== null && !this.memEmitted) {
      memOut = this.mem;
      this.memEmitted = true;
    }
    return {
      structs: structs, classes: classes, enums: [], containers: [],
      closures: clos, fnTypes: fnTys,
      funcs: funcs.concat(lifted),
      globals: globals,
      imports: this.sigImports,
      entry: entryName,
      // 线性内存只在**声明它的那一批**里发出去（见构造器里的 memEmitted）：
      // 后面几批的产物里 mem 是 null，于是它们不会把内存重建一遍、把字节清掉。
      mem: memOut,
    };
  }

  /* --------------------------------------------- 线性内存的两条声明（第二刀）
   * `(memory MIN MAX)`  —— 页数下界与上界，一页 64KB。MAX = 0 表示不设上界。
   * `(data OFF 字节…)`  —— 初始字节，OFF 是字节偏移。字节可以写成整数（0..255）
   *                        或字符串（按 UTF-8 展开），一条 data 里可以混着写。
   *
   * 为什么 data 的字节不是表达式：它们要在**编译期**算好（wasm 的 data 段也是常量），
   * 于是四条腿各自把它们发成自己的字面量 —— C 那边是一个 static 数组，JS 那边是一个
   * 数组字面量，LLVM 那边是 private constant。允许表达式就等于要求四条腿各有一个
   * 编译期求值器。
   *
   * 第 0 页刻意不检查"你别用" —— 那是约定（C 的空指针要能与地址 0 区分），
   * 但把它做成硬检查就等于给 wasm 的 data 段加一条 wasm 没有的规则。
   */
  memDecl(n) {
    if (this.mem !== null) return this.err(n, '(memory …) 只能有一条 —— 一个模块一块线性内存');
    const min = this.constInt(n.items[1]);
    const max = n.items.length > 2 ? this.constInt(n.items[2]) : 0;
    if (min === null || max === null) return this.err(n, '(memory MIN [MAX])：页数要是整数字面量');
    if (min < 0 || max < 0) return this.err(n, '(memory MIN MAX)：页数不能是负数');
    if (max !== 0 && max < min) return this.err(n, `(memory ${min} ${max})：上界比下界还小`);
    if (min > 65536 || max > 65536) return this.err(n, '(memory …)：页数上限是 65536（wasm32 的 4GB）');
    this.mem = { min: min, max: max, data: [] };
    this.memEmitted = false;
    return null;
  }

  dataDecl(n) {
    if (this.mem === null) return this.err(n, '(data …) 之前要先有 (memory …)');
    const off = this.constInt(n.items[1]);
    if (off === null || off < 0) return this.err(n, '(data OFF 字节…)：OFF 要是非负的整数字面量');
    const bytes = [];
    let i = 2;
    while (i < n.items.length) {
      const it = n.items[i];
      if (isStr(it)) { for (const b of utf8Bytes(it.value)) bytes.push(b); i++; continue; }
      const v = this.constInt(it);
      if (v === null || v < 0 || v > 255) {
        return this.err(it, '(data OFF 字节…) 的字节要是 0..255 的整数或一个字符串字面量');
      }
      bytes.push(v);
      i++;
    }
    const end = off + bytes.length;
    if (end > this.mem.min * 65536) {
      return this.err(n, `(data ${off} …) 有 ${bytes.length} 个字节，越过了声明的 ${this.mem.min} 页`
        + `（${this.mem.min * 65536} 字节）—— data 段是初始内容，不会触发 grow`);
    }
    this.mem.data.push({ off: off, bytes: bytes });
    return null;
  }

  /** 整数字面量（不是表达式）。`(memory 2 4)` 与 `(data 65536 …)` 的那几格。 */
  constInt(x) {
    if (x === undefined || !isAtom(x)) return null;
    if (!/^[+-]?[0-9]+$/.test(x.value)) return null;
    return Number(x.value);
  }

  /**
   * 线性内存的读侧（写侧是语句 `mstore`）。ADR-0017 第二刀。
   *
   *   (msize)                当前页数
   *   (mgrow N)              加 N 页；回**旧**页数，加不了回 -1（wasm 的约定，不报错）
   *   (mload KIND ADDR)      读；KIND 是 i8s/i8u/i16s/i16u/i32s/i32u/i64/f32/f64
   *   (mload KIND ADDR OFF)  带静态偏移
   *
   * 为什么 KIND 是**字面量**而不是表达式：它决定这条指令读几个字节、怎么扩展、结果是
   * int 还是 real —— 那是类型，不是值。wasm 那边它也是指令名的一部分（`i64.load32_u`）。
   *
   * 为什么 OFF 也是字面量：它是 wasm 的 `offset=` 立即数、C 的 `p->field` 那个常量偏移。
   * 写成表达式就等于 `(mload k (bin "+" a off))`，那本来就能写 —— 分开一格是为了让
   * 四条腿都能把它折进寻址里（LLVM 一条 add、C 一次常量折叠），而不是每次多算一次。
   *
   * 结果类型只有 int 与 real 两种（方言就这两格数）：`i32s` 读出来是符号扩展到 64 位的
   * int，`f32` 读出来是加宽到 double 的 real。C 前端将来发的是同一条 MLOAD，只是它的
   * `t` 会是 T_I32 / T_F32 —— 那一格已经在第一刀里就位了。
   */
  memExpr(n, h) {
    if (this.mem === null) {
      return this.err(n, `(${h} …) 要先在模块里写一条 (memory MIN [MAX])`);
    }
    if (h === 'msize') return { kind: 'MemSize', type: INT };
    if (h === 'mgrow') {
      const c = this.expr(n.items[1]);
      if (c === null) return null;
      if (c.type !== INT) return this.err(n, `(mgrow N) 的 N 要是 int，这里是 ${coreTypeText(c.type)}`);
      return { kind: 'MemGrow', pages: c, type: INT };
    }
    const kind = isAtom(n.items[1]) ? n.items[1].value : null;
    const rt = kind === null ? undefined : MEM_LOAD_KINDS.get(kind);
    if (rt === undefined) {
      return this.err(n, `(mload KIND ADDR) 的 KIND 要是 ${[...MEM_LOAD_KINDS.keys()].join(' / ')}`
        + `，这里是 '${kind === null ? '?' : kind}'`);
    }
    const a = this.expr(n.items[2]);
    if (a === null) return null;
    if (a.type !== INT) return this.err(n, `(mload …) 的地址要是 int，这里是 ${coreTypeText(a.type)}`);
    const off = n.items.length > 3 ? this.constInt(n.items[3]) : 0;
    if (off === null || off < 0) return this.err(n, '(mload KIND ADDR OFF) 的 OFF 要是非负的整数字面量');
    return { kind: 'MemLoad', mkind: kind, addr: a, off: off, type: rt };
  }

  /**
   * `(mstore KIND ADDR VAL)` / `(mstore KIND ADDR VAL OFF)`。跟 `pstore` 一样是**语句**。
   * KIND 是 i8/i16/i32/i64/f32/f64 —— **没有符号**：写只是把低若干位拍进内存
   * （wasm 的 store 也没有 `_s`/`_u`）。窄写会丢高位，这是刻意的：`(mstore i8 a 300)`
   * 存进去的是 44，而 C 的 `*(char*)p = 300` 也是这个意思。
   */
  memStore(n) {
    if (this.mem === null) {
      return this.err(n, '(mstore …) 要先在模块里写一条 (memory MIN [MAX])');
    }
    const kind = isAtom(n.items[1]) ? n.items[1].value : null;
    const vt = kind === null ? undefined : MEM_STORE_KINDS.get(kind);
    if (vt === undefined) {
      return this.err(n, `(mstore KIND ADDR VAL) 的 KIND 要是 ${[...MEM_STORE_KINDS.keys()].join(' / ')}`
        + `，这里是 '${kind === null ? '?' : kind}'`);
    }
    const a = this.expr(n.items[2]);
    const v = this.expr(n.items[3]);
    if (a === null || v === null) return null;
    if (a.type !== INT) return this.err(n, `(mstore …) 的地址要是 int，这里是 ${coreTypeText(a.type)}`);
    if (v.type !== vt) {
      return this.err(n, `(mstore ${kind} …) 的值要是 ${coreTypeText(vt)}，这里是 ${coreTypeText(v.type)}`);
    }
    const off = n.items.length > 4 ? this.constInt(n.items[4]) : 0;
    if (off === null || off < 0) return this.err(n, '(mstore KIND ADDR VAL OFF) 的 OFF 要是非负的整数字面量');
    return {
      kind: 'ExprStmt',
      expr: { kind: 'MemStore', mkind: kind, addr: a, off: off, value: v, type: vt },
    };
  }

  /* -------------------------------------------------------------- 语句 */

  block(nodes, ret) {
    const out = [];
    for (const s of nodes) {
      const st = this.stmt(s, ret);
      if (st !== null) out.push(st);
    }
    return out;
  }

  stmt(n, ret) {
    if (!isList(n)) return this.err(n, '语句要写成一个 (…) 形式');
    const h = head(n);
    if (h === 'do') {
      this.scopes.push(new Map());
      const body = this.block(n.items.slice(1), ret);
      this.scopes.pop();
      return { kind: 'Block', stmts: body };
    }
    if (h === 'let') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(let 名字 类型 值)');
      const t = this.ty(n.items[2], `变量 ${nm}`);
      if (t === null) return null;
      const v = this.expr(n.items[3]);
      if (v === null) return null;
      if (!sameCoreType(v.type, t)) return this.err(n, `变量 ${nm} 是 ${coreTypeText(t)}，初值是 ${coreTypeText(v.type)}`);
      // 同一层里重名是错的；外层同名是遮蔽，合法
      if (this.scopes[this.scopes.length - 1].has(nm)) return this.err(n, `'${nm}' 在这一层已经声明过了`);
      this.scopes[this.scopes.length - 1].set(nm, t);
      return { kind: 'Local', name: nm, type: t, init: v };
    }
    if (h === 'set') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(set 名字 值)');
      const r = this.nameRef(nm);
      if (r === null) return this.err(n, `未声明的变量 '${nm}'`);
      if (r.global && this.inKernel) {
        return this.err(n, `kernel 里改模块级变量 '${nm}'（GPU 那条腿上没有它，`
          + '结果写回 (buf …) 形参）');
      }
      const t = r.type;
      const v = this.expr(n.items[2]);
      if (v === null) return null;
      if (!sameCoreType(v.type, t)) return this.err(n, `'${nm}' 是 ${coreTypeText(t)}，赋的值是 ${coreTypeText(v.type)}`);
      const tgt = r.global
        ? { kind: 'GlobalRef', name: nm, type: t }
        : { kind: 'VarRef', name: nm, type: t };
      return { kind: 'ExprStmt', expr: { kind: 'Assign', target: tgt, value: v, type: t } };
    }
    return this.stmt2(n, h, ret);
  }

  stmt2(n, h, ret) {
    if (h === 'if') {
      const c = this.cond(n.items[1]);
      if (c === null) return null;
      const then = this.stmt(n.items[2], ret);
      if (then === null) return null;
      const els = n.items[3] === undefined ? null : this.stmt(n.items[3], ret);
      return { kind: 'If', cond: c, then: then, otherwise: els };
    }
    if (h === 'while') {
      const c = this.cond(n.items[1]);
      if (c === null) return null;
      this.loopDepth++;
      const body = this.stmt(n.items[2], ret);
      this.loopDepth--;
      if (body === null) return null;
      return { kind: 'While', cond: c, body: body };
    }
    // `(brk)` / `(cont)`：OIR 里 Break / Continue 早就有，方言这边一直没开口。
    // 补上不是为 asy 特设的 —— 任何 C 系语言的循环都要它，而"用标志位绕开 break"
    // 会把控制流塞进数据流里，六条腿上都更难读。
    //
    // `(brk N)` / `(cont N)` 是往外数第 N 层（第四十刀）。MIR 早就是按层号跳的
    // （`OP.BR` 的第三个操作数就是层数），这一格只是把方言那一头开出来。N 省掉就是 1。
    // 上限 9：jancy 的词法就是 `'break' [1-9]`（jnc_ct_Lexer.rl:317-320），没有 `break10`。
    if (h === 'brk' || h === 'cont') {
      let level = 1;
      if (n.items[1] !== undefined) {
        const s = isAtom(n.items[1]) ? n.items[1].value : null;
        if (s === null || !/^[1-9]$/.test(s)) return this.err(n, `(${h} N) 的 N 要是 1..9 的十进制数字`);
        level = Number(s);
      }
      if (this.loopDepth === 0) return this.err(n, `(${h}) 只能写在循环里`);
      if (this.loopDepth < level) {
        return this.err(n, `(${h} ${level}) 要往外数 ${level} 层循环，这里只有 ${this.loopDepth} 层`);
      }
      return { kind: h === 'brk' ? 'Break' : 'Continue', level: level };
    }
    if (h === 'ret') {
      if (n.items[1] === undefined) {
        if (ret !== VOID) return this.err(n, `这个函数要返回 ${ret.k}，(ret) 没给值`);
        return { kind: 'Return', value: null };
      }
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (!sameCoreType(v.type, ret)) return this.err(n, `要返回 ${coreTypeText(ret)}，给的是 ${coreTypeText(v.type)}`);
      return { kind: 'Return', value: v };
    }
    // 宿主面只有 print 一条，和 WAT 前端同一条理由：格式、换行、四个执行器之间的
    // 一致性全是现成的，不必为新方言再造一份
    // `(fail E)`：运行期错误，六条腿都是"印 omni: runtime error: 消息、退 70"（OIR 里
    // 就是 Omni 的 fail，所以这一条没有给任何后端加新东西）。方言需要它是因为被降级的
    // 语言有**自己的**运行期错误 —— 比如 asy 的 angle((0,0))：那不是"还没做"，是照搬。
    if (h === 'fail') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type !== STRING) return this.err(n, `(fail E) 的实参要是 string，这里是 ${coreTypeText(v.type)}`);
      return { kind: 'ExprStmt', expr: { kind: 'Builtin', name: 'fail', args: [v], type: VOID, argType: STRING } };
    }
    if (h === 'print') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type === VOID) return this.err(n, 'print 的实参不能是 void');
      // 向量没有 print：运行时没有对应的输出函数，而"随便定一个格式"意味着六个执行器
      // 各自实现一遍格式化 —— 那是最容易分叉的地方。要看向量就 (lane v k) 逐道印。
      if (v.type.k === 'vec') return this.err(n, 'print 不接受向量：用 (lane v N) 逐道印');
      if (v.type.k === 'buf') return this.err(n, 'print 不接受缓冲：用 (bget b i) 逐个印');
      if (v.type.k === 'arr') return this.err(n, 'print 不接受数组：用 (aget a i) 逐个印');
      if (v.type.k === 'struct') return this.err(n, 'print 不接受结构体：用 (fld s 字段) 逐个印');
      if (v.type.k === 'class') return this.err(n, 'print 不接受类：用 (fld o 字段) 逐个印');
      return { kind: 'ExprStmt', expr: { kind: 'Builtin', name: 'print', args: [v], type: VOID, argType: v.type } };
    }
    // `(write E)` —— 印一个 string，**不加换行**。
    //
    // `print` 自带换行，而 jancy 的 `printf("%d ", x)` 到处都是（ADR-0016 第四刀）。
    // 原先这一格只有 JS 后端有，于是 jancy 那一侧只能把"格式串必须以 \n 收尾"当边界 ——
    // 那是让语言向方言妥协，反了。这一条补齐五条腿。
    //
    // 只收 string：要印数就先 `(tostr …)`。理由与 print 那条不同 —— print 收所有标量是
    // 因为它早就那样（Omni 的 `print` 是个多态内建），而这一条是新的，没有历史包袱，
    // 于是选"只有一种签名"：五条腿各一个符号，而不是各四个。
    if (h === 'write') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type !== STRING) return this.err(n, `(write E) 的实参要是 string，这里是 ${coreTypeText(v.type)}（要印数就先 (tostr …)）`);
      return { kind: 'ExprStmt', expr: { kind: 'Builtin', name: 'write', args: [v], type: VOID, argType: STRING } };
    }
    if (h === 'expr') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      return { kind: 'ExprStmt', expr: v };
    }
    if (h === 'bset') return this.bufSet(n);
    if (h === 'pstore') return this.ptrStore(n);
    if (h === 'mstore') return this.memStore(n);
    if (h === 'unsafe') return this.unsafeBlock(n, ret);
    if (h === 'aset' || h === 'apush') return this.arrWrite(n, h);
    if (h === 'fldset') return this.fldSet(n);
    if (h === 'dispatch') return this.dispatch(n);
    return this.err(n, `不认识的语句 '${h}'`);
  }

  /**
   * `(fldset 结构体 字段 值)`。跟 bset/aset 一样是**语句**：写回的"值"没人用。
   *
   * 目标只能是一个**表达式**（通常是 `(var p)`），不是名字 —— 于是 `(fldset (aget a i) x …)`
   * 这种写法在方言层面就是通的，各条腿按自己的左值规则处理（C 是 `a[i].f_x = v`，
   * 两个解释器是"对象引用上写字段"）。
   */
  fldSet(n) {
    const o = this.expr(n.items[1]);
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (o === null) return null;
    if (nm === null) return this.err(n, '(fldset 结构体 字段 值)：字段要是一个名字');
    if (o.type.k !== 'struct' && o.type.k !== 'class') {
      return this.err(n, `fldset 的第一个实参要是结构体或类，这里是 ${coreTypeText(o.type)}`);
    }
    const fd = this.field(n, o.type, nm);
    if (fd === null) return null;
    if (fd.type.k === 'blk') return this.blkNotAValue(n, o.type, nm, 'fldset', '写');
    const v = this.expr(n.items[3]);
    if (v === null) return null;
    if (!sameCoreType(v.type, fd.type)) {
      return this.err(n, `${o.type.name}.${nm} 是 ${coreTypeText(fd.type)}，写进去的是 ${coreTypeText(v.type)}`);
    }
    const tgt = { kind: 'Field', object: o, name: nm, type: fd.type };
    return { kind: 'ExprStmt', expr: { kind: 'Assign', target: tgt, value: v, type: fd.type } };
  }

  /** 字段查表。找不到时把有哪些字段一起说出来 —— 拼错字段名是最常见的手误。 */
  field(n, t, nm) {
    for (const f of t.fields) if (f.name === nm) return f;
    const names = [];
    for (const f of t.fields) names.push(f.name);
    return this.err(n, `${t.k === 'class' ? '类' : '结构体'} ${t.name} 没有字段 '${nm}' —— 有的是 ${names.join(' / ')}`);
  }

  /**
   * 定长内存的字段不能当**值**读写（第二十二刀）。`(fld …)` / `(fldset …)` 走的是"结构体
   * 是一个值"那条路，而 `(blk T N)` 没有能装它的槽（第十八刀那两条 bad 也是这个理由）。
   * 内嵌那 N 格只能**在内存里**碰：`(pfield p f)` 拿到它的地址，`(pelem …)` 退成元素指针。
   */
  blkNotAValue(n, st, nm, form, verb) {
    return this.err(n, `(${form} …) 的 ${st.name}.${nm} 是一段定长内存，不是一个值 ——`
      + ` 用 (pelem (pfield p ${nm})) 拿元素指针再${verb}一格`);
  }

  /** `(bset 缓冲 下标 值)`。写回是语句而不是表达式：它的"值"没人用，留着只会多一条路。 */
  bufSet(n) {
    const b = this.expr(n.items[1]);
    const i = this.expr(n.items[2]);
    const v = this.expr(n.items[3]);
    if (b === null || i === null || v === null) return null;
    if (b.type.k !== 'buf') return this.err(n, `bset 的第一个实参要是缓冲，这里是 ${coreTypeText(b.type)}`);
    if (i.type !== INT) return this.err(n, `bset 的下标要是 int，这里是 ${coreTypeText(i.type)}`);
    if (!sameCoreType(v.type, b.type.elem)) {
      return this.err(n, `这个缓冲装 ${b.type.elem.k}，写进去的是 ${coreTypeText(v.type)}`);
    }
    return { kind: 'ExprStmt', expr: { kind: 'BufSet', buf: b, index: i, value: v, type: b.type.elem } };
  }

  /**
   * `(pstore 指针 值)`。与 bset 同一条规矩：写回是语句，它的"值"没人用。
   * fat 指针会查范围，空指针是运行期错误。
   */
  ptrStore(n) {
    const p = this.expr(n.items[1]);
    const v = this.expr(n.items[2]);
    if (p === null || v === null) return null;
    if (p.type.k !== 'ptr' && p.type.k !== 'tptr') {
      return this.err(n, `pstore 的第一个实参要是指针，这里是 ${coreTypeText(p.type)}`);
    }
    if (p.type.k === 'tptr' && !this.unsafe) {
      return this.err(n, 'thin 指针上的 pstore 要写在 (unsafe …) 里 —— 它没有范围，查不了');
    }
    // 定长内存那一条先说（第十八刀）：不然下面 sameCoreType 会报成"指向 int[3]、写进去的是
    // int"，那句话把人往"换个值"的方向带，而真正要换的是**指针**。
    if (p.type.target.k === 'blk') {
      return this.err(n, `(pstore p v) 的 p 指向 ${coreTypeText(p.type.target)}：一段定长内存不是`
        + '一个值 —— 用 (pelem p) 退成元素指针再写');
    }
    if (!sameCoreType(v.type, p.type.target)) {
      return this.err(n, `这个指针指向 ${coreTypeText(p.type.target)}，`
        + `写进去的是 ${coreTypeText(v.type)}`);
    }
    if (p.type.target.k === 'struct') {
      return this.err(n, `(pstore p v) 的 p 指向结构体 ${p.type.target.name}：整块写还没做 ——`
        + ' 用 (pfield p 字段名) 逐字段写');
    }
    return { kind: 'ExprStmt', expr: {
      kind: 'PtrStore', ptr: p, value: v, size: sizeOf(p.type.target), type: p.type.target,
    } };
  }

  /**
   * `(unsafe 语句...)`（ADR-0016 决策三）。**块级**，与 jancy 自己的 `unsafe { … }` 一样
   * （语料里只有 test50.jnc 用到它）。
   *
   * 落地上它就是一个 `do`：这一层只是把 `this.unsafe` 这一格开着，让 thin 那一族
   * 在检查时过得去。**没有**任何运行期代价 —— unsafe 的全部作用就是"少查一次"。
   *
   * 嵌套时是现设现还（不是"置成 true 再置回 false"）：`(unsafe (do (unsafe …)))` 之后
   * 外层那一段还得是 unsafe 的。
   */
  unsafeBlock(n, ret) {
    const keep = this.unsafe;
    this.unsafe = true;
    this.scopes.push(new Map());
    const body = this.block(n.items.slice(1), ret);
    this.scopes.pop();
    this.unsafe = keep;
    return body === null ? null : { kind: 'Block', stmts: body };
  }

  /**
   * 数组的两条写侧：`(aset 数组 下标 值)` 与 `(apush 数组 值)`。
   * 跟 bset 一样是**语句** —— 它们在 C 里返回写进去的值（省一个分支），但方言里不给出口：
   * 「表达式带副作用」会让求值顺序变成语义的一部分，而这一层的六条腿都得给同一个答案。
   */
  arrWrite(n, h) {
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    if (a.type.k !== 'arr') return this.err(n, `${h} 的第一个实参要是数组，这里是 ${coreTypeText(a.type)}`);
    const vNode = h === 'aset' ? n.items[3] : n.items[2];
    if (vNode === undefined) return this.err(n, h === 'aset' ? '(aset 数组 下标 值) 要三个实参' : '(apush 数组 值) 要两个实参');
    const v = this.expr(vNode);
    if (v === null) return null;
    if (!sameCoreType(v.type, a.type.elem)) {
      return this.err(n, `这个数组装 ${a.type.elem.k}，写进去的是 ${coreTypeText(v.type)}`);
    }
    if (h === 'apush') {
      return { kind: 'ExprStmt', expr: { kind: 'ArrPush', arr: a, value: v, type: a.type.elem } };
    }
    const i = this.expr(n.items[2]);
    if (i === null) return null;
    if (i.type !== INT) return this.err(n, `aset 的下标要是 int，这里是 ${coreTypeText(i.type)}`);
    return { kind: 'ExprStmt', expr: { kind: 'ArrSet', arr: a, index: i, value: v, type: a.type.elem } };
  }

  /**
   * `(dispatch NAME 网格 实参...)`：把一个 kernel 在 `[0, 网格)` 上跑一遍。
   *
   * 在这里就展开成「临时量 + while 循环 + 普通调用」，不留一个 OIR 节点 ——
   * 于是六个执行器一行都不用改，而 CPU 上的答案就是门槛 7 要比的那个答案。
   * GPU 那条腿看的是 kernel 函数本身（`kernel: true` 标注）与这里的网格大小，
   * 不是这个循环：循环是"没有 GPU 时怎么执行"的定义，不是语义的一部分。
   *
   * 实参先各绑一个临时量再进循环：`(dispatch k (blen b) (bget b 0))` 这种写法里
   * 实参表达式只该求值一次。
   */
  dispatch(n) {
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.err(n, '(dispatch NAME 网格 实参...)');
    const d = this.kernels.get(nm);
    if (d === undefined) {
      return this.err(n, this.funcs.has(nm) ? `'${nm}' 是函数，不是 kernel` : `未声明的 kernel '${nm}'`);
    }
    const grid = this.expr(n.items[2]);
    if (grid === null) return null;
    if (grid.type !== INT) return this.err(n, `网格大小要是 int，这里是 ${coreTypeText(grid.type)}`);
    const args = [];
    for (const a of n.items.slice(3)) {
      const v = this.expr(a);
      if (v === null) return null;
      args.push(v);
    }
    // 形参表里第一个是隐含的 gid，所以实参个数比形参个数少一个
    if (args.length !== d.params.length - 1) {
      return this.err(n, `kernel '${nm}' 要 ${d.params.length - 1} 个实参，给了 ${args.length} 个`);
    }
    let i = 0;
    while (i < args.length) {
      if (!sameCoreType(args[i].type, d.params[i + 1].type)) {
        return this.err(n, `kernel '${nm}' 的第 ${i + 1} 个形参是 ${coreTypeText(d.params[i + 1].type)}，给的是 ${coreTypeText(args[i].type)}`);
      }
      i++;
    }
    const tag = this.tmpNo;
    this.tmpNo++;
    const nVar = `$n${tag}`;
    const gVar = `$g${tag}`;
    const stmts = [
      { kind: 'Local', name: nVar, type: INT, init: grid },
      { kind: 'Local', name: gVar, type: INT, init: { kind: 'Const', type: INT, value: 0n } },
    ];
    const callArgs = [{ kind: 'VarRef', name: gVar, type: INT }];
    let k = 0;
    while (k < args.length) {
      const an = `$a${tag}_${k}`;
      stmts.push({ kind: 'Local', name: an, type: args[k].type, init: args[k] });
      callArgs.push({ kind: 'VarRef', name: an, type: args[k].type });
      k++;
    }
    const gRef = { kind: 'VarRef', name: gVar, type: INT };
    const step = {
      kind: 'ExprStmt',
      expr: {
        kind: 'Assign',
        target: gRef,
        value: { kind: 'Bin', op: '+', opType: INT, left: gRef, right: { kind: 'Const', type: INT, value: 1n }, type: INT },
        type: INT,
      },
    };
    stmts.push({
      kind: 'While',
      cond: { kind: 'Cmp', op: '<', opType: INT, left: gRef, right: { kind: 'VarRef', name: nVar, type: INT }, type: BOOL },
      body: {
        kind: 'Block',
        stmts: [
          { kind: 'ExprStmt', expr: { kind: 'Call', func: d.mangled, name: d.name, args: callArgs, type: VOID } },
          step,
        ],
      },
    });
    return { kind: 'Block', stmts: stmts };
  }

  /** 条件位置：必须是 bool，不做真值化 —— 那是各门语言自己的规则。 */
  cond(n) {
    const c = this.expr(n);
    if (c === null) return null;
    if (c.type !== BOOL) return this.err(n, `条件要是 bool，这里是 ${c.type.k}`);
    return c;
  }

  /* --------------------------------------------------- 函数值（ADR-0010） */

  /** `(cap c)`：读当前 `(cfn …)` 的一个捕获。只在捕获表里查 —— 见构造函数里的 caps。 */
  capRef(n) {
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.err(n, '(cap 名字)');
    if (this.caps === null) return this.err(n, `(cap ${nm}) 只能出现在 (cfn ...) 的体里`);
    if (!this.caps.has(nm)) return this.err(n, `这个闭包没有叫 '${nm}' 的捕获`);
    return { kind: 'CaptureRef', name: nm, type: this.caps.get(nm) };
  }

  /** `(mkclo NAME v...)`：造一个闭包值。捕获**按值**求一次存进记录。 */
  mkClo(n) {
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.err(n, '(mkclo NAME 捕获值...)');
    const d = this.closures.get(nm);
    if (d === undefined) {
      return this.err(n, this.funcs.has(nm)
        ? `'${nm}' 是普通函数，当值用写 (fnref ${nm})`
        : `没有叫 '${nm}' 的 (cfn ...)`);
    }
    const args = [];
    let i = 0;
    while (i < d.captures.length) {
      const a = this.expr(n.items[i + 2]);
      if (a === null) return null;
      if (!sameCoreType(a.type, d.captures[i].type)) {
        return this.err(n.items[i + 2], `捕获 '${d.captures[i].name}' 要 `
          + `${coreTypeText(d.captures[i].type)}，这里是 ${coreTypeText(a.type)}`);
      }
      args.push(a);
      i++;
    }
    if (n.items.length - 2 !== d.captures.length) {
      return this.err(n, `(mkclo ${nm} ...) 要 ${d.captures.length} 个捕获值，`
        + `给了 ${n.items.length - 2} 个`);
    }
    return { kind: 'MakeClosure', closure: d.id, make: d.make, args: args, type: d.type };
  }

  /**
   * `(fnref NAME)`：把一个普通 `(fn …)` 当值用。生成一个**薄适配器**闭包（形参照抄、
   * 转手调用），于是所有函数值共用同一套调用约定（第一个实参是记录自己）。
   * 代价是一次多余的调用，换来的是调用处不需要区分"这是闭包还是具名函数" ——
   * 与 hir/check.js 的 funcRef 是同一条决定，不是这里另立的规矩。
   */
  fnRef(n) {
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.err(n, '(fnref NAME)');
    const d = this.funcs.get(nm);
    if (d === undefined) {
      return this.err(n, this.closures.has(nm)
        ? `'${nm}' 是 (cfn ...)，当值用写 (mkclo ${nm} ...)`
        : `没有叫 '${nm}' 的函数`);
    }
    const key = `&${nm}`;
    if (!this.closures.has(key)) {
      const pts = [];
      const ps = [];
      let i = 0;
      while (i < d.params.length) {
        ps.push({ name: `a${i}`, type: d.params[i].type });
        pts.push(d.params[i].type);
        i++;
      }
      const t = this.useFnType(fnType(pts, d.ret));
      const id = this.closures.size;
      const args = [];
      for (const p of ps) args.push({ kind: 'VarRef', name: p.name, type: p.type });
      const call = { kind: 'Call', func: d.mangled, name: d.name, args: args, type: d.ret };
      const stmt = d.ret === VOID
        ? { kind: 'ExprStmt', expr: call }
        : { kind: 'Return', value: call };
      const tail = { kind: 'Return', value: d.ret === VOID ? null : zeroValue(d.ret) };
      this.closures.set(key, {
        // 名字按**被取地址的那个函数**起（同上：不能用"第几个"编号）
        id, mangled: `omni_clo_ref_${nm}`, make: `omni_mk_ref_${nm}`,
        captures: [], params: ps, ret: d.ret, type: t, node: n,
      });
      this.lifted.push({
        name: key, mangled: `omni_clo_ref_${nm}`, ret: d.ret, params: ps,
        body: { kind: 'Block', stmts: [stmt, tail] }, closureId: id,
      });
    }
    const c = this.closures.get(key);
    return { kind: 'MakeClosure', closure: c.id, make: c.make, args: [], type: c.type };
  }

  /** `(callfn E a...)`：调一个函数值。函数值没有形参名，所以这里只有位置实参。 */
  callFn(n) {
    const f = this.expr(n.items[1]);
    if (f === null) return null;
    if (f.type.k !== 'fn') {
      return this.err(n, `(callfn E ...) 的 E 要是一个函数值，这里是 ${coreTypeText(f.type)}`);
    }
    const t = f.type;
    const args = [];
    let i = 2;
    while (i < n.items.length) {
      const a = this.expr(n.items[i]);
      if (a === null) return null;
      args.push(a);
      i++;
    }
    if (args.length !== t.params.length) {
      return this.err(n, `这个函数值要 ${t.params.length} 个实参，给了 ${args.length} 个`);
    }
    i = 0;
    while (i < args.length) {
      if (!sameCoreType(args[i].type, t.params[i])) {
        return this.err(n.items[i + 2], `第 ${i + 1} 个实参要 ${coreTypeText(t.params[i])}，`
          + `这里是 ${coreTypeText(args[i].type)}`);
      }
      i++;
    }
    this.useFnType(t);
    return { kind: 'CallFn', callee: f, fnType: t, args: args, type: t.ret };
  }

  /* ------------------------------------------------------------ 表达式 */

  expr(n) {
    if (n === undefined) return this.err(null, '少了一个表达式');
    if (!isList(n)) return this.err(n, '表达式要写成一个 (…) 形式（常量也要：(int 1)）');
    const h = head(n);
    if (h === 'int') return this.intLit(n);
    if (h === 'real') return this.realLit(n);
    if (h === 'bool') {
      const v = isAtom(n.items[1]) ? n.items[1].value : null;
      if (v !== 'true' && v !== 'false') return this.err(n, '(bool true) 或 (bool false)');
      return { kind: 'Const', type: BOOL, value: v === 'true' };
    }
    if (h === 'str') {
      if (!isStr(n.items[1])) return this.err(n, '(str "…") 要一个字符串字面量');
      return { kind: 'Const', type: STRING, value: n.items[1].value };
    }
    // 函数值四条。`(cap c)` 读捕获、`(mkclo NAME v...)` 造一个闭包值、
    // `(fnref NAME)` 把一个普通 `(fn …)` 当值用、`(callfn E a...)` 调一个函数值。
    if (h === 'cap') return this.capRef(n);
    if (h === 'mkclo') return this.mkClo(n);
    if (h === 'fnref') return this.fnRef(n);
    if (h === 'callfn') return this.callFn(n);
    // `(tostr E)`：数值/布尔 -> 字符串。OIR 的 `to_string` 早就在（四个消费方都认它），
    // 方言这边一直没开口，于是"把数拼进一句话里"在这一层根本写不出来 —— 而那是任何
    // 语言的 `write("x = ", x)` 都要的。刻意**不**做隐式转换：`+` 两边照旧必须同型，
    // 要拼就显式写出这一步。格式跟 print 的同一份（ADR-0005 的 %.6g），不另造一份。
    if (h === 'tostr') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      const k = v.type.k;
      if (k !== 'int' && k !== 'real' && k !== 'bool') {
        return this.err(n, `(tostr E) 只接受 int / real / bool，这里是 ${coreTypeText(v.type)}`);
      }
      if (n.items[2] === undefined) {
        return { kind: 'Builtin', name: 'to_string', args: [v], type: STRING, argType: v.type };
      }
      // `(tostr E N)`：按 **N 位有效数字** 格式化，只对 real 有意义。加它是因为默认那份
      // %.6g 是"看值用的"（ADR-0005），而别的语言有自己的默认位数 —— asy 是 %.15g，
      // 逐字节对不上就等于没做。N 只收 1..17 的字面量：位数是格式的一部分，不是运行期
      // 才知道的东西，写死了后端就能把它当常量传下去，也不会出现 %.0g 这种没有定义的东西。
      if (k !== 'real') return this.err(n, `(tostr E N) 的位数只对 real 有意义，这里是 ${coreTypeText(v.type)}`);
      const p = this.expr(n.items[2]);
      if (p === null) return null;
      if (p.kind !== 'Const' || p.type.k !== 'int') return this.err(n.items[2], '(tostr E N) 的 N 要是 int 字面量');
      const digits = Number(p.value);
      if (!Number.isInteger(digits) || digits < 1 || digits > 17) {
        return this.err(n.items[2], `(tostr E N) 的 N 要在 1..17 之间，这里是 ${digits}`);
      }
      return { kind: 'Builtin', name: 'to_string_g', args: [v, p], type: STRING, argType: REAL };
    }
    // `(rmath "NAME" A [B])`：real 上的数学函数。名单是**量出来的**（runtime/omni_math.c
    // 的头注里写着）：只有各家实现必然一致的那几个进得来 —— sqrt 是 IEEE-754 强制正确
    // 舍入，fabs/floor/ceil/round/fmod 是精确运算，pow 在 80 组随机输入上 libm 与 V8
    // 逐位相同。exp/log/tan/atan/cos 那一类刻意不收：它们在最后一位就分叉，收了
    // "五条腿逐字节相同"这条纪律就成了摆设。
    if (h === 'rmath') {
      if (!isStr(n.items[1])) return this.err(n, '(rmath "NAME" A [B]) 的第一项要是函数名字符串');
      const fn = n.items[1].value;
      const want = RMATH.get(fn);
      if (want === undefined) {
        return this.err(n.items[1], `(rmath) 不认识 '${fn}'，能用的是 ${[...RMATH.keys()].join(' / ')}`);
      }
      const args = [];
      for (let i = 0; i < want; i++) {
        const v = this.expr(n.items[2 + i]);
        if (v === null) return null;
        if (v.type.k !== 'real') return this.err(n.items[2 + i], `(rmath "${fn}") 的参数要是 real，这里是 ${coreTypeText(v.type)}`);
        args.push(v);
      }
      if (n.items.length !== 2 + want) return this.err(n, `(rmath "${fn}") 要 ${want} 个参数`);
      return { kind: 'Builtin', name: `rmath_${fn}`, args, type: REAL, argType: REAL };
    }
    // 字符串上的三条：长度、子串、找子串。OIR 侧三个 `Builtin` 早就在（Omni 自己的
    // `s.length` / `s.substr(i,n)` / `s.indexOf(t)` 就是它们），所以 run / run-c /
    // interp / interp --mir 四条腿一行没改就通了；LLVM 那条腿要三条 ABI（见 RT_OPS）。
    //
    // **按字节**，不按码点：Omni 的 string 就是 UTF-8 字节序列（ADR-0005），asy 的
    // string 是 C++ 的 std::string，也是字节。所以两边的 length/substr 说的是同一件事。
    // 越界**报错**而不是截断（`(ssub …)` 用的就是 Omni 自己那份检查，消息也是同一句）——
    // 哪门语言要 clamp，clamp 就写在那门语言的前端里，不写进这一层。
    if (h === 'slen' || h === 'ssub' || h === 'sfind') {
      const s = this.expr(n.items[1]);
      if (s === null) return null;
      if (s.type.k !== 'string') return this.err(n, `(${h} …) 的第一个参数要是 string，这里是 ${coreTypeText(s.type)}`);
      if (h === 'slen') {
        if (n.items.length !== 2) return this.err(n, '(slen E) 要 1 个参数');
        return { kind: 'Builtin', name: 'len', args: [s], recvType: STRING, type: INT };
      }
      if (h === 'sfind') {
        if (n.items.length !== 3) return this.err(n, '(sfind E T) 要 2 个参数');
        const t = this.expr(n.items[2]);
        if (t === null) return null;
        if (t.type.k !== 'string') return this.err(n.items[2], `(sfind E T) 的 T 要是 string，这里是 ${coreTypeText(t.type)}`);
        return { kind: 'Builtin', name: 'indexOf', args: [s, t], recvType: STRING, type: INT };
      }
      if (n.items.length !== 4) return this.err(n, '(ssub E I N) 要 3 个参数');
      const at = this.expr(n.items[2]);
      const len = this.expr(n.items[3]);
      if (at === null || len === null) return null;
      if (at.type.k !== 'int') return this.err(n.items[2], `(ssub E I N) 的起点要是 int，这里是 ${coreTypeText(at.type)}`);
      if (len.type.k !== 'int') return this.err(n.items[3], `(ssub E I N) 的长度要是 int，这里是 ${coreTypeText(len.type)}`);
      return { kind: 'Builtin', name: 'substr', args: [s, at, len], recvType: STRING, type: STRING };
    }
    // `(chr E)` —— 一个码位 -> 一个字符的串。**借现成的**（Omni 的 `chr(65)`，四条腿早就
    // 在，LLVM 那条腿补一行 ABI）—— 与 slen/ssub/sfind 同一个路子。jancy 的 `%c` 要它。
    // `(srep S N)` —— 把 S 重复 N 遍（printf 的宽度要它，ADR-0016 第五刀）：
    // `%5d` 就是"空格重复 max(0, 5 - 长度) 遍再接上"。**N <= 0 回空串，不报错** ——
    // 那个 max 常常是 0 或负数，是正常情形。刻意不接封闭 ABI 里的 js_str_repeat：
    // 它收发 omni_dyn，从这条按类型走的路上用它要装箱拆箱两次。
    if (h === 'chr') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type !== INT) return this.err(n, `(chr E) 的实参要是 int，这里是 ${coreTypeText(v.type)}`);
      return { kind: 'Builtin', name: 'chr', args: [v], argType: INT, type: STRING };
    }
    if (h === 'srep') {
      const s = this.expr(n.items[1]);
      const k = this.expr(n.items[2]);
      if (s === null || k === null) return null;
      if (s.type.k !== 'string') return this.err(n, `(srep S N) 的 S 要是 string，这里是 ${coreTypeText(s.type)}`);
      if (k.type !== INT) return this.err(n, `(srep S N) 的 N 要是 int，这里是 ${coreTypeText(k.type)}`);
      return { kind: 'Builtin', name: 'str_repeat', args: [s, k], recvType: STRING, type: STRING };
    }
    // `(sbase E 进制)` —— 把 E 按某个进制印出来（ADR-0016 第七刀，jancy 的 `%x` / `%o` 要它）。
    //
    // 两条定死的语义，两套实现上必须一致：
    //   - **E 的位当无符号 64 位读**。这是 C 的 `%x` 的规矩（它把实参当 unsigned），所以
    //     `(sbase (int -1) (int 16))` 是 16 个 f。要 32 位的答案就先在上一层掩一次
    //     （`x & 0xFFFFFFFF`）—— 位宽是**降级那一层的账**，这条形式不管。
    //   - **数字用小写**（`0-9a-z`）。要大写走 `(supper …)`：不在这条形式里加一个标志位，
    //     那会让它多一种参数形状，而只省一次调用。
    //
    // 进制**要写成字面量**：printf 里它永远是字面量，而收运行期值就得多一条"进制不在
    // 2..36"的运行期错误路径（四条腿各一份消息）。这条限制在这儿一次说清，便宜得多。
    if (h === 'sbase') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type !== INT) return this.err(n, `(sbase E 进制) 的 E 要是 int，这里是 ${coreTypeText(v.type)}`);
      if (!isList(n.items[2]) || head(n.items[2]) !== 'int') {
        return this.err(n, '(sbase E 进制) 的进制要写成字面量 (int N)');
      }
      const b = this.intLit(n.items[2]);
      if (b === null) return null;
      if (b.value < 2n || b.value > 36n) {
        return this.err(n, `(sbase E 进制) 的进制要在 2..36 之间，这里是 ${b.value}`);
      }
      return { kind: 'Builtin', name: 'str_base', args: [v, b], argType: INT, type: STRING };
    }
    // `(supper S)` —— **只把 ASCII 的 a-z 换成大写**，别的字节一个不动。
    //
    // 刻意不是"Unicode 的 toUpperCase"：JS 那侧 `"ß".toUpperCase()` 是 `"SS"`（长度都变了），
    // C 那侧 `toupper` 还看 locale —— 两条路上根本对不上。定成 ASCII-only 之后四条腿是
    // 同一个函数。`%X` 要它（`(supper (sbase …))`）。
    if (h === 'supper') {
      const s = this.expr(n.items[1]);
      if (s === null) return null;
      if (s.type.k !== 'string') return this.err(n, `(supper S) 的 S 要是 string，这里是 ${coreTypeText(s.type)}`);
      return { kind: 'Builtin', name: 'str_upper', args: [s], recvType: STRING, type: STRING };
    }
    // `(sfix E N)` —— real -> 小数点后**正好 N 位**（ADR-0016 第八刀，C 的 `%.Nf`）。
    //
    // 与 `(tostr E N)` 是两件事：那一条是 `%.Ng`（N 位**有效数字**、去尾随零），这一条是
    // `%.Nf`（小数点后固定 N 位、不去零）。printf 的 `%f` 要的是后者。
    //
    // **舍入定的是"就近取偶"**（C 的 printf，也就是 IEEE-754 的默认舍入）。这一条必须
    // 在这儿写死，因为两条实现路子在**恰好一半**上本来不一样：C 给 `0.12`，JS 的
    // `toFixed` 给 `0.13`（ECMA-262 规定取较大的 n）。挑 C 那一边的理由是 jancy —— 它的
    // printf 底下就是 C 的 printf，而纪律是"jancy 不向方言妥协"。JS 那侧因此**不能**用
    // toFixed，得按精确值用 BigInt 算（native.js 的 fmtFixed 与 prelude 的 $str_fixed）。
    //
    // 位数的范围是 0..30（上界让 C 那侧的缓冲有个头）。它**不必**是字面量（第二十八刀）：
    // `printf("%.*f", n, x)` 的位数运行期才知道，而 jancy 的 printf 就是 C 库的 vsnprintf，
    // 那一行在它那边是通的 —— 所以这一格照收一段表达式。是字面量时照旧当场判范围
    //（诊断更早、也更准），不是字面量时那一条落到运行期：四份实现各自查，越界是运行期错误
    //（同一句话："sfix precision out of range: N (0..30)"）。
    //
    // `(ssci E N)` 是同一条的科学计数那一格（第三十刀，C 的 `%.Ne`）：`d.dddde±dd`，
    // 整数部分正好一位、指数至少两位且一定带符号。舍入、位数范围、"不必是字面量"三条
    // 与 `sfix` 一字不差 —— 所以这两条走同一段代码，只差一个内建名字。
    //
    // `(sgen E N)` / `(sgenk E N)` 是同一族的第四、第五格（第三十一刀，C 的 `%.Ng` /
    // `%#.Ng`）：在 `%e` 与 `%f` 里按舍入之后的指数挑一个，精度 0 等于 1。两个名字的差别
    // 只有那个 `#` —— `sgenk` **不去尾随零**（`%#g` 印 1.5 是 `1.50000`）。`#` 在格式串里
    // 是编译期就定了的，所以这儿用两个名字而不是加一个 bool 参数：方言的每一格都是表达式。
    //
    // 与 `(tostr E N)` 的关系：那一条就是 `sgen`（永远去零）的一个子集，可它的 N 只收字面量、
    // 范围是 1..17。两条并成一条是以后的事（asy 那边在用 `tostr`），这一刀不动它。
    if (h === 'sfix' || h === 'ssci' || h === 'sgen' || h === 'sgenk') {
      const bn = { sfix: 'str_fixed', ssci: 'str_sci', sgen: 'str_gen', sgenk: 'str_genk' }[h];
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type !== REAL) return this.err(n, `(${h} E N) 的 E 要是 real，这里是 ${coreTypeText(v.type)}`);
      if (isList(n.items[2]) && head(n.items[2]) === 'int') {
        const p = this.intLit(n.items[2]);
        if (p === null) return null;
        if (p.value < 0n || p.value > 30n) {
          return this.err(n, `(${h} E N) 的位数要在 0..30 之间，这里是 ${p.value}`);
        }
        return { kind: 'Builtin', name: bn, args: [v, p], argType: REAL, type: STRING };
      }
      const p = this.expr(n.items[2]);
      if (p === null) return null;
      if (p.type !== INT) return this.err(n, `(${h} E N) 的位数要是 int，这里是 ${coreTypeText(p.type)}`);
      return { kind: 'Builtin', name: bn, args: [v, p], argType: REAL, type: STRING };
    }
    // `(readtext E)`：把一份文本文件**整份**读成 string。方言里读文件只有这一个口子 ——
    // 被降级的语言那边的文件对象（asy 的 `input(name).line().word()`：分词、注释、eof）
    // 都在它上面搭，方言不认识"文件"这个概念，只认识"名字 -> 文本"。
    // 读不到是运行期错误（三条腿一份语义：$read_text / omni_read_text / readTextOrFail）。
    if (h === 'readtext') {
      if (n.items.length !== 2) return this.err(n, '(readtext E)');
      const p = this.expr(n.items[1]);
      if (p === null) return null;
      if (p.type.k !== 'string') {
        return this.err(n.items[1], `(readtext E) 的参数要是 string，这里是 ${coreTypeText(p.type)}`);
      }
      return { kind: 'Builtin', name: 'read_text', args: [p], argType: STRING, type: STRING };
    }
    // `(writetext P E)`：把 string E **整份**写成一份文本文件，回写进去的字节数。
    // 与 `(readtext E)` 是同一层的一对 —— 方言仍旧不认识"文件"，只认识"名字 <-> 文本"。
    // 为什么要有：asy 的标签是 TeX 排的（texfile.cc 生一份 `<名>_.tex`，再 latex + dvips），
    // 那条路上必须先把 `.tex` 落到盘上，别人（latex）才读得到。
    if (h === 'writetext') {
      if (n.items.length !== 3) return this.err(n, '(writetext P E)');
      const p = this.expr(n.items[1]);
      const v = this.expr(n.items[2]);
      if (p === null || v === null) return null;
      if (p.type.k !== 'string') {
        return this.err(n.items[1], `(writetext P E) 的路径要是 string，这里是 ${coreTypeText(p.type)}`);
      }
      if (v.type.k !== 'string') {
        return this.err(n.items[2], `(writetext P E) 的内容要是 string，这里是 ${coreTypeText(v.type)}`);
      }
      return { kind: 'Builtin', name: 'write_text', args: [p, v], argType: STRING, type: INT };
    }
    // `(runproc CMD)`：把 CMD 交给 `/bin/sh -c` 跑一趟，回退出码（跑不起来也是非 0）。
    // 子进程的 stdout/stderr **不接**，直接继承 —— 要输出就让被调的程序自己写文件，
    // 我们再 `(readtext …)` 读回来（asy 那边 dvips 也是 `-o<文件>`，同一个办法）。
    // 只有这一个"外面的程序"口子。走 shell 而不是 argv 数组：方言里还没有 string[] 实参
    // 的 ABI，而这一层的命令行全是我们自己拼的（latex / dvips 加一个文件名）。
    // **拼命令行的那一处要自己负责引号**：文件名进来之前先过一层引用（见 asy 那一侧的
    // asy__shq），否则名字里一个空格就能改掉命令的意思。
    if (h === 'runproc') {
      if (n.items.length !== 2) return this.err(n, '(runproc CMD)');
      const c = this.expr(n.items[1]);
      if (c === null) return null;
      if (c.type.k !== 'string') {
        return this.err(n.items[1], `(runproc CMD) 的参数要是 string，这里是 ${coreTypeText(c.type)}`);
      }
      return { kind: 'Builtin', name: 'run_proc', args: [c], argType: STRING, type: INT };
    }
    // `(toreal E)` / `(toint E)`：int <-> real 的**显式**转换。同一条纪律：类型不推导、
    // 不插隐式转换，所以两个方向都得写出来。OIR 侧两个都是现成的（Cast int->real、
    // trunc real->int），方言这边原先没开口 —— 而 asy 的 `1/3` 是实数除法、`(int) 3.7`
    // 是截断，没有这两条就一句都降不下来。
    // `(torealu E)` —— 把 E 的位**当无符号 64 位**转成 real（第六十一刀）。
    // 为什么要单开一条而不是在上一层展开成 `sel`：那个展开要把 E 抄四遍
    // （`E >= 0 ? (double)E : (double)((E u>> 1) | (E & 1)) * 2`），E 有副作用就跑四次。
    // 落到各条腿上都是现成的一条：LLVM 的 uitofp、C 的 `(double)(uint64_t)`、
    // JS 的 `Number(BigInt.asUintN(64, x))`、SPIR-V 的 OpConvertUToF。
    if (h === 'torealu') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type.k !== 'int') {
        return this.err(n, `(torealu E) 的参数要是 int，这里是 ${coreTypeText(v.type)}`);
      }
      return { kind: 'Cast', type: REAL, from: INT, expr: v, uns: true };
    }
    if (h === 'toreal' || h === 'toint') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      const want = h === 'toreal' ? 'int' : 'real';
      if (v.type.k !== want) {
        return this.err(n, `(${h} E) 的参数要是 ${want}，这里是 ${coreTypeText(v.type)}`);
      }
      if (h === 'toreal') return { kind: 'Cast', type: REAL, from: INT, expr: v };
      return { kind: 'Builtin', name: 'trunc', args: [v], type: INT, argType: REAL };
    }
    if (h === 'var') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(var 名字)');
      const r = this.nameRef(nm);
      if (r === null) return this.err(n, `未声明的变量 '${nm}'`);
      // kernel 里读全局是不收的：GPU 那条腿上"模块级变量"没有对应物（SPIR-V 的
      // 全局变量得挂在某个存储类上，而选哪个是接口设计，不是降级能替它定的）。
      if (r.global && this.inKernel) {
        return this.err(n, `kernel 里读模块级变量 '${nm}'（GPU 那条腿上没有它，`
          + '要的数据从 (buf …) 形参进来）');
      }
      if (r.global) return { kind: 'GlobalRef', name: nm, type: r.type };
      return { kind: 'VarRef', name: nm, type: r.type };
    }
    if (h === 'call') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(call 名字 实参...)');
      const d = this.funcs.get(nm);
      if (d === undefined) {
        return this.err(n, this.kernels.has(nm)
          ? `'${nm}' 是 kernel，要用 (dispatch ${nm} 网格 实参...) 启动`
          : `未声明的函数 '${nm}'`);
      }
      const args = [];
      for (const a of n.items.slice(2)) {
        const v = this.expr(a);
        if (v === null) return null;
        args.push(v);
      }
      if (args.length !== d.params.length) {
        return this.err(n, `'${nm}' 要 ${d.params.length} 个实参，给了 ${args.length} 个`);
      }
      let i = 0;
      while (i < args.length) {
        if (!sameCoreType(args[i].type, d.params[i].type)) {
          return this.err(n, `'${nm}' 的第 ${i + 1} 个形参是 ${coreTypeText(d.params[i].type)}，给的是 ${coreTypeText(args[i].type)}`);
        }
        i++;
      }
      return { kind: 'Call', func: d.mangled, name: d.name, args: args, type: d.ret };
    }
    if (h === 'splat' || h === 'vlit' || h === 'lane' || h === 'hsum') return this.vecExpr(n, h);
    if (h === 'bnew' || h === 'bget' || h === 'blen') return this.bufExpr(n, h);
    // `(sel 条件 甲 乙)` —— 条件表达式，**惰性**（只算取中的那一支）。
    //
    // 加这一条是因为 jancy 的 `? :` 不该向方言妥协：那门语言里它到处都是，而
    // "拆成一个临时量加一条 if" 只在语句位置成立 —— 一旦它出现在 `&&` 的右边、
    // 实参里、或另一个 `sel` 的分支里，拆出来的语句就跑到了不该跑的地方。
    //
    // 代价近乎零：汇聚层下面**早就有** Ternary（Omni 自己的 `?:` 就是它），
    // 五条腿与 MIR 都认（from_oir.js 的 ternary()：开一个槽、IF/ELSE 各存一次、
    // 再读回来）。这里缺的一直只是一个**表面形式**。
    if (h === 'sel') {
      const c = this.expr(n.items[1]);
      const a = this.expr(n.items[2]);
      const b = this.expr(n.items[3]);
      if (c === null || a === null || b === null) return null;
      if (c.type !== BOOL) return this.err(n, `(sel …) 的条件要是 bool，这里是 ${coreTypeText(c.type)}`);
      // 两支必须同型。方言不推导也不隐式加宽（ADR-0014 决策 1）—— 要加宽就在前端写出
      // `(toreal …)`，那一步在各语言那边本来就是一次隐式转换，写下来才看得见。
      if (!sameCoreType(a.type, b.type)) {
        return this.err(n, `(sel …) 两支要同型：甲是 ${coreTypeText(a.type)}，乙是 ${coreTypeText(b.type)}`);
      }
      return { kind: 'Ternary', cond: c, then: a, otherwise: b, type: a.type };
    }
    if (h === 'msize' || h === 'mgrow' || h === 'mload') return this.memExpr(n, h);
    if (h === 'pnew' || h === 'pnull' || h === 'pload' || h === 'padd' || h === 'psub'
      || h === 'pisnull' || h === 'pfield' || h === 'pthin' || h === 'pelem'
      || h === 'peq') return this.ptrExpr(n, h);
    if (h === 'anew' || h === 'aget' || h === 'alen' || h === 'apop') return this.arrExpr(n, h);
    // 结构体的两条读侧（写侧是语句 fldset）：`(new Point)` 零值，`(fld p x)` 读字段。
    // 没有"结构体字面量"：字段一多，字面量就要么按顺序（改字段顺序会静默改语义）、
    // 要么带名字（那是命名实参那套东西，属于各语言的前端）。零值 + 逐个 fldset 少一条路。
    if (h === 'new') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null || !this.structs.has(nm)) {
        return this.err(n, `(new NAME)：'${nm === null ? '?' : nm}' 不是这份模块里的结构体`);
      }
      return zeroValue(this.structs.get(nm));
    }
    if (h === 'fld') {
      const o = this.expr(n.items[1]);
      const nm = isAtom(n.items[2]) ? n.items[2].value : null;
      if (o === null) return null;
      if (nm === null) return this.err(n, '(fld 结构体 字段)：字段要是一个名字');
      if (o.type.k !== 'struct' && o.type.k !== 'class') {
        return this.err(n, `fld 的第一个实参要是结构体或类，这里是 ${coreTypeText(o.type)}`);
      }
      const fd = this.field(n, o.type, nm);
      if (fd === null) return null;
      if (fd.type.k === 'blk') return this.blkNotAValue(n, o.type, nm, 'fld', '读');
      return { kind: 'Field', object: o, name: nm, type: fd.type };
    }
    // `(cnew NAME)`：新建一个**类**的实例（引用语义，第十三刀）。名字与 `(new …)` 分开是
    // 刻意的 —— 值语义和引用语义在读代码时必须一眼分得开，而不是靠回头查那个名字是
    // struct 还是 class 声明的。
    if (h === 'cnew') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null || !this.classes.has(nm)) {
        return this.err(n, `(cnew NAME)：'${nm === null ? '?' : nm}' 不是这份模块里的类`);
      }
      return { kind: 'NewObject', type: this.classes.get(nm) };
    }
    if (h === 'gid') {
      if (!this.inKernel) return this.err(n, '(gid) 只在 kernel 里有意义');
      return { kind: 'VarRef', name: '$gid', type: INT };
    }
    // `(null TYPE)`：**空引用**（第三十三刀）。只对引用类型成立 —— 类、函数、数组，
    // 也就是运行时躺着一个句柄的那三种。标量没有空引用这回事，写了就是错。
    //
    // OIR 那边这个概念本来就有（`NullRef` / `NullFn`：类与函数的**零值**就是它们，
    // 多维数组那一刀还在 `(anew (arr (arr T)) N)` 的格子零值上用过），六条腿也都认
    // （JS `null`、C `NULL`、LLVM `null`、两个解释器的 `null`、MIR `K.nul`）——
    // 缺的只是**方言里写不出来**。asy 的 `null` 字面量要它：
    // `restricted bool isNullValue(V) = null;`（collections/map.asy:11）、
    // `map.isNullValue != null`（:130）与 math.asy:160 那一族。
    //
    // 函数类型上发的是 `NullFn` 而不是 `NullRef`，为的是跟 `zeroValue` 出同一个节点 ——
    // 同一个语义两种节点，后端迟早有一边漏。数组则**没有**这条对应：
    // `zeroValue((arr T))` 是长度 0 的空数组而不是空引用（`alen`/`apush` 在任何数组上
    // 都得能答），所以 `(null (arr T))` 是一个只能显式写出来的值，不是谁的零值。
    if (h === 'null') {
      const t = this.ty(n.items[1], 'null 的类型');
      if (t === null) return null;
      if (t.k !== 'class' && t.k !== 'fn' && t.k !== 'arr') {
        return this.err(n, `(null TYPE) 的 TYPE 要是引用类型（类 / 函数 / 数组），`
          + `这里是 ${coreTypeText(t)}`);
      }
      return { kind: t.k === 'fn' ? 'NullFn' : 'NullRef', type: t };
    }
    return this.operator(n, h);
  }

  /**
   * 缓冲的三条读侧（写侧是语句 `bset`）。
   *
   *   (bnew (buf T) N)   新建长度 N 的零缓冲
   *   (bget b i)         读第 i 个
   *   (blen b)           长度
   *
   * 越界是**运行期错误**，消息与 list 那套同一个形状（`buffer index out of range: i (length n)`）。
   * GPU 上没有这条错误路径 —— 那边的约定是 kernel 自己用 `(blen b)` 守门，
   * 越界属于程序的 bug；CPU 这五条腿会当场报出来，正是想要的：错误在 CPU 上暴露。
   */
  bufExpr(n, h) {
    if (h === 'bnew') {
      const t = this.ty(n.items[1], 'bnew 的类型');
      if (t === null) return null;
      if (t.k !== 'buf') return this.err(n, '(bnew TYPE N) 的 TYPE 要是 (buf T)');
      const c = this.expr(n.items[2]);
      if (c === null) return null;
      if (c.type !== INT) return this.err(n, `bnew 的长度要是 int，这里是 ${coreTypeText(c.type)}`);
      return { kind: 'BufNew', type: t, count: c };
    }
    const b = this.expr(n.items[1]);
    if (b === null) return null;
    if (b.type.k !== 'buf') return this.err(n, `${h} 的实参要是缓冲，这里是 ${coreTypeText(b.type)}`);
    if (h === 'blen') return { kind: 'BufLen', buf: b, type: INT };
    const i = this.expr(n.items[2]);
    if (i === null) return null;
    if (i.type !== INT) return this.err(n, `bget 的下标要是 int，这里是 ${coreTypeText(i.type)}`);
    return { kind: 'BufGet', buf: b, index: i, type: b.type.elem };
  }

  /**
   * 指针的读侧（写侧是语句 `pstore`）。ADR-0016 决策一。
   *
   *   (pnew (ptr T) N)   在堆上要 N 个 T，回一个盖住这 N 个的 fat 指针（零初始化）
   *   (pload p)          解引用；fat 会查范围
   *   (padd p n)         指针算术，**按元素**（不是字节）
   *   (psub p q)         两个指针的差，按元素；不同块之间相减是运行期错误
   *   (pnull (ptr T))    空指针
   *   (pisnull p)        是不是空指针
   *   (pfield p 字段名)  结构体指针 -> 那个字段的指针（"把协议头盖在缓冲上"靠这一条）
   *   (pthin p)          fat 降成 thin；**只在 `(unsafe …)` 里**
   *   (pelem p)          `(ptr (blk T N))` -> `(ptr T)`（第十八刀）；地址与范围都不动
   *   (peq p q)          两个指针指的是不是同一格
   *
   * `peq` 单开一条而不是走 `(bin "==" …)`：`==` 那一条要求"两边同型、按值比"，而 fat
   * 指针是三个字 —— C 那条腿上比整个结构体编不过，JS 那条腿上比两个数组永远不等。
   * 而"两个地址相不相等"这件事在**两套实现下都有定义**（arena 偏移与真地址都是标量），
   * 所以它是一条能立住的形式。刻意**不给** `<` `>`：块间的次序在两套实现下不一样，
   * 那种比较只在同一块内有意义，而"是不是同一块"要用 `psub`（它会替你报错）。
   *
   * 为什么第一刀里没有 `(addr 局部量)`：那要求局部量可寻址，也就是 jancy 说的
   * "any local taken fat address of, is being lifted to GC heap"（type_ptr_data.rst）。
   * 那一格要动到每条腿的局部量表示，单独一刀。有 `pnew` 之后第一刀的门槛已经够了。
   */
  ptrExpr(n, h) {
    if (h === 'pnew' || h === 'pnull') {
      const t = this.ty(n.items[1], `${h} 的类型`);
      if (t === null) return null;
      if (t.k !== 'ptr' && t.k !== 'tptr') {
        return this.err(n, `(${h} TYPE …) 的 TYPE 要是 (ptr T) 或 (tptr T)`);
      }
      if (h === 'pnull') return { kind: 'PtrNull', type: t };
      if (t.k === 'tptr') {
        return this.err(n, '(pnew (tptr T) N)：thin 指针没有范围，分配出来的那块就没人管了 ——'
          + ' 用 (pnew (ptr T) N) 再 (pthin …)');
      }
      const c = this.expr(n.items[2]);
      if (c === null) return null;
      if (c.type !== INT) return this.err(n, `pnew 的个数要是 int，这里是 ${coreTypeText(c.type)}`);
      return { kind: 'PtrNew', type: t, count: c, size: sizeOf(t.target) };
    }
    const p = this.expr(n.items[1]);
    if (p === null) return null;
    if (p.type.k !== 'ptr' && p.type.k !== 'tptr') {
      return this.err(n, `${h} 的实参要是指针，这里是 ${coreTypeText(p.type)}`);
    }
    const thin = p.type.k === 'tptr';
    if (thin && !this.unsafe) {
      return this.err(n, `thin 指针上的 '${h}' 要写在 (unsafe …) 里 —— 它没有范围，查不了`);
    }
    if (h === 'pisnull') return { kind: 'PtrIsNull', ptr: p, type: BOOL };
    // `(pelem p)`：`(ptr (blk T N))` -> `(ptr T)`（第十八刀）。地址与范围一个字都不动，
    // 变的只有类型 —— 于是接下来的 `padd` 一步跨一格元素而不是一整块。运行期它是恒等的
    // （四个 OIR 消费者都直接把操作数交出去），所以 MIR 上连一条新指令都没有。
    if (h === 'pelem') {
      if (p.type.target.k !== 'blk') {
        return this.err(n, `(pelem p) 的 p 要指向 (blk T N)，这里是 ${coreTypeText(p.type)}`);
      }
      const et = p.type.target.el;
      return { kind: 'PtrElem', ptr: p, type: thin ? tptrType(et) : ptrType(et) };
    }
    if (h === 'pload') {
      // 结构体整块读出来这一刀不给：那要按类型逐字段从内存里拼一个值出来，四条腿各一份
      // marshalling。而这门语言真正的用法是"把头结构体盖在缓冲上、然后**逐字段**访问"
      // （type_ptr_data.rst 开头那段 TCP/IP 包），也就是 `(pfield …)` 那一条。
      if (p.type.target.k === 'struct') {
        return this.err(n, `(pload p) 的 p 指向结构体 ${p.type.target.name}：整块读还没做 ——`
          + ' 用 (pfield p 字段名) 逐字段读');
      }
      // 定长内存同理，而且更彻底：`(blk T N)` **不是一个值**，没有能装它的槽 ——
      // 先用 `(pelem p)` 退到 `(ptr T)` 再读一格（第十八刀）。
      if (p.type.target.k === 'blk') {
        return this.err(n, `(pload p) 的 p 指向 ${coreTypeText(p.type.target)}：一段定长内存不是`
          + '一个值 —— 用 (pelem p) 退成元素指针再读');
      }
      return { kind: 'PtrLoad', ptr: p, type: p.type.target, size: sizeOf(p.type.target) };
    }
    if (h === 'pthin') {
      if (!this.unsafe) return this.err(n, '(pthin p) 要写在 (unsafe …) 里 —— 它把范围丢掉了');
      if (thin) return p;
      return { kind: 'PtrThin', ptr: p, type: tptrType(p.type.target) };
    }
    if (h === 'pfield') {
      if (p.type.target.k !== 'struct') {
        return this.err(n, `(pfield p 字段名) 的 p 要是结构体指针，这里是 ${coreTypeText(p.type)}`);
      }
      const fn = isAtom(n.items[2]) ? n.items[2].value : null;
      const lay = structLayout(p.type.target);
      const fld = fn === null || lay === null ? undefined : lay.fields.find((f) => f.name === fn);
      if (fld === undefined) {
        return this.err(n, `结构体 ${p.type.target.name} 没有字段 '${fn}'`);
      }
      const rt = thin ? tptrType(fld.type) : ptrType(fld.type);
      return { kind: 'PtrField', ptr: p, off: fld.off, size: sizeOf(fld.type), type: rt };
    }
    if (h === 'padd') {
      const k = this.expr(n.items[2]);
      if (k === null) return null;
      if (k.type !== INT) return this.err(n, `padd 的步数要是 int，这里是 ${coreTypeText(k.type)}`);
      return { kind: 'PtrAdd', ptr: p, delta: k, size: sizeOf(p.type.target), type: p.type };
    }
    // psub / peq —— 都要第二个指针
    const q = this.expr(n.items[2]);
    if (q === null) return null;
    if (q.type.k !== p.type.k || typeKey(q.type) !== typeKey(p.type)) {
      return this.err(n, `${h} 的两个指针要同型：左是 ${coreTypeText(p.type)}，`
        + `右是 ${coreTypeText(q.type)}`);
    }
    // `peq` 不查块：**跨块比相等是有定义的**（答案是"不等"），而 psub 跨块是错误
    // （C 那边的指针差在不同块之间就是未定义行为，这一层把它变成一句报错）。
    if (h === 'peq') return { kind: 'PtrEq', a: p, b: q, type: BOOL };
    return { kind: 'PtrSub', a: p, b: q, size: sizeOf(p.type.target), type: INT };
  }

  /**
   * 数组的四条读侧（写侧是语句 `aset` / `apush`）。
   *
   *   (anew (arr T) N)   新建长度 N 的零数组
   *   (aget a i)         读第 i 个
   *   (alen a)           当前长度（会变，所以每次都问）
   *   (apop a)           摘掉并返回最后一个；空数组是运行期错误
   *
   * 越界与空 pop 都是**运行期错误**，消息在运行时里只有一份（omni_arr.c），
   * 五条腿共用同一个字符串 —— buf 那边是逐形状生成的 C + 另写一份 IR 助手，
   * 那是两份实现，这次不重复那个决定。
   *
   * 刻意**没有**的东西：负下标（asy 也没有）、切片、`==`、print。切片要新建数组，
   * 那是一条独立的语义（拷贝还是视图？），留给需要它的那一刀去定。
   */
  arrExpr(n, h) {
    if (h === 'anew') {
      const t = this.ty(n.items[1], 'anew 的类型');
      if (t === null) return null;
      if (t.k !== 'arr') return this.err(n, '(anew TYPE N) 的 TYPE 要是 (arr T)');
      const c = this.expr(n.items[2]);
      if (c === null) return null;
      if (c.type !== INT) return this.err(n, `anew 的长度要是 int，这里是 ${coreTypeText(c.type)}`);
      // 元素是数组时，格子的零值是**空引用**而不是空数组（多维数组那一刀）：`zero` 是一个
      // **求过一次**的操作数，运行时把那一份复制 N 遍，所以零值必须是"复制了也不共享"的
      // 东西。空数组共享 —— 那会让 `a[0]` 上 push 一格之后 `a[1]` 也长一格（静默的错答案）。
      // 空引用没有这个问题，而且与 asy 对得上：`new real[3][]` 的行是 null，
      // `a[0][0]` 在真 asy 那边就是运行期错误。要行就自己 `(aset a i (anew (arr T) M))`。
      const zero = t.elem.k === 'arr'
        ? { kind: 'NullRef', type: t.elem }
        : zeroValue(t.elem);
      return { kind: 'ArrNew', type: t, count: c, zero };
    }
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    if (a.type.k !== 'arr') return this.err(n, `${h} 的实参要是数组，这里是 ${coreTypeText(a.type)}`);
    if (h === 'alen') return { kind: 'ArrLen', arr: a, type: INT };
    if (h === 'apop') return { kind: 'ArrPop', arr: a, type: a.type.elem };
    const i = this.expr(n.items[2]);
    if (i === null) return null;
    if (i.type !== INT) return this.err(n, `aget 的下标要是 int，这里是 ${coreTypeText(i.type)}`);
    return { kind: 'ArrGet', arr: a, index: i, type: a.type.elem };
  }

  /**
   * 向量的四条（ADR-0014 门槛 6 第一阶段）。刻意只有这四条 —— 比较、select、shuffle、
   * 从容器加载都还没有，因为每一条都要在六个执行器上各实现一次，而它们的答案要逐位相同。
   *
   *   (splat TYPE E)     标量铺满所有道
   *   (vlit TYPE E...)   逐道给值，个数必须等于宽度
   *   (lane E N)         取第 N 道（N 是字面量，不是表达式 —— 变量下标要边界检查，
   *                      而那会给两条腿各引入一条错误路径，下一阶段再说）
   *   (hsum E)           水平求和。**求值顺序写死成严格左到右**：((v0+v1)+v2)+v3。
   *                      浮点加法不结合，这一条就是门槛 6 里「固定求值顺序」的落点 ——
   *                      两条腿必须发同一棵树，而不是各自挑一个规约形状。
   */
  vecExpr(n, h) {
    if (h === 'lane') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type.k !== 'vec') return this.err(n, `lane 的实参要是向量，这里是 ${v.type.k}`);
      const i = isAtom(n.items[2]) ? Number(n.items[2].value) : NaN;
      if (!Number.isInteger(i) || i < 0 || i >= v.type.lanes) {
        return this.err(n, `(lane v N) 的 N 要是 0..${v.type.lanes - 1} 的字面量`);
      }
      return { kind: 'VecLane', vec: v, lane: i, type: v.type.elem };
    }
    if (h === 'hsum') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type.k !== 'vec') return this.err(n, `hsum 的实参要是向量，这里是 ${v.type.k}`);
      return { kind: 'VecHsum', vec: v, type: v.type.elem };
    }
    const t = this.ty(n.items[1], h === 'splat' ? 'splat 的类型' : 'vlit 的类型');
    if (t === null) return null;
    if (t.k !== 'vec') return this.err(n, `(${h} TYPE ...) 的 TYPE 要是 (vec T N)`);
    if (h === 'splat') {
      const v = this.expr(n.items[2]);
      if (v === null) return null;
      if (!sameCoreType(v.type, t.elem)) {
        return this.err(n, `splat 的值要是 ${t.elem.k}，这里是 ${v.type.k}`);
      }
      return { kind: 'VecSplat', value: v, type: t };
    }
    const lanes = [];
    for (const a of n.items.slice(2)) {
      const v = this.expr(a);
      if (v === null) return null;
      if (!sameCoreType(v.type, t.elem)) {
        return this.err(a, `vlit 的每一道要是 ${t.elem.k}，这里是 ${v.type.k}`);
      }
      lanes.push(v);
    }
    if (lanes.length !== t.lanes) {
      return this.err(n, `vlit 要 ${t.lanes} 个值，给了 ${lanes.length} 个`);
    }
    return { kind: 'VecLit', lanes: lanes, type: t };
  }

  /** `(bin "OP" a b)` / `(un "OP" a)`。算符写成字符串，所以映射模板里可以直接 `(bin $2 $1 $3)`。 */
  operator(n, h) {
    if (h === 'un') {
      const op = isStr(n.items[1]) ? n.items[1].value : null;
      const a = this.expr(n.items[2]);
      if (op === null || a === null) return op === null ? this.err(n, '(un "OP" 值)') : null;
      if (op === '-') {
        if (a.type !== INT && a.type !== REAL) return this.err(n, `一元 - 要 int 或 real，这里是 ${a.type.k}`);
        return { kind: 'Un', op: '-', operand: a, type: a.type };
      }
      if (op === '!') {
        if (a.type !== BOOL) return this.err(n, `! 要 bool，这里是 ${a.type.k}`);
        return { kind: 'Un', op: '!', operand: a, type: BOOL };
      }
      return this.err(n, `不认识的一元算符 '${op}'`);
    }
    if (h !== 'bin') return this.err(n, `不认识的表达式 '${h}'`);
    const op = isStr(n.items[1]) ? n.items[1].value : null;
    if (op === null) return this.err(n, '(bin "OP" 左 右)：算符要写成字符串');
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    if (!sameCoreType(a.type, b.type)) return this.err(n, `'${op}' 两边要同型：左是 ${coreTypeText(a.type)}，右是 ${coreTypeText(b.type)}`);
    // 向量：只有逐元素的四则运算。比较要出 vec<bool,N>（掩码类型），select 要三目 ——
    // 两条都得先在六个执行器上定好语义，第一阶段不做，所以在这里挡住而不是给错答案。
    if (a.type.k === 'vec') {
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') {
        return this.err(n, `向量上第一阶段只有 + - * /，不能用 '${op}'`);
      }
      return { kind: 'Bin', op: op, opType: a.type, left: a, right: b, type: a.type };
    }
    if (LOGIC.has(op)) {
      if (a.type !== BOOL) return this.err(n, `'${op}' 要 bool，这里是 ${a.type.k}`);
      return { kind: 'Logic', op: op, left: a, right: b, type: BOOL };
    }
    // 无符号那七个（第六十一刀）：只对 int 成立 —— real 上没有"无符号"这回事，
    // string / bool 更没有。挡在这儿而不是让后端各报一句。
    if (UARITH.has(op) || UCOMPARE.has(op)) {
      if (a.type !== INT) {
        return this.err(n, `'${op}' 是无符号那一版，只对 int 成立，这里是 ${coreTypeText(a.type)}`);
      }
      if (UCOMPARE.has(op)) return { kind: 'Cmp', op: op, opType: a.type, left: a, right: b, type: BOOL };
      return { kind: 'Bin', op: op, opType: a.type, left: a, right: b, type: a.type };
    }
    if (COMPARE.has(op)) {
      return { kind: 'Cmp', op: op, opType: a.type, left: a, right: b, type: BOOL };
    }
    if (!ARITH.has(op)) return this.err(n, `不认识的二元算符 '${op}'`);
    if (a.type === STRING && op !== '+') return this.err(n, `string 上只有 '+'（拼接），不能用 '${op}'`);
    if (a.type === BOOL) return this.err(n, `'${op}' 不能作用在 bool 上`);
    if (a.type === REAL && (op === '%' || op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>')) {
      return this.err(n, `'${op}' 只对 int 成立，这里是 real`);
    }
    return { kind: 'Bin', op: op, opType: a.type, left: a, right: b, type: a.type };
  }

  intLit(n) {
    const s = isAtom(n.items[1]) ? n.items[1].value : null;
    if (s === null || !/^[+-]?[0-9]+$/.test(s)) return this.err(n, '(int 十进制整数)');
    return { kind: 'Const', type: INT, value: BigInt(s) };
  }

  realLit(n) {
    const s = isAtom(n.items[1]) ? n.items[1].value : null;
    if (s === null || !/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) {
      return this.err(n, '(real 十进制小数)');
    }
    return { kind: 'Const', type: REAL, value: Number(s) };
  }
}

/**
 * OIR 类型相等。标量比一个 `k` 就够；向量还要比元素与宽度，
 * 否则 vec<int,4> 与 vec<real,8> 会被当成同一个类型（两者的 `k` 都是 'vec'）。
 * 名字带 Core 不是啰嗦：自举构建把所有模块拍平，模块级名字必须全仓唯一，
 * 而 `hir/types.js` 里已经有一个 `same` —— 撞了只在自举链上报，node 上照跑。
 */
function sameCoreType(a, b) {
  if (a.k !== b.k) return false;
  if (a.k === 'vec') return sameCoreType(a.elem, b.elem) && a.lanes === b.lanes;
  if (a.k === 'buf') return sameCoreType(a.elem, b.elem);
  // 结构体与类按**名字**认（标称类型，不是结构类型）：字段一样的两个结构体是两个类型，
  // 与 hir/check.js 的 typeKey（`S<名字>` / `C<名字>`）同一条规矩。
  if (a.k === 'struct' || a.k === 'class') return a.name === b.name;
  // 递归而不是比 `elem.k`：`(arr (vec real 2))` 与 `(arr (vec int 4))` 的 elem.k 都是 'vec'
  if (a.k === 'arr') return sameCoreType(a.elem, b.elem);
  // 指针同理，而且 fat 与 thin 是**两个类型**（`a.k !== b.k` 上面已经挡了）
  if (a.k === 'ptr' || a.k === 'tptr') return sameCoreType(a.target, b.target);
  // 定长内存（第十八刀）：元素同型、格数相同才算一个类型 —— `int(*)[3]` 与 `int(*)[4]`
  // 是两个类型（`padd` 一步跨的字节数不同）。
  if (a.k === 'blk') return a.n === b.n && sameCoreType(a.el, b.el);
  // 函数值按**签名**认（结构类型）：形参逐个同型、返回同型才算一个类型。
  if (a.k === 'fn') {
    if (a.params.length !== b.params.length) return false;
    let i = 0;
    while (i < a.params.length) {
      if (!sameCoreType(a.params[i], b.params[i])) return false;
      i++;
    }
    return sameCoreType(a.ret, b.ret);
  }
  return true;
}

/**
 * 诊断里的类型拼写。标量就是 `k`，向量要连元素和宽度一起说 ——
 * 否则「左是 vec，右是 vec」这种消息等于没说（vec<int,2> 和 vec<real,4> 的 `k` 都是 vec）。
 * 同理递归：`arr<vec<real,2>>` 印成 `arr<vec>` 也是等于没说。
 */
function coreTypeText(t) {
  if (t.k === 'vec') return `vec<${coreTypeText(t.elem)},${t.lanes}>`;
  if (t.k === 'buf') return `buf<${coreTypeText(t.elem)}>`;
  if (t.k === 'arr') return `arr<${coreTypeText(t.elem)}>`;
  if (t.k === 'ptr') return `${coreTypeText(t.target)}*`;
  if (t.k === 'tptr') return `${coreTypeText(t.target)} thin*`;
  if (t.k === 'blk') return `${coreTypeText(t.el)}[${t.n}]`;
  if (t.k === 'struct' || t.k === 'class') return t.name;
  if (t.k === 'fn') {
    let ps = '';
    for (const p of t.params) ps = ps === '' ? coreTypeText(p) : `${ps},${coreTypeText(p)}`;
    return `fn<(${ps})->${coreTypeText(t.ret)}>`;
  }
  return t.k;
}

/**
 * 核心方言的源文本 -> OIR。`.sx` 文件走这条，`omni glr` 的输出也走这条 ——
 * 后者才是重点：语法文件的映射模板拼出这份方言，中间没有为那门语言写的一行代码。
 */
export function lowerCoreSexpr(file, diags, entry) {
  const nodes = readSexpr(file, diags);
  if (diags.hasErrors()) return null;
  // 入口名默认是 `omni_main`（整个程序）。一个库文件编成一份自己的产物时给它自己的名字
  // （`omni_init_plain` 之类）：那一份的 `(main …)` 就是这个库的初始化函数。
  return new CoreLowerer(diags).chunk(nodes, entry === undefined ? 'omni_main' : entry);
}

/**
 * REPL 的 `:js` / `:c`：把整个会话当**一个程序**降一遍。
 * 与 lowerCoreSexpr 的差别只有一条 —— 交互式输入是松散的形式，壳子（`(module …)` 与
 * `(main …)`）由 coreWrap 补，所以这里不能要求源文本自己写全。
 */
export function lowerCoreSession(text, diags) {
  const nodes = readSexpr(new SourceFile('<repl>', text), diags);
  if (diags.hasErrors()) return null;
  return new CoreLowerer(diags).chunk(coreWrap(nodes), 'omni_main');
}

/**
 * 核心方言的**增量**会话（REPL）。
 *
 * 这一层是所有语法驱动前端共用的 REPL 后半段：一门语言只要能把一批输入印成核心方言，
 * 它的 REPL 就有了 —— 增量、回滚、跨批可见性都在这里，不在那门语言里。
 * `omni` 那条腿走的是 hir/check.js 的 CheckSession，形状一样（add -> delta）。
 */
export class CoreSession {
  constructor() {
    this.lw = new CoreLowerer(null);
    this.no = 0;
    this.lastChecked = 0;
  }

  /** 失败要能回到上一批成功的样子：这一层的改动都是"往表里加"，复原容器就够 */
  snapshot() {
    const l = this.lw;
    return {
      funcs: new Map(l.funcs), kernels: new Map(l.kernels), globals: new Map(l.globals),
      structs: new Map(l.structs), classes: new Map(l.classes), tmpNo: l.tmpNo, no: this.no,
      topScope: l.topScope,
      vars: l.topScope === null ? null : new Map(l.topScope[0]),
    };
  }

  restore(s) {
    const l = this.lw;
    l.funcs = s.funcs;
    l.kernels = s.kernels;
    l.globals = s.globals;
    l.structs = s.structs;
    l.classes = s.classes;
    l.tmpNo = s.tmpNo;
    l.topScope = s.topScope;
    if (s.topScope !== null) s.topScope[0] = s.vars;
    this.no = s.no;
  }

  /**
   * 一批核心方言源文本 -> 这一批新增的 OIR（入口是 `omni_chunk_N`）。
   * REPL 里不必写 `(module …)`：顶层项照写，其余的形式自动进这一批的入口。
   */
  add(text, diags) {
    this.lw.diags = diags;
    const nodes = readSexpr(new SourceFile('<repl>', text), diags);
    if (diags.hasErrors()) return null;
    this.no = this.no + 1;
    const delta = this.lw.chunk(coreWrap(nodes), `omni_chunk_${this.no}`);
    this.lastChecked = delta === null ? 0 : delta.funcs.length;
    return delta;
  }
}

/** `(module …)` 里能出现的顶层项。REPL 的包装靠它区分"声明"与"语句"。 */
const CORE_DECLS = new Set(['struct', 'class', 'global', 'fn', 'kernel']);

/**
 * 松散的一批形式 -> 一个 `(module …)`：声明留在顶层，其余的收进 `(main …)`。
 * 交互式输入里 `(print (lit int 1))` 就该能直接跑，而不是逼人每次手打两层壳子。
 */
function coreWrap(nodes) {
  if (nodes.length === 1 && head(nodes[0]) === 'module') return nodes;
  const span = nodes.length === 0 ? null : nodes[0].span;
  const items = [{ kind: 'atom', value: 'module', span: span }];
  const stmts = [{ kind: 'atom', value: 'main', span: span }];
  for (const n of nodes) {
    const h = head(n);
    if (CORE_DECLS.has(h)) items.push(n);
    // 用户自己写的 `(main …)`：把里面的语句摊进这一批的入口，而不是变成第二个 main
    else if (h === 'main') for (const s of n.items.slice(1)) stmts.push(s);
    else stmts.push(n);
  }
  items.push({ kind: 'list', items: stmts, span: span });
  return [{ kind: 'list', items: items, span: span }];
}

