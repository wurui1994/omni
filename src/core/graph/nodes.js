// src/core/graph/nodes.js —— **第一批节点的五栏声明**（ADR-0033 §3.2 的那五栏）
//
// 十份 `ext/*/SPEC.md` 写完之后，"需要多少节点"有了量出来的答案
// （`docs/design/node-graph-contract.md` 附录 A.6：骨架 26 格）。这一份先落**第一批**：
// 够跑通一门语言"含全部基础要素的完整例子"的最小集，13 格。
//
// ## 先说清哪几样**不给节点**（这是这一份最要紧的内容，四条全有出处）
//
//   * **type 不是节点。** 它是端口的 `sort`（一栏声明），不是图上的一个格子。
//     出处：chez 的 `Lsrc` 里没有类型层（`Ltype` 只在 `foreign` 那两格出现）、
//     awk / lua 连类型概念都没有、go 允许匿名 struct。
//     ——"删掉一个类型 class 崩不崩"这问题在图上根本不成立（附录 A 三处证据）。
//   * **stmt 不是节点。** "按次序发生"是 `effect` 边（ADR-0033 §3.3），不是一格算子。
//     出处：chez 的 `Lsrc` 有 `seq`、CL 有 `progn`、V 有 SemicolonStmt —— 三家都需要它，
//     是因为项（term）表达不了次序；我们有边，所以 G2 明文禁止手写 `seq`。
//   * **expr / decl 不各占一格。** `expr` 是一批节点的 sort；`decl` 就是 `bind`
//     （名字 + 一格初值 + 一格 region）。出处：sbcl 的 `let` 一族、go 的 `OAS*` 八格塌成一格。
//   * **`print` 不是节点。** 它是 `prim`（内建）的一格 —— 与 chez 的 `pr`、go 的 23 格内建、
//     awk / freebasic 那一大批自带词序的语句同一格。给 print 开节点等于给每门语言的
//     每个库函数开节点。
//
// ## 五栏怎么读
//
//   sort      expr / stat / decl —— 它属于哪一类（ADR-0029 那张位置矩阵的行）
//   ins       入端口：名字 × 求值语义。`value` 要值、`lazy` 可能不算、`name` 只要名字、
//             `body` 是一块子图（也是 lazy 的一种，单列是为了让调度器看得见 region）
//   outs      出端口。**多出端口是常态**：值一格、错误一格（V 的 `?T`/`!T`）、续延一格
//   effects   reads · writes · allocates · may-early-exit · suspends · unordered ·
//             synchronizes（第七格见 ADR-0035）。**六格全空 = pure**
//   lifetime  出端口的归属：owns / borrows(k) / static / managed / untracked（ADR-0036）

import { primEffects } from './prims.js';

/** 求值语义（入端口那一栏的取值）。 */
export const SEM = { value: 'value', lazy: 'lazy', name: 'name', body: 'body' };

const N = (op, sort, ins, opts = {}) => [op, {
  op,
  sort,
  ins,
  outs: opts.outs ?? ['value'],
  effects: opts.effects ?? [],
  lifetime: opts.lifetime ?? 'static',
  attrs: opts.attrs ?? [],
  doc: opts.doc ?? '',
}];

/**
 * 第一批：**11 格**（原来 13 格 —— `binop` / `unop` 并进了 `prim`，见那一段注释）。
 * 每一格后面那句话是它的**出处**（哪几门语言的规格要求它），
 * 判据是 `omni nodes --source`：没有出处的节点不许存在。
 */
export const NODES = new Map([
  // ---- 值与名字（4 格）--------------------------------------------------------
  N('const', 'expr', [], { attrs: ['value'], doc: 'chez quote / go OLITERAL / 十门全有' }),
  N('ref', 'expr', [], { attrs: ['name'], effects: ['reads'], doc: 'chez ref / sbcl ref' }),
  N('bind', 'decl', [{ name: 'init', sem: SEM.value }], {
    attrs: ['name'], effects: ['writes'], lifetime: 'owns', outs: [],
    doc: 'decl 就是这一格：sbcl let / go OAS / lua local / nim let',
  }),
  N('set', 'stat', [{ name: 'value', sem: SEM.value }], {
    attrs: ['name'], effects: ['writes'], outs: [],
    doc: 'chez set! / sbcl cset / go OAS',
  }),

  // ---- 算子与调用（2 格）------------------------------------------------------
  // **算符没有自己的节点**：`a + b` 与 `(+ a b)` 落的是同一格 `prim`。
  // 原来这儿有 `binop` / `unop` 两格，与 `prim` 的差别只有效应那一栏（前者声明 pure、
  // 后者声明 reads+writes）—— 而那一栏本来就该按**内建自己**分，不按"用哪种语法写它"分。
  // 于是两格删掉，效应从 `prims.js` 那张表查（`+` pure、`print` writes）。
  // 十门语言的算符与内建从此是同一格：go 的 19 格二元 + 7 格一元 + 23 格内建、
  // chez 的 `pr`、awk 的 builtin、freebasic 那一批自带词序的语句，全落这儿。
  N('call', 'expr', [{ name: 'fn', sem: SEM.value }, { name: 'args', sem: SEM.value, rest: true }], {
    effects: ['reads', 'writes'], doc: 'chez call / go OCALL* 八格 / 十门全有',
  }),
  N('prim', 'expr', [{ name: 'args', sem: SEM.value, rest: true }], {
    attrs: ['name'], effects: ['reads', 'writes'],
    doc: 'chez pr（prims.ss）/ go 19+7+23 格 / awk builtin / freebasic 那一批语句。'
      + '效应那一栏**逐格内建**地查 prims.js —— 这儿写的是"最坏情况"的默认值',
  }),

  // ---- 控制流（3 格；控制流**不是**第五种边，是带效应的节点把图切段）--------
  N('branch', 'expr', [
    { name: 'cond', sem: SEM.value },
    { name: 'then', sem: SEM.lazy },
    { name: 'else', sem: SEM.lazy, optional: true },
  ], { doc: 'chez if（入端口 lazy 就是它要的）/ 十门全有' }),
  N('loop', 'stat', [
    { name: 'cond', sem: SEM.lazy },
    { name: 'body', sem: SEM.body },
  ], { outs: [], doc: 'lua while / go OFOR / freebasic Do…Loop 六种写法' }),
  N('region', 'stat', [{ name: 'body', sem: SEM.body, rest: true }], {
    outs: ['value'], doc: 'sbcl bind/creturn 一对 / freebasic Scope（SCOPEBEGIN/END）',
  }),

  // ---- 函数与出口（3 格）------------------------------------------------------
  // 形参表是**附属**（元数分派不是新节点 —— chez 的 case-lambda 那一条）。
  N('func', 'expr', [{ name: 'body', sem: SEM.body }], {
    attrs: ['params', 'name'], lifetime: 'owns',
    doc: 'chez case-lambda（函数只有这一种形式）/ 十门全有',
  }),
  N('ret', 'stat', [{ name: 'value', sem: SEM.value, optional: true }], {
    effects: ['may-early-exit'], outs: [],
    doc: 'go ORETURN / lua return / nim return —— 早退是效应，不是边',
  }),
]);

/** 一格节点的声明。不认识的 op 当场报，不给"以后再接"的模糊地带（I2）。 */
export function declOf(op) {
  const d = NODES.get(op);
  if (d === undefined) throw new Error(`no such node: ${op}`);
  return d;
}

/** 纯不纯 —— 效应栏六格全空。pure 的节点不进 effect 图，于是可重排、可共享、可删。 */
/** 纯不纯 —— 效应栏六格全空。 那一格要**看内建名字**（ pure、 不是）。 */
export function isPure(node) {
  const op = typeof node === 'string' ? node : node.op;
  if (op === 'prim') {
    const name = typeof node === 'string' ? null : node.attrs?.name;
    return name === null ? false : primEffects(name).length === 0;
  }
  return declOf(op).effects.length === 0;
}
