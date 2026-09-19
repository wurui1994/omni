// src/core/graph/prims.js —— **内建表：一格内建一行，效应写在行上**
//
// 这一份是"逐步减少冗余"的第一刀，删掉的是**节点级的重复**：
//
//   原来有三格干同一件事 —— `binop("+", a, b)`、`unop("-", a)`、`prim("+", [a, b])`。
//   按 ADR-0033 §2.3 那条判据（五栏逐格相同的两个东西是同一个节点），它们的差别只有一栏：
//   `binop` 声明 pure、`prim` 声明 reads+writes。而**那一栏本来就不该按节点分** ——
//   `+` 是 pure、`print` 不是，差别在**内建自己**身上，不在"用哪种语法写它"上。
//
//   于是：`binop` / `unop` 删掉，只留 `prim`，效应那一栏**从这张表里查**。
//   十门语言的算符与内建（go 的 19 格二元 + 7 格一元 + 23 格内建、chez 的 `pr`、
//   awk 的 builtin、freebasic 那一批语句）从此落到**同一格节点**。
//
// 第二刀在同一份里：**kernel 与 js 落法写在同一行上**。原来 `eval.js` 有一张
// `callPrim` 的 switch、`contract.js` 有一张 `JS_PRIM` 的模板表 —— 同一份知识两处抄。
// 加一格内建原来要改两处，现在改一行。

/** 一格内建：`arity`（-1 = 任意）· `effects`（空 = pure）· `kernel`（interp 用）· `js`（js 后端用）。 */
const P = (name, arity, effects, kernel, js) => [name, { name, arity, effects, kernel, js }];

const show = (v, showValue) => showValue(v);

/**
 * 位运算那六格（`band` / `bor` / `bxor` / `bnot` / `shl` / `shr`）。
 *
 * kernel 那一侧算在 **BigInt** 上再折回 Number（js 的位运算是 32 位的），
 * js 那一侧发出去的代码也一样 —— 两侧同一套算法，不许一侧 32 位一侧 64 位。
 */
const asI64 = (v) => BigInt(Math.trunc(Number(v)));
const shiftCount = (v) => {
  const n = Math.trunc(Number(v));
  if (!(n >= 0 && n <= 63)) throw new Error(`移位的位数要在 0..63，给的是 ${n}`);
  return BigInt(n);
};
/**
 * js 那一侧的移位位数检查：**发一格自带的箭头函数**，不新开运行期钩子。
 * （那张钩子表是契约的一部分 —— 为一格检查加第 16 格不值，而两侧的规矩必须一样。）
 */
const jsShift = (v) => `((__c) => { if (!(__c >= 0 && __c <= 63)) `
  + `throw new Error('移位的位数要在 0..63，给的是 ' + __c); return BigInt(__c); })(${v})`;
const bitPrims = () => [
  P('band', 2, [], (a) => Number(asI64(a[0]) & asI64(a[1])), (a) => `Number(BigInt(${a[0]}) & BigInt(${a[1]}))`),
  P('bor', 2, [], (a) => Number(asI64(a[0]) | asI64(a[1])), (a) => `Number(BigInt(${a[0]}) | BigInt(${a[1]}))`),
  P('bxor', 2, [], (a) => Number(asI64(a[0]) ^ asI64(a[1])), (a) => `Number(BigInt(${a[0]}) ^ BigInt(${a[1]}))`),
  P('bnot', 1, [], (a) => Number(~asI64(a[0])), (a) => `Number(~BigInt(${a[0]}))`),
  P('shl', 2, [], (a) => Number(asI64(a[0]) << shiftCount(a[1])), (a) => `Number(BigInt(${a[0]}) << ${jsShift(a[1])})`),
  P('shr', 2, [], (a) => Number(asI64(a[0]) >> shiftCount(a[1])), (a) => `Number(BigInt(${a[0]}) >> ${jsShift(a[1])})`),
];


export const PRIMS = new Map([
  // ---- 算术与比较：**pure**（效应六格全空 ⇒ 可重排、可共享、可删）------------
  P('+', -1, [], (a) => (a.length === 0 ? 0 : a.reduce((x, y) => x + y)), (a) => (a.length === 0 ? '0' : `(${a.join(' + ')})`)),
  P('-', -1, [], (a) => (a.length === 1 ? -a[0] : a.reduce((x, y) => x - y)), (a) => (a.length === 1 ? `(-${a[0]})` : `(${a.join(' - ')})`)),
  P('*', -1, [], (a) => (a.length === 0 ? 1 : a.reduce((x, y) => x * y)), (a) => (a.length === 0 ? '1' : `(${a.join(' * ')})`)),
  P('/', -1, [], (a) => a.reduce((x, y) => x / y), (a) => `(${a.join(' / ')})`),
  P('%', 2, [], (a) => a[0] % a[1], (a) => `(${a[0]} % ${a[1]})`),
  P('^', 2, [], (a) => a[0] ** a[1], (a) => `(${a[0]} ** ${a[1]})`),
  P('<', 2, [], (a) => a[0] < a[1], (a) => `(${a[0]} < ${a[1]})`),
  P('>', 2, [], (a) => a[0] > a[1], (a) => `(${a[0]} > ${a[1]})`),
  P('<=', 2, [], (a) => a[0] <= a[1], (a) => `(${a[0]} <= ${a[1]})`),
  P('>=', 2, [], (a) => a[0] >= a[1], (a) => `(${a[0]} >= ${a[1]})`),
  P('=', 2, [], (a) => a[0] === a[1], (a) => `(${a[0]} === ${a[1]})`),
  P('!=', 2, [], (a) => a[0] !== a[1], (a) => `(${a[0]} !== ${a[1]})`),
  // 真值观是**一格能力**（四家答案不同，见 eval.js 里那段）—— 这儿只给最保守的那一档
  P('not', 1, [], (a, io) => !io.truthy(a[0]), (a) => `(!__truthy(${a[0]}))`),
  P('concat', -1, [], (a, io) => a.map((v) => show(v, io.show)).join(''), (a) => `[${a.join(', ')}].map(__show).join('')`),
  P('len', 1, [], (a) => (a[0] === null || a[0] === undefined ? 0 : a[0].length), (a) => `(${a[0]} == null ? 0 : (${a[0]}).length)`),

  // ---- 位运算那六格：**pure**，只对整数 ------------------------------------------
  //
  // 账上算出来的一族（三门合起来 64 份印"这个算子还没接：`<<` / `&` / `|` / `^` / `shl`"）。
  // **名字不能用符号**：图上的 `^` 早就是**幂**（`P('^')` 就在上面几行），所以这六格用词 ——
  // 与 nim 写源码的那几个词一致（`and` / `or` / `xor` / `not` / `shl` / `shr` 的位运算义）。
  // go / V 的 `&` `|` `^` `~` `<<` `>>` 由各自的算符表映到这六个名字上。
  //
  // **算在 BigInt 上再折回 Number**：js 的 `&` / `<<` 是**32 位**的（`1 << 40` 会得 256），
  // 而这一层的整数按 64 位看（c 那侧是 `long long`、wat 那侧是 i64、方言那侧也是 64 位）。
  // BigInt 的位运算按无穷精度的二补数算，负数与 int64 的答案一致，折回 Number 在 ±2^53
  // 之内准确 —— 超出那一档是"这一层的整数就是 f64"那笔老账，不是这一刀新欠的。
  //
  // 移位的位数**必须在 0..63**：负数或过大在 go 里是 panic、在 wasm 里是取模，
  // 两种都不许静静地给个答案 —— 当场报。
  ...bitPrims(),

  // ---- 列表追加：**writes**（改的是那格列表本身）------------------------------
  //
  // **为什么是内建而不是节点**：两格实参都是普通的值（要追加的那格表、要追加的那个东西），
  // 没有"哪一格是什么角色"要分 —— 与 `len` 同一类，是**列表上的一个库函数**。
  // （`nodes.js` 文件头那一条：给库函数开节点等于给每门语言的每个库函数开节点。
  // 这也正是它与 `assert` 的差别 —— 那一格的消息是**自己的端口**，所以那一格才是节点。）
  //
  // 它是**账上算出来的**，而且那笔账原来记错了：`bench/tograph.js` 印的是
  // "这个算子还没接：`<<`"（V 那一栏 98 份），看着像位运算 —— 抽一遍语料才知道
  // V 自己的编译器里 `<<` **压倒性地是数组追加**（`nodes << x`、`lines << continued`），
  // 位移只有词法表里那几行。所以那 98 份要的是这一格，不是位运算那一刀。
  P('push', 2, ['writes'],
    (a) => {
      if (!Array.isArray(a[0])) throw new Error('push: 第一格不是列表');
      a[0].push(a[1]);
      return null;
    },
    /* 交出来的是 nil（与 interp 一侧同一个值 —— js 的 `push` 回的是新长度，要压掉）。 */
    (a) => `((${a[0]}).push(${a[1]}), null)`),

  // ---- 成员是不是在里头：**pure**（只读，不改）--------------------------------
  //
  // 与 `push` 同一类（列表上的一个库函数 -> **内建**，不是节点）。账上算出来的：
  // V 的 `x in arr` 20 份 + nim 的 `x in xs` 5 份 —— 那 25 份印的是"这个算子还没接：in"。
  //
  // **只接列表**（线性扫找元素）。两处刻意不接：
  //   * map 不走这一格 —— 那是 `map-has`（键在不在），图上早有那一格；
  //   * **串找子串也不走这一格** —— 头一版写了那一支，可**没有一份判据用得上它**
  //     （V 的 `in` 只对数组与 map 合法，串要 `.contains()`；nim 的 `x in s` 要 char，
  //     而 char 那一格还没接）。没有判据的代码不留 —— 要接就连它的判据一起来。
  P('contains', 2, [],
    (a) => {
      if (!Array.isArray(a[0])) throw new Error('contains: 第一格不是列表');
      return a[0].some((v) => v === a[1]);
    },
    (a) => `((${a[0]}).some((__v) => __v === (${a[1]})))`),

  // ---- 按长度造一格列表：**pure**（造一格新的，不改别人）--------------------------
  //
  // `make([]T, n)`（go）/ `[]T{len: n}`（V）—— 账上算出来的（go 那一栏 16 份）。
  // 与 `push` / `contains` 同一类：**列表上的一个库函数 -> 内建**，不是节点。
  //
  // 两格实参都是普通的值：**长度**与**每一格的初值**。初值是**元素类型的零值**，由映射
  // 那一层算（`zeroOf` 早就有那一格）—— 这一格只管"造 n 格，每格都是它"。
  //
  // **初值是一格聚合时不许共享**：js 的 `Array(n).fill(obj)` 是 n 格指向同一格对象，
  // 而 go 的 `make([]T, n)` 给的是 n 格各自的零值。这一格只接**标量初值**（数 / 串 /
  // bool / nil）—— 具名结构体的零值在映射那一层本来就当场报（`vardecl` 那一刀定的），
  // 所以这条约束在两边是对上的。
  P('fill', 2, [],
    (a) => {
      const n = Math.trunc(Number(a[0]));
      if (!(n >= 0)) throw new Error(`fill: 长度要 >= 0，给的是 ${a[0]}`);
      if (a[1] !== null && typeof a[1] === 'object') throw new Error('fill: 初值是一格聚合 —— 那样 n 格会指向同一格');
      return new Array(n).fill(a[1]);
    },
    (a) => `new Array(Math.trunc(Number(${a[0]}))).fill(${a[1]})`),

  // ---- 外部 IO：**writes**。`print` 就在这儿 —— 它不是节点（见 nodes.js 文件头）----
  P('print', -1, ['writes'],
    (a, io) => { io.out.push(a.map((v) => show(v, io.show)).join(' ')); return null; },
    (a) => `__out.push([${a.join(', ')}].map(__show).join(' '))`),
]);

/** 一格内建的声明。不认识的当场报 —— 与节点那一侧同一条纪律（不留"以后再接"）。 */
export function primOf(name) {
  const p = PRIMS.get(name);
  if (p === undefined) throw new Error(`no such primitive: ${name}`);
  return p;
}

/** 这格内建纯不纯 —— `prim` 节点的效应那一栏由它答（不是由节点名答）。 */
export const primEffects = (name) => (PRIMS.has(name) ? PRIMS.get(name).effects : ['reads', 'writes']);
