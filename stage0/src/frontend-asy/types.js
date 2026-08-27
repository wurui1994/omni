// Omni stage0 — asy 前端的**类型层**：类型在这一层就是字符串，这个文件是那些字符串的全部规矩
//
// 从 lower.js 里搬出来的（那个文件 5400 行，标准是「lower.js 至多是一个薄入口」）。
// 这一刀只搬**模块级**的表与纯函数：它们一个都不碰 AsyLower 的状态（没有 `this`），
// 所以搬家是纯粹的位置变动，行为上一个字节都不该变 —— 这也是先搬这一半的理由，
// 那 4400 行的类体要拆得靠跨文件的 extends 或 mixin，两条在自举那条路上都没有先例。
//
// 名字一个都没改：封闭 ABI 要求模块级名字全仓唯一（ADR-0011/0014），改名等于换 ABI。

import { isStr, isAtom } from '../sexpr/read.js';

/** 所有「这一刀还没做」的报错都带上这句 —— 测试轴按它判「拒得对不对」 */
export const ASY_NOPE = 'asy 前端第一刀还不支持';

export const SCALARS = new Set(['int', 'real', 'bool', 'string']);

/** dotQual 的第三种答案："是带点的名字，但接收者那一层已经报过错了" */
export const DOT_BAD = { bad: true };

/** capOf 的第三种答案："这个名字确实是外层的局部量，但这一刀捕获不了它（诊断已经发了）" */
export const CAP_BAD = { bad: true };

/** 零字段 struct 的占位字段名（核心方言的 class 至少要一个字段，见 recordBody 那一段） */
export const ASY_FILLER = 'asy__filler';

/** 模块相关的顶层声明（第二十五刀）。认得的是前三条，后面几条在 modStmt 里报"还没做" */
export const ASY_MODSTM = new Set(['import', 'access', 'from-access', 'unravel', 'include',
  'template-access', 'receive-typedef']);

/** 能当数组元素的**内建**类型。pair 是第八刀加的（核心方言的 `(arr T)` 现在收向量元素）；
 *  记录（struct）是第十九刀加的，但它不在这个表里 —— 记录是逐文件声明的，问 isRec。
 *  数组也不在里面 —— 多维数组那一刀问的是 arrElemOk（它对元素递归）。 */
export const ASY_ARRELEM = new Set(['int', 'real', 'bool', 'string', 'pair', 'triple']);

/** 数组元素这一刀收的东西写成一句话，四处报错共用（免得四处各写一遍走样） */
export const ASY_ARRELEM_TEXT = '数组元素这一刀只有 int/real/bool/string/pair/triple、struct 与它们的数组';

/**
 * 实参类型 -> 形参类型要走几次隐式转换：0 = 同型，1 = 一次转换，-1 = 不行。
 * 表就是 asy 的那三条（int->real、int/real->pair，见 coerce）。重载解析按这个打分：
 * 同型优先，两个候选各要一次转换就是歧义（量过 asy 也报 ambiguous）。
 * 名字带 asy 前缀是封闭 ABI 的要求：模块级名字全仓唯一。
 */
export function asyConvCost(from, to) {
  if (from === to) return 0;
  if (from === 'int' && to === 'real') return 1;
  if (to === 'pair' && (from === 'int' || from === 'real')) return 1;
  return -1;
}


/** 算符文本。语法模板里有两种写法：`(bin "+" …)` 给的是字符串节点，
 *  `(self $2 $1 $3)` 直接把 SELFOP **词法 token**（原子）搬过来。两种都要认。
 *  名字带 asy 前缀是封闭 ABI 的要求：模块级的名字全局唯一（mir/print.js 已有一个 opText）。 */
export const asyOpText = (n) => (isStr(n) || isAtom(n) ? n.value : null);

/**
 * 能重载的算符 -> 生成的函数名片段（第二十三刀）。`V operator +(V,V)` 降成一个普通函数
 * `asy__op_add`，重载解析那一套（第十一刀）因此白捡 —— asy 里算符本来就是"名字叫
 * `operator +` 的函数"，量过它跟普通重载在同一张候选表里：用户写了
 * `int operator +(int,int) { return a*b; }` 之后 `2 + 3` 印的是 **6**。
 *
 * 表外分两类，诊断也分两类：
 *  - `ASY_OPBAD` 里的 **asy 自己就不收**（量过 `bool operator &&(V,V)` 那行 asy 报
 *    `2.16: syntax error:` 并 exit 1 —— camp.y 的 operator 产生式里没有这两个 token）。
 *    这种是普通错误，不带 ASY_NOPE：不是我们还没做。
 *  - 其余（`cast`、`::`、`..`、`[]`、`&`、`|`、`**` …，量过 asy 全都**收**）是我们还没做，
 *    报 ASY_NOPE。`cast` 尤其不是形态问题，它会改重载解析的打分，见 bad/op-cast.asy。
 */
export const ASY_OPSYM = new Map([
  ['+', 'add'], ['-', 'sub'], ['*', 'mul'], ['/', 'div'], ['#', 'quot'], ['%', 'mod'],
  ['^', 'pow'], ['==', 'eq'], ['!=', 'ne'], ['<', 'lt'], ['<=', 'le'], ['>', 'gt'],
  ['>=', 'ge'], ['!', 'not'], ['--', 'seg'], ['^^', 'cat'],
]);

/** asy 的语法本身就拒的算符名（量过）。见 strict/op-logic.asy。 */
export const ASY_OPBAD = new Set(['&&', '||']);

/** `cycle` 那个字面量落到哪个名字上（见 lit）：绘图层 stage0/lib/asy/plain.asy 里
 *  的 `path cyclepath;`。前端与绘图层之间**只有这一个**约定的名字。 */
export const ASY_CYCLE = 'cyclepath';

/** 文件级变量收得下的类型（第三十刀放开）：int/real/bool/string、pair/triple、
 *  记录，以及它们的一维数组。核心方言的 `(global …)` 原先只收标量，理由写的是
 *  「聚合的身份不在 MIR 的 8 位类型码里」—— 量下来那个身份**根本不需要**：class 与
 *  数组在四条腿上都是一个指针（LLVM 的 T_AGG/T_ARR 都是 `ptr`），字段与元素的身份
 *  是从表达式的 OIR 类型来的。绘图层要 currentpicture/defaultpen 这种模块级单件，
 *  所以这一条是那一刀的前置。判定在 globalNames 里（要看 this.records）。 */


/** 数组类型在这一层就是「元素名 + []」的字符串（`'real[]'`），核心方言那边是 `(arr real)`。
 *  用字符串是因为这个文件里所有类型都是字符串，Map 查表与 `===` 比较都现成 ——
 *  为数组另造一个对象型会把每处比较都改成函数调用。名字带 asy 前缀：模块级名字全仓唯一。 */
export const asyIsArr = (t) => t !== null && t !== undefined && t.endsWith('[]');
export const asyElem = (t) => t.slice(0, -2);

/** 类型名 -> 能当标识符片段的名字（`real[]` -> `arr_real`）。数组 helper 的名字要用它 ——
 *  `asy__grow_real[]` 不是一个标识符。递归，所以 `real[][]` 是 `arr_arr_real`。 */
export const asyMangle = (t) => (asyIsArr(t) ? `arr_${asyMangle(asyElem(t))}` : t);

/**
 * 函数类型在这一层也是字符串，拼法照 asy 自己的：`real(real)`、`void(int,string)`。
 * 量出来的理由：真 base 在场时 304 个 examples 里 203 个第一个撞的就是
 * `math.asy:446` 的 `real findroot(real f(real), …)` —— 函数类型的形参。
 *
 * 用 asy 的拼法而不是另造一个（`fn<real|real>` 之类）是为了诊断：报错里印的类型
 * 就是用户写的那几个字。代价是**返回类型自己是函数类型**时这个拼法有歧义
 * （`real(real)(int)` 的第一对括号分不清是谁的），所以那一种在 asyFnSplit 里认不出来、
 * 由调用方报"还没做" —— 认不出比猜错好。
 */
export const asyIsFn = (t) => t !== null && t !== undefined && t.length > 2 && t.endsWith(')');

/** `real(int,string)` -> `{ ret: 'real', params: ['int','string'] }`；认不出给 null。 */
export function asyFnSplit(t) {
  let i = 0;
  while (i < t.length && t.charAt(i) !== '(') i++;
  if (i === 0 || i >= t.length) return null;
  // 那个 '(' 必须与**最后一个字符**配对，否则就是 `real(real)(int)` 那种歧义拼法
  let d = 0;
  let k = i;
  while (k < t.length) {
    const c = t.charAt(k);
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) break; }
    k++;
  }
  if (k !== t.length - 1) return null;
  const inner = t.slice(i + 1, t.length - 1);
  const params = [];
  if (inner !== '') {
    let cur = '';
    let j = 0;
    d = 0;
    while (j < inner.length) {
      const c = inner.charAt(j);
      if (c === '(') d++;
      else if (c === ')') d--;
      if (c === ',' && d === 0) { params.push(cur); cur = ''; } else cur = `${cur}${c}`;
      j++;
    }
    params.push(cur);
  }
  return { ret: t.slice(0, i), params: params };
}

/**
 * pair 就是核心方言的 `(vec real 2)`：第 0 道是 x，第 1 道是 y。
 *
 * 为什么不给核心方言加一条 `pair` 类型：`+` 和 `-` 在 pair 上就是**逐分量**的，
 * 而向量的 `+ -` 已经是逐道的；`(vlit …)`、`(lane …)` 正好是"造一个"和"取一个分量"。
 * 剩下的复数 `*`、`/`、`abs`、`==` 和 `(x,y)` 的印法都是 **asy 的语义**，不是"向量"的
 * 语义 —— 那几条落在这一层的 helper 里，六条腿共用同一份，不会分叉。
 *
 * 代价写在明处：`?:` 的两支是 pair 时靠 ZERO 里那个零向量占位。
 * `pair[]` 第八刀通了：核心方言的 `(arr T)` 现在收 `(vec T N)` 元素，运行时那一份
 * 按字节的实现管长度与增长，元素的读写由每条腿自己发（见 omni_arr.c 尾部）。
 */
export const ASY_PAIR_TY = '(vec real 2)';
/**
 * triple 是 `(vec real 4)`，**第 3 道空着**。为什么不是 `(vec real 3)`：MIR 的类型码
 * 把向量宽度存成**对数**（`mir/ir.js` 的高 3 位），3 在那里根本编不出来 —— 放开它是
 * 重画类型码，牵动 MIR + 三个后端 + SPIR-V。而硬件本来就把 vec3 垫成 vec4
 * （SIMD 寄存器、GPU 的 vec3 对齐都是 16 字节），所以垫一道不是将就，是常规做法。
 * 代价写在明处：每个 triple 占 32 字节而不是 24；第 3 道**永远不参与语义** ——
 * 所有 helper 都是逐道写死的，`==` 只比前三道，印的时候也只印前三道。
 */
export const ASY_TRIPLE_TY = '(vec real 4)';
export const asyCore = (t) => {
  if (asyIsArr(t)) return `(arr ${asyCore(asyElem(t))})`;
  if (asyIsFn(t)) {
    const s = asyFnSplit(t);
    let ps = '';
    for (const p of s.params) ps = ps === '' ? asyCore(p) : `${ps} ${asyCore(p)}`;
    return `(fnty (${ps}) ${asyCore(s.ret)})`;
  }
  if (t === 'pair') return ASY_PAIR_TY;
  return t === 'triple' ? ASY_TRIPLE_TY : t;
};

/**
 * asy 的内建实数函数是一张**数据表**（`frontend-asy/builtins.tab`），不是这里的代码 ——
 * asy 自己也是这么组织的（builtin.cc 里 `addRealFunc(sin,SYM(sin))` 那一段就是一张
 * 名字->实现的表）。这个函数只负责把那张表读成 Map；实现分两种：
 *   rmath = 核心方言白名单里的 `(rmath …)`（转手宿主的数学库：C 是 libm、JS 是 Math.*）；
 *   nope  = 还没做。
 * 表由驱动（cli.js）读进来 —— 文件 IO 不在降级器里，跟语法表、模块一个路子。
 */
export function parseAsyBuiltins(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const cols = [];
    for (const c of line.split(' ')) if (c !== '') cols.push(c);
    if (cols.length !== 5) continue;
    out.set(cols[0], {
      arity: Number(cols[1]), ret: cols[2], kind: cols[3],
      fn: cols[3] === 'rmath' ? cols[4] : undefined,
    });
  }
  return out;
}
