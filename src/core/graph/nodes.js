// src/core/graph/nodes.js —— **第一批节点的五栏声明**（ADR-0033 §3.2 的那五栏）
//
// 十份 `ext/*/SPEC.md` 写完之后，"需要多少节点"有了量出来的答案
// （`docs/design/node-graph-contract.md` 附录 A.6：骨架 26 格）。这一份先落**第一批**：
// 够跑通一门语言"含全部基础要素的完整例子"的最小集，13 格。
//
// 之后按批往上加，每一批都要有一个新的例子家族做判据（`tests/graph/run.js`）：
// 第二批多值（+2）、第三批 scope-exit（+1）、第四批记录（+3）、第五批列表与下标（+3）、
// 第六批循环的早退（+1）、第七批表示转换（+1）—— 现在 **22 格**。
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
    // `keepMulti` 是一格**附属**：绑的是整格多值（`destructure` 那格临时量），不是第一格。
    // 没有它的话 `local x = f()` 与"装住多值"两件事分不开 —— lua 的规矩是前者只取第一格。
    attrs: ['name', 'keepMulti'], effects: ['writes'], lifetime: 'owns', outs: [],
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
    // **步进单列一格端口**（不是缀在体的末尾）：`continue` 必须跳过体的剩下部分
    // 却**照跑步进** —— go 的三段式 `for` 与 lua 的 `for i = a, b` 都是这条规矩。
    // 缀在体末尾的写法在没有 continue 的时候看不出差别，加上 continue 就是死循环。
    { name: 'post', sem: SEM.body, optional: true },
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
  N('ret', 'stat', [{ name: 'value', sem: SEM.value, optional: true, multi: true }], {
    effects: ['may-early-exit'], outs: [],
    doc: 'go ORETURN / lua return / nim return —— 早退是效应，不是边',
  }),

  // ---- 作用域出口（1 格）：**八个提供者共用这一格**（附录 A.1 里最稳的一格能力）----
  //
  // go 的 `defer` / nim 的 `defer` / V 的 `defer` 与 `lock` / lua 的 `<close>` /
  // CL 的 `unwind-protect` 与七种 cleanup / mojo 的 `__deinit__` 与 `with` /
  // freebasic 的 `Destructor` 与 `Scope` / cpp 的 RAII —— 全落这一格。
  //
  // 它的语义只有三句话，而且**三句话都由调度器给，不由语言给**：
  //   1. 在**注册的那一刻**记下这段动作（实参当场求值 —— go 的 defer 就是这条）；
  //   2. 宿主 region 出口时**逆序**跑；
  //   3. **早退也跑**（`may-early-exit` 切段之后那一段仍要经过出口）。
  N('scope-exit', 'stat', [{ name: 'action', sem: SEM.body }], {
    effects: ['writes'], outs: [],
    doc: 'defer（go/nim/V）/ unwind-protect（CL）/ <close>（lua）/ with（mojo）/ RAII（cpp）',
  }),

  // ---- 多值（2 格）：**多出端口是常态**（ADR-0033 §3.2）------------------------
  //
  // `return a, b`（go / lua / V）与 `(values a b)`（CL）落 `values`；
  // `x, y := f()` 那一侧落一串 `pick`（第 k 格出端口）。
  //
  // 为什么是"一个生产者 + 一串 pick"而不是"给 bind 加一栏名字表"：
  //   * 出端口是**边的一端**，取第几格是**消费者**的事 —— 写成 pick 才是一条边一格消费者；
  //   * go 的 `x, ok = m[k]` / V 的 `?T` / CL 的 `multiple-value-bind` 三种写法
  //     从此共用同一对节点（`ext/go/SPEC.md` §五第 1 项那句"三种双值形式是同一个形状"）。
  N('values', 'expr', [{ name: 'args', sem: SEM.value, rest: true }], {
    doc: 'go `return a, b` / lua `return a, b` / CL `values` / V 的双值形式',
  }),
  N('pick', 'expr', [{ name: 'from', sem: SEM.value, multi: true }], {
    attrs: ['index'],
    doc: '多出端口的第 k 格。`x, y := f()` 那一侧就是一串它',
  }),

  // ---- 记录（3 格）：**一格存储 + 按名字取/放**（附录 A.1：九门语言都有）--------
  //
  // 这三格与"类型"没有关系，这是它们最要紧的一条性质（附录 A 第 69 行那句话）：
  // lua 的 `{x = 1}` 没有类型、go 的 `Point{x: 1}` 有 —— **落到的是同一格节点**，
  // 类型名不进图（要用起来是 `carry` 那一问的事）。字段名是**附属**，不是端口名。
  //
  // 为什么不合成一格"按键取值"（index-get）：字段名在**编译期已知**、下标是运行期算的，
  // 两者的 `lower` 不同（前者是偏移量，后者要边界检查）。合成一格会把这个差别丢掉。
  N('record-new', 'expr', [{ name: 'fields', sem: SEM.value, rest: true }], {
    attrs: ['names'], effects: ['allocates'], lifetime: 'owns',
    doc: 'go `T{…}` / lua `{x=1}` / V `T{…}` / nim `T(x: 1)` / CL defstruct',
  }),
  N('field-get', 'expr', [{ name: 'obj', sem: SEM.value }], {
    attrs: ['field'], effects: ['reads'], lifetime: 'borrows(obj)',
    doc: 'go/V 的 `(sel …)` / lua/nim 的 `(dot …)` —— 九门全有',
  }),
  N('field-set', 'stat', [
    { name: 'obj', sem: SEM.value },
    { name: 'value', sem: SEM.value },
  ], {
    attrs: ['field'], effects: ['writes'], outs: [],
    doc: '`p.y = 5` —— 左边是字段的赋值落这格，不落 set（set 只认名字）',
  }),

  // ---- 列表与下标（3 格）------------------------------------------------------
  //
  // `list` 这一格是**高级节点**，收它的理由写在 §4：十门里九门有列表字面量，
  // 不给节点就要在每门语言的降级里各写一遍"建一格存储、逐个塞"。它有消去规则
  // （`list-new` -> 一格存储 + 一串 index-set），所以后端不认识它也不影响正确性。
  //
  // **下标的起点不在这儿**：图上 `index-get` 一律按 0 起，lua 从 1 起那一格差
  // 由 lua 自己的映射减掉（与真值观同一条纪律 —— 语言的答案由语言的映射给）。
  //
  // 与 `field-get` 为什么不是一格：字段名编译期已知（lower 成偏移量）、下标运行期算
  // （lower 要边界检查）。**也别把 `m[k]` 塞进来**：go 的 map 读可能 `allocates`、
  // V 的返回 option —— 效应那一栏不同就是另一格节点（§3 那条"不许合并"的判据）。
  N('list-new', 'expr', [{ name: 'items', sem: SEM.value, rest: true }], {
    effects: ['allocates'], lifetime: 'owns',
    doc: 'lua `{1,2}` / go `[]int{…}` / V `[…]` / nim `@[…]` —— 九门有列表字面量',
  }),
  N('index-get', 'expr', [
    { name: 'obj', sem: SEM.value },
    { name: 'index', sem: SEM.value },
  ], {
    effects: ['reads'], lifetime: 'borrows(obj)',
    doc: 'lua/go/V 的 `(index …)` / nim 的 `(bracket …)`',
  }),
  N('index-set', 'stat', [
    { name: 'obj', sem: SEM.value },
    { name: 'index', sem: SEM.value },
    { name: 'value', sem: SEM.value },
  ], {
    effects: ['writes'], outs: [],
    doc: '`xs[1] = 5` —— 左边是下标的赋值落这格',
  }),

  // ---- 循环的早退（1 格）------------------------------------------------------
  //
  // `break` 与 `continue` 是**同一格节点**：五栏（sort / 端口 / 出端口 / 效应 / 寿命）
  // 逐格相同，差的只有"跳到哪儿"—— 那是一格**附属**（`kind`）。
  // 与 `prim` 收下所有内建、`scope-exit` 收下八种语法是同一条纪律。
  //
  // 它是这一批第一格**函数边界之外**的 `may-early-exit`：`ret` 切到函数出口，
  // 它切到最近那一格 `loop` 的出口（break）或下一轮（continue）。
  // 两条都由调度器给，而且**都要经过途中每一格 region 的出口**（scope-exit 照跑）。
  //
  // lua 只有 break（它的 continue 是 `goto`）—— 一格节点两个 kind，不是两格节点。
  //
  // **一笔量出来的账**：这一格想上 C / wasm 两条腿，先要 OIR 长出**带标签的 break** ——
  // 拿手写的 WAT 试过，`br` 跳外层 `block` 当场报 "OIR has no labeled break"
  // （`docs/design/node-graph-contract.md` §9 那段量的三条）。墙在 OIR，不在 wasm。
  N('loop-exit', 'stat', [], {
    attrs: ['kind'], effects: ['may-early-exit'], outs: [],
    doc: 'break / continue（go/V/nim/mojo/awk）/ lua 只有 break / fb 的 Exit Do',
  }),
  // ---- 表示（1 格）：**目标类型是一格附属，不是端口** ------------------------
  //
  // go 的 12 格 `Op`（OCONV / OCONVIFACE / OCONVNOP …）塌成这一格。四门语言量过一遍：
  // **转换在树上都是"调用"的形状**（`int(x)` / `CInt(x)` / `Int(x)`），
  // 分开"调用"与"转换"靠的是一张**名字表**，而那张表是**语言的事**（`convs()` 在 fromtree）。
  // 于是节点这一层只留一格附属 `to`（`int` / `float` / `str` / `bool`）——
  // 具体是 `float64` 还是 `f64` 是那门语言的写法，不进图（与算符名同一条纪律）。
  N('conv', 'expr', [{ name: 'value', sem: SEM.value }], {
    attrs: ['to'],
    doc: 'go 的 conv 一族 / V 的 `f64(x)` / nim 的 `int(x)` / freebasic 的 `CInt` 一族 / mojo 的 `Int(x)`',
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
