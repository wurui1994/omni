// src/core/graph/nodes.js —— **第一批节点的五栏声明**（ADR-0033 §3.2 的那五栏）
//
// 十份 `ext/*/SPEC.md` 写完之后，"需要多少节点"有了量出来的答案
// （`docs/design/node-graph-contract.md` 附录 A.6：骨架 26 格）。这一份先落**第一批**：
// 够跑通一门语言"含全部基础要素的完整例子"的最小集，13 格。
//
// 之后按批往上加，每一批都要有一个新的例子家族做判据（`tests/graph/run.js`）：
// 第二批多值（+2）、第三批 scope-exit（+1）、第四批记录（+3）、第五批列表与下标（+3）、
// 第六批循环的早退（+1）、第七批表示转换（+1）、第八批切片（+1）—— 现在 **23 格**。
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
  /**
   * 可选的一格：**规格里数出来的提供者名单 + 还没接的那几门各欠什么**。
   * `{ spec: ['go', …], why: { lua: '…' } }`
   *
   * 为什么要有它：`--machines` 那份普查印的是"矩阵里量出来接了几门"，而节点注释里常写
   * "规格里有几门" —— **两个数**。混成一句话，账就会烂（`scope-exit` 上真烂过：
   * 注释写八个、普查印 4）。给了这一格之后它是判据：`tests/graph/run.js` 检
   * "量出来的 ⊆ 规格里的"，且差集里每一门都得有一句为什么还没接。
   */
  providers: opts.providers ?? null,
  /**
   * 可选的一格：**这一格属于哪一族**（族长那一格记账，族里其余的指向它）。
   *
   * 理由是"一族一笔账"：`record-new` / `field-get` / `field-set` 是同一件能力的三格，
   * 各记一遍账等于同一句话抄三份（而抄的那几份里总有一份会忘了改）。
   * 判据在 `tests/graph/run.js`："每一格节点要么自己有账，要么 `family` 指向一格有账的"
   * —— 于是**新加一格节点而不记账**这件事当场会红。
   */
  family: opts.family ?? null,
}];

/**
 * 第一批：**11 格**（原来 13 格 —— `binop` / `unop` 并进了 `prim`，见那一段注释）。
 * 每一格后面那句话是它的**出处**（哪几门语言的规格要求它），
 * 判据是 `omni nodes --source`：没有出处的节点不许存在。
 */
/**
 * 十门语言的名字（`src/core/graph/langs.js` 那张登记处里的十门 —— 方言不算一家）。
 * 只有 `providers.spec` 用它：写 `spec: TEN` 就是"这一格十门的规格里都要求它"。
 */
const TEN = ['go', 'vlang', 'nim', 'lua', 'mojo', 'cpp', 'awk', 'freebasic', 'chez', 'sbcl'];

export const NODES = new Map([
  // ---- 值与名字（4 格）--------------------------------------------------------
  N('const', 'expr', [], {
    attrs: ['value'], doc: 'chez quote / go OLITERAL / 十门全有',
    providers: { spec: TEN, why: {} },
  }),
  N('ref', 'expr', [], {
    attrs: ['name'], effects: ['reads'], doc: 'chez ref / sbcl ref / 十门全有',
    providers: { spec: TEN, why: {} },
  }),
  N('bind', 'decl', [{ name: 'init', sem: SEM.value }], {
    // `keepMulti` 是一格**附属**：绑的是整格多值（`destructure` 那格临时量），不是第一格。
    // 没有它的话 `local x = f()` 与"装住多值"两件事分不开 —— lua 的规矩是前者只取第一格。
    attrs: ['name', 'keepMulti'], effects: ['writes'], lifetime: 'owns', outs: [],
    doc: 'decl 就是这一格：sbcl let / go OAS / lua local / nim let',
    providers: { spec: TEN, why: {} },
  }),
  N('set', 'stat', [{ name: 'value', sem: SEM.value }], {
    attrs: ['name'], effects: ['writes'], outs: [],
    doc: 'chez set! / sbcl cset / go OAS',
    // 十门的规格里都有"改一格已有的名字"，十门都接了。chez 那一门原来只欠**一份用它的
    // 例子**（Scheme 那几份写的是纯递归）—— `ext/chez/examples/mut.ss` 就是补上的那一份。
    // 这条留在这儿当纪录：账上"欠机制"与"欠判据"是两件事，分得清才算数。
    providers: { spec: TEN, why: {} },
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
    providers: { spec: TEN, why: {} },
  }),
  N('prim', 'expr', [{ name: 'args', sem: SEM.value, rest: true }], {
    attrs: ['name'], effects: ['reads', 'writes'],
    doc: 'chez pr（prims.ss）/ go 19+7+23 格 / awk builtin / freebasic 那一批语句。'
      + '效应那一栏**逐格内建**地查 prims.js —— 这儿写的是"最坏情况"的默认值',
    providers: { spec: TEN, why: {} },
  }),

  // ---- 控制流（3 格；控制流**不是**第五种边，是带效应的节点把图切段）--------
  N('branch', 'expr', [
    { name: 'cond', sem: SEM.value },
    { name: 'then', sem: SEM.lazy },
    { name: 'else', sem: SEM.lazy, optional: true },
  ], {
    doc: 'chez if（入端口 lazy 就是它要的）/ 十门全有',
    providers: { spec: TEN, why: {} },
  }),
  N('loop', 'stat', [
    { name: 'cond', sem: SEM.lazy },
    { name: 'body', sem: SEM.body },
    // **步进单列一格端口**（不是缀在体的末尾）：`continue` 必须跳过体的剩下部分
    // 却**照跑步进** —— go 的三段式 `for` 与 lua 的 `for i = a, b` 都是这条规矩。
    // 缀在体末尾的写法在没有 continue 的时候看不出差别，加上 continue 就是死循环。
    { name: 'post', sem: SEM.body, optional: true },
  ], {
    outs: [], doc: 'lua while / go OFOR / freebasic Do…Loop 六种写法',
    // 九门 —— **chez 不在规格里**：Scheme 的迭代是递归（尾调用），语言里没有循环这一格。
    providers: {
      spec: ['go', 'vlang', 'nim', 'lua', 'mojo', 'cpp', 'awk', 'freebasic', 'sbcl'],
      why: {},
    },
  }),
  N('region', 'stat', [{ name: 'body', sem: SEM.body, rest: true }], {
    outs: ['value'], doc: 'sbcl bind/creturn 一对 / freebasic Scope（SCOPEBEGIN/END）/ nim 的 `block:`',
    // 十门都有"一段带自己作用域的语句"，十门都接了。nim 那门原来只欠一份显式块的例子
    // （它的 region 全是函数与 `defer:` 顺带带来的）—— `ext/nim/examples/blockscope.nim`
    // 补上的那一份还顺带压住"这一格真的开了一层作用域"（里外两个同名的 `x`：5 / 1）。
    providers: { spec: TEN, why: {} },
  }),

  // ---- 函数与出口（3 格）------------------------------------------------------
  // 形参表是**附属**（元数分派不是新节点 —— chez 的 case-lambda 那一条）。
  N('func', 'expr', [{ name: 'body', sem: SEM.body }], {
    attrs: ['params', 'name'], lifetime: 'owns',
    doc: 'chez case-lambda（函数只有这一种形式）/ 十门全有',
    providers: { spec: TEN, why: {} },
  }),
  N('ret', 'stat', [{ name: 'value', sem: SEM.value, optional: true, multi: true }], {
    effects: ['may-early-exit'], outs: [],
    doc: 'go ORETURN / lua return / nim return / CL 的 `(return-from f v)` —— 早退是效应，不是边',
    // 九门 —— **chez 不在规格里**：Scheme 的函数体就是它的值，语言里没有 return 这一格
    // （要早退得用 call/cc）。九门都接了：CL 那门的 `return-from` 落的就是这一格
    // （`ext/sbcl/examples/blockret.lisp`），所以**没加"带标签的早退"那格节点**。
    providers: {
      spec: ['go', 'vlang', 'nim', 'lua', 'mojo', 'cpp', 'awk', 'freebasic', 'sbcl'],
      why: {},
    },
  }),

  // ---- 作用域出口（1 格）：**规格里数出来八个提供者**（附录 A.1 里最稳的一格能力）----
  //
  // 「八个」是从十份 `ext/*/SPEC.md` 里数出来的，**不是矩阵里接了八门**：
  //   go 的 `defer` / nim 的 `defer` / V 的 `defer` 与 `lock` / CL 的 `unwind-protect`
  //   / mojo 的 `with`（`__enter__`/`__exit__`）/ freebasic 的 `Destructor` / cpp 的 RAII
  //   —— 这七门矩阵里**接了**（`node tests/graph/run.js --machines` 数得出来）；
  //   lua 的 `<close>` —— **还欠这一门**，欠的东西写在下面 `providers.why` 里。
  // 这两个数原来在这段注释里混成一句"八个提供者共用这一格"，而普查印的是 4 ——
  // **一句话对着两个数**就是账要烂掉的样子。所以现在它是一格**判据**：
  // `tests/graph/run.js` 检"量出来的 ⊆ 规格里的"，且差集里每一门都得有一句为什么。
  //
  // 后三门（mojo / freebasic / cpp）当初记的账都是"要类型与析构那一族"，**量下来记重了**：
  // 要的只是"名字从声明来 + 一格 self 实参"（第二十四批的方法），出口动作因此落成
  // **现成的 call**，一格新节点都没加。剩下 lua 那一门才是真的运行期查表（元表）。
  //
  // 它的语义只有三句话，而且**三句话都由调度器给，不由语言给**：
  //   1. 注册的那一刻只记下"这段动作"，**动作里的值到出口那一刻才求**；
  //   2. 宿主 region 出口时**逆序**跑；
  //   3. **早退也跑**（`may-early-exit` 切段之后那一段仍要经过出口）。
  //
  // 第 1 条原来写的是"实参当场求值 —— go 的 defer 就是这条"，**那句话是错的**：
  // 手搭一格图量过（`tests/graph/run.js` 的 `hand+exit-when`），interp 与 js 两条腿
  // 都在出口那一刻才求值。这样对 CL 的 `unwind-protect` 与 nim / V 的 `defer` 块是对的，
  // 对 go 的 `defer f(x)` **不对**（它的实参在注册那一刻就算好了）。
  //
  // 当时记的账是"得把 `action` 拆成被调者 + 实参各一格端口"，**那笔账也记错了**：
  // 拆端口是给节点加格子，而这件事**归语言**。go 的映射把实参先 `bind` 到一格临时名字
  // （`bind` 的语义就是"这一刻算"），动作里用 `ref` 那个名字 —— 现成的两格节点就说清了。
  // 判据是 `ext/go/examples/deferarg.go`（注册之后改那个变量，两种语义因此分得开）。
  // 提供者只有 go 一门（G5 那条里的"一家"），更说明它不该变成节点。
  N('scope-exit', 'stat', [{ name: 'action', sem: SEM.body }], {
    effects: ['writes'], outs: [],
    doc: 'defer（go/nim/V）/ unwind-protect（CL）/ <close>（lua）/ with（mojo）/ RAII（cpp）'
      + ' / Destructor（freebasic）',
    // **八门全接了**（这一格是矩阵里第一格"规格与矩阵对齐"的能力节点）。
    // lua 那一门最后落地：它的出口动作在**元表**里，而元表量下来不要新节点 ——
    // 一格 map（对象）+ 一格 map-set（元表存进保留键 `__meta`）+ 这一格 scope-exit
    // （出口那一刻从元表里查出 `__close` 再调它）。
    providers: {
      spec: ['go', 'nim', 'vlang', 'sbcl', 'lua', 'mojo', 'freebasic', 'cpp'],
      why: {},
    },
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
    doc: 'go `return a, b` / lua `return a, b` / CL `values` / V 的双值形式'
      + ' / Scheme 的 `values` + `let-values` / nim 与 mojo 的元组 / cpp 的 `std::make_pair`',
    // **八门全接了**（awk 与 freebasic 的语言里没有多值这件事，所以不在规格里）。
    // cpp 那门最后落地：双值载体是 `std::pair`，而"一格产生两个值 + 按第几格取用"
    // 图上本来就有 —— `make_pair` 落 values、`t.first` / `t.second` 落 pick。
    providers: {
      spec: ['go', 'lua', 'vlang', 'nim', 'sbcl', 'chez', 'mojo', 'cpp'],
      why: {},
    },
  }),
  N('pick', 'expr', [{ name: 'from', sem: SEM.value, multi: true }], {
    attrs: ['index'], family: 'values',
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
    // 规格里九门有记录（awk 只有关联数组，没有"按名字的字段"）。**九门全接上了**：
    // chez / sbcl 是"一句话生成一族名字"、freebasic 是"字段表在类型上、没有字面量"、
    // mojo 是"`@value` 的字段顺序就是构造顺序" —— 三条原来都记成"要类型声明那一族"，
    // 量出来**都记重了**：要的只是一张字段表（登记处），不是图里的类型层。
    providers: {
      spec: ['go', 'vlang', 'lua', 'nim', 'cpp', 'chez', 'sbcl', 'freebasic', 'mojo'],
      why: {},
    },
  }),
  N('field-get', 'expr', [{ name: 'obj', sem: SEM.value }], {
    attrs: ['field'], effects: ['reads'], lifetime: 'borrows(obj)', family: 'record-new',
    doc: 'go/V 的 `(sel …)` / lua/nim 的 `(dot …)` —— 规格里九门有（矩阵接了几门看 record-new 那格的账）',
  }),
  N('field-set', 'stat', [
    { name: 'obj', sem: SEM.value },
    { name: 'value', sem: SEM.value },
  ], {
    attrs: ['field'], effects: ['writes'], outs: [], family: 'record-new',
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
    // 规格里九门有列表字面量（awk 只有关联数组）。**九门全接上了** ——
    // freebasic 那一条是最后补的：它的字面量绑在声明上（`Dim a(2) As Integer = {…}`），
    // 而且 `a(0)` 与函数调用同形（映射登记数组名分开，见 ext/freebasic/tograph.js）。
    providers: {
      spec: ['lua', 'go', 'vlang', 'nim', 'chez', 'sbcl', 'mojo', 'cpp', 'freebasic'],
      why: {},
    },
  }),
  N('index-get', 'expr', [
    { name: 'obj', sem: SEM.value },
    { name: 'index', sem: SEM.value },
  ], {
    effects: ['reads'], lifetime: 'borrows(obj)', family: 'list-new',
    doc: 'lua/go/V 的 `(index …)` / nim 的 `(bracket …)`',
  }),
  N('index-set', 'stat', [
    { name: 'obj', sem: SEM.value },
    { name: 'index', sem: SEM.value },
    { name: 'value', sem: SEM.value },
  ], {
    effects: ['writes'], outs: [], family: 'list-new',
    doc: '`xs[1] = 5` —— 左边是下标的赋值落这格',
  }),

  // ---- map / dict（4 格）------------------------------------------------------
  //
  // **五个提供者**：lua 的 table（字符串键）/ awk 的关联数组 / go 与 V 的 `map[K]V` /
  // nim 的 `Table` —— G5 那条里的"机器"。
  //
  // **为什么不与 `index-*` 合并**（§3 那条"效应不同就是两格"）：列表的下标是**位置**，
  // map 的键是**值**。`map-set` 可能**长出一格新键**（`allocates` + `writes`），
  // 而 `index-set` 只写已经在那儿的一格（`writes`）；`map-get` 要按键比较，
  // `index-get` 是一次寻址。这不是"看起来像"的差别，是五栏里第四格的差别。
  //
  // **缺键怎么办：报错**（明说的一条）。九门语言的答案各不相同（go 给零值、lua 给 nil、
  // awk 当场长出一格空串、V 给 option），所以调度器**不替谁选**：要默认值就用
  // `map-has` + `branch` 自己写一遍 —— 那正是"写法归语言"。
  //
  // **两格 rest 端口**（`keys` / `vals`）而不是一格交替的表：键与值都是运行期的值，
  // 交替表要靠"偶数格是键"这种约定，而约定不是端口。
  N('map-new', 'expr', [
    { name: 'keys', sem: SEM.value, rest: true },
    { name: 'vals', sem: SEM.value, rest: true },
  ], {
    effects: ['allocates'], lifetime: 'owns',
    doc: 'go/V `map[K]V{…}` / lua `{}` / nim `initTable` / awk 的关联数组（隐式）'
      + ' / Scheme `make-eqv-hashtable` / CL `make-hash-table` / mojo `Dict[K, V]()`',
    // 规格里数出来**九门**（十门里只有 freebasic 没有：FB 的语言里没有字典这一格）。
    // map 那四格是一族，账记在这一格上（与 record-new 那格同一条：一族一笔账）。
    //
    // **九门全接上了**（cpp 最后进来，第二十五批之十九）。cpp 那一笔的 why 记错过一版：
    // 写的是"`std::map<K,V> m;` 这一行读不进来"，量下来**读得进来** —— 前提是那个名字
    // 登记过（`needs-type` 那台机器）。真欠的是"库里的名字从哪儿来"：这一门不做预处理。
    // 还法一句话：例子把用到的库名**自己前向声明**（头文件干的就是这件事），于是
    // `std::map<K,V> m;` 落 map-new + bind、`m[k]` 落 map-get/set、`m.count(k)` 落 map-has。
    providers: {
      spec: ['go', 'vlang', 'awk', 'nim', 'lua', 'chez', 'sbcl', 'mojo', 'cpp'],
    },
  }),
  N('map-get', 'expr', [
    { name: 'obj', sem: SEM.value },
    { name: 'key', sem: SEM.value },
  ], {
    effects: ['reads'], lifetime: 'borrows(obj)', family: 'map-new',
    doc: '`m[k]` —— 缺键是错误（默认值归语言，用 map-has 自己写）',
  }),
  N('map-set', 'stat', [
    { name: 'obj', sem: SEM.value },
    { name: 'key', sem: SEM.value },
    { name: 'value', sem: SEM.value },
  ], {
    effects: ['writes', 'allocates'], outs: [], family: 'map-new',
    doc: '`m[k] = v` —— 可能长出一格新键，所以效应里有 allocates',
  }),
  N('map-has', 'expr', [
    { name: 'obj', sem: SEM.value },
    { name: 'key', sem: SEM.value },
  ], {
    effects: ['reads'], lifetime: 'borrows(obj)', family: 'map-new',
    doc: 'go 的 `_, ok := m[k]` / lua 的 `t[k] ~= nil` / awk 的 `k in m`'
      + ' / CL 的 `(nth-value 1 (gethash …))` / Scheme 的 `hashtable-contains?`',
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
  // **那笔账已经结了，而且结论与当初的猜相反**：当初拿手写 WAT 试出 "OIR has no
  // labeled break"，以为墙在 OIR；再量一遍才发现 OIR 的 `Break` / `Continue` 本来就带
  // 一格 `level`（1 = 最内层），四条腿全认 —— 墙其实在 **WAT 前端**那一句没写的 TODO。
  // 补上之后（`level = depth + 1`），这一格在 wat 那条腿上也跑得起来了。
  N('loop-exit', 'stat', [], {
    attrs: ['kind'], effects: ['may-early-exit'], outs: [],
    doc: 'break / continue（go/V/nim/mojo/awk/cpp）/ lua 只有 break / fb 的 Exit Do'
      + ' / CL 的 `(return)`（从循环那格 `nil` 块里出去）',
    // 规格里数出来**九门**（十门里只有 chez 没有：Scheme 的迭代出口是 named let 与
    // call/cc，语言里根本没有 break 这一格）。九门都接了 —— 账清零。
    providers: {
      spec: ['go', 'vlang', 'nim', 'lua', 'mojo', 'cpp', 'awk', 'freebasic', 'sbcl'],
      why: {},
    },
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
    doc: 'go 的 conv 一族 / V 的 `f64(x)` / nim 的 `int(x)` / freebasic 的 `CInt` 一族'
      + ' / mojo 的 `Int(x)` / cpp 的 `(int)x` 与 `static_cast<int>(x)`'
      + ' / CL 的 `truncate` 与 `float` / Scheme 的 `exact` 与 `exact->inexact`',
    // 十门的规格里都有"显式换一种表示"这件事，矩阵接了八门。**九门的写法是"调用的形状"，
    // 只有 cpp 语法上就是转换** —— 所以那八门各要一张名字表，cpp 不要。
    providers: {
      spec: ['go', 'vlang', 'nim', 'mojo', 'freebasic', 'cpp', 'lua', 'awk', 'chez', 'sbcl'],
      why: {
        lua: '数只有一族（整数与浮点是同一类型的两个子型），显式转换全在库里'
          + '（`math.floor` / `tostring` / `tonumber`）—— 而"整数 -> 实数"在 lua 里**没有写法**'
          + '（`7 / 2` 本来就出实数），所以这一族的第二行在 lua 上落不到 conv',
        awk: '数只有 double，`int()` 是截断的内建；串 <-> 数是**自动**的 ——'
          + ' 那是一条规则不是一格节点，而"整数 -> 实数"同样没有写法（与 lua 同一条）',
      },
    },
  }),
  // ---- 切片（1 格）：**一段范围复制成一格新的列表** ---------------------------
  //
  // 四门语言四种写法：go 的 `xs[1:3]`、V 的 `xs[1..3]`、nim 的 `xs[1 .. 2]`、
  // mojo 的 `xs[1:3]`。**上界一律"不含"、下标一律 0 起** —— nim 的 `..` 是"含"，
  // 那一格 +1 由 nim 自己的映射做（与"下标起点是语言的事"同一条纪律）。
  //
  // 为什么不与 `index-get` 合并：它出的是**一格新存储**（`allocates` + `owns`），
  // 而 `index-get` 出的是宿主里的一格值（`borrows`）—— 效应与寿命两栏都不同。
  N('slice', 'expr', [
    { name: 'obj', sem: SEM.value },
    { name: 'from', sem: SEM.value, optional: true },
    { name: 'to', sem: SEM.value, optional: true },
  ], {
    effects: ['reads', 'allocates'], lifetime: 'owns',
    doc: 'go `xs[1:3]` / V `xs[1..3]` / nim `xs[1 .. 2]` / mojo `xs[1:3]`'
      + ' / CL `(subseq v 1 3)` / Scheme `(vector-copy v 1 3)`',
    // 规格里数出来**七门**：四门写成下标语法、两门 Lisp 写成函数调用（**同一格节点**），
    // 加上 cpp。lua / awk / freebasic 三门的规格里没有"一段范围复制成新列表"这件事
    // （lua 的 `table.move` 是往现成的表里搬、`string.sub` 是串那一侧）—— 所以不在 spec。
    providers: {
      spec: ['go', 'vlang', 'nim', 'mojo', 'sbcl', 'chez', 'cpp'],
      why: {
        cpp: '`std::span` / `std::vector` 那一行读不进来 —— 与 map 欠的是**同一笔**：'
          + 'cpp 不做预处理，头文件里的类型名登记不进来（自己声明的模板已经能当类型用了）',
      },
    },
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
