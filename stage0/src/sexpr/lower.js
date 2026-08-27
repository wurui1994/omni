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
 *         | (kernel NAME ((p TYPE)...) STMT...)     GPU 核（隐含第一个形参是 gid）
 *         | (struct NAME (字段 TYPE)...)            结构体（值语义，ADR-0005）
 *         | (class NAME (字段 TYPE)...)             类（引用语义）
 *         | (global NAME TYPE)                      模块级变量（零初始化，跨函数共享）
 *         | (main STMT...)                          入口体
 *   TYPE  = int | real | bool | string | void | (vec int|real 2|4|8) | (buf int|real)
 *         | (arr int|real|bool|string) | (arr (vec T N)) | 结构体名 | 类名
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

import { INT, REAL, BOOL, STRING, VOID, vecType, bufType, arrType, structType, classType, zeroValue } from '../hir/types.js';
import { readSexpr, isList, isAtom, isStr, head } from './read.js';

const TYPES = new Map([['int', INT], ['real', REAL], ['bool', BOOL], ['string', STRING], ['void', VOID]]);

/** 向量宽度：2 的幂，上界 8。放宽之前先想清楚 C 那条腿要展开多少行。 */
const VEC_LANES = new Set([2, 4, 8]);

/** 算术/位运算：两边同型，结果同型。字符串只允许 `+`（拼接，与 Omni 一致）。 */
const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const LOGIC = new Set(['&&', '||']);

/** `(rmath "NAME" …)` 的名单与参数个数。为什么只有这七个，见 runtime/omni_math.c 的头注。 */
const RMATH = new Map([
  ['sqrt', 1], ['fabs', 1], ['floor', 1], ['ceil', 1], ['round', 1],
  ['pow', 2], ['fmod', 2],
]);

class CoreLowerer {
  constructor(diags) {
    this.diags = diags;
    this.funcs = new Map();   // 名字 -> {name, mangled, ret, params}
    this.scopes = [];         // 名字 -> OIR 类型
    // kernel 与函数分开登记：kernel 只能被 (dispatch ...) 启动，(call ...) 要报错说清这件事。
    // 它在 OIR 里就是一个普通函数，第一个形参是隐含的 gid —— 于是「同一份 MIR 在 CPU 上跑」
    // 不需要任何新机制（门槛 7 要比的就是这个 CPU 结果），dispatch 只是一个循环。
    this.kernels = new Map();
    this.inKernel = false;
    // 模块级变量（第二十四刀）：名字 -> OIR 类型。查名字时它是**最外层的兜底** ——
    // 局部量与形参先赢，所以同名的局部量是遮蔽而不是错。
    this.globals = new Map();
    this.tmpNo = 0;           // dispatch 展开出来的临时量编号，保证名字唯一
    this.loopDepth = 0;       // (brk) / (cont) 只在循环里合法，跟 hir/check.js 同一条规矩
    // 结构体：名字 -> OIR 的 struct 类型对象。**声明就是类型**（hir/types.js 的 structType），
    // 所以这张表里的对象和每个 (fld …) 节点上挂的 `type` 是同一个对象，与 hir/check.js 一致。
    this.structs = new Map();
    // 类：**引用**语义的聚合。跟 struct 的区别只有一条 —— 赋值/传参/返回**不复制**
    // （from_oir 的 rvalue 只给 struct 与 enum 发 OP.COPY）。asy 的 struct 就是这种
    // （量过：`A b = a; b.x = 7;` 之后 `a.x` 是 7），所以这两种都要有，不是重复。
    this.classes = new Map();
    // 这一份源文件里所有结构体/类的名字（run 的第 0 遍扫出来）。只为诊断服务：
    // 字段类型提到自己或后面那个时，能说"声明在后面"而不是"认不出的类型"。
    this.aggLater = new Set();
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
    // **数组套数组仍然不收**：MIR 那一层元素类型只有一个 8 位类型码，`(arr (arr int))`
    // 与 `(arr (arr string))` 在那里是同一个码 —— 那不是"少写几行"，是类型身份丢了。
    if (isList(node) && head(node) === 'arr') {
      const en = node.items[1];
      if (isList(en) && head(en) === 'vec') {
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
    if (!isAtom(node) || !TYPES.has(node.value)) {
      // 结构体名（第十二刀）与类名（第十三刀）：方言里用户能起的类型名只有这两种，
      // 所以放在内建名单后面查 —— 内建名字不可能被遮蔽（那两遍会拒掉重名）。
      if (isAtom(node) && this.structs.has(node.value)) return this.structs.get(node.value);
      if (isAtom(node) && this.classes.has(node.value)) return this.classes.get(node.value);
      return this.err(node, `${what} 的类型只能是 int / real / bool / string / void / (vec T N) / (buf T) / (arr T) / 结构体名 / 类名`);
    }
    return TYPES.get(node.value);
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

  run(nodes) {
    const top = nodes.length === 1 && head(nodes[0]) === 'module' ? nodes[0] : null;
    if (top === null) {
      this.err(nodes[0], '一份核心方言的源文件是恰好一个 (module ...)');
      return null;
    }
    const forms = top.items.slice(1);
    // 三遍。第一遍收结构体：函数签名与字段类型都可能提到它，所以它必须最先成型。
    // 字段类型里**可以**提到别的结构体/类（第十七刀），但只能提**前面已经声明过**的 ——
    // 一遍就够，而且自引用（`(struct A (n A))`）天然挡在门外：它的零值会无限递归。
    // 先把所有名字扫出来，好让"提到的是后面那个"给出准的诊断而不是"认不出的类型"。
    const later = new Set();
    for (const f of forms) {
      if (head(f) !== 'struct' && head(f) !== 'class') continue;
      if (isAtom(f.items[1])) later.add(f.items[1].value);
    }
    this.aggLater = later;
    for (const f of forms) {
      if (head(f) === 'struct') this.structDec(f, 'struct');
      else if (head(f) === 'class') this.structDec(f, 'class');
    }
    // 第二遍收模块级变量（第二十四刀）：函数体与 (main …) 都可能提到它，所以要在
    // 那些体降级之前成型。这一刀只收标量 —— MIR 那边全局的类型就是一个 8 位类型码，
    // 聚合的**身份**在类型池里，全局要带身份得先给那张池子加一列，那是另一刀。
    for (const f of forms) {
      if (head(f) !== 'global') continue;
      const nm = isAtom(f.items[1]) ? f.items[1].value : null;
      if (nm === null) { this.err(f, '(global 名字 类型)'); continue; }
      if (this.globals.has(nm)) { this.err(f, `模块级变量 '${nm}' 重复定义`); continue; }
      const t = this.ty(f.items[2], `模块级变量 ${nm}`);
      if (t === null) continue;
      if (t !== INT && t !== REAL && t !== BOOL && t !== STRING) {
        this.err(f, `模块级变量 ${nm} 这一刀只收 int / real / bool / string，`
          + `不收 ${coreTypeText(t)}（聚合的身份不在 MIR 的 8 位类型码里，那是另一刀）`);
        continue;
      }
      this.globals.set(nm, t);
    }
    // 第三遍收函数签名，函数才能互相调用（也才能递归）
    for (const f of forms) {
      const h = head(f);
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
    return this.assemble(forms);
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
   * **字段类型这一刀收 int / real / bool / string、`(vec T N)`、`(arr T)`
   * 与另一个结构体/类**
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
   * 发射器里没有第二份"逐字段递归"。字段类型只收**前面已经声明过**的那个：自引用与
   * 前向引用的零值会无限递归（`run()` 里先扫一遍聚合名，好让这两种给出不同的诊断）。
   * `tests/sexpr/bad/struct-self.sx` 与 `struct-fwd.sx` 钉着这两半。
   */
  structDec(n, kind) {
    const what = kind === 'struct' ? '结构体' : '类';
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.err(n, `(${kind} NAME (字段 类型)...) 缺名字`);
    if (TYPES.has(nm)) return this.err(n, `'${nm}' 是内建类型名，不能当${what}名`);
    if (this.structs.has(nm) || this.classes.has(nm)) return this.err(n, `'${nm}' 重复定义`);
    const fields = [];
    const seen = new Map();
    for (const fd of n.items.slice(2)) {
      if (!isList(fd) || fd.items.length !== 2 || !isAtom(fd.items[0])) {
        return this.err(fd, '一个字段是 (名字 类型)');
      }
      const fn = fd.items[0].value;
      if (seen.has(fn)) return this.err(fd, `${what} '${nm}' 里有两个字段叫 '${fn}'`);
      // 字段类型提到的是**自己**或**后面才声明**的那个：单独报，别落到"认不出的类型"上。
      // 自引用是真的不行（零值会无限递归）；提到后面那个也不收 —— 一遍收记录，
      // 而"两遍收记录"要先答"互相嵌套的零值怎么铺"，那不是这一刀的事。
      const tn = isAtom(fd.items[1]) ? fd.items[1].value : null;
      if (tn !== null && !this.structs.has(tn) && !this.classes.has(tn) && this.aggLater.has(tn)) {
        return this.err(fd, `字段 ${nm}.${fn}：${tn === nm ? '字段的类型就是它自己' : `'${tn}' 声明在后面`}`
          + ` —— 字段类型只能是**前面已经声明过**的结构体/类（自引用的零值会无限递归）`);
      }
      const t = this.ty(fd.items[1], `字段 ${nm}.${fn}`);
      if (t === null) return null;
      if (t !== INT && t !== REAL && t !== BOOL && t !== STRING
          && t.k !== 'vec' && t.k !== 'arr' && t.k !== 'struct' && t.k !== 'class') {
        return this.err(fd, `字段 ${nm}.${fn}：这一刀的字段只能是 int / real / bool / string、`
          + `(vec T N)、(arr T) 或另一个结构体/类，这里是 ${coreTypeText(t)}`);
      }
      seen.set(fn, true);
      fields.push({ name: fn, type: t });
    }
    if (fields.length === 0) return this.err(n, `${what} '${nm}' 至少要有一个字段`);
    if (kind === 'struct') this.structs.set(nm, structType(nm, fields));
    else this.classes.set(nm, classType(nm, fields));
    return null;
  }

  assemble(forms) {
    const funcs = [];
    const mainStmts = [];
    let sawMain = false;
    // 模块级变量的零初始化就是 `(main …)` 最前面的几句赋值（第二十四刀）。放在这一层
    // 而不是让六个后端各写一份"这个类型的零长什么样"：零值节点 OIR 里现成（zeroValue），
    // 而后端只要会存取一个全局就够。顺序是声明序，所以两次降级出来的文本一样。
    for (const [nm, t] of this.globals) {
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
      if (h === 'main') {
        if (sawMain) { this.err(f, '(main ...) 只能有一个'); continue; }
        sawMain = true;
        this.scopes = [new Map()];
        for (const s of this.block(f.items.slice(1), VOID)) mainStmts.push(s);
        continue;
      }
      if (h === 'struct' || h === 'class') continue;   // 第一遍已经收过了
      if (h === 'global') continue;                    // 第二遍已经收过了
      this.err(f, `(module ...) 里只能是 (struct ...) / (class ...) / (global ...) / (fn ...) / (kernel ...) / (main ...)，见到 '${h}'`);
    }
    if (!sawMain) this.err(null, '缺入口：加一个 (main ...)');
    mainStmts.push({ kind: 'Return', value: null });
    funcs.push({ name: 'main', mangled: 'omni_main', ret: VOID, params: [], body: { kind: 'Block', stmts: mainStmts } });
    // 结构体按**声明顺序**发出去：C 后端会按值嵌套关系拓扑排序，但字段里不许再有结构体，
    // 所以这里的顺序就是最终顺序 —— 同一份输入两次降出来的文本因此逐字节相同。
    const structs = [];
    for (const s of this.structs.values()) structs.push(s);
    const classes = [];
    for (const c of this.classes.values()) classes.push(c);
    // 模块级变量按**声明顺序**发出去（Map 记的就是插入序）：MIR 的全局号按这个顺序分配，
    // 所以同一份输入两次编译出来的字节与哈希都一样。
    const globals = [];
    for (const [nm, t] of this.globals) globals.push({ name: nm, mangled: `g_${nm}`, type: t });
    return {
      structs: structs, classes: classes, enums: [], containers: [], closures: [], fnTypes: [],
      funcs: funcs,
      globals: globals,
      entry: 'omni_main',
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
    if (h === 'brk' || h === 'cont') {
      if (this.loopDepth === 0) return this.err(n, `(${h}) 只能写在循环里`);
      return { kind: h === 'brk' ? 'Break' : 'Continue' };
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
    if (h === 'expr') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      return { kind: 'ExprStmt', expr: v };
    }
    if (h === 'bset') return this.bufSet(n);
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
    // `(toreal E)` / `(toint E)`：int <-> real 的**显式**转换。同一条纪律：类型不推导、
    // 不插隐式转换，所以两个方向都得写出来。OIR 侧两个都是现成的（Cast int->real、
    // trunc real->int），方言这边原先没开口 —— 而 asy 的 `1/3` 是实数除法、`(int) 3.7`
    // 是截断，没有这两条就一句都降不下来。
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
      return { kind: 'ArrNew', type: t, count: c, zero: zeroValue(t.elem) };
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
  if (t.k === 'struct' || t.k === 'class') return t.name;
  return t.k;
}

/**
 * 核心方言的源文本 -> OIR。`.sx` 文件走这条，`omni glr` 的输出也走这条 ——
 * 后者才是重点：语法文件的映射模板拼出这份方言，中间没有为那门语言写的一行代码。
 */
export function lowerCoreSexpr(file, diags) {
  const nodes = readSexpr(file, diags);
  if (diags.hasErrors()) return null;
  return new CoreLowerer(diags).run(nodes);
}

