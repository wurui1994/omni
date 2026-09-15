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
  P('len', 1, [], (a) => (a[0] === null || a[0] === undefined ? 0 : a[0].length), (a) => `(${a[0]}).length`),

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
