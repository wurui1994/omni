// ext/cpp/adapter/index.js —— **C++ → 标准 IR**（ADR-0044 第二片第六门）
//
// 替掉 `ext/cpp/tograph.js`（534 行）。这一门的要点：
//   1. **类型是写着的**（`int` / `double` / `Point` / `std::map<std::string,int>`），`auto` 从初值取；
//   2. **`~Say()` 是出作用域跑一段**（RAII）—— 交给**公共层的作用域出口**
//      （`{ kind: 'scope', stmts, exits }`，`lower-stmt.js`）：这一份只说"哪几格要销毁、
//      按什么次序"，"每个出口都补一遍"是公共层的事；
//   3. `#include` / `namespace` / `template` 的前向声明**丢掉**（这一门不做预处理，
//      例子里那几行是为了让语法认得 `std::map` 这类名字）；
//   4. 入口是 `int main()` —— 公共降级器看见名叫 `main` 的函数就发 `(main (expr (call main)))`。

import {
  tag, kids, leaf, part, isList, groupItems,
} from '../../../src/core/lower/cst.js';
import { INT, arrOf, named, typeOf } from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfSpecs, printArgs, nameOf, tyArg, vcallName, readParams, coerce,
  wrapNarrow, argsWithRefs,
} from './expr.js';

/**
 * 析构函数的名字。**两截**：`rec` 是给哪一格记录用的、`owner` 是谁的体 ——
 * 继承之后 `Mid` 要跑 `~Mid` 与 `~Base` 两段，而基类那段的接收者是 `Mid`
 * （摊平之后 `Base` 与 `Mid` 是两格互不相关的记录，不能拿 `Base` 那份去收 `Mid`）。
 */
const dtorName = (rec, owner) => `__destruct_${rec}_${owner}`;

/**
 * 构造函数的名字（交的是一格记录，所以它是个**普通函数**，不带 `this`）。
 * **按实参个数编**（`Vec__ctor0` / `Vec__ctor2`）：重载就是"调用点数一数实参"，
 * 于是它还是一格普通调用，一格新东西都不用加。
 */
const ctorName = (rec, argc) => `${rec}__ctor${argc}`;

/**
 * **一格方法叫什么**。三档，从"不动"往"分得最细"排：
 *   1. 没重载 → 还叫老名字（`Acc_get`）——**已有那几族一个字节都不动**；
 *   2. 重载了、但几份的**实参个数各不相同** → 缀个数（`Acc_add__1`）；
 *   3. 有两份个数一样 → 缀**实参类型**（`Acc_add__int` / `Acc_add__real`）。
 * 调用点照这三档反过来找（见 `pickMethodT` / `pickMethod`）。
 */
function methodName(rec, m, C) {
  const base = `${C.ref(rec.name)}_${C.ref(m.name)}`;
  if (rec.ovlT?.has(m.name) === true) return `${base}__${paramTags(m.tok, C)}`;
  return (rec.ovl?.has(m.name) === true) ? `${base}__${ctorArity(m.tok)}` : base;
}

/**
 * **体里被借出去的那几格局部量**（要发成盒子的）。一趟扫树：凡是 `f(…, y, …)` 里
 * `y` 落在 `f` 的引用形参那个位置上，`y` 就得装盒子。
 *
 * **Why 先扫一趟**：声明那一句（`int y = 5;`）要发成 `let y = __ref_int{v:5}`，
 * 而它在体里排在调用**之前** —— 边降边发现来不及。
 */
function borrowedLocals(fnTok, C) {
  const out = new Set();
  /**
   * **`[&]` / `[&x]` 捕的那几格也要装盒子**：捕获一律按值传进闭包，而"按引用捕获"的意思是
   * 改得动外头那一格 —— 装成盒子之后"按值捕一格记录的引用"就是它（与出参同一台机器）。
   * 这一趟手上还没有类型，所以先收着，最后与"这个体里真声明过的局部量"求交（见下面）。
   */
  const capWanted = new Set();
  const walk = (t) => {
    if (t === null || t === undefined || !isList(t)) return;
    if (tag(t) === 'lambda') {
      const capsTok = kids(t).find((y) => tag(y) === 'captures');
      let allRef = false;
      for (const c of (capsTok === undefined ? [] : kids(capsTok))) {
        if (tag(c) === 'c-ref') capWanted.add(C.ref(String(leaf(kids(c)[0]))));
        if (tag(c) === 'by-ref-all') allRef = true;
      }
      if (allRef) for (const n of freeNames(part(t, 'body'))) capWanted.add(C.ref(n));
    }
    if (tag(t) === 'call') {
      const fn = kids(t)[0];
      const as = part(t, 'args');
      if (fn !== undefined && (tag(fn) === 'dot' || tag(fn) === 'arrow') && as !== undefined) {
        /* 方法调用：这一趟还没有类型，按方法名近似（多装一格盒子不会错）。 */
        const idx = C.refByName.get(nameOf(kids(fn)[1]));
        if (idx !== undefined) {
          kids(as).forEach((a, i) => {
            const inner = tag(a) === 'addrof' ? kids(a)[0] : a;
            if (idx.has(i) && tag(inner) === 'n') out.add(C.ref(nameOf(inner)));
          });
        }
      }
      if (fn !== undefined && tag(fn) === 'n' && as !== undefined) {
        /* 自由函数，或者**函数式的构造**（`Counter(y)` —— 那一格按类名查）。 */
        const idx = C.refSig.get(C.ref(nameOf(fn))) ?? C.ctorRef.get(C.ref(nameOf(fn)));
        if (idx !== undefined) {
          kids(as).forEach((a, i) => {
            const inner = tag(a) === 'addrof' ? kids(a)[0] : a;
            if (idx.has(i) && tag(inner) === 'n') out.add(C.ref(nameOf(inner)));
          });
        }
      }
    }
    /* **声明形的构造**（`Counter c(y);`）：类名在 specs 上、实参在声明符的 `(ctor …)` 里。 */
    if (tag(t) === 'decl') {
      const sp = part(t, 'specs');
      const cn = sp === undefined ? undefined : kids(sp).find((y) => tag(y) === 'n');
      const idx = cn === undefined ? undefined : C.ctorRef.get(C.ref(nameOf(cn)));
      const it = part(t, 'init');
      if (idx !== undefined && it !== undefined) {
        for (const d of kids(it)) {
          const ct = kids(d).find((y) => tag(y) === 'ctor');
          const cas = ct === undefined ? undefined : part(ct, 'args');
          if (cas === undefined) continue;
          kids(cas).forEach((a, i) => {
            const inner = tag(a) === 'addrof' ? kids(a)[0] : a;
            if (idx.has(i) && tag(inner) === 'n') out.add(C.ref(nameOf(inner)));
          });
        }
      }
    }
    for (const k of kids(t)) walk(k);
  };
  walk(part(fnTok, 'body'));
  /* 与"这个体里真声明过的局部量"求交 —— 全局名字与函数名不许装盒子（装了会当场报）。 */
  if (capWanted.size > 0) {
    const locals = declaredLocals(part(fnTok, 'body'), C);
    for (const n of capWanted) if (locals.has(n)) out.add(n);
  }
  return out;
}

/** 一格体里**声明过的局部量**（名字都 ref 过）。 */
function declaredLocals(bodyTok, C) {
  const out = new Set();
  const walk = (t) => {
    if (t === null || t === undefined || !isList(t)) return;
    if (tag(t) === 'decl') {
      const it = part(t, 'init');
      for (const d of (it === undefined ? [] : kids(it))) {
        const nm = kids(d)[0];
        if (nm === undefined) continue;
        const bare = tag(nm) === 'n' ? nm : kids(nm).find((y) => tag(y) === 'n');
        if (bare !== undefined) out.add(C.ref(nameOf(bare)));
      }
    }
    for (const k of kids(t)) walk(k);
  };
  walk(bodyTok);
  return out;
}

/** 形参里有 `T&` 就当场报（自由函数上接了，别的位置还没接）。 */
function noRefParams(s, who) {
  if (s.params.some((p) => p.ref === true)) {
    throw new Error(`cpp->IR: ${who} 上的 \`T&\` 形参还没接（自由函数上接了）`);
  }
}

/**
 * **按值收的记录，进门先拷一份**（C++ 的值语义）。
 *
 * 为什么落在**被调方**而不是每个调用点：调用点有八九处（自由函数、方法、虚方法的分派、
 * 构造、模板实例、lambda…），而"进门第一句"只有一处 —— 少八处就少八处漏。
 * 接收者（`this`）与借出去的那几格（`ref`）不拷：前者本来就是引用语义，后者的整个意义
 * 就是要改到调用者那一格。
 */
function byValueCopies(sig, C) {
  return sig.params
    .filter((p) => p.name !== 'this' && p.ref !== true && p.type.kind === 'named')
    .map((p) => ({
      kind: 'assign',
      target: { kind: 'name', name: p.name },
      value: {
        kind: 'call',
        fn: { kind: 'name', name: C.recCopy(p.type) },
        args: [{ kind: 'name', name: p.name }],
      },
    }));
}

/**
 * **按值收的窄整数，进门也回卷一次**（`void show(unsigned char c)`，`show(300)` 是 44）。
 *
 * 落在被调方的理由与上一格一模一样：调用点有八九处（自由函数、方法、虚分派、构造、
 * 模板实例、lambda…），而"进门第一句"只有一处。借出去的那几格（`ref`）不动 ——
 * 它们在体里是 `.v`，不是这个名字自己。
 */
function narrowParams(sig, C) {
  return sig.params
    .filter((p) => p.name !== 'this' && p.ref !== true
      && p.type.kind === 'int' && p.type.bits !== undefined)
    .map((p) => ({
      kind: 'assign',
      target: { kind: 'name', name: p.name },
      value: wrapNarrow({ kind: 'name', name: p.name }, p.type),
    }));
}

/** 一格记录**当值赋出去**（`P b = a;` / `b = a;`）也要拷 —— 右边是"一格地方"才拷。 */
function copyIfLv(v, type, C) {
  if (type === null || type === undefined || type.kind !== 'named') return v;
  if (!['name', 'field', 'index', 'capture'].includes(v.kind)) return v;
  return { kind: 'call', fn: { kind: 'name', name: C.recCopy(type) }, args: [v] };
}

/** 一份函数的形参类型标记（`int_real`）—— 与造模板实例名时用的是同一份 `tyTag`。 */
function paramTags(fnTok, C) {
  const f = kids(fnTok).find((y) => tag(y) === 'fn');
  return readParams(part(f, 'params'), C).map((p) => tyTag(p.type)).join('_');
}

/**
 * **这个类的几份构造各叫什么**（与方法那三档同一条规矩）：个数各不相同 → 缀个数
 * （`Vec__ctor2`，与从前一样）；有两份个数一样 → 那一档缀**实参类型**
 * （`Vec__ctor1_int` / `Vec__ctor1_real`）。`byType` 为真时**整个类**的几份构造都要进
 * `C.ctorOvl`（调用点是按类名找那张表的，混着两种名字不要紧）。
 */
function ctorPlan(recRef, ctors, C) {
  const seen = new Set();
  const dup = new Set();
  for (const ct of ctors) {
    const k = ctorArity(ct);
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return ctors.map((ct) => {
    const argc = ctorArity(ct);
    const base = ctorName(recRef, argc);
    return { tok: ct, name: dup.has(argc) ? `${base}_${paramTags(ct, C)}` : base, byType: dup.size > 0 };
  });
}

/**
 * 这个方法要不要进"按类型挑"那张表（只有 `ovlT` 里的名字要）。
 * `params` 里**去掉 this** —— 调用点手上只有写出来的那几格实参。
 */
function regMethOvl(rec, m, s, C) {
  if (rec.ovlT?.has(m.name) !== true) return;
  const k = `${C.ref(rec.name)}_${C.ref(m.name)}`;
  if (!C.methOvl.has(k)) C.methOvl.set(k, []);
  C.methOvl.get(k).push({ name: s.name, params: s.params.slice(1) });
}

/**
 * **从几份重载里挑一份**（自由函数与方法共用这一份）。照 C++ 的次序两步：
 *   1. 逐格类型**一模一样**的那份赢；
 *   2. 没有的话看"每格实参都能转过去"的（这条腿上只认 `int -> double` 与
 *      `bool -> int` 两格提升）—— 剩下**正好一份**才算。
 * 挑不出唯一那份就当场报并把候选全列出来（别猜 —— 猜错就是答案静默地错）。
 */
function pickAmong(label, cands, argTypes) {
  const tags = argTypes.map(tyTag);
  const arity = (c) => c.params.length === tags.length;
  const same = cands.filter((c) => arity(c) && c.params.every((p, i) => tyTag(p.type) === tags[i]));
  if (same.length === 1) return same[0];
  const ok = (want, got) => tyTag(want) === tyTag(got)
    || (want.kind === 'real' && got.kind === 'int')
    || (want.kind === 'int' && got.kind === 'bool');
  const fits = cands.filter((c) => arity(c) && c.params.every((p, i) => ok(p.type, argTypes[i])));
  if (fits.length === 1) return fits[0];
  throw new Error(`cpp->IR: \`${label}(${tags.join(', ')})\` 挑不出唯一那一份重载`
    + `（有 ${cands.length} 份：${cands.map((c) => c.name).join(' / ')}）`);
}

/** 一份构造函数（或方法）收几个实参。 */
function ctorArity(ctorTok) {
  const f = kids(ctorTok).find((y) => tag(y) === 'fn');
  const ps = f === undefined ? undefined : part(f, 'params');
  return ps === undefined ? 0 : kids(ps).filter((y) => tag(y) === 'p').length;
}

/**
 * **`operator@` 的方法名**（与 `expr.js` 的 `OP_MAP` 是同一张表的两头）。
 * 落法是把重载编成一格**普通方法**（`类名_op_add`）—— 登记、发体、分派全不用另写；
 * 改写发生在调用点（`a + b` 里 a 装的是有这一格的类才改写）。
 */
const OP_NAMES = new Map([
  ['+', 'op_add'], ['-', 'op_sub'], ['*', 'op_mul'], ['/', 'op_div'], ['%', 'op_mod'],
  ['==', 'op_eq'], ['!=', 'op_neq'],
  ['<', 'op_lt'], ['>', 'op_gt'], ['<=', 'op_le'], ['>=', 'op_ge'],
  ['index', 'op_index'], ['call', 'op_call'],
]);

/** `(opname "+")` → `op_add`。不认的算子当场报（别静默地编出个怪名字）。 */
function opMethodName(tok) {
  const s = String(leaf(kids(tok)[0]));
  const n = OP_NAMES.get(s);
  if (n === undefined) throw new Error(`cpp->IR: \`operator${s}\` 这一格重载还没接`);
  return n;
}

/** 模板实例的名字里那一截（`int` / `real` / `arr_int` / `Point`）。 */
function tyTag(t) {
  if (t.kind === 'named') return t.name;
  if (t.kind === 'arr') return `arr_${tyTag(t.elem)}`;
  if (t.kind === 'map') return `map_${tyTag(t.value)}`;
  return t.kind;
}

/** 一棵 cpp 的树（`(unit …)`）→ 标准 IR 的模块。 */
export function cppToIR(tree) {
  if (tag(tree) !== 'unit') throw new Error('cpp->IR: 这不是 (unit …)');

  let tmpN = 0;
  const names = new Map();
  const scopes = [new Map()];
  const recFields = new Map();
  const mvs = new Map();
  const decls = [];
  const C = {
    /** 记录名 → { name, fields, methods, dtor }。 */
    records: new Map(),
    /** `typedef int myint;` → 名字 → 类型。**模板的类型形参实例化时也临时摆在这儿**。 */
    aliases: new Map(),
    fns: new Map(),
    /** `template <class T> T f(…)` → 名字 → { tparams, fnTok }（本身**不发代码**）。 */
    templates: new Map(),
    /** `template <class T> struct Box {…}` → 名字 → { tparams, clsTok }（同样不发代码）。 */
    ctemplates: new Map(),
    /** 已经发过的实例名（`maxOf__int`）—— 同一格只降一遍。 */
    instDone: new Set(),
    /**
     * **`T&` 那一格的盒子**：标量按引用传不出去（方言里标量是值），所以装进一格只有
     * 一格字段 `v` 的记录 —— 记录本来就是引用语义。同一个元素类型只造一格
     * （`__ref_int` / `__ref_real` / …），用户写不出这个名字（双下线开头留给我们）。
     */
    refBox: (t) => {
      const nm = `__ref_${tyTag(t)}`;
      if (!C.refBoxDone.has(nm)) {
        C.refBoxDone.add(nm);
        recFields.set(nm, [{ name: 'v', type: t }]);
        decls.push({ kind: 'class', name: nm, fields: [{ name: 'v', type: t }] });
      }
      return { kind: 'named', name: nm, ref: true, cls: nm };
    },
    refBoxDone: new Set(),
    /** 函数名（已 ref 过） → 哪几格形参是借出去的（下标集合）。 */
    refSig: new Map(),
    /** `类名_成员名`（类名已 ref 过） → 那格 `static` 成员落成的模块级名字。 */
    statics: new Map(),
    /** `类名_成员函数名`（类名已 ref 过） → 那格 `static` 成员函数落成的函数名。 */
    statFns: new Map(),
    /**
     * **正在发哪个类的 `static` 成员函数**（已 ref 过；不在里头是 null）。
     * `C.self` 那一格管的是"裸名字当 `this->` 的字段"，而 static 里没有 `this` ——
     * 但**`static` 数据成员还是要认得**，所以另开这一格。
     */
    statCls: null,
    /** 名字 → 它其实是哪一格地方（区间 for 按引用走那一格：`v` 就是 `xs[i]`）。 */
    lvAlias: new Map(),
    /**
     * **方法名（没缀类名的那个） → 哪几格实参是借出去的**。降体之前那一趟扫树
     * （`borrowedLocals`）手上还没有类型，认不出 `a.set(y)` 里 `a` 是哪个类 ——
     * 所以按**名字**近似。多装了盒子不会错（读写一律走 `.v`），只是白装一格。
     */
    refByName: new Map(),
    /**
     * **类名（规整过的） → 它那一份构造的哪几格实参是借出去的**。构造在两个位置上被调
     * （`Counter c(y);` 与 `Counter(y)`），两处都要在**求值之前**知道 —— 所以按类名记。
     * 只有"这个类只有一份构造"那一档进这张表（重载的当场报）。
     */
    ctorRef: new Map(),
    /**
     * **按值传一格记录要拷一份**（C++ 的值语义）。方言的记录是引用语义，所以"传进去、
     * 在里头改字段"从前**改到了调用者那一格**（`grow(a)` 之后 `a.x` 变了 —— 答案静默地错）。
     * 这儿给每格记录发一份 `类名__copy`（逐字段，字段本身是记录就再递归拷一层），
     * **要到才发**，所以没用到这条路的家族一个字节都不动。
     */
    recCopy: (type) => {
      const nm = `${type.name}__copy`;
      if (!C.copyDone.has(nm)) {
        C.copyDone.add(nm);
        const fs = recFields.get(type.name) ?? [];
        const src = { kind: 'name', name: 'src' };
        const pre = [];
        /**
         * 一格字段怎么拷：记录再递归拷一层；**列表要连里头一起拷**（发一段
         * `anew` + `while` —— 方言没有"拷一份列表"的内建，那就现搭一格循环）；
         * 字典当场报（方言里没有能装下键列表的类型，拷不了）。
         */
        const copyValue = (read, t, out) => {
          if (t.kind === 'named') {
            return { kind: 'call', fn: { kind: 'name', name: C.recCopy(t) }, args: [read] };
          }
          if (t.kind === 'map') {
            throw new Error(`cpp->IR: 按值拷 ${type.name} 还没接`
              + '（字段是字典 —— 方言里没有能装下键列表的类型，拷不了）');
          }
          if (t.kind !== 'arr') return read;
          const dst = C.fresh('cp');
          const idx = C.fresh('ci');
          const len = { kind: 'builtin', name: 'alen', args: [read] };
          out.push({
            kind: 'let',
            name: dst,
            type: t,
            init: { kind: 'builtin', name: 'anew', args: [tyArg(t), len] },
          });
          out.push({
            kind: 'let', name: idx, type: INT, init: { kind: 'int', value: 0 },
          });
          const body = [];
          const one = copyValue({ kind: 'index', obj: read, index: { kind: 'name', name: idx } }, t.elem, body);
          body.push({
            kind: 'assign',
            target: { kind: 'index', obj: { kind: 'name', name: dst }, index: { kind: 'name', name: idx } },
            value: one,
          });
          body.push({
            kind: 'assign',
            target: { kind: 'name', name: idx },
            value: {
              kind: 'binop', op: '+', left: { kind: 'name', name: idx }, right: { kind: 'int', value: 1 },
            },
          });
          out.push({
            kind: 'while',
            cond: {
              kind: 'binop', op: '<', left: { kind: 'name', name: idx }, right: len,
            },
            body,
          });
          return { kind: 'name', name: dst };
        };
        const fields = fs.map((f) => ({
          name: f.name,
          value: copyValue({ kind: 'field', obj: src, name: f.name }, f.type, pre),
        }));
        C.fns.set(nm, { params: [{ name: 'src', type }], ret: type });
        decls.push({
          kind: 'fn',
          name: nm,
          params: [{ name: 'src', type }],
          ret: type,
          body: [...pre, {
            kind: 'return',
            values: [{
              kind: 'new-record', type, ref: true, fields,
            }],
          }],
        });
      }
      return nm;
    },
    copyDone: new Set(),
    /**
     * **当前函数里哪几格名字装在盒子里**（引用形参 + 被借出去的局部量）。
     * 读写这些名字都要走 `.v`，而在"借出去"的那个实参位置上要交盒子本身。
     */
    refNames: new Set(),
    /**
     * **重载了的自由函数**：原名 → `[{ name, params }]`（`name` 是缀了实参类型的那个）。
     * 只有真重载了的名字才在这张表里 —— 没重载的名字一个字节不动。
     */
    ovlFns: new Map(),
    /**
     * **一格类名 → 它在方言里落成哪一格记录**。没有虚函数的类就是自己；有虚函数的
     * 整棵继承树**共用根那一格记录**（见 `planVirtuals`）—— 那是"基类指针能装派生类"
     * 的唯一办法，方言里没有子类型。
     */
    storage: new Map(),
    /** 同一张表，键与值都**已经 ref 过**（`C.self` 是 ref 过的名字，那边要用这张）。 */
    storageRef: new Map(),
    /** 类名 → `__vt` 的值（根是 0，派生类按登记次序 1、2、…）。 */
    vtId: new Map(),
    /** 同一张表，键**已经 ref 过**。 */
    vtIdRef: new Map(),
    /**
     * **挑哪一份方法**：先试"带实参个数"那个名字（重载的那几份），再试老名字。
     * 两个都没有答 null —— 调用点再报，别在这儿猜。
     */
    pickMethod: (clsRef, mname, argc) => {
      const a = `${clsRef}_${C.ref(mname)}__${argc}`;
      if (C.fns.has(a)) return a;
      const b = `${clsRef}_${C.ref(mname)}`;
      return C.fns.has(b) ? b : null;
    },
    /** 根名（已 ref 过） → 方法名 → [{ vt, fn }]（虚方法的分派表）。 */
    vtab: new Map(),
    /**
     * **挑哪一份重载**（自由函数，按实参**类型**）。两步，照 C++ 的次序：
     *   1. 逐格类型**一模一样**的那份赢；
     *   2. 没有的话，看"每格实参都能转过去"的（这条腿上只认 `int -> double`
     *      与 `bool -> int` 两格提升）—— 剩下**正好一份**才算，不然当场报。
     *
     * 交的是 `{ name, params }`，调用点照 `params` 给实参补转换（方言是严的：
     * 拿 int 去喂 real 形参会当场报，不会悄悄转）。
     */
    pickFn: (base, argTypes) => pickAmong(base, C.ovlFns.get(base) ?? [], argTypes),
    /**
     * **挑哪一份方法**（按实参类型）—— 只有"两份实参个数一样"的名字在这张表里
     * （见 `overloadedByType`）；不在表里答 null，调用点退回按个数挑的老路。
     */
    pickMethodT: (clsRef, mname, argTypes) => {
      const k = `${clsRef}_${C.ref(mname)}`;
      const cands = C.methOvl.get(k);
      return cands === undefined ? null : pickAmong(k, cands, argTypes);
    },
    /** `类名_方法名`（都已 ref 过） → `[{ name, params }]`（params 里**不含** this）。 */
    methOvl: new Map(),
    /**
     * 类名（已 ref 过） → 它那几份构造 `[{ name, params }]`。只有"有两份实参个数一样"的类
     * 在这张表里；造对象那两处（`newLet` 与 `Point(1,2)` 那种函数式的）先查它。
     */
    ctorOvl: new Map(),
    /** 造对象时挑哪一份构造（不在 `ctorOvl` 里答 null —— 调用点退回按个数挑的老路）。 */
    pickCtor: (recRef, argTypes) => {
      const cands = C.ctorOvl.get(recRef);
      return cands === undefined ? null : pickAmong(`${recRef}::构造`, cands, argTypes);
    },
    /**
     * 一格类名 → 类型。**`name` 是落地的记录（可能是根）、`cls` 是写着的那个静态类型** ——
     * 非虚方法按 `cls` 单态分派（C++ 的隐藏规则），虚方法按 `name` 找分派表。
     */
    recType: (n) => ({
      kind: 'named', name: C.ref(C.storage.get(n) ?? n), ref: true, cls: C.ref(n),
    }),
    /** 当前函数里那几格带析构的量（出作用域逆序调一遍）。 */
    scoped: [],
    /** 正在降的这格方法的**接收者类型名**（裸写字段名 = `this->` 那一格靠它）。 */
    self: null,
    /** 正在降的这格函数**写着的返回类型** —— 窄整数交出去那一下要回卷（见 `case 'return'`）。 */
    retType: null,
    /** 正在降的这格 lambda 借走了哪几格量（名字 → 类型）—— 体里它们落成 `(cap …)`。 */
    capNames: new Map(),
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
    ref: (n) => {
      if (!names.has(n)) {
        let s = String(n).replace(/[^A-Za-z0-9_]/g, '_');
        if (/^[0-9]/.test(s)) s = `_${s}`;
        names.set(n, s);
      }
      return names.get(n);
    },
    push: () => scopes.push(new Map()),
    pop: () => scopes.pop(),
    /**
     * **把作用域栈整个换成空的，跑一段，再换回来**。模板实例化发生在**别人的体中间**
     * （调用点），要是不换，模板体里的名字会往外看见调用者的局部量 —— 那是
     * "答案静默地错"那一类（同名的量被借走）。数组的身份要保住，所以用 splice。
     */
    isolate: (f) => {
      const saved = scopes.splice(0, scopes.length, new Map());
      try { return f(); } finally { scopes.splice(0, scopes.length, ...saved); }
    },
    bind: (n, t) => scopes[scopes.length - 1].set(n, t),
    tyCtx: () => ({
      env: {
        get: (n) => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            const v = scopes[i].get(n);
            if (v !== undefined) return v;
          }
          return undefined;
        },
      },
      fns: C.fns,
      fields: recFields,
    }),
    /** 多值那一族合成的记录。`fieldNames` 给了就按它命名（C++ 的 pair 叫 first/second）。 */
    mvType: (types, fieldNames) => {
      const ns = fieldNames ?? types.map((_, i) => `v${i}`);
      const key = `${ns.join(',')}|${types.map((t) => JSON.stringify(t)).join(',')}`;
      if (!mvs.has(key)) {
        const name = `mv${mvs.size + 1}`;
        mvs.set(key, name);
        const fields = types.map((t, i) => ({ name: ns[i], type: t }));
        recFields.set(name, fields);
        decls.push({ kind: 'struct', name, fields });
      }
      return named(mvs.get(key));
    },
  };

  /* ---- 第零遍：模板登记（本身不发代码，等调用点来要）----------------------- */
  for (const d of kids(tree)) {
    if (tag(d) !== 'template') continue;
    const ps = part(d, 'params');
    const tparams = (ps === undefined ? [] : kids(ps))
      .filter((y) => tag(y) === 'tp')
      .map((y) => nameOf(kids(y).find((z) => tag(z) === 'n')));
    const inner = kids(d).find((y) => tag(y) === 'func' || tag(y) === 'decl');
    if (inner === undefined) throw new Error('cpp->IR: 这格 template 里什么都没有');
    if (tag(inner) === 'func') {
      const f = kids(inner).find((y) => tag(y) === 'fn');
      C.templates.set(nameOf(kids(f)[0]), { tparams, fnTok: inner });
      continue;
    }
    /* **类模板**：`template <class T> struct Box { … };`。 */
    const sp = part(inner, 'specs');
    const cls = sp === undefined ? undefined : kids(sp).find((y) => tag(y) === 'class');
    if (cls === undefined) throw new Error('cpp->IR: 这一格 template 还没接（只接函数与类）');
    const clsKids = kids(cls).flatMap((y) => (tag(y) === null && isList(y) ? groupItems(y) : [y]));
    const cn = clsKids.find((y) => tag(y) === 'n');
    C.ctemplates.set(nameOf(cn), { tparams, clsTok: cls });
  }

  /* ---- 第一遍：typedef 与 struct/class ------------------------------------- */
  for (const d of kids(tree)) {
    if (tag(d) !== 'decl') continue;
    const specs = part(d, 'specs');
    if (specs === undefined) continue;
    const isTypedef = kids(specs).some((y) => tag(y) === null && String(leaf(y)) === 'typedef');
    if (isTypedef) {
      const init = part(d, 'init');
      const nm = init === undefined ? undefined : kids(kids(init)[0])[0];
      if (nm !== undefined) C.aliases.set(nameOf(nm), typeOfSpecs(specs, C));
      continue;
    }
    const cls = kids(specs).find((y) => tag(y) === 'class');
    if (cls === undefined) continue;
    const rec = collectClass(cls, C);
    C.records.set(rec.name, rec);
  }
  /**
   * **`static` 数据成员落成模块级的量**（一个类一份，公共层现成的 `{ kind: 'global' }`）。
   * 初值有两个来源：类里那句（`static const int LIMIT = 10;`）与类外那句定义
   * （`int Counter::total = 0;`）—— 后者先扫出来，两者都没有就是零值。
   */
  const staticInit = new Map();
  const staticSets = [];
  for (const d of kids(tree)) {
    if (tag(d) !== 'decl') continue;
    const it = part(d, 'init');
    const dd = it === undefined ? undefined : kids(it)[0];
    const nmTok = dd === undefined ? undefined : kids(dd)[0];
    if (nmTok === undefined || tag(nmTok) !== 'qual') continue;
    const v = part(dd, 'init');
    if (v !== undefined) {
      staticInit.set(`${nameOf(kids(nmTok)[0])}_${nameOf(kids(nmTok)[1])}`, kids(v)[0]);
    }
  }
  for (const [, rec] of C.records) {
    for (const st of (rec.statics ?? [])) {
      const g = `${C.ref(rec.name)}__${C.ref(st.name)}`;
      const tok = st.init !== undefined
        ? kids(st.init)[0] : staticInit.get(`${rec.name}_${st.name}`);
      decls.push({ kind: 'global', name: g, type: st.type });
      /**
       * 方言的 `(global 名字 类型)` **不带初值**（按设计零初始化），初值要在入口里赋 ——
       * 所以非零的那几格攒起来，摆在 `main` 体的最前面（C++ 里 static 也是 main 之前
       * 就初始化好的，这条腿上 main 之前不跑别的东西，两者对得上）。
       */
      if (tok !== undefined) {
        staticSets.push({
          kind: 'assign', target: { kind: 'name', name: g }, value: exprOf(tok, C),
        });
      }
      C.statics.set(`${C.ref(rec.name)}_${st.name}`, g);
    }
  }
  /**
   * **体写在类外的那几格搬回类里**（`int Counter::bump() { … }`）—— 要排在摊平与
   * 虚方法那两趟**之前**：它们读的就是 `rec.methods` / `rec.ctors` / `rec.dtor`。
   * 搬走的那几格不能再当自由函数发一遍，所以顶层函数那份名单从这儿取。
   */
  const topFns = attachOutline(kids(tree).filter((f) => tag(f) === 'func'), C);
  planVirtuals(C, recFields, decls);
  /* **把基类摊进派生类**（字段在前、方法按名字继承）—— 见 `flatten`。 */
  for (const [, rec] of C.records) flatten(rec, C, new Set());
  /* 哪几个方法名在这个类上出现过一次以上 —— 名字怎么编靠它（见 `methodName`）。 */
  for (const [, rec] of C.records) { rec.ovl = overloadedNames(rec); rec.ovlT = overloadedByType(rec); }
  for (const [, rec] of C.records) {
    if (rec.done === true) continue;
    recFields.set(C.ref(rec.name), rec.fields);
    /* 虚继承树那一档**只发根那一格记录**（字段是整棵树的并集 + `__vt`）—— 见 `layoutVirtual`。 */
    if (C.storage.get(rec.name) === rec.name) {
      decls.push({ kind: 'class', name: C.ref(rec.name), fields: rec.fields });
    }
  }
  layoutVirtual(C, recFields, decls);

  /* ---- 第二遍：函数签名（含方法与析构）------------------------------------- */
  const sigOf = (fnTok, selfType, forcedName) => {
    const f = kids(fnTok).find((y) => tag(y) === 'fn');
    const nmTok = kids(f)[0];
    const params = readParams(part(f, 'params'), C);
    const ret = typeOfSpecs(part(fnTok, 'specs'), C) ?? { kind: 'void' };
    const name = forcedName ?? C.ref(nameOf(nmTok));
    const all = selfType === undefined ? params : [{ name: 'this', type: selfType }, ...params];
    return { name, params: all, ret };
  };
  /**
   * **一格模板实例**（单态化）。名字按实参类型编（`maxOf__int` / `maxOf__real`），
   * 第一次要到才把体降一遍 —— 图上一格新节点也没加，落的全是现成的 `fn` + `call`。
   *
   * 类型形参**临时摆进 `C.aliases`**（`typeOfSpecs` 认得那张表），完了还回去：
   * 嵌套实例化（模板里调模板）靠这条就够，因为里层要的是自己那一格绑定。
   * 作用域栈要 `C.isolate` 换空 —— 调用点在别人的体中间，不换就会看见调用者的局部量。
   */
  C.instantiate = (name, types) => {
    const t = C.templates.get(name);
    const inst = `${C.ref(name)}__${types.map(tyTag).join('_')}`;
    if (C.instDone.has(inst)) return inst;
    C.instDone.add(inst);
    const saved = t.tparams.map((p) => C.aliases.get(p));
    t.tparams.forEach((p, i) => C.aliases.set(p, types[i]));
    try {
      const s = sigOf(t.fnTok, undefined, inst);
      C.fns.set(s.name, { params: s.params, ret: s.ret });
      decls.push(C.isolate(() => fnDecl(s, t.fnTok, C)));
    } finally {
      t.tparams.forEach((p, i) => {
        if (saved[i] === undefined) C.aliases.delete(p); else C.aliases.set(p, saved[i]);
      });
    }
    return inst;
  };
  /**
   * **一格类模板的实例**（`Box<int>` → 一格叫 `Box__int` 的普通记录）。
   *
   * 与函数模板同一条路：类型形参临时摆进 `C.aliases`，把**同一棵 `(class …)` 树**
   * 再读一遍 —— `collectClass` / `sigOf` 一个字都不用改。读完当场把类、方法签名、
   * 方法体三样都发掉，并把 `done` 立起来：这一格可能发生在第二、三遍**中间**
   * （`Box<int> mk(int)` 的返回类型），外头那两个遍历看见 `done` 就跳过，不会发第二份。
   */
  C.instClass = (name, types) => {
    const t = C.ctemplates.get(name);
    const inst = `${C.ref(name)}__${types.map(tyTag).join('_')}`;
    if (C.instDone.has(inst)) return C.recType(inst);
    C.instDone.add(inst);
    const saved = t.tparams.map((p) => C.aliases.get(p));
    t.tparams.forEach((p, i) => C.aliases.set(p, types[i]));
    try {
      const rec = collectClass(t.clsTok, C, inst);
      if (rec.virtuals.size > 0) throw new Error('cpp->IR: 类模板 + 虚函数还没接');
      if (rec.declared.size > 0 || rec.declaredCtors.size > 0 || rec.dtorDeclared === true) {
        throw new Error('cpp->IR: 类模板里"只声明不给体"（体写在类外）还没接');
      }
      /**
       * **类模板 + 继承**：基类必须是**已经登记过的普通类**（第一遍收的那些）。
       * 摊平走的是同一份 `flatten` —— 字段接在前面、方法按名字继承、析构串成链。
       * 基类那侧有虚函数就当场报：虚那条路是"整块合成一格记录"，而这一格是第二、三遍
       * 中间现造出来的，`planVirtuals` 那一趟早过去了。
       */
      if (rec.bases.length > 0) {
        for (const bn of rec.bases) {
          const base = C.records.get(bn);
          if (base === undefined) throw new Error(`cpp->IR: 基类 ${bn} 没有登记过`);
          if (base.virtuals.size > 0 || C.vtIdRef.has(C.ref(bn))) {
            throw new Error('cpp->IR: 类模板 + 虚函数（基类那侧）还没接');
          }
          if (C.ctemplates.has(bn)) {
            throw new Error('cpp->IR: 基类本身是类模板（`Derived : Base<T>`）还没接');
          }
        }
        flatten(rec, C, new Set());
      } else {
        /* 没有继承，析构链就是它自己那一格。 */
        rec.dchain = rec.dtor !== null ? [rec.name] : [];
      }
      rec.done = true;
      rec.flat = true;
      C.records.set(inst, rec);
      C.storage.set(inst, inst);
      C.storageRef.set(C.ref(inst), C.ref(inst));
      recFields.set(C.ref(inst), rec.fields);
      decls.push({ kind: 'class', name: C.ref(inst), fields: rec.fields });
      const selfType = C.recType(inst);
      rec.ovl = overloadedNames(rec);
      rec.ovlT = overloadedByType(rec);
      const sigs = rec.methods.map((m) => sigOf(m.tok, selfType, methodName(rec, m, C)));
      sigs.forEach((s, i) => {
        noRefParams(s, `${inst}::${rec.methods[i].name}`);
        C.fns.set(s.name, { params: s.params, ret: s.ret });
        regMethOvl(rec, rec.methods[i], s, C);
      });
      /**
       * **构造与析构**：签名要在体之前全登记好（构造函数体里可能调自己这个类的方法，
       * 而方法体里也可能造一格自己）。落法与非模板那条路**同一条** —— 构造是一格交记录的
       * 普通函数 `Holder__int__ctor1`、析构挂在公共层的作用域出口上。
       */
      const ctorSigs = ctorPlan(C.ref(inst), rec.ctors ?? [], C).map(({ tok, name, byType }) => {
        if (C.fns.has(name)) {
          throw new Error(`cpp->IR: ${inst} 有两份形参一模一样的构造函数`);
        }
        const s = sigOf(tok, undefined, name);
        noRefParams(s, `${inst} 的构造函数`);
        C.fns.set(name, { params: s.params, ret: selfType });
        if (byType) {
          if (!C.ctorOvl.has(C.ref(inst))) C.ctorOvl.set(C.ref(inst), []);
          C.ctorOvl.get(C.ref(inst)).push({ name, params: s.params });
        }
        return s;
      });
      /* 析构按**链**登记（自己先、再一层层往基类走）—— 与非模板那条路同一条。 */
      for (const owner of (rec.dchain ?? [])) {
        C.fns.set(dtorName(C.ref(inst), C.ref(owner)), {
          params: [{ name: 'this', type: selfType }], ret: { kind: 'void' },
        });
      }
      rec.methods.forEach((m, i) => {
        decls.push(C.isolate(() => fnDecl(sigs[i], m.tok, C, C.ref(inst))));
      });
      ctorSigs.forEach((s, i) => {
        decls.push(C.isolate(() => ctorDecl({ ...s, ret: selfType }, rec, rec.ctors[i], C)));
      });
      for (const owner of (rec.dchain ?? [])) {
        const s = {
          name: dtorName(C.ref(inst), C.ref(owner)),
          params: [{ name: 'this', type: selfType }],
          ret: { kind: 'void' },
        };
        /* 体是 `owner` 的、接收者是这格实例 —— 字段已经摊平，所以同一份体逐字成立。 */
        decls.push(C.isolate(() => fnDecl(s, C.records.get(owner).dtor, C, C.ref(inst))));
      }
    } finally {
      t.tparams.forEach((p, i) => {
        if (saved[i] === undefined) C.aliases.delete(p); else C.aliases.set(p, saved[i]);
      });
    }
    return C.recType(inst);
  };
  /**
   * **一格 lambda** → 公共层现成的闭包（`{ kind: 'closure' }` + `make-closure` + `capture`，
   * 与 go 的匿名函数走同一台机器）。图上一格新节点也没加。
   *
   * 三条是这一门自己的：
   *   1. **捕获一律按值**。`[x]` 照抄、`[=]` 扫体里的自由名字（只收"这儿真有这格局部量"的）；
   *      `[&]` / `[&x]` **当场报** —— 按引用要"把局部量提上去"那台机器（go 那侧的 promote）。
   *   2. **返回类型从体里第一句 `return` 推**（C++ 的 `auto` 推导；写了 `-> T` 也认）。
   *   3. 体要换一格干净的作用域（`C.isolate`）—— 不换就会直接看见外层的局部量，
   *      于是该落成 `(cap …)` 的那几格落成了裸名字，**答案静默地错**。
   */
  C.lambda = (tok) => {
    const name = C.fresh('__lam');
    const params = readParams(kids(tok).find((y) => tag(y) === 'params'), C);
    noRefParams({ params }, 'lambda');
    const body = part(tok, 'body');
    const capsTok = kids(tok).find((y) => tag(y) === 'captures');
    const wanted = [];
    let all = false;
    /** 按引用捕的那几格（名字已 ref 过）—— 它们在外头是**盒子**，体里读写走 `.v`。 */
    const refCaps = new Set();
    let allRef = false;
    for (const c of (capsTok === undefined ? [] : kids(capsTok))) {
      if (tag(c) === 'c') { wanted.push(String(leaf(kids(c)[0]))); continue; }
      if (tag(c) === 'c-ref') {
        const n0 = String(leaf(kids(c)[0]));
        wanted.push(n0);
        refCaps.add(C.ref(n0));
        continue;
      }
      if (tag(c) === 'by-value-all') { all = true; continue; }
      if (tag(c) === 'by-ref-all') { all = true; allRef = true; continue; }
      /**
       * **`[this]`**：把接收者借进去（记录本来就是引用语义，所以"按值捕一格记录"
       * 与 C++ 的 `[this]` 是同一件事 —— 改字段改得动那个对象）。
       * 体里裸写的字段名还要当 `this->`，所以 `C.self` 在这一格上**不清空**。
       */
      if (tag(c) === 'c-this') {
        if (C.self === null) throw new Error('cpp->IR: `[this]` 只能在方法体里用');
        wanted.push('this');
        continue;
      }
      throw new Error(`cpp->IR: lambda 的这一格捕获还没接：${tag(c)}`);
    }
    const pnames = new Set(params.map((p) => p.name));
    if (all) {
      for (const n of freeNames(body)) {
        if (pnames.has(C.ref(n))) continue;
        if (C.tyCtx().env.get(C.ref(n)) === undefined) continue;   // 不是局部量（全局 / 函数名）
        if (!wanted.includes(n)) wanted.push(n);
      }
    }
    if (allRef) for (const n of wanted) refCaps.add(C.ref(n));
    const caps = wanted.map((n) => {
      const flat = C.ref(n);
      const t = C.tyCtx().env.get(flat) ?? C.capNames.get(flat);
      if (t === undefined) throw new Error(`cpp->IR: lambda 捕获了 ${n}，可是这儿没有这格量`);
      /**
       * 按引用捕的那格量**必须已经装了盒子**（降体之前那趟扫树干的事）。不是盒子就说明
       * 那两处没对上 —— 当场报，别让它静默地退化成按值捕获。
       */
      if (refCaps.has(flat) && !(t.kind === 'named' && C.refBoxDone.has(t.name))) {
        throw new Error(`cpp->IR: \`[&${n}]\` 按引用捕的那格量没装盒子 ——`
          + ' 只接"这个函数体里声明的标量局部量"那一档');
      }
      return { name: flat, type: t };
    });
    /* 造点上那几格实参 —— **在换作用域之前**算（外面一层自己也可能在一格 lambda 里）。 */
    const capArgs = caps.map((c) => (
      C.tyCtx().env.get(c.name) === undefined && C.capNames.has(c.name)
        ? { kind: 'capture', name: c.name, type: c.type }
        : { kind: 'name', name: c.name }));
    const outer = {
      caps: C.capNames, self: C.self, scoped: C.scoped, refs: C.refNames, ret: C.retType,
    };
    C.capNames = new Map(caps.map((c) => [c.name, c.type]));
    /* 捕了 `this` 才留着 `C.self`（体里裸写的字段名当 `this->`）；别的一律清空。 */
    C.self = wanted.includes('this') ? C.self : null;
    C.scoped = [];
    /**
     * **盒子那张表在 lambda 里只留按引用捕的那几格**：按值捕的那几格在体里就是一格
     * 普通的值（`(cap x)`），走 `.v` 会错；按引用捕的那几格捕进来的是**盒子**，
     * 读写必须走 `.v`（落成 `(field (cap x) v)`）。
     */
    C.refNames = refCaps;
    /**
     * 写着的返回类型（`-> T`）在降体**之前**就要知道 —— 窄整数交出去那一下要回卷。
     * 没写的那一档从体里推（`firstReturn`），推出来的不是"写着的"，不回卷。
     */
    const retTok = kids(tok).find((y) => tag(y) === 'ret');
    const declRet = retTok === undefined
      ? null
      : typeOfSpecs(part(kids(retTok)[0], 'specs') ?? kids(kids(retTok)[0])[0], C);
    C.retType = declRet;
    let stmts;
    let ret;
    try {
      C.isolate(() => {
        C.push();
        for (const p of params) C.bind(p.name, p.type);
        stmts = [
          ...byValueCopies({ params }, C),
          ...narrowParams({ params }, C),
          ...kids(body).flatMap((s) => stmtsOf(s, C)),
        ];
        const rv = firstReturn(stmts);
        ret = rv === null ? { kind: 'void' } : typeOf(rv, C.tyCtx());
        C.pop();
      });
    } finally {
      C.capNames = outer.caps;
      C.self = outer.self;
      C.scoped = outer.scoped;
      C.refNames = outer.refs;
      C.retType = outer.ret;
    }
    if (declRet !== null && declRet !== undefined) ret = declRet;
    decls.push({
      kind: 'closure', name, caps, params, ret, body: stmts,
    });
    return {
      kind: 'make-closure',
      name,
      caps: capArgs,
      type: { kind: 'fn-type', params: params.map((p) => p.type), ret },
    };
  };

  /** 实参类型 → 类型形参的绑定（**只认"形参的类型就是那个形参名"**那一档）。 */
  C.deduce = (name, argTypes) => {
    const t = C.templates.get(name);
    const f = kids(t.fnTok).find((y) => tag(y) === 'fn');
    const ps = part(f, 'params');
    const plist = ps === undefined ? [] : kids(ps).filter((y) => tag(y) === 'p');
    return t.tparams.map((tp) => {
      for (let i = 0; i < plist.length; i += 1) {
        const sp = part(plist[i], 'specs');
        const ns = (sp === undefined ? [] : kids(sp)).filter((y) => tag(y) === 'n').map(nameOf);
        if (ns.includes(tp) && argTypes[i] !== undefined) return argTypes[i];
      }
      throw new Error(`cpp->IR: \`${name}\` 的类型形参 ${tp} 推不出来`
        + '（这一批只认"某个形参的类型就写着它"那一档 —— 显式写出 `f<T>(…)` 也行）');
    });
  };
  /* 顶层函数的签名**要等三格实例化的口子装好之后**才算：`Box<int> mk(int)` 的返回类型
     就是一格用点，算它的时候会现造 `Box__int`。 */
  /**
   * **自由函数的重载**（`int twice(int)` / `double twice(double)`）。
   *
   * 与方法那一格同一条规矩的两半：①**没重载的名字一个字节不动**（别的家族逐字节中性）；
   * ②重载了的按**实参类型**缀名字（`twice__int` / `twice__real`）。方法那一格缀的是
   * 实参**个数** —— 个数一样的两份到现在还是当场报，而自由函数这儿按类型分得开。
   *
   * **Why 非要管**：从前两份同名函数都发成一个名字，方言报的是 `.sx` 里的"重复定义"，
   * 而且**第一份的签名赢了**，第二份的体照第一份的类型去检 —— 报出来的第二条错
   * （"`*` 两边要同型"）根本不是病因。这是"覆盖 vs 追加"那个形状的第五次。
   */
  const topSig = new Map();
  const fnSeen = new Map();
  for (const f of topFns) {
    const fTok = kids(f).find((y) => tag(y) === 'fn');
    const n = C.ref(nameOf(kids(fTok)[0]));
    fnSeen.set(n, (fnSeen.get(n) ?? 0) + 1);
  }
  for (const f of topFns) {
    const s0 = sigOf(f);
    const refIdx = new Set(s0.params.flatMap((p, i) => (p.ref === true ? [i] : [])));
    if ((fnSeen.get(s0.name) ?? 0) < 2) {
      if (refIdx.size > 0) C.refSig.set(s0.name, refIdx);
      topSig.set(f, s0);
      C.fns.set(s0.name, { params: s0.params, ret: s0.ret });
      continue;
    }
    if (refIdx.size > 0) {
      throw new Error(`cpp->IR: \`${s0.name}\` 既重载又有 \`T&\` 形参 —— 还没接`
        + '（调用点挑重载靠实参类型，而借出去那一格给的是盒子）');
    }
    const s = { ...s0, name: `${s0.name}__${s0.params.map((p) => tyTag(p.type)).join('_')}` };
    if (C.fns.has(s.name)) {
      throw new Error(`cpp->IR: \`${s0.name}\` 有两份形参类型一模一样的重载`);
    }
    topSig.set(f, s);
    C.fns.set(s.name, { params: s.params, ret: s.ret });
    if (!C.ovlFns.has(s0.name)) C.ovlFns.set(s0.name, []);
    C.ovlFns.get(s0.name).push({ name: s.name, params: s.params });
  }

  for (const [, rec] of C.records) {
    /* 类模板的实例自己已经把三样都发过了（`C.instClass`）—— 跳过，别发第二份。 */
    if (rec.done === true) continue;
    const selfType = C.recType(rec.name);
    for (const m of rec.methods) {
      const s = sigOf(m.tok, selfType, methodName(rec, m, C));
      /**
       * **方法上的出参**（`void set(int& out)`）：形参表第一格是 `this`，所以实参的下标
       * 要减一。重载与虚方法上仍当场报 —— 前者挑那一份靠实参类型（而借出去那一格给的是
       * 盒子），后者要连分派函数一起转发。
       */
      const mRef = new Set(s.params.flatMap((p, i) => (p.ref === true ? [i - 1] : [])));
      if (mRef.size > 0) {
        if (rec.ovl?.has(m.name) === true || rec.virtuals.has(m.name)) {
          throw new Error(`cpp->IR: ${rec.name}::${m.name} 既是重载/虚方法又有 \`T&\` 形参 —— 还没接`);
        }
        C.refSig.set(s.name, mRef);
        C.refByName.set(m.name, mRef);
      }
      if (C.fns.has(s.name)) {
        throw new Error(`cpp->IR: ${rec.name} 上有两份一模一样的 ${m.name}`);
      }
      C.fns.set(s.name, { params: s.params, ret: s.ret });
      regMethOvl(rec, m, s, C);
    }
    /* **`static` 成员函数**：一格普通函数（没有接收者）。 */
    for (const sf of (rec.statFns ?? [])) {
      const nm3 = `${C.ref(rec.name)}__${C.ref(sf.name)}`;
      const s3 = sigOf(sf.tok, undefined, nm3);
      noRefParams(s3, `${rec.name}::${sf.name}`);
      if (C.fns.has(nm3)) throw new Error(`cpp->IR: ${rec.name}::${sf.name} 有两份`);
      C.fns.set(nm3, { params: s3.params, ret: s3.ret });
      C.statFns.set(`${C.ref(rec.name)}_${sf.name}`, nm3);
    }
    for (const owner of (rec.dchain ?? [])) {
      C.fns.set(dtorName(C.ref(rec.name), C.ref(owner)), {
        params: [{ name: 'this', type: selfType }],
        ret: { kind: 'void' },
      });
    }
    /* **构造函数**交的是一格记录（`Point__ctor(a, b) -> Point`）。名字那一格与方法同理
       分三档（个数一样的两份缀实参类型 —— 见 `ctorPlan`）。 */
    for (const { tok, name, byType } of ctorPlan(C.ref(rec.name), rec.ctors ?? [], C)) {
      if (C.fns.has(name)) {
        throw new Error(`cpp->IR: ${rec.name} 有两份形参一模一样的构造函数`);
      }
      const s = sigOf(tok, undefined, name);
      /**
       * **构造上的出参**（`Sum(int& out)`）：与方法那一格同一台机器，只认"这个类只有
       * 一份构造"那一档 —— 名字定得死，调用点才能在**求值之前**知道哪几格要交盒子。
       * 有两份及以上就当场报（挑那一份靠实参类型，而借出去那一格给的是盒子）。
       */
      const cRef = new Set(s.params.flatMap((p, i) => (p.ref === true ? [i] : [])));
      if (cRef.size > 0) {
        if ((rec.ctors ?? []).length > 1) {
          throw new Error(`cpp->IR: ${rec.name} 的构造既重载又有 \`T&\` 形参 —— 还没接`);
        }
        C.refSig.set(s.name, cRef);
        C.ctorRef.set(C.ref(rec.name), cRef);
      }
      C.fns.set(s.name, { params: s.params, ret: selfType });
      if (byType) {
        const k = C.ref(rec.name);
        if (!C.ctorOvl.has(k)) C.ctorOvl.set(k, []);
        C.ctorOvl.get(k).push({ name: s.name, params: s.params });
      }
    }
  }

  /* **虚方法的分派函数**（签名照声明处那一份抄，第一格实参是接收者）。 */
  for (const { root } of (C.vtRoots ?? [])) {
    const rootRef = C.ref(root);
    for (const [m, t] of C.vtab.get(rootRef)) {
      /* 签名照声明处那一份抄；**纯虚那一格声明处没有体**，那就照分派表里第一份实现抄。 */
      const base = C.fns.get(`${C.ref(t.owner)}_${C.ref(m)}`)
        ?? (t.entries.length > 0 ? C.fns.get(t.entries[0].fn) : undefined);
      if (base === undefined) {
        throw new Error(`cpp->IR: ${t.owner}::${m} 是纯虚的，可一个派生类都没有实现它`);
      }
      C.fns.set(vcallName(rootRef, C.ref(m)), { params: base.params, ret: base.ret });
    }
  }

  /* ---- 第三遍：方法 / 析构 / 函数的体 -------------------------------------- */
  for (const [, rec] of C.records) {
    if (rec.done === true) continue;
    const selfType = C.recType(rec.name);
    for (const m of rec.methods) {
      const s = sigOf(m.tok, selfType, methodName(rec, m, C));
      decls.push(fnDecl(s, m.tok, C, C.ref(rec.name)));
    }
    for (const sf of (rec.statFns ?? [])) {
      const nm3 = `${C.ref(rec.name)}__${C.ref(sf.name)}`;
      /* **体里没有 `this`**，所以 `selfName` 不给 —— 裸写字段名会当场报（正是 C++ 的规矩）；
         但 `static` 数据成员与别的 static 成员函数要认得，那是 `C.statCls` 那一格的事。 */
      const outerStat = C.statCls;
      C.statCls = C.ref(rec.name);
      decls.push(fnDecl(sigOf(sf.tok, undefined, nm3), sf.tok, C));
      C.statCls = outerStat;
    }
    for (const owner of (rec.dchain ?? [])) {
      const s = {
        name: dtorName(C.ref(rec.name), C.ref(owner)),
        params: [{ name: 'this', type: selfType }],
        ret: { kind: 'void' },
      };
      /* 体是 `owner` 的，接收者是 `rec` —— 字段已经摊平，所以同一份体在派生类上逐字成立。 */
      decls.push(fnDecl(s, C.records.get(owner).dtor, C, C.ref(rec.name)));
    }
    for (const { tok, name } of ctorPlan(C.ref(rec.name), rec.ctors ?? [], C)) {
      const s = sigOf(tok, undefined, name);
      decls.push(ctorDecl({ ...s, ret: selfType }, rec, tok, C));
    }
  }
  for (const f of topFns) decls.push(fnDecl(topSig.get(f), f, C));
  /* `static` 成员的初值摆在 `main` 体的最前面（见上面那一段）。 */
  if (staticSets.length > 0) {
    const mainDecl = decls.find((d) => d.kind === 'fn' && d.name === 'main');
    if (mainDecl === undefined) throw new Error('cpp->IR: 有 static 成员可没有 main');
    mainDecl.body = [...staticSets, ...mainDecl.body];
  }
  for (const d of vcallDecls(C)) decls.push(d);

  if (!C.fns.has('main')) throw new Error('cpp->IR: 这份源码里没有 `int main()`');
  return { kind: 'module', decls };
}

/**
 * **虚方法的分派函数**：按 `this.__vt` 走一条 if 链，兜底是**声明处**那一份
 * （多继承时那不一定是块名那一格 —— `ink` 声明在 `Printable` 上）。
 *
 * 为什么是 if 链而不是一格"虚表"：方言里函数不是值（没有函数指针那一族），
 * 而这条链落的全是现成的 `if` + `call` —— 一格新节点也没加。派生类少的时候它也够快。
 */
function vcallDecls(C) {
  const out = [];
  for (const { root } of (C.vtRoots ?? [])) {
    const rootRef = C.ref(root);
    for (const [m, t] of C.vtab.get(rootRef)) {
      const mref = C.ref(m);
      const sig = C.fns.get(vcallName(rootRef, mref));
      const fwd = sig.params.map((p) => ({ kind: 'name', name: p.name }));
      const callTo = (fn) => ({ kind: 'call', fn: { kind: 'name', name: fn }, args: fwd });
      const isVoid = sig.ret.kind === 'void';
      const hand = (fn) => (isVoid
        ? [{ kind: 'expr-stmt', expr: callTo(fn) }, { kind: 'return', values: [] }]
        : [{ kind: 'return', values: [callTo(fn)] }]);
      const body = [];
      for (const e of t.entries) {
        if (!t.abstract && e.vt === t.home) continue;    // 声明处那一份是兜底，摆在最后
        body.push({
          kind: 'if',
          cond: {
            kind: 'binop',
            op: '==',
            left: { kind: 'field', obj: { kind: 'name', name: 'this' }, name: VT },
            right: { kind: 'int', value: e.vt },
          },
          then: hand(e.fn),
          else_: null,
        });
      }
      if (t.abstract) {
        /**
         * **纯虚的兜底**：抽象类造不出对象，所以这一支跑不到；真跑到了就是我们自己
         * 算错了（`__vt` 没设对），那时候停下来比静默地答错强。
         */
        body.push({
          kind: 'builtin-stmt',
          name: 'fail',
          args: [{ kind: 'string', value: `${t.owner}::${m} 是纯虚的（__vt 没设对）` }],
        });
        if (sig.ret.kind !== 'void') body.push({ kind: 'return', values: [zeroFor(sig.ret)] });
        else body.push({ kind: 'return', values: [] });
      } else {
        body.push(...hand(`${C.ref(t.owner)}_${mref}`));
      }
      out.push({
        kind: 'fn', name: vcallName(rootRef, mref), params: sig.params, ret: sig.ret, body,
      });
    }
  }
  return out;
}

/**
 * 体里**第一句交了值的 `return`** 那格表达式（lambda 的返回类型从它推）。
 * 要往 if / while / for / block / scope 里走 —— 不走的话 `[](int x){ if (…) return 1; return 2; }`
 * 会算成"什么都不交"，那是静默地错。
 */
function firstReturn(stmts) {
  for (const s of stmts) {
    if (s === null || s === undefined) continue;
    if (s.kind === 'return') return s.values.length === 0 ? null : s.values[0];
    for (const key of ['then', 'else_', 'body', 'stmts']) {
      const sub = s[key];
      if (!Array.isArray(sub)) continue;
      const v = firstReturn(sub);
      if (v !== null) return v;
    }
  }
  return null;
}

/**
 * 一棵树里出现过的名字（`(n X)`）。`[=]` 那一格用它猜"借走了哪几格量" ——
 * 会多收几个（字段名、函数名也长这样），所以调用点还要再过一道"这儿真有这格局部量"。
 * 多捕一格按值的量不改变答案，少捕一格才会错，所以宁可多收。
 */
function freeNames(tok) {
  const out = [];
  const walk = (t) => {
    if (t === null || t === undefined) return;
    if (tag(t) === 'n') { out.push(nameOf(t)); return; }
    if (!isList(t)) return;
    for (const k of kids(t)) walk(k);
  };
  walk(tok);
  return out;
}

/**
 * 一格 `(class …)` → `{ name, bases, fields, methods, dtor, ctors, virtuals, pure }`。
 * `asName` 给了就用它当记录名（**类模板的实例**走这一格：同一棵树按不同的 `T` 读两遍，
 * 名字是 `Box__int` / `Box__real`）。字段与形参的类型走 `typeOfSpecs`，所以类型形参
 * 只要在 `C.aliases` 里绑着，这一份一个字都不用改。
 */
function collectClass(cls, C, asName = null) {
  /* **带基类的那一档，名字与基类表裹在一格无名表里**（`(class "struct" (· (n …) (bases …)) …)`）
     —— 无名表的孩子是**全部 items**（`cst.js` 文件头那条教训），所以先摊一层再找。 */
  const clsKids = kids(cls).flatMap((y) => (tag(y) === null && isList(y) ? groupItems(y) : [y]));
  const nm = clsKids.find((y) => tag(y) === 'n');
  /* **继承**：`struct Derived : Base {}` 的 `(bases (b (n "Base")))`。 */
  const basesTok = clsKids.find((y) => tag(y) === 'bases');
  const bases = (basesTok === undefined ? [] : kids(basesTok))
    .map((b) => nameOf(kids(b).find((y) => tag(y) === 'n')))
    .filter((b) => b !== null && b !== undefined);
  const members = clsKids.find((y) => tag(y) === 'members');
  const fields = [];
  const methods = [];
  const virtuals = new Set();
  const pure = new Set();
  /** 类里**只声明不给体**的那几格（体写在类外，见 `attachOutline`）。 */
  const declared = new Set();
  const declaredCtors = new Set();
  let dtorDeclared = false;
  /** `static` 的数据成员（一个类一份，落成模块级的量）。 */
  const statics = [];
  /** `static` 的成员函数（没有 `this`，落成一格普通函数）。 */
  const statFns = [];
  let dtor = null;
  const ctors = [];
  for (const m of (members === undefined ? [] : kids(members))) {
    if (tag(m) === 'decl') {
      const ms = part(m, 'specs');
      const mi = part(m, 'init');
      const mn = mi === undefined ? undefined : kids(kids(mi)[0])[0];
      /**
       * **`static` 的数据成员不是字段**，是一格模块级的量（一个类只有一份）。
       * 从前 `static` 在 specs 里被当成修饰丢掉，于是它变成了**每个对象各一份的字段**：
       * `static const int LIMIT = 10;` 落成一格零值字段，`LIMIT - n` 算出来是 `-n` ——
       * **答案静默地错**（这一条是"声明符/说明符上的修饰有没有人看"那个形状的第七次）。
       */
      const isStatic = ms !== undefined
        && kids(ms).some((y) => tag(y) === null && String(leaf(y)) === 'static');
      if (isStatic && mn !== undefined && tag(mn) !== 'fn') {
        statics.push({
          name: nameOf(mn),
          type: typeOfSpecs(ms, C, kids(kids(mi)[0])[0]) ?? INT,
          init: part(kids(mi)[0], 'init'),
        });
        continue;
      }
      /**
       * **纯虚那一格在树上是 `decl` 不是 `func`**：
       * `virtual int area() = 0;` → `(decl (specs "virtual" …) (init (d (fn (n area) …) (init (num 0)))))`。
       * 不认它的后果是"多出一格叫 null 的字段"（`nameOf` 读 `(fn …)` 答 null）—— 静默地错。
       */
      if (mn !== undefined && tag(mn) === 'fn') {
        const zero = kids(kids(mi)[0]).find((y) => tag(y) === 'init');
        const head = kids(mn)[0];
        if (zero === undefined) {
          /**
           * **类里只声明、体写在类外**（`int bump();` + `int Counter::bump() { … }`）。
           * 这一格只把名字记下来（`declared` / `declaredCtors`），体由 `attachOutline`
           * 从顶层那几格 `(fn (qual (n 类) (n 方法)) …)` 搬进来。收不到体就当场报 ——
           * 静默地少一格方法，调用点会变成"这一格方法还没接"，账就不在这儿了。
           */
          const isVirt = ms !== undefined
            && kids(ms).some((y) => tag(y) === null && String(leaf(y)) === 'virtual');
          if (tag(head) === 'dtor') { dtorDeclared = true; continue; }
          if (tag(head) === 'n' && nameOf(head) === nameOf(nm) && ms === undefined) {
            const ps = part(mn, 'params');
            declaredCtors.add(ps === undefined ? 0 : kids(ps).filter((y) => tag(y) === 'p').length);
            continue;
          }
          if (tag(head) !== 'n' && tag(head) !== 'opname') {
            throw new Error('cpp->IR: 这一格"只声明不给体"的成员还没接');
          }
          const pn0 = tag(head) === 'opname' ? opMethodName(head) : nameOf(head);
          declared.add(pn0);
          if (isVirt) virtuals.add(pn0);
          continue;
        }
        const pn = nameOf(head);
        virtuals.add(pn);
        pure.add(pn);
        continue;
      }
      /**
       * **数组字段**（`int xs[3];`）：从前 `nameOf` 读 `(array (n xs) (num 3))` 答 null ——
       * 字段表里多出一格叫 `null` 的、而 `xs` 根本不存在（方言报"类 Bag 没有字段 xs"，
       * 病因不在那儿）。现在收成一格列表字段，**长度也记下来** —— 造对象时要照它开格子。
       */
      if (mn !== undefined && tag(mn) === 'array') {
        const inner = kids(mn).find((y) => tag(y) === 'n');
        const numTok = kids(mn).find((y) => tag(y) === 'num');
        fields.push({
          name: nameOf(inner),
          type: arrOf(typeOfSpecs(ms, C, inner) ?? INT),
          size: numTok === undefined ? 0 : Number(leaf(kids(numTok)[0])),
        });
        continue;
      }
      if (mn !== undefined) {
        fields.push({ name: nameOf(mn), type: typeOfSpecs(ms, C, kids(kids(mi)[0])[0]) ?? INT });
      }
      continue;
    }
    if (tag(m) === 'func') {
      const f = part(m, 'fn') ?? kids(m).find((y) => tag(y) === 'fn');
      const head = f === undefined ? undefined : kids(f)[0];
      if (head !== undefined && tag(head) === 'dtor') { dtor = m; continue; }
      /* **构造函数**：名字与类同名、而且**没有返回类型那一格**。 */
      if (head !== undefined && tag(head) === 'n' && nameOf(head) === nameOf(nm)
        && part(m, 'specs') === undefined) { ctors.push(m); continue; }
      const mn2 = (head !== undefined && tag(head) === 'opname')
        ? opMethodName(head) : nameOf(kids(f)[0]);
      /* `virtual` 是 specs 里的一格光秃秃的词。 */
      const ms2 = part(m, 'specs');
      /**
       * **`static` 的成员函数就是一格没有 `this` 的普通函数**（名字 `类名__名字`）。
       * 不收进 `methods` —— 那张表里的每一格都会带一格接收者。
       */
      if (ms2 !== undefined
        && kids(ms2).some((y) => tag(y) === null && String(leaf(y)) === 'static')) {
        statFns.push({ tok: m, name: mn2 });
        continue;
      }
      if (ms2 !== undefined
        && kids(ms2).some((y) => tag(y) === null && String(leaf(y)) === 'virtual')) {
        virtuals.add(mn2);
      }
      methods.push({ tok: m, name: mn2 });
    }
  }
  return {
    name: asName ?? nameOf(nm), bases, fields, methods, dtor, ctors, virtuals, pure,
    declared, declaredCtors, dtorDeclared, statics, statFns,
  };
}

/**
 * **体写在类外的那几格搬回类里**：`int Counter::bump() { … }` 在树上是一格**顶层** `func`，
 * 声明符的名字是 `(qual (n Counter) (n bump))`。
 *
 * 为什么不在类里就地留个"待补"的壳：类那一遍读完才知道有哪几个类，而 `Counter::bump`
 * 的归属只看声明符 —— 一趟扫顶层就分得清。搬完之后后面几遍（摊平、重载编名、签名、
 * 发体）一个字都不用改：它们只看 `rec.methods` / `rec.ctors` / `rec.dtor`。
 *
 * 交的是**剩下的顶层函数**（搬走的那几格不能再当自由函数发一遍）。
 */
function attachOutline(topFns, C) {
  const rest = [];
  for (const fnTok of topFns) {
    const f = kids(fnTok).find((y) => tag(y) === 'fn');
    const head = f === undefined ? undefined : kids(f)[0];
    if (head === undefined || tag(head) !== 'qual') { rest.push(fnTok); continue; }
    const owner = nameOf(kids(head)[0]);
    const member = kids(head)[1];
    const rec = C.records.get(owner);
    if (rec === undefined) throw new Error(`cpp->IR: \`${owner}::…\` 的 ${owner} 不是登记过的类`);
    if (tag(member) === 'dtor') {
      if (rec.dtor !== null) throw new Error(`cpp->IR: ${owner} 有两份析构函数`);
      rec.dtor = fnTok;
      continue;
    }
    const mn = tag(member) === 'opname' ? opMethodName(member) : nameOf(member);
    /* 构造函数：名字与类同名、而且没有返回类型那一格（与类里那一档同一条判据）。 */
    if (mn === owner && part(fnTok, 'specs') === undefined) { rec.ctors.push(fnTok); continue; }
    rec.methods.push({ tok: fnTok, name: mn });
    rec.declared.delete(mn);
  }
  /**
   * **只声明、体没找着**：那一格调用点会变成"这一格方法还没接"，账就不在这儿了 ——
   * 所以在这儿当场报。构造函数那一档按**实参个数**核对。
   */
  for (const [, rec] of C.records) {
    for (const n of rec.declared) {
      throw new Error(`cpp->IR: ${rec.name}::${n} 只声明了，这份源码里没有它的体`);
    }
    if (rec.dtorDeclared === true && rec.dtor === null) {
      throw new Error(`cpp->IR: ${rec.name} 的析构只声明了，这份源码里没有它的体`);
    }
    for (const argc of rec.declaredCtors) {
      if (!rec.ctors.some((ct) => ctorArity(ct) === argc)) {
        throw new Error(`cpp->IR: ${rec.name} 收 ${argc} 个实参的构造函数只声明了，`
          + '这份源码里没有它的体');
      }
    }
  }
  return rest;
}

/**
 * **哪几棵继承树要合成一格记录**（`C.storage` / `C.vtId`）。
 *
 * 判据只有一条：树里**有人写了 `virtual`**。没写的（`inherit.cpp` 那一族）照旧一类一格
 * 记录、方法静态分派 —— 那条路已经全绿，不为这一格去动它。
 *
 * **Why 合成一格**：方言的记录没有子类型，`Shape* p = &r;` 在"两格互不相关的记录"上
 * 根本表示不出来。合成一格（字段是并集 + 一格 `__vt` 标记）之后它就是一格普通赋值，
 * 而"按真身分派"落成按 `__vt` 走的 if 链 —— 图上一格新节点也没加。
 */
function planVirtuals(C, recFields, decls) {
  /**
   * 分组按**连通块**，不按"往上走找根"：`Box : Shape, Printable` 有两个基类，
   * "根"不止一格。把继承那几条边当**无向**的一并连起来，整块合成一格记录之后
   * "通过第二基类的指针调"就只是同一格记录上的另一种静态类型。
   *
   * 块的名字取**块里第一格登记的类**（C++ 里基类一定先声明，所以那一格没有基类）。
   */
  const find = new Map();
  const root0 = (n) => {
    let r = n;
    while (find.get(r) !== r) r = find.get(r);
    return r;
  };
  for (const [n] of C.records) find.set(n, n);
  for (const [n, rec] of C.records) {
    for (const bn of rec.bases) {
      if (!find.has(bn)) throw new Error(`cpp->IR: 基类 ${bn} 没有登记过`);
      const a = root0(n);
      const b = root0(bn);
      if (a !== b) find.set(a, b);          // 合成一块（谁指谁不要紧，名字另取）
    }
  }
  /* 每块的成员表（块名 → 块里的类，按登记次序）。 */
  const trees = new Map();
  for (const [n] of C.records) {
    const r = root0(n);
    if (!trees.has(r)) trees.set(r, []);
    trees.get(r).push(n);
  }
  for (const [, members] of trees) {
    const root = members[0];
    const anyVirtual = members.some((n) => C.records.get(n).virtuals.size > 0);
    if (!anyVirtual) {
      for (const n of members) { C.storage.set(n, n); C.storageRef.set(C.ref(n), C.ref(n)); }
      continue;
    }
    members.forEach((n, i) => {
      C.storage.set(n, root);
      C.storageRef.set(C.ref(n), C.ref(root));
      C.vtId.set(n, i);
      C.vtIdRef.set(C.ref(n), i);
    });
    C.vtRoots = C.vtRoots ?? [];
    C.vtRoots.push({ root, members });
  }
  /* 这两个实参只是让调用点读起来是"三件事一起算"，这一趟不用它们。 */
  void recFields; void decls;
}

/** `__vt` 那一格字段的名字（用户写不出这个名字 —— 双下线开头是留给我们的）。 */
const VT = '__vt';

/**
 * 虚继承树的**落地**：根那一格记录的字段 = 整棵树的并集 + `__vt`，
 * 再给每个虚方法发一格**分派函数** `根__v_方法(this, …)` —— 按 `__vt` 走 if 链，
 * 兜底是根自己那一份（`__vt` 为 0 就是基类的对象）。
 */
function layoutVirtual(C, recFields, decls) {
  for (const { root, members } of (C.vtRoots ?? [])) {
    const union = [];
    for (const n of members) {
      for (const f of C.records.get(n).fields) {
        if (!union.some((y) => y.name === f.name)) union.push(f);
      }
    }
    union.push({ name: VT, type: INT });
    const rootRef = C.ref(root);
    recFields.set(rootRef, union);
    const cls = decls.find((d) => d.kind === 'class' && d.name === rootRef);
    cls.fields = union;
    C.vtUnion = C.vtUnion ?? new Map();
    C.vtUnion.set(rootRef, union);
    /**
     * 分派表：一格虚方法名 → `{ home, abstract, entries }`。
     *   * `home` 是**最先声明它的那一格**的 `__vt`（多继承时那不一定是块名那一格 ——
     *     `ink` 声明在 `Printable` 上，而块名可能是 `Shape`）；
     *   * `abstract` 是"声明处没有体"（纯虚）；
     *   * `entries` 只收**真有一份体**的类（没覆盖纯虚的中间层不该进链）。
     */
    const tab = new Map();
    const names = new Set(members.flatMap((n) => [...C.records.get(n).virtuals]));
    for (const name of names) {
      for (const n of members) {
        if (C.records.get(n).ovl?.has(name) === true) {
          throw new Error(`cpp->IR: ${n} 上的 ${name} 既是虚方法又重载了 —— 还没接`);
        }
      }
      const homeName = members.find((n) => C.records.get(n).virtuals.has(name));
      const has = (n) => C.records.get(n).methods.some((m) => m.name === name);
      const entries = members
        .filter(has)
        .map((n) => ({ vt: C.vtId.get(n), fn: `${C.ref(n)}_${C.ref(name)}` }));
      if (entries.length === 0) {
        throw new Error(`cpp->IR: ${homeName}::${name} 是纯虚的，可一个派生类都没有实现它`);
      }
      tab.set(name, { home: C.vtId.get(homeName), abstract: !has(homeName), owner: homeName, entries });
    }
    C.vtab.set(rootRef, tab);
  }
}

/** 这个类上**出现过一次以上**的方法名（重载）。 */function overloadedNames(rec) {
  const cnt = new Map();
  for (const m of rec.methods) cnt.set(m.name, (cnt.get(m.name) ?? 0) + 1);
  return new Set([...cnt].filter(([, n]) => n > 1).map(([k]) => k));
}

/**
 * 这个类上**有两份实参个数一样**的方法名 —— 那几个要按**类型**分（`methodName` 第三档）。
 * 从前这一格是当场报（方言会看见两份同名的函数）。
 */
function overloadedByType(rec) {
  const seen = new Set();
  const out = new Set();
  for (const m of rec.methods) {
    const k = `${m.name}/${ctorArity(m.tok)}`;
    if (seen.has(k)) out.add(m.name);
    seen.add(k);
  }
  return out;
}

/**
 * **把基类摊进派生类**（单继承与多继承都走这一格，按声明次序）。
 *
 * 落法是**摊平**：字段表 = 基类的接在自己前面（C++ 的布局也是这样）、
 * 方法按**名字**继承（派生类自己那一份赢 —— C++ 的隐藏规则）。
 * 为什么不给方言加"基类"那一格：方言的记录只有一张字段表，摊平之后
 * `d.基类字段` 与 `d.自己的字段` 在同一格记录上，三条腿一格都不用改。
 *
 * 继承来的方法**按派生类再发一份体**（接收者的类型不同，方言那侧是两格类型）——
 * 字段已经摊平了，所以同一份体在派生类上逐字成立。
 */
function flatten(rec, C, seen) {
  if (rec.flat === true) return;
  if (seen.has(rec.name)) {
    throw new Error(`cpp->IR: 继承成环了（${[...seen, rec.name].join(' -> ')}）`);
  }
  const next = new Set([...seen, rec.name]);
  const fields = [];
  const methods = [];
  for (const bn of rec.bases ?? []) {
    const base = C.records.get(bn);
    if (base === undefined) throw new Error(`cpp->IR: 基类 ${bn} 没有登记过`);
    flatten(base, C, next);
    for (const f of base.fields) {
      /**
       * **两个基类都有这个字段名**（菱形里的公共祖先，或者两个基类各自叫了同一个名字）：
       * C++ 那边是**两份独立的字段**（要写 `B::x` / `C::x` 才分得开），而摊平只有一张表 ——
       * 并成一份就是静默地答错。所以当场报。
       */
      const dup = fields.find((y) => y.name === f.name);
      if (dup !== undefined) {
        throw new Error(`cpp->IR: ${rec.name} 的两个基类都有字段 ${f.name}`
          + '（摊平只有一张表，并成一份会静默地答错）—— 菱形继承还没接');
      }
      fields.push(f);
    }
    for (const m of base.methods) methods.push(m);
  }
  /* 派生类自己写了同名字段 = **遮住**基类那一份（C++ 允许）；摊平只有一张表，所以当场报。 */
  for (const f of rec.fields) {
    if (fields.some((y) => y.name === f.name)) {
      throw new Error(`cpp->IR: ${rec.name} 自己的字段 ${f.name} 遮住了基类同名的那一份`
        + '（摊平只有一张表）—— 还没接');
    }
    fields.push(f);
  }
  /* 派生类自己那一份**盖掉**同名的基类方法。 */
  const own = new Set(rec.methods.map((m) => m.name));
  rec.methods = [...methods.filter((m) => !own.has(m.name)), ...rec.methods];
  rec.fields = fields;
  /**
   * **析构链**：自己那一份先跑，再一层层往基类走（C++ 的次序）。中间层没有析构就跳过它。
   * 从前只记一份 `dtor` 且不串链 —— `Mid m;` 出作用域只跑 `~Mid()`，`~Base()`
   * 那一段**安静地没跑**。
   */
  rec.dchain = [
    ...(rec.dtor !== null ? [rec.name] : []),
    ...(rec.bases ?? []).flatMap((bn) => C.records.get(bn).dchain ?? []),
  ];
  rec.flat = true;
}

/**
 * 一格函数。**析构交给公共层的作用域出口**（`{ kind: 'scope', stmts, exits }`）——
 * 从前这一份自己在"体的末尾"与"每个 `return` 前面"各补一遍，那是六门语言里第六份同样的
 * 代码，而且漏一个出口（跳出函数的 `break`、`if` 里的 `return`）就是**静默地少跑一段**。
 * 现在只交两样：体，与那几句出口动作（**逆序** —— 那是 C++ 的规矩，不是公共层的）。
 */
function fnDecl(sig, fnTok, C, selfName = null) {
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  const outerScoped = C.scoped;
  const outerSelf = C.self;
  const outerRefs = C.refNames;
  const outerRet = C.retType;
  /**
   * **这一格函数里哪几个名字装在盒子里**：引用形参，加上"体里被借出去"的那几格局部量
   * （`borrowedLocals` 先扫一趟树 —— 声明那一句要发成盒子，所以得在降体**之前**知道）。
   */
  C.refNames = new Set(sig.params.filter((p) => p.ref === true).map((p) => p.name));
  for (const n of borrowedLocals(fnTok, C)) C.refNames.add(n);
  C.self = selfName;
  C.retType = sig.ret;
  C.scoped = [];
  const body = part(fnTok, 'body');
  const stmts = [
    ...byValueCopies(sig, C),
    ...narrowParams(sig, C),
    ...(body === undefined ? [] : kids(body).flatMap((s) => stmtsOf(s, C))),
  ];
  const exits = dtorCalls(C);
  C.scoped = outerScoped;
  C.self = outerSelf;
  C.refNames = outerRefs;
  C.retType = outerRet;
  C.pop();
  return {
    kind: 'fn',
    name: sig.name,
    params: sig.params,
    ret: sig.ret,
    body: exits.length === 0 ? stmts : [{ kind: 'scope', stmts, exits }],
  };
}

/**
 * **一格构造函数**。落成"造一格零值记录 → 跑成员初始化表 → 跑体 → 交出去"的普通函数：
 *
 *   Point__ctor(a, b) -> Point { let this = Point{x:0,y:0,sum:0}; this.x=a; this.y=b; …; return this }
 *
 * 两条是 C++ 的规矩，不是公共层的：
 *   1. 成员初始化表**按字段声明的次序**跑（不按表里写的次序 —— 那一格写反了答案会静默地错）；
 *   2. 体里裸写的名字先查形参、再查字段（`C.self` 那条既有规矩，见 expr.js 的 `case 'n'`）。
 */
function ctorDecl(sig, rec, ctorTok, C) {
  const recName = C.ref(rec.name);
  const selfType = C.recType(rec.name);
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  C.bind('this', selfType);
  const outerScoped = C.scoped;
  const outerSelf = C.self;
  const outerRet = C.retType;
  const outerRefs = C.refNames;
  /* 这格构造里哪几个名字装在盒子里（出参 + 体里被借出去的那几格局部量）—— 与 `fnDecl` 同。 */
  C.refNames = new Set(sig.params.filter((p) => p.ref === true).map((p) => p.name));
  for (const n of borrowedLocals(ctorTok, C)) C.refNames.add(n);
  C.self = recName;
  /* 构造交出去的是那格记录 —— 体里的 `return;` 上没有窄整数要回卷。 */
  C.retType = null;
  C.scoped = [];
  const stmts = [...byValueCopies(sig, C), ...narrowParams(sig, C), {
    kind: 'let',
    name: 'this',
    type: selfType,
    /* 零值记录走同一份（虚继承树上那一格要带 `__vt`，字段表也是并集）。 */
    init: vtZeroRecord(selfType, C),
  }];
  /* 成员初始化表 —— 按**字段声明的次序**，不按表里写的次序。 */
  const initTok = kids(ctorTok).find((y) => tag(y) === 'ctor-init');
  const inits = new Map();
  for (const mi of (initTok === undefined ? [] : kids(initTok))) {
    if (tag(mi) !== 'mi') continue;
    const args = part(mi, 'args');
    if (args === undefined || kids(args).length !== 1) {
      throw new Error('cpp->IR: 成员初始化表这一格还没接（只接 `字段(一格表达式)`）');
    }
    inits.set(nameOf(kids(mi)[0]), kids(args)[0]);
  }
  for (const f of rec.fields) {
    const e = inits.get(f.name);
    if (e === undefined) continue;
    stmts.push({
      kind: 'assign',
      target: { kind: 'field', obj: { kind: 'name', name: 'this' }, name: f.name },
      value: exprOf(e, C),
    });
  }
  const body = part(ctorTok, 'body');
  if (body !== undefined) for (const s of kids(body)) stmts.push(...stmtsOf(s, C));
  stmts.push({ kind: 'return', values: [{ kind: 'name', name: 'this' }] });
  const exits = dtorCalls(C);
  C.scoped = outerScoped;
  C.self = outerSelf;
  C.retType = outerRet;
  C.refNames = outerRefs;
  C.pop();
  return {
    kind: 'fn',
    name: sig.name,
    params: sig.params,
    ret: selfType,
    body: exits.length === 0 ? stmts : [{ kind: 'scope', stmts, exits }],
  };
}

/**
 * 一格**带 `__vt` 的零值记录**。字段表取的是**落地那格记录**的（虚继承树上那是并集），
 * 所以派生类自己那几格也在里头 —— 少一格 `new-record` 就会缺字段。
 */
function vtZeroRecord(type, C) {
  const fs = C.tyCtx().fields.get(type.name) ?? [];
  const id = C.vtIdRef.get(type.cls) ?? 0;
  return {
    kind: 'new-record',
    type,
    ref: true,
    fields: fs.map((f) => ({
      name: f.name,
      value: f.name === VT ? { kind: 'int', value: id } : zeroField(f, C),
    })),
  };
}

/**
 * 一格**字段**的零值。数组字段要照写着的长度开格子（`int xs[3]` → `anew(T, 3)`）——
 * 照 `zeroFor` 那条走的话开的是 0 格，`xs[0] = 10` 就越界了。
 */
function zeroField(fld, C) {
  if (fld.type.kind === 'arr' && fld.size !== undefined) {
    return {
      kind: 'builtin',
      name: 'anew',
      args: [tyArg(fld.type), { kind: 'int', value: fld.size }],
    };
  }
  return zeroFor(fld.type, C);
}

/** 一格类型的零值（构造函数先造一格全零的记录，再让初始化表与体去改）。 */function zeroFor(t, C) {
  switch (t.kind) {
    case 'int': return { kind: 'int', value: 0 };
    case 'real': return { kind: 'real', value: 0 };
    case 'bool': return { kind: 'bool', value: false };
    case 'string': return { kind: 'string', value: '' };
    case 'arr': return { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: 0 }] };
    case 'map': return { kind: 'builtin', name: 'dnew', args: [tyArg(t)] };
    /**
     * **字段本身是一格记录**：要造一格零值的子记录，不能留 null —— 留 null 的后果是
     * `a.in.v = 5` 在运行期"null reference"（C++ 那边子对象是现成的）。
     */
    case 'named':
      if (C === undefined) throw new Error('cpp->IR: 嵌套记录的零值要 C（内部错）');
      return vtZeroRecord(t, C);
    default:
      throw new Error(`cpp->IR: 构造函数里 ${t.kind} 那一格字段的零值还没接`);
  }
}

/**
 * 当前函数里那几格带析构的量 → **量之间逆序**（C++ 的规矩），
 * 每格量**按析构链的次序**（自己那一份先、再往基类走）各调一次。
 */
function dtorCalls(C) {
  return [...C.scoped].reverse().flatMap((v) => v.chain.map((owner) => ({
    kind: 'expr-stmt',
    expr: {
      kind: 'call',
      fn: { kind: 'name', name: dtorName(C.ref(v.rec), C.ref(owner)) },
      args: [{ kind: 'name', name: v.name }],
    },
  })));
}

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

export function stmtsOf(x, C) {
  switch (tag(x)) {
    case 'block': {
      C.push();
      const stmts = kids(x).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'block', stmts }];
    }
    case 'pp': case 'namespace': case 'template': case 'using': return [];
    case 'expr': {
      const inner = kids(x)[0];
      /* `printf(…)` / `puts(…)` 是语句（它们不交值）。 */
      if (tag(inner) === 'call' && tag(kids(inner)[0]) === 'n') {
        const nm = nameOf(kids(inner)[0]);
        if (nm === 'printf' || nm === 'puts') {
          const argsTok = part(inner, 'args');
          return printArgs(nm, argsTok === undefined ? [] : kids(argsTok), C);
        }
      }
      if (tag(inner) === 'assign') return [assignOf(inner, C)];
      if (tag(inner) === 'post' || tag(inner) === 'pre') return [stepOf(inner, C)];
      return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
    }
    case 'assign': return [assignOf(x, C)];
    case 'post': case 'pre': return [stepOf(x, C)];
    /* `int acc = 0;` / `int xs[3] = {…};` / `Point p = {1,2};` / `Say s1;` / `auto t = …`。 */
    case 'decl': {
      const specs = part(x, 'specs');
      /* 结构体/类的声明（`struct Point { … };`）已经在第一遍收过了。 */
      if (specs !== undefined && kids(specs).some((y) => tag(y) === 'class' || tag(y) === 'elaborated')) return [];
      if (specs !== undefined && kids(specs).some((y) => tag(y) === null && String(leaf(y)) === 'typedef')) return [];
      const out = [];
      for (const d of kids(x).filter((y) => tag(y) === 'init')) {
        out.push(declOf(d, specs, C));
      }
      return out;
    }
    case 'if': {
      const parts = kids(x);
      const cond = condOf(parts[0], C);
      const then = stmtsOf(parts[1], C);
      const elseTok = parts.slice(2).find((y) => tag(y) === 'else');
      const els = elseTok === undefined ? null : kids(elseTok).flatMap((s) => stmtsOf(s, C));
      return [{ kind: 'if', cond, then, else_: els }];
    }
    case 'while': {
      const cond = condOf(kids(x)[0], C);
      C.push();
      const body = kids(x).slice(1).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'while', cond, body }];
    }
    /* `for (init; cond; post) body` —— 三段式（公共降级器会把 `continue` 那一格摆对）。 */
    case 'for': {
      const [initTok, condTok, postTok, ...rest] = kids(x);
      C.push();
      const init = initTok === undefined || tag(initTok) === null ? null : stmtsOf(initTok, C)[0];
      const cond = condTok === undefined || tag(condTok) === null ? null : condOf(condTok, C);
      const post = postTok === undefined || tag(postTok) === null ? null : stmtsOf(postTok, C)[0];
      const body = rest.flatMap((s) => stmtsOf(s, C));
      C.pop();
      return [{ kind: 'for', init, cond, post, body }];
    }
    /**
     * `for (T v : xs)` —— **按值在列表上走一遍**。C++ 里它就是一格下标循环，所以直接
     * 摊成三段式的 `for`（公共层那格 `for-range` 要一份语言钩子 —— "在什么上走一遍"
     * 各门语言答得不一样，而这一门的答案就是"下标从 0 到 alen"，没必要再加一层）。
     * 那格量是**拷出来的**（记录就走 `类名__copy`）；`for (T& v : xs)` 当场报。
     */
    case 'for-range': {
      const [, declTok, iterTok, bodyTok] = kids(x);
      /**
       * `for (T& v : xs)`（**改得动元素**那一档）：`v` 不是一格新量，它就是 `xs[i]`
       * 的**别名** —— 读写都摊成那一格下标（见 expr.js 的 `C.lvAlias`）。
       * 只认 `&`；`&&`（右值引用）在这条腿上没有意义，当场报。
       */
      const byRef = tag(declTok) === 'ptr'
        && kids(declTok).some((y) => tag(y) === null && String(leaf(y)) === '&');
      if (tag(declTok) === 'ptr' && !byRef) {
        throw new Error('cpp->IR: `for (T&& v : …)` 还没接');
      }
      const iter = exprOf(iterTok, C);
      const it = typeOf(iter, C.tyCtx());
      if (it.kind !== 'arr') {
        throw new Error(`cpp->IR: 只接在列表上走一遍（这儿是 ${it.kind}）`);
      }
      const elem = typeOfSpecs(part(x, 'specs'), C, declTok) ?? it.elem;
      const vname = C.ref(nameOf(byRef ? kids(declTok)[kids(declTok).length - 1] : declTok));
      const idx = C.fresh('ri');
      C.push();
      C.bind(idx, INT);
      const at = { kind: 'index', obj: iter, index: { kind: 'name', name: idx } };
      let rbody;
      if (byRef) {
        C.lvAlias.set(vname, at);
        rbody = stmtsOf(bodyTok, C);
        C.lvAlias.delete(vname);
      } else {
        C.bind(vname, elem);
        rbody = [{
          kind: 'let', name: vname, type: elem, init: copyIfLv(at, elem, C),
        }, ...stmtsOf(bodyTok, C)];
      }
      C.pop();
      return [{
        kind: 'for',
        init: { kind: 'let', name: idx, type: INT, init: { kind: 'int', value: 0 } },
        cond: {
          kind: 'binop',
          op: '<',
          left: { kind: 'name', name: idx },
          right: { kind: 'builtin', name: 'alen', args: [iter] },
        },
        post: {
          kind: 'assign',
          target: { kind: 'name', name: idx },
          value: {
            kind: 'binop', op: '+', left: { kind: 'name', name: idx }, right: { kind: 'int', value: 1 },
          },
        },
        body: rbody,
      }];
    }
    /**
     * `switch` —— 落公共层现成的那一格（它摊成 if/else 链）。**两处与 C++ 不一样，要认清**：
     *   1. C++ 是**穿透**的（不写 `break` 就往下掉），而公共层那一格每一支各自独立 ——
     *      所以每一组末尾那句 `break` 要**摘掉**（它的意思是"出 switch"，而公共层的
     *      `break` 是"出循环"，留着就跳错了）；**没有 `break` 又不是最后一组**的当场报，
     *      别静默地把穿透改成不穿透。
     *   2. 树上每格 `case` 只带**一条**语句（`(case v stmt)`），剩下的是它后面的兄弟 ——
     *      所以要自己按 `case` / `default` **分组**。
     */
    case 'switch': {
      const [condTok, bodyTok] = kids(x);
      const items = tag(bodyTok) === 'block' || tag(bodyTok) === null
        ? kids(bodyTok) : [bodyTok];
      const groups = [];
      /**
       * 一格 `case` 带的那条语句**可能又是一格 `case`**（`case 2: case 3: …` —— 树上是
       * 套起来的）：那是"两个值共用一份体"，摊成两格 case（各发一份体，语义一样）。
       */
      const push = (it) => {
        const first = kids(it)[tag(it) === 'case' ? 1 : 0];
        if (first !== undefined && (tag(first) === 'case' || tag(first) === 'default')) {
          groups.push({ tok: it, stmts: [], share: true });
          push(first);
          return;
        }
        groups.push({ tok: it, stmts: first === undefined ? [] : [first] });
      };
      for (const it of items) {
        if (tag(it) === 'case' || tag(it) === 'default') { push(it); continue; }
        if (groups.length === 0) throw new Error('cpp->IR: switch 里第一句不是 case/default');
        groups[groups.length - 1].stmts.push(it);
      }
      const cases = [];
      let default_ = null;
      groups.forEach((g, gi) => {
        /* 共用体的那几格（`case 2:` 紧跟着 `case 3:`）借下一组的体。 */
        if (g.share === true) {
          const host = groups.slice(gi + 1).find((y) => y.share !== true);
          if (host === undefined) throw new Error('cpp->IR: switch 里这一格 case 没有体');
          g.stmts = host.stmts;
        }
        const last = g.stmts[g.stmts.length - 1];
        const hasBreak = last !== undefined && tag(last) === 'break';
        const isLastReal = groups.slice(gi + 1).every((y) => y.share === true);
        const ends = hasBreak || (last !== undefined && tag(last) === 'return');
        if (!ends && !isLastReal && g.stmts.length > 0) {
          throw new Error('cpp->IR: switch 的这一支会**穿透**到下一支 —— 还没接（补一句 break）');
        }
        const body = (hasBreak ? g.stmts.slice(0, -1) : g.stmts).flatMap((t2) => stmtsOf(t2, C));
        if (tag(g.tok) === 'default') { default_ = body; return; }
        const mt = kids(g.tok)[0];
        if (tag(mt) === 'range') throw new Error('cpp->IR: `case a ... b`（区间）还没接');
        cases.push({ match: exprOf(mt, C), body });
      });
      return [{
        kind: 'switch', value: exprOf(condTok, C), cases, default_,
      }];
    }
    case 'return': {
      /* 析构不在这儿补 —— 公共层那一格 `scope` 在**每个**出口上补（见 `fnDecl`）。 */
      const vs = kids(x);
      /* 交出去那一下也要回卷（`unsigned char f(int x) { return x; }`，`f(300)` 是 44）。 */
      return [{
        kind: 'return',
        values: vs.length === 0 ? [] : [wrapNarrow(exprOf(vs[0], C), C.retType)],
      }];
    }
    case 'break': return [{ kind: 'break', label: null }];
    case 'continue': return [{ kind: 'continue', label: null }];
    case 'func':
      throw new Error('cpp->IR: 函数里套函数（lambda）还没接');
    default:
      throw new Error(`cpp->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** `i++` / `++i` / `i--` → 一格赋值。 */
function stepOf(x, C) {
  const op = String(leaf(kids(x)[0])) === '++' ? '+' : '-';
  const target = lhsOf(kids(x)[1], C);
  const step = { kind: 'binop', op, left: target, right: { kind: 'int', value: 1 } };
  return {
    kind: 'assign',
    target,
    value: wrapNarrow(step, typeOf(target, C.tyCtx())),
  };
}

/** 赋值的左边那一格。 */
function lhsOf(t, C) {
  /**
   * 裸名字走 `exprOf` —— 那一份已经有"局部量先查、再当 `this->` 那一格字段"的规矩
   * （见 expr.js 的 `case 'n'`）。**赋值的左边也要认这条**：构造函数体里的
   * `sum = total();` 与方法里的 `n = 1;` 改的都是字段，写成裸 `(set sum …)` 会报未声明。
   */
  if (tag(t) === 'n') {
    const e = exprOf(t, C);
    if (e.kind !== 'name' && e.kind !== 'field' && e.kind !== 'index') {
      throw new Error(`cpp->IR: \`${nameOf(t)}\` 不能当赋值的左边`);
    }
    return e;
  }
  if (tag(t) === 'dot' || tag(t) === 'arrow') {
    return { kind: 'field', obj: exprOf(kids(t)[0], C), name: nameOf(kids(t)[1]) };
  }
  /* `*p = …` —— 按指针收的出参（`exprOf` 的 `case 'deref'` 把它落成盒子那一格字段）。 */
  if (tag(t) === 'deref') return exprOf(t, C);
  /* `Counter::total = …` —— 一格 `static` 成员（模块级的量）。 */
  if (tag(t) === 'qual') return exprOf(t, C);
  if (tag(t) === 'index') {
    return { kind: 'index', obj: exprOf(kids(t)[0], C), index: exprOf(kids(t)[1], C) };
  }
  throw new Error(`cpp->IR: 赋值的左边是 ${tag(t)} —— 还没接`);
}

/** `a = b` / `a += b`。 */
function assignOf(x, C) {
  const [op, lhs, rhs] = kids(x);
  const o = String(leaf(op));
  const target = lhsOf(lhs, C);
  let value = exprOf(rhs, C);
  if (o !== '=') {
    const bare = o.replace('=', '');
    value = { kind: 'binop', op: bare, left: target, right: value };
  }
  /* 字典的键要走 `dset`（它只当语句用）。 */
  if (target.kind === 'index') {
    const t = typeOf(target.obj, C.tyCtx());
    if (t.kind === 'map') {
      return { kind: 'builtin-stmt', name: 'dset', args: [target.obj, target.index, value] };
    }
  }
  const tt = typeOf(target, C.tyCtx());
  /* **存进窄整数要回卷**（`unsigned char` 8 位…）—— 见 expr.js 的 `wrapNarrow`。 */
  return { kind: 'assign', target, value: wrapNarrow(copyIfLv(value, tt, C), tt) };
}

/** 一格 `(init (d 名字 [(init 值)]))` → 一条 `let`。 */
function declOf(d, specs, C) {
  const dd = kids(d)[0];
  const nameTok = kids(dd)[0];
  const initTok = part(dd, 'init');
  const isArray = tag(nameTok) === 'array';
  const bare = tag(nameTok) === 'n' ? nameTok : kids(nameTok).find((y) => tag(y) === 'n');
  const name = C.ref(nameOf(bare));
  let type = typeOfSpecs(specs, C, nameTok);

  /* `auto t = …`：类型从初值取。 */
  if (type === null) {
    if (initTok === undefined) throw new Error(`cpp->IR: \`auto ${name}\` 没有初值`);
    const v = exprOf(kids(initTok)[0], C);
    type = typeOf(v, C.tyCtx());
    C.bind(name, type);
    return { kind: 'let', name, type, init: v };
  }

  /**
   * **被借出去的局部量装进盒子**（`int y = 5;` 后头有一句 `bump(y, 3)`）——
   * 哪几格要装是降体之前扫出来的（`borrowedLocals`）。盒子就是一格只有 `v` 的记录，
   * 于是"改得动调用者那一格"落成一次普通的字段赋值，图上一格新东西也没加。
   */
  if (C.refNames.has(name) && !isArray) {
    const ok = type !== null && ['int', 'real', 'bool', 'string'].includes(type.kind);
    if (!ok) {
      throw new Error(`cpp->IR: \`${name}\` 被按引用借出去了，可它不是标量 —— 还没接`);
    }
    const box = C.refBox(type);
    const v = initTok === undefined ? zeroFor(type, C) : exprOf(kids(initTok)[0], C);
    C.bind(name, box);
    return {
      kind: 'let',
      name,
      type: box,
      init: {
        kind: 'new-record', type: box, ref: true, fields: [{ name: 'v', value: v }],
      },
    };
  }

  if (isArray) {
    const elem = type;
    const arrTy = arrOf(elem);
    C.bind(name, arrTy);
    const nTok = kids(nameTok).find((y) => tag(y) === 'num');
    const size = nTok === undefined ? 0 : Number(leaf(kids(nTok)[0]));
    if (initTok !== undefined && tag(kids(initTok)[0]) === 'braces') {
      const its = kids(kids(initTok)[0]).map((k) => exprOf(k, C));
      const tmp = C.fresh('arr');
      C.bind(tmp, arrTy);
      const stmts = [{
        kind: 'let', name: tmp, type: arrTy,
        init: { kind: 'builtin', name: 'anew', args: [tyArg(arrTy), { kind: 'int', value: Math.max(size, its.length) }] },
      }];
      its.forEach((v, i) => stmts.push({
        kind: 'assign',
        target: { kind: 'index', obj: { kind: 'name', name: tmp }, index: { kind: 'int', value: i } },
        value: v,
      }));
      return {
        kind: 'let', name, type: arrTy,
        init: { kind: 'block-expr', stmts, value: { kind: 'name', name: tmp } },
      };
    }
    /**
     * **元素是记录的那一档要把格子填上**（`P ps[2];`）：`anew` 开出来的格子是 null，
     * `ps[0].x = 1` 在运行期报 "null reference"（C++ 那边 2 个子对象是现成的）。
     * 填法是现搭一段 `while` —— 与按值拷列表那一段同一手。
     */
    if (elem.kind === 'named' && size > 0) {
      const tmp2 = C.fresh('arr');
      const idx2 = C.fresh('ai');
      C.bind(tmp2, arrTy);
      C.bind(idx2, INT);
      return {
        kind: 'let',
        name,
        type: arrTy,
        init: {
          kind: 'block-expr',
          stmts: [
            {
              kind: 'let',
              name: tmp2,
              type: arrTy,
              init: { kind: 'builtin', name: 'anew', args: [tyArg(arrTy), { kind: 'int', value: size }] },
            },
            { kind: 'let', name: idx2, type: INT, init: { kind: 'int', value: 0 } },
            {
              kind: 'while',
              cond: {
                kind: 'binop',
                op: '<',
                left: { kind: 'name', name: idx2 },
                right: { kind: 'int', value: size },
              },
              body: [
                {
                  kind: 'assign',
                  target: { kind: 'index', obj: { kind: 'name', name: tmp2 }, index: { kind: 'name', name: idx2 } },
                  value: vtZeroRecord(elem, C),
                },
                {
                  kind: 'assign',
                  target: { kind: 'name', name: idx2 },
                  value: {
                    kind: 'binop', op: '+', left: { kind: 'name', name: idx2 }, right: { kind: 'int', value: 1 },
                  },
                },
              ],
            },
          ],
          value: { kind: 'name', name: tmp2 },
        },
      };
    }
    return {
      kind: 'let', name, type: arrTy,
      init: { kind: 'builtin', name: 'anew', args: [tyArg(arrTy), { kind: 'int', value: size }] },
    };
  }

  C.bind(name, type);
  /* `Point p = {1, 2}`：按字段顺序造一格记录。 */
  if (initTok !== undefined && tag(kids(initTok)[0]) === 'braces' && type.kind === 'named') {
    const its = kids(kids(initTok)[0]).map((k) => exprOf(k, C));
    const fields = C.tyCtx().fields.get(type.name) ?? [];
    return {
      kind: 'let', name, type,
      init: {
        kind: 'new-record',
        type,
        ref: true,
        fields: fields.map((f, i) => ({
          name: f.name,
          value: its[i] === undefined ? { kind: 'int', value: 0 } : its[i],
        })),
      },
    };
  }
  /* `Say s1;`（带析构的类型）—— 记一格，出作用域要逆序调。 */
  if (type.kind === 'named') {
    const rec = [...C.records.values()].find((r) => C.ref(r.name) === type.name);
    if (rec !== undefined && (rec.dchain ?? []).length > 0) {
      C.scoped.push({ name, rec: rec.name, chain: rec.dchain });
    }
  }
  /**
   * **构造**：`Point p(1, 2)` 走 `(ctor (args …))` 那一格，`Counter c;`（这个类有构造函数）
   * 走的是"没有初值"那一格 —— 两者落的都是一次 `Rec__ctor(…)`。没有构造函数的类照旧
   * （`Point p;` 是 `init: null`，`Say s1;` 只登记析构）。
   */
  const ctorTok = kids(dd).find((y) => tag(y) === 'ctor');
  /**
   * **虚继承树里的对象要带上 `__vt`**（那是"真身是谁"的唯一记号）。`Square q;` 落成
   * 一格全零的根记录 + `__vt = 1` —— 忘了这一句，分派会一路走到兜底那份，
   * 答案静默地错成基类的。
   */
  if (type.kind === 'named' && C.vtIdRef.has(type.cls)
    && ctorTok === undefined && initTok === undefined) {
    return {
      kind: 'let', name, type, init: vtZeroRecord(type, C),
    };
  }
  /* **哪一份构造**：数一数实参（`Vec a;` 是 0 个、`Vec c(3, 4)` 是 2 个）；
     那个类有两份个数一样的构造时，再按**实参类型**挑（见 `ctorPlan` / `pickCtor`）。 */
  if (type.kind === 'named') {
    const as = ctorTok === undefined ? undefined : part(ctorTok, 'args');
    /* 借出去的那几格实参不许求值（`Counter c(y);`）—— 交的是盒子本身。 */
    const crs = C.ctorRef.get(type.cls ?? type.name);
    const args = as === undefined ? []
      : argsWithRefs(kids(as), crs, C, `${type.cls ?? type.name} 的构造`);
    const hitT = (ctorTok !== undefined || initTok === undefined)
      ? C.pickCtor(type.cls ?? type.name, args.map((a) => typeOf(a, C.tyCtx()))) : null;
    if (hitT !== null) {
      return {
        kind: 'let',
        name,
        type,
        init: {
          kind: 'call',
          fn: { kind: 'name', name: hitT.name },
          args: args.map((a, i) => coerce(a, hitT.params[i].type, C)),
        },
      };
    }
    const pick = `${type.name}__ctor${args.length}`;
    if (C.fns.has(pick) && (ctorTok !== undefined || initTok === undefined)) {
      return {
        kind: 'let', name, type, init: { kind: 'call', fn: { kind: 'name', name: pick }, args },
      };
    }
    /* 有构造函数、可个数对不上 —— 当场报（别静默地走成"零值 + 什么都不跑"）。 */
    if (ctorTok !== undefined) {
      throw new Error(`cpp->IR: ${type.cls} 没有收 ${args.length} 个实参的构造函数`);
    }
  }
  /**
   * **字段里套着记录的那一档，声明时要现造一格零值记录**：只发 `(let a P)` 的话那格子
   * 记录是 null，`a.in.v = 5` 在运行期报 "null reference"（C++ 那边子对象是现成的）。
   * 字段全是标量的照旧（`init: null`）—— 那一档已经全绿，不为这一格去动它。
   */
  if (type !== null && type.kind === 'named' && ctorTok === undefined && initTok === undefined
    && (C.tyCtx().fields.get(type.name) ?? [])
      .some((f) => ['named', 'arr', 'map'].includes(f.type.kind))) {
    C.bind(name, type);
    return { kind: 'let', name, type, init: vtZeroRecord(type, C) };
  }
  return {
    kind: 'let',
    name,
    type,
    /* 初值也要回卷（`unsigned char c = 300;` 在 C++ 里就是 44）。 */
    init: initTok === undefined
      ? null : wrapNarrow(copyIfLv(exprOf(kids(initTok)[0], C), type, C), type),
  };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. **异常**（`try` / `catch` / `throw`）—— 整格没接，而且**不该在这一层接**：
//      方言里没有异常那一族（JS 那条腿也缺它，见 docs/js-bootstrap-subset.md），在 adapter
//      里靠"一格隐藏的全局 + 每次调用后查一下"伪造出来就是第二份实现 —— 慢、漏、而且
//      别的门用不上。这一格要先有一次**语言决定**（方言加什么、三条腿各怎么落），
//      那是一份 ADR 的事，不是这一份文件的事。
//   2. `printf` 的格式串走公共层那一份（`src/core/lower/fmt.js` 的 `fmtToStmts`）：
//      宽度、`-` / `0` / `+` / 空格 / `#` 五个标志、各档精度、`*` / `.*`、`%c`、
//      末尾不带换行（落 `write`）、一句里几个换行 —— **都接了**。
//      长度修饰（`%lld` / `%lu` / `%08lld` 那一族）**读得对、印得也对** —— 量过一趟与
//      `c++` 逐字节相同：这条腿上整数只有一格宽度，所以"按几位读"那件事现在没有区别
//      （按位截断那一格见第 4 条 —— 回卷在**存进去**那一头，不在印出来这一头）。
//   3. 引用（`T&`）与**按指针收的出参**（`T*` + `*p` + 调用点 `&y`）落成同一样东西：
//      记录 / 列表 / 字典照原样收（本来就是引用语义）；**标量装进一格盒子**
//      （`__ref_int`，`refparam.cpp`）。接**自由函数**、**方法**与**构造**（后两者只认
//      "没重载、非虚"那一档 —— 名字定得死，调用点才能在求值之前知道哪几格要交盒子）；
//      借出去的那个实参只能是"一格装着盒子的量"。构造那一格两种写法都接：声明形
//      （`Grab gr(g);` —— 实参在声明符的 `(ctor …)` 里，按类名查 `C.ctorRef`）与函数式
//      （`Grab(g)` —— 一格普通调用）。
//      lambda 的形参、重载或虚方法 + `T&`、重载的构造 + `T&`、把字段或数组元素借出去，
//      全当场报。指针也**只有这一种用法** —— 指针算术、指向数组的指针都当场报。
//      `&x`（取地址当值用）只在记录/列表/字典上成立。
//   4. **窄整数存进去会回卷**（`narrow.cpp`）：方言里整数只有一格宽度，所以类型上带一格
//      `bits` / `uns` 记号（`expr.js` 的 `BTYPES`），**存进去**的六处补一次 `wrapNarrow` ——
//      声明的初值、赋值、`++` / `--`、显式转换、**按值收的形参**（补在被调方**进门第一句**，
//      `narrowParams` —— 与记录的值语义同一手：调用点有八九处、进门只有一处）、以及
//      **`return`**（按 `C.retType`，那是**写着的**返回类型；lambda 上只有写了 `-> T`
//      那一档算"写着的"，从体里推出来的不回卷）。
//      无符号一次与掩码；有符号 `((v+half)&mask)-half`。
//      `int` / `long` 那几格**有意不带**：C++ 里有符号溢出是 UB，没有义务把 UB 学像。
//      读树那一格要当心：`unsigned char` 是**一格 `btype` 里两个词**（只读第一个词会按 32 位
//      回卷，还是错的）—— 所以 `typeOfSpecs` 把 `btype` 的 kids 全 flatMap 出来按"合起来的词"查表。
//      还没补的：借出去的窄形参（`unsigned char&` —— 那格在体里是 `.v`）。定宽类型
//      （`int8_t` …）的位宽表在 `src/core/lower/cfam.js` 的 `C_INT_BITS`（与 jancy 共用一张）。
//   5. **自由函数、方法与构造函数**都按实参**类型**重载（`fnovl.cpp` / `methov2.cpp` /
//      `ctor3.cpp`：名字分三档 —— 没重载不动 / 个数各不相同的缀个数 / 有两份个数一样的
//      缀类型；挑那一份三处共用 `pickAmong`）。形参一模一样的两份当场报。
//      拷贝构造与赋值算子没有 —— 记录是引用语义，那两格在这条腿上本来就不是"拷贝"。
//      **虚方法 + 重载**当场报（分派表按老名字找那一份）。
//   6. 虚函数接**单继承与多继承**（分组按连通块 —— 见 `planVirtuals`）；纯虚（`= 0`）接了 ——
//      声明处没有体，分派函数的兜底是一格 `(fail …)`。**菱形继承当场报**（两个基类都有
//      同一个字段名时 C++ 是两份独立的字段，而摊平只有一张表 —— 见 `flatten`）；
//      派生类遮住基类同名字段那一档也当场报。析构**按链跑**（自己先、再往基类走）；
//      `virtual ~X()` 上的 `virtual` 这条腿上没有意义（没有 `delete`，对象都是作用域里的，
//      静态类型定得死），所以照普通析构收。
//      类里"只声明不给体、体写在类外"那一档**接了**（`attachOutline`；类模板上还没有）。
//   7. 类模板接**构造、析构与继承**（`ctmpl2.cpp`；继承摊平走同一份 `flatten`，析构串链）。
//      **虚函数**当场报（自己写了 `virtual` 或基类那侧有 —— 虚那条路是"整块合成一格记录"，
//      而实例是第二、三遍中间现造的，`planVirtuals` 早过去了）；基类本身是类模板
//      （`Derived : Base<T>`）、模板的默认实参与特化、类模板里"体写在类外"也都当场报。
//   8. lambda 的捕获：按值（`[x]` / `[=]`）与**按引用**（`[&x]` / `[&]`）都接了 ——
//      后者与出参走同一台机器：那格量装进一格盒子，闭包**按值捕盒子**（记录本来就是
//      引用），体里读写落成 `(field (cap x) v)`。只接"这个函数体里声明过的局部量"
//      （哪几格要装是降体之前扫树算的，与"真声明过"求交 —— 全局名字装了盒子会当场报）。
//      **`[this]`** 也接了（记录是引用语义，"按值捕一格记录"就是它；体里裸写的字段名
//      照旧当 `this->`，`this` 自己落成一格捕获）。`mutable`、`[*this]`、`[x = 表达式]`、
//      泛型 lambda 还没接。
//   9. **`static` 数据成员**落成一格模块级的量（`类名__成员名`，`staticmem.cpp`）：
//      一个类一份，初值（类里那句或类外那句 `int C::x = …;`）摆在 `main` 体的最前面 ——
//      方言的 `(global 名字 类型)` 按设计零初始化，不带初值那一格。
//      `static` 的**成员函数**也接了：一格没有 `this` 的普通函数（`类名__名字`）。
//      裸名字在它体里**不当字段**（C++ 的规矩），但 static 数据成员与别的 static 成员函数
//      看得见 —— 那是 `C.statCls` 那一格（`C.self` 管的是"裸名字当 `this->` 的字段"）。
//  10. **记录是值语义**（`byvalue.cpp`）：按值收的记录形参在**被调方进门第一句**拷一份
//      （`类名__copy`，逐字段、字段是记录再递归拷），拷贝初始化与拷贝赋值也拷。
//      不拷的两格是有意的：接收者（`this`）与借出去的形参（`T&` / `T*`）。
//      记录里有**列表**的按值拷**接了**（`arrfield.cpp`：现搭一段 `anew` + `while` 逐格拷）；
//      有**字典**的仍当场报（方言里没有能装下键列表的类型，拷不了）。返回局部记录不拷
//      （那格量本来就要没了，与 C++ 的省略拷贝对得上）。
//      字段里套着记录 / 列表 / 字典的，声明时现造一格零值记录（只发 `(let a P)` 那几格是 null）。
//  11. **数组字段**（`int xs[3];`，`arrfield.cpp`）：收成一格列表字段并**记下长度** ——
//      造对象时照它开格子。从前 `nameOf` 读 `(array …)` 答 null，字段表里多一格叫 `null` 的
//      而 `xs` 根本不存在。长度只在"字面写着的"那一档有；`int xs[]` 那种开 0 格。
//  12. **区间 for**（`for (T v : xs)`，`rangefor.cpp`）摊成三段式的下标循环 —— 公共层那格
//      `for-range` 要一份语言钩子，而这一门的答案太直白，摊在 adapter 里省一层。
//      按值走那格量是**拷出来的**；**按引用走**（`T&`）的那一格不造新量 —— 它就是
//      `xs[i]` 的**别名**（`C.lvAlias`），改它落成一次普通的 `aset`。`T&&` 与在字典上
//      走一遍当场报。元素是记录的数组声明时会把格子填上（否则是 null）。
//  13. **`switch`**（`swbreak.cpp`）落公共层那一格（它摊成 if/else 链）。两处形状要自己认：
//      树上每格 `case` 只带**一条**语句，剩下的是它后面的兄弟 —— 得按 `case` / `default`
//      自己分组；而 `case 2: case 3:` 在树上是**套起来的**（一格 case 的那条语句又是一格
//      case），那是"两个值共用一份体"，摊成两格（`share` 借同一份体）。
//      每组末尾那句 `break` 要**摘掉** —— 它的意思是"出 switch"，而公共层的 `break` 是
//      "出循环"，留着就跳错了。**穿透当场报**（没有 `break` / `return` 又不是最后一支）：
//      公共层每支各自独立，静默地把穿透改成不穿透就是答案静默地错。
//      `case a ... b`（区间，gcc 的扩展）当场报。go 那一族的 `switch` 不是同一个程序
//      （无值形与 `case 2, 3` 多值形 C++ 写不出来），所以另起了一个家族名。
//  14. **`i++` / `++i` 当值用**（`narrow.cpp`）落公共层现成的 `block-expr`（先跑几句、
//      再交一格值）：`++i` 交的是那格量自己，`i++` 先把旧值存进一格临时量再交它。
//      语句位置那一档本来就有。步进那一下照第 4 条补回卷。
