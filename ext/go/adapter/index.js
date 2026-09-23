// ext/go/adapter/index.js —— **go → 标准 IR**（ADR-0044 第四片）
//
// 替掉 `ext/go/tograph.js`（4900 行）+ `ext/go/go.mapping`（205 行）。这一份管声明与语句：
//
//   * **struct 落 `(class …)`**、方法压成 `Type__名字`（接收者是第一格实参，单态分派）；
//   * **多返回值合成一格记录**（`(out (p int) (p int))` 与 `return a, b` 落同一格）；
//   * **`var` / `const` 是"声明就有零值"**：`var p Point` 要真的造出那格记录
//     （`zeroval.go` 里 `q.a.y` 要 0，那就得连嵌进去的 Point 一起造）；
//   * **`const … = iota`**：编译期常量，用处直接换成值（方言的 global 没有初值那一格）；
//   * **`defer f(x)` 的实参在 defer 那一刻就定下来**（`deferarg.go` 判的是这一条）——
//     所以登记的时候先把实参落进临时量，出口处调的是那几格临时量；
//   * **`switch` 三种形状**（带主语 / 不带主语 / 带 init）落成 if 链。

import { tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import {
  INT, STR, BOOL, arrOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';
import {
  exprOf, condOf, typeOfTok, retTypeOf, retOf, paramsOf, nameOf, zeroExpr, valueOf,
  coerce, dgetOr, argsFor, tyArg, ifaceType, PRINTS, printfStmts,
} from './expr.js';
import {
  ifaceMethodToks, ifaceMethodSig, ifaceFields, boxMemoName, boxOf,
  collectNarrow, typeSwitchStmts, implementsIface,
} from './iface.js';
import {
  chanType, chanTypeOfTok, chanMake, chanRecv, chanClose, chanLen,
  sendStmts, goStmts, rangeChanStmts, selectStmts, runMain,
} from './conc.js';

const AUG = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'],
  ['&', '&'], ['|', '|'], ['^', '^'], ['<<', '<<'], ['>>', '>>'],
]);

const nameRef = (n) => ({ kind: 'name', name: n });
const plus1 = (e) => ({ kind: 'binop', op: '+', left: e, right: { kind: 'int', value: 1 } });
const str = (value) => ({ kind: 'string', value });

/**
 * 一棵 go 的树（`(file 包名 …)`）→ 标准 IR 的模块。
 * `opts.also` 是旁边那几份读进来的同语言文件（依赖在前）—— 摆在这一份前面一起处理。
 */
export function goToIR(tree, opts = {}) {
  const asFile = (t) => {
    if (tag(t) !== 'file') throw new Error('go->IR: 这不是 (file …)');
    return kids(t).filter((y) => tag(y) !== null);
  };
  const top = [...(opts.also ?? []), tree].flatMap(asFile);

  let tmpN = 0;
  let liftN = 0;
  let anonN = 0;
  let capN = 0;
  const scopes = [new Map()];
  const recFields = new Map();
  const mvs = new Map();
  const decls = [];
  const anons = new Map();
  const typeIds = new Map();
  const ifaceDecls = new Map();
  const pendingIfaces = [];
  const cused = new Set();
  const C = {
    records: new Map(),
    /** 接口名 → 那几格方法（`{ name, params, ret }`，嵌入的已摊平）。 */
    ifaces: new Map(),
    /** 要"降回去"的那几个具体类型（`switch t := s.(type)` 的收窄，见 `iface.js`）。 */
    narrow: collectNarrow(top),
    /** 造过的闭包（`(cfn …)` 一格一份）。 */
    closures: new Set(),
    decls,
    aliases: new Map(),
    imports: new Set(),
    consts: new Map(),
    methods: new Map(),
    fns: new Map(),
    /** **没有体**的那几格函数（`omnihost` 那一份）—— 调用点落 `(ccall …)`，自己不发函数。 */
    bodiless: new Set(),
    /**
     * 借外头那份 C：`(lib …)` 一次、每个符号一句 `(cabi …)`（按用到的顺序、去重）。
     * **`fn` 那一格要写成 `ptr`**：方言的 `(cabi …)` 只认 i32/i64/f32/f64/bool/ptr
     * （函数指针在 C 那侧就是一格指针）。
     */
    needC: (sym, ret, ps) => {
      if (cused.size === 0) decls.unshift({ kind: 'lib', name: 'libomnigo' });
      if (cused.has(sym)) return;
      cused.add(sym);
      const cty = (p) => (p === 'fn' ? 'ptr' : p);
      decls.push({ kind: 'cabi', sym, ret: cty(ret), params: ps.map(cty) });
    },
    defers: [],
    cur: { fn: null, ret: { kind: 'void' }, results: [] },
    /** 通道那几格（体在 `libomnigo` —— 见 `conc.js`）。 */
    needsSched: false,
    chanMake: (capTok) => chanMake(capTok, C),
    chanRecv: (chTok) => chanRecv(chTok, C),
    chanClose: (ch) => chanClose(ch, C),
    chanLen: (ch) => chanLen(ch, C),
    /** 一格类型的零值（自引用的记录有环闸 —— 见 `zeroExprWith`）。 */
    zeroOf: (t) => zeroExprWith(t, C, new Set()),
    fresh: (p) => { tmpN += 1; return `${p}${tmpN}`; },
    ref: (n) => {
      const raw = String(n);
      /* **被内层函数借走的局部量**改了名（见 `capturedNames`）：一格函数一张表，
         所以另一个函数里的同名局部量不受影响（`46-shadowed-global.go` 判的正是这条）。 */
      const r = C.rename.get(raw);
      return r === undefined ? raw.replace(/[^A-Za-z0-9_]/g, '_') : r;
    },
    rename: new Map(),
    caps: new Set(),
    /**
     * **一格局部量被内层函数借走了** —— 方言的顶层函数看不见别人的局部量，所以把它
     * 提成模块级 global（名字换成独一份的，见 `ref`）。回 null = 照旧落局部量。
     */
    promote: (raw, type) => {
      if (!C.caps.has(raw)) return null;
      capN += 1;
      const g = `${String(raw).replace(/[^A-Za-z0-9_]/g, '_')}__cap${capN}`;
      C.rename.set(String(raw), g);
      scopes[0].set(g, type);
      decls.push({ kind: 'global', name: g, type });
      return g;
    },
    push: () => scopes.push(new Map()),
    pop: () => scopes.pop(),
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
    mvType: (types) => {
      const key = types.map((t) => JSON.stringify(t)).join(',');
      if (!mvs.has(key)) {
        const name = `mv${mvs.size + 1}`;
        mvs.set(key, name);
        const fields = types.map((t, i) => ({ name: `v${i}`, type: t }));
        recFields.set(name, fields);
        decls.push({ kind: 'struct', name, fields });
      }
      return named(mvs.get(key));
    },
    /** 匿名 struct（`var anon struct{ n int }`）—— 按字段的形状去重，落一格具名的类。 */
    anonRecord: (structTok) => {
      const fields = fieldsOf(structTok, C);
      const key = JSON.stringify(fields);
      if (!anons.has(key)) {
        anonN += 1;
        const name = `anon${anonN}`;
        anons.set(key, name);
        recFields.set(name, fields);
        decls.push({ kind: 'class', name, fields });
      }
      return named(anons.get(key), true);
    },
    /** 具体类型的**号**（类型 switch 按它分支）。1 起 —— 0 留给"没装过东西"。 */
    typeId: (tn) => {
      if (!typeIds.has(tn)) typeIds.set(tn, typeIds.size + 1);
      return typeIds.get(tn);
    },
    /** 把一格具体类型的值装进接口（见 `iface.js`）。 */
    box: (value, ifn, tn) => boxOf(value, ifn, tn, C),
    /** 给 `iface.js` / `stdlib.js` / `conc.js` 用的几格小手（那几份不 import `expr.js`
        或不许成环 —— `check:self` 那道闸盯着这一条）。 */
    exprOf: (tok) => exprOf(tok, C),
    valueOf: (tok, type) => valueOf(tok, type, C),
    typeOfIR: (e) => typeOf(e, C.tyCtx()),
    /**
     * 写在类型位置上的匿名接口。名字按**方法名单**生成（同一形状只有一份）；
     * `interface{}`（= `any`）一格方法都没有，方言里没有对应的形状 —— 当场报。
     */
    anonIface: (tok) => {
      const ms = ifaceMethodToks(tok, ifaceDecls).map((m) => ifaceMethodSig(m, C));
      if (ms.length === 0) {
        throw new Error('go->IR: `interface{}`（any）还没接 —— 那一格装什么都行，'
          + '方言里没有对应的形状（要先给方言加一格，是一次语言决定）');
      }
      const key = ms.map((m) => m.name).sort().join('_');
      const name = `iface_${key}`;
      if (!C.ifaces.has(name)) {
        C.ifaces.set(name, ms);
        pendingIfaces.push(name);
      }
      return ifaceType(name);
    },
    /**
     * **两格结构体值之间的 `==`**：go 是**逐字段比**，而方言的 `==` 对记录是句柄比较。
     * 所以一个类型造一份 `__eq_T(a, b)`（嵌进去的记录递归比、**指针字段按句柄比** ——
     * 那正是 go 的规矩）。先登记再造体：自引用的类型不许无限造下去。
     */
    eqFn: (type) => {
      const name = `__eq_${type.name}`;
      if (C.fns.has(name)) return name;
      const params = [{ name: '__a', type }, { name: '__b', type }];
      C.fns.set(name, { params, ret: BOOL, results: [{ name: null, type: BOOL }] });
      const fs = recFields.get(type.name) ?? [];
      const cmp = (f) => {
        const av = { kind: 'field', obj: nameRef('__a'), name: f.name };
        const bv = { kind: 'field', obj: nameRef('__b'), name: f.name };
        if (f.type.kind === 'named' && f.type.ptr !== true) {
          return { kind: 'call', fn: nameRef(C.eqFn(f.type)), args: [av, bv] };
        }
        return { kind: 'binop', op: '==', left: av, right: bv };
      };
      const all = fs.length === 0
        ? { kind: 'bool', value: true }
        : fs.map(cmp).reduce((a, b) => ({ kind: 'binop', op: '&&', left: a, right: b }));
      decls.push({
        kind: 'fn', name, params, ret: BOOL, body: [{ kind: 'return', values: [all] }],
      });
      return name;
    },
    /**
     * 一格具名记录的**零值字段表**（嵌进去的记录也要造 —— `zeroval.go` 判的是这一条）。
     * 环靠 `zeroExprWith` 那道闸收：自引用的那格字段一定是指针、接口或切片，三格都不往下铺。
     * **别在这一层"整格降成 0"** —— 那会把 `arr` 与接口那几格也写成 `(int 0)`
     * （量出来是 `Node.Kids 是 arr<Node>，写进去的是 int`）。
     */
    zeroFields: (type, seen = new Set()) => {
      const fs = recFields.get(type.name) ?? [];
      const next = new Set([...seen, type.name]);
      return fs.map((f) => ({ name: f.name, value: zeroExprWith(f.type, C, next) }));
    },
    lift: (fnlit, hint) => {
      liftN += 1;
      const name = hint === null ? `__fn${liftN}` : C.ref(hint);
      const sig = sigOfTok(part(fnlit, 'sig'), C);
      C.fns.set(name, sig);
      decls.push(fnBody(name, sig, part(fnlit, 'block'), C));
      return name;
    },
    blockStmts: (blockTok) => {
      if (blockTok === undefined || blockTok === null) return [];
      C.push();
      const out = kids(blockTok).flatMap((s) => stmtsOf(s, C));
      C.pop();
      return out;
    },
  };

  /* ---- 第一遍：import 的包名（`fmt.Println` 靠它认出"这是库里的"）--------------- */
  for (const d of top) {
    if (tag(d) !== 'import') continue;
    for (const p of kids(d)) {
      const path = String(leaf(kids(p)[0]) ?? '');
      C.imports.add(path.split('/').pop());
    }
  }

  /* ---- 第二遍：类型的**名字**（struct 与 interface 互相引用，所以先把名字都登上）---- */
  const tspecs = top.filter((d) => tag(d) === 'typedecl').flatMap((d) => kids(d));
  for (const s of tspecs) {
    const name = String(leaf(kids(s)[0]));
    const body = kids(s)[1];
    if (tag(body) === 'struct') C.records.set(name, { fields: [] });
    if (tag(body) === 'interface') { ifaceDecls.set(name, body); C.ifaces.set(name, []); }
  }
  /**
   * ---- 第二遍之二：字段表与别名。**类先不发** ----
   * 装箱记忆那一格（`__boxof_接口名`）要等"谁实现了哪个接口"算出来，而那要方法签名 ——
   * 所以发类推到第四遍之二。字段表这一趟已经定下来（类型要它）。
   */
  const structNames = [];
  /* **常量先抢着收一趟**：定长数组的长度可以是一格常量（`vec [rngLen]int64`，`math/rand`
     那份桩），而那要在算字段类型之前就认得。算不出来的那几格这一趟跳过，第三遍再来。 */
  collectConsts(top, C, true);
  for (const s of tspecs) {
    const name = String(leaf(kids(s)[0]));
    const body = kids(s)[1];
    if (tag(body) === 'interface') continue;
    if (tag(body) === 'struct') {
      const fields = fieldsOf(body, C);
      C.records.get(name).fields = fields;
      recFields.set(C.ref(name), fields);
      structNames.push(C.ref(name));
      continue;
    }
    /**
     * `type Level int` 与 `type Name = string` —— 底下是别名，可**名字要留着**：
     * `type Duration int64` 身上挂着方法（`d.Seconds()`），而那要"这一格装的是 Duration"
     * 说得出来。所以别名的类型描述上多带一位 `named`（算术照 int 走，方法按它查）。
     */
    C.aliases.set(name, { ...typeOfTok(body, C), named: C.ref(name) });
  }

  /* ---- 第三遍：const（编译期常量，`iota` 从 0 数上去）-------------------------- */
  collectConsts(top, C, false);

  /* ---- 第四遍：函数与方法的签名 ---------------------------------------------- */
  const routines = top.filter((d) => tag(d) === 'fn' || tag(d) === 'method');
  for (const r of routines) {
    if (tag(r) === 'fn') {
      const name = C.ref(String(leaf(kids(r)[0])));
      /* 泛型那一格（`(tparams …)`）：类型参数登记成 int —— **明说的近似**，
         这一层不做单态化（`vardecl.go` 里 `firstOf([]int{…})` 的答案正好对得上）。 */
      for (const tp of kids(part(r, 'tparams') ?? { kind: 'list', items: [] })) {
        if (tag(tp) === 'p') C.aliases.set(nameOf(kids(tp).find((y) => tag(y) === 'name')), INT);
      }
      C.fns.set(name, sigOfTok(part(r, 'sig'), C));
      /* **没有体的那几格**（`omnihost` 那一份）：体在 `libomnigo` 里，自己不许发一格空函数
         —— 发了就会盖掉真的那一份（而且与别的桩撞名，量出来是"'NumCPU' 重复定义"）。 */
      if (part(r, 'block') === undefined) C.bodiless.add(name);
      continue;
    }
    const recv = kids(part(r, 'recv'))[0];
    const owner = typeOfTok(kids(recv).find((y) => tag(y) !== 'name'), C);
    const key = ownerKey(owner);
    if (key === null) throw new Error('go->IR: 方法的接收者不是一格 struct，也不是具名的标量类型');
    const m = String(leaf(kids(r)[1]));
    const name = `${key}__${m}`;
    const sig = sigOfTok(part(r, 'sig'), C);
    sig.params = [{ name: C.ref(nameOf(part(recv, 'name'))), type: owner }, ...sig.params];
    C.fns.set(name, sig);
    C.methods.set(`${key}.${m}`, { name, params: sig.params, ret: sig.ret, results: sig.results });
  }

  /**
   * ---- 第四遍之二：接口的方法表、装箱记忆那一格、发类 ----
   * 次序是硬的：方法签名（上一遍）→ "谁实现了哪个接口" → 记忆字段 → 发类。
   * 反过来就会少一格字段，而形状是按字段名单定的（那时递给同一个函数就报"两处类型不一样"）。
   */
  for (const [ifn, body] of ifaceDecls) {
    C.ifaces.set(ifn, ifaceMethodToks(body, ifaceDecls).map((m) => ifaceMethodSig(m, C)));
  }
  for (const tn of structNames) {
    const fs = recFields.get(tn);
    for (const ifn of [...C.ifaces.keys()].sort()) {
      if (!implementsIface(tn, ifn, C)) continue;
      fs.push({ name: boxMemoName(ifn), type: ifaceType(ifn) });
    }
    decls.push({ kind: 'class', name: tn, fields: fs });
  }
  const emitIface = (ifn) => {
    if (recFields.has(ifn)) return;
    const fs = ifaceFields(ifn, C);
    recFields.set(ifn, fs);
    decls.push({ kind: 'class', name: ifn, fields: fs });
  };
  for (const ifn of C.ifaces.keys()) emitIface(ifn);

  /**
   * ---- 第五遍：模块级 var（**初值落在入口里** —— 方言的 global 没有初值那一格）----
   *
   * **纯字面量的那几格先赋**：go 的模块级初始化是**按依赖排序**的，而依赖要穿过函数体才看得清
   * （`var globalRand = New(NewSource(1))` 里 `rngSource.Seed` 读的是另一份文件里的
   * `rngCooked`）。照源码顺序一把梭的话 `math/rand` 那份桩当场"下标越界 0（长度 0）"。
   * 这一层的近似是**两趟**：初值里没有调用的先赋（表、常量表那一族），有调用的后赋。
   * 真正的依赖排序要一张"函数读了哪些全局"的表，那是另一笔账（明说记着）。
   */
  const pureInit = [];
  const callInit = [];
  for (const d of top) {
    if (tag(d) !== 'var') continue;
    for (const s of kids(d)) {
      const names = kids(part(s, 'names')).map((n) => C.ref(String(leaf(n))));
      const tyTok = kids(s).find((y) => !['names', 'init'].includes(tag(y)));
      const initTok = part(s, 'init');
      const inits = initTok === undefined ? [] : kids(initTok);
      names.forEach((n, i) => {
        const { type, value } = declValue(tyTok, inits[i], C);
        scopes[0].set(n, type);
        decls.push({ kind: 'global', name: n, type });
        const one = { kind: 'assign', target: nameRef(n), value: value ?? C.zeroOf(type) };
        (hasCall(inits[i]) ? callInit : pureInit).push(one);
      });
    }
  }
  const globalInit = [...pureInit, ...callInit];

  /* ---- 第六遍：函数体 -------------------------------------------------------- */
  for (const r of routines) {
    if (tag(r) === 'fn') {
      const name = C.ref(String(leaf(kids(r)[0])));
      if (C.bodiless.has(name)) continue;
      decls.push(fnBody(name, C.fns.get(name), part(r, 'block'), C));
      continue;
    }
    const recv = kids(part(r, 'recv'))[0];
    const owner = typeOfTok(kids(recv).find((y) => tag(y) !== 'name'), C);
    const name = `${ownerKey(owner)}__${String(leaf(kids(r)[1]))}`;
    decls.push(fnBody(name, C.fns.get(name), part(r, 'block'), C));
  }
  if (!C.fns.has('main')) throw new Error('go->IR: 这份源码里没有 `func main`（go 的入口）');
  /* 体里才见到的匿名接口（走类型位置的那一格）—— 补发它的类。 */
  for (const ifn of C.ifaces.keys()) emitIface(ifn);
  /**
   * 入口：模块级 var 的初值先跑，再叫 main。
   * **要调度器的那一档 `main` 得跑成主 g**（`(ccall omni_go_run (fnref main))`）——
   * `chan_send` 阻塞时要 park 当前那条 g 再切走，而主线程本身不是一条 g。
   */
  decls.push({
    kind: 'main',
    body: [
      ...globalInit,
      C.needsSched ? runMain(C) : { kind: 'expr-stmt', expr: { kind: 'call', fn: nameRef('main'), args: [] } },
    ],
  });
  return { kind: 'module', decls };
}

/** 这一格初值里有调用吗（模块级 var 的两趟赋值靠它分档）。 */
function hasCall(tok) {
  if (tok === null || tok === undefined || !Array.isArray(tok.items ?? null)) return false;
  if (tag(tok) === 'call') return true;
  return kids(tok).some(hasCall);
}

/**
 * 顶层的 `const`（编译期常量，`iota` 从 0 数上去；用处直接换成值 ——
 * 方言的 global 没有初值那一格）。
 * `lenient` 为真 = 算不出来的那几格**跳过**（字段类型那一趟抢着收时用它）。
 */
function collectConsts(top, C, lenient) {
  for (const d of top) {
    if (tag(d) !== 'const') continue;
    let iota = 0;
    let last = null;
    for (const s of kids(d)) {
      const initTok = part(s, 'init');
      const names = kids(part(s, 'names')).map((n) => String(leaf(n)));
      if (initTok !== undefined) {
        last = kids(initTok);
        iota = 0;
      } else {
        iota += 1;
      }
      names.forEach((n, i) => {
        if (n === '_') return;
        const vTok = last === null ? undefined : last[i];
        let value;
        try {
          value = vTok === undefined
            ? { kind: 'int', value: iota }
            : (nameOf(vTok) === 'iota' ? { kind: 'int', value: iota } : exprOf(vTok, C));
        } catch (err) {
          if (lenient) return;
          throw err;
        }
        C.consts.set(C.ref(n), value);
      });
    }
  }
}

/**
 * 一格接收者的类型 → **方法挂在哪个名字下**。
 * struct（与 `*struct`）是那格具名类型；`type Duration int64` 那一族底下是标量，
 * 名字在 `named` 那一位上（见第二遍之二那段话）。都不是就回 null。
 */
const ownerKey = (owner) => {
  if (owner.kind === 'named') return owner.name;
  return owner.named ?? null;
};

/** `(struct (f (names x y) T) …)` → 字段表（一格标注能带好几个名字）。 */
function fieldsOf(structTok, C) {
  const out = [];
  for (const f of kids(structTok)) {
    if (tag(f) !== 'f') continue;
    const ns = part(f, 'names');
    const ty = typeOfTok(kids(f).find((y) => tag(y) !== 'names'), C);
    for (const n of (ns === undefined ? [] : kids(ns))) out.push({ name: String(leaf(n)), type: ty });
  }
  return out;
}

/** 零值（带"这个记录造过了没有"的环闸 —— 自引用的结构不许无限造下去）。 */
function zeroExprWith(type, C, seen) {
  if (type.kind === 'named') {
    /* 接口与指针的零值是**空引用**（go 的 nil）。 */
    if (type.iface === true || type.ptr === true || seen.has(type.name)) {
      return { kind: 'null', type };
    }
    return {
      kind: 'new-record', type, ref: type.ref === true, fields: C.zeroFields(type, seen),
    };
  }
  return zeroExpr(type, C);
}

/** `(sig (in (p T (name n))…) (out …))` → 签名。**类型在前、名字在后**。 */
function sigOfTok(sigTok, C) {
  const ins = paramsOf(sigTok === undefined ? undefined : part(sigTok, 'in'), C);
  const params = ins.map((p) => ({
    name: p.name === null ? C.fresh('p') : C.ref(p.name),
    /* **变参那一格的声明类型是 `[]T`**（树上摆的是元素类型 T）—— 调用点打包成一格数组。 */
    type: p.variadic === true ? arrOf(p.type) : p.type,
    variadic: p.variadic === true,
  }));
  const results = paramsOf(sigTok === undefined ? undefined : part(sigTok, 'out'), C)
    .map((r) => ({ name: r.name === null ? null : C.ref(r.name), type: r.type }));
  return { params, ret: retOf(results, C), results };
}

/** **具名返回值**那一档（`func f() (u, v float64)`）—— 全带名字才算。 */
const namedResults = (sig) => {
  const rs = sig.results ?? [];
  return rs.length > 0 && rs.every((r) => r.name !== null && r.name !== '_') ? rs : [];
};

/**
 * **哪几格局部量被内层的函数字面量借走了**。
 *
 * 方言的顶层函数看不见别人的局部量，而 `func(){ … w … }` 提上去之后就是一格顶层函数 ——
 * 所以那几格要提成模块级 global（`C.promote`）。这一趟只回"名字"：
 * 内层用到的名字减去它自己的形参与自己声明的（不然 `func(i int){ … i … }` 会把外头
 * 那格同名的也拖下水）。
 */
function capturedNames(blockTok) {
  const out = new Set();
  const walkLit = (lit) => {
    const own = new Set();
    const used = new Set();
    for (const p of paramNameToks(part(lit, 'sig'))) own.add(nameOf(p));
    const go = (n) => {
      if (n === null || n === undefined || !Array.isArray(n.items ?? null)) return;
      const t = tag(n);
      if (t === 'name') { used.add(nameOf(n)); return; }
      if (t === 'define' || t === 'var') {
        for (const y of declaredNames(n)) own.add(y);
      }
      if (t === 'fnlit') { for (const y of walkLit(n)) used.add(y); return; }
      for (const k of kids(n)) go(k);
    };
    for (const k of kids(part(lit, 'block') ?? { kind: 'list', items: [] })) go(k);
    return [...used].filter((u) => !own.has(u));
  };
  const scan = (n) => {
    if (n === null || n === undefined || !Array.isArray(n.items ?? null)) return;
    if (tag(n) === 'fnlit') { for (const u of walkLit(n)) out.add(u); return; }
    for (const k of kids(n)) scan(k);
  };
  scan(blockTok);
  return out;
}

/** 一格 `(sig …)` 里那几格形参的名字记号。 */
function paramNameToks(sigTok) {
  const inTok = sigTok === undefined || sigTok === null ? undefined : part(sigTok, 'in');
  const out = [];
  for (const p of (inTok === undefined ? [] : kids(inTok))) {
    const nTok = part(p, 'name');
    if (nTok !== undefined) out.push(nTok);
  }
  return out;
}

/** 一格 `define` / `var` 声明了哪几个名字。 */
function declaredNames(n) {
  if (tag(n) === 'define') return kids(part(n, 'lhs') ?? { kind: 'list', items: [] }).map((y) => nameOf(y));
  return kids(n).flatMap((s) => kids(part(s, 'names') ?? { kind: 'list', items: [] }).map((y) => String(leaf(y))));
}

/** 一格函数体（`defer` 在每个出口前**逆序**摊开）。 */
function fnBody(name, sig, blockTok, C) {
  C.push();
  for (const p of sig.params) C.bind(p.name, p.type);
  const outerCur = C.cur;
  const outerDefers = C.defers;
  const outerCaps = C.caps;
  const outerRename = C.rename;
  /* 提名那张表**一格函数一张**，可内层提上去的那几格要接着认（所以照抄一份）。 */
  C.rename = new Map(outerRename);
  C.caps = capturedNames(blockTok);
  const res = namedResults(sig);
  /* `results` 是**声明的返回类型**（`return` 的每一格按它落）；`named` 只有"全带名字"那一档
     才非空（`return` 不带值时交它们）。两格分开 —— 合成一格就会让不带名字的返回值
     漏掉升格与装箱（量出来是"要返回 Texture，给的是 ColorTexture"）。 */
  C.cur = { fn: name, ret: sig.ret, results: sig.results ?? [], named: res };
  C.defers = [];
  /* 具名返回值先落成零值的局部量（go 的规矩：它们一开始就在，`return` 不带值就交它们）。 */
  const head = res.map((r) => {
    C.bind(r.name, r.type);
    return { kind: 'let', name: r.name, type: r.type, init: C.zeroOf(r.type) };
  });
  const stmts = [...head, ...(blockTok === undefined ? [] : kids(blockTok)).flatMap((s) => stmtsOf(s, C))];
  const last = stmts[stmts.length - 1];
  if (last === undefined || last.kind !== 'return') {
    /* 体自己走到底：具名返回值那一档也要交出来（不然方言报"这条路没有返回值"）。 */
    stmts.push(...(res.length > 0 ? returnValues([], C) : exitStmts(C)));
  }
  C.cur = outerCur;
  C.defers = outerDefers;
  C.caps = outerCaps;
  C.rename = outerRename;
  C.pop();
  return {
    kind: 'fn', name, params: sig.params, ret: sig.ret, body: stmts,
  };
}

const exitStmts = (C) => [...C.defers].reverse().flat();

/* ─── 语句 ────────────────────────────────────────────────────────────────── */

export function stmtsOf(x, C) {
  switch (tag(x)) {
    case 'block': return [{ kind: 'block', stmts: C.blockStmts(x) }];
    case 'import': case 'typedecl': case 'fn': case 'method': return [];
    case 'expr': return exprStmts(kids(x)[0], C);
    case 'define': return defineStmts(x, C);
    case 'assign': return assignStmts(x, C);
    case 'var': return varStmts(x, C);
    /* 函数体里的 `const` 也是编译期常量（登记下来，不落变量）。 */
    case 'const': {
      for (const s of kids(x)) {
        const initTok = part(s, 'init');
        const names = kids(part(s, 'names')).map((n) => String(leaf(n)));
        const inits = initTok === undefined ? [] : kids(initTok);
        names.forEach((n, i) => {
          if (n === '_' || inits[i] === undefined) return;
          C.consts.set(C.ref(n), exprOf(inits[i], C));
        });
      }
      return [];
    }
    case 'inc': return [{ kind: 'assign', target: lhsOf(kids(x)[0], C), value: plus1(exprOf(kids(x)[0], C)) }];
    case 'dec': return [{
      kind: 'assign',
      target: lhsOf(kids(x)[0], C),
      value: { kind: 'binop', op: '-', left: exprOf(kids(x)[0], C), right: { kind: 'int', value: 1 } },
    }];
    case 'if': return ifStmts(x, C);
    case 'switch': return switchStmts(x, C);
    case 'for': return forStmts(x, C);
    case 'for-range': return forRangeStmts(x, C);
    case 'return': return returnStmts(x, C);
    case 'break': return [{ kind: 'break', label: null }];
    case 'continue': return [{ kind: 'continue', label: null }];
    /* **`defer f(x)` 的实参在这一刻就定下来**（`deferarg.go` 判的是这一条）：
       先把实参落进临时量，出口处调的是那几格临时量。 */
    case 'defer': {
      const pre = [];
      const callTok = kids(x)[0];
      const argsTok = part(callTok, 'args');
      const frozen = [];
      for (const a of (argsTok === undefined ? [] : kids(argsTok))) {
        const v = exprOf(a, C);
        const t = typeOf(v, C.tyCtx());
        const tmp = C.fresh('defer_');
        C.bind(tmp, t);
        pre.push({ kind: 'let', name: tmp, type: t, init: v });
        frozen.push(nameRef(tmp));
      }
      C.defers.push(deferBody(callTok, frozen, C));
      return pre;
    }
    case 'tswitch': return typeSwitchStmts(x, C, stmtsOf);
    /* 并发那一族（体在 `libomnigo` —— 见 `conc.js`）。 */
    case 'go': return goStmts(x, C);
    case 'send': return sendStmts(x, C);
    case 'select': return selectStmts(x, C, stmtsOf);
    case 'typeswitch': case 'label': case 'goto':
      throw new Error(`go->IR: \`${tag(x)}\` 这一格还没接`);
    default:
      throw new Error(`go->IR: 这一格语句还没接：${tag(x)}`);
  }
}

/** 一格 `defer` 里那个调用（实参已经冻成临时量了）→ 出口处要跑的语句。 */
function deferBody(callTok, frozen, C) {
  if (tag(callTok) !== 'call') throw new Error('go->IR: `defer` 后面要是一格调用');
  const fnTok = kids(callTok)[0];
  if (tag(fnTok) === 'sel' && C.imports.has(nameOf(kids(fnTok)[0]))) {
    const m = String(leaf(kids(fnTok)[1]));
    if (!PRINTS.has(m)) throw new Error(`go->IR: defer 里那格库函数还没接：${m}`);
    return printStmts(frozen, C);
  }
  const nm = nameOf(fnTok);
  if (nm === 'println' || nm === 'print') return printStmts(frozen, C);
  if (!C.fns.has(C.ref(nm))) throw new Error(`go->IR: defer 里叫的 ${nm} 没有登记过`);
  return [{ kind: 'expr-stmt', expr: { kind: 'call', fn: nameRef(C.ref(nm)), args: frozen } }];
}

/**
 * `fmt.Println(a, b)` —— **中间一个空格**。一格多值的调用摊开也是这样
 * （`fmt.Println(minmax(1, 2))` -> `1 2`）。
 */
function printStmts(values, C) {
  if (values.length === 0) return [{ kind: 'print', values: [str('')] }];
  if (values.length === 1) {
    const t = typeOf(values[0], C.tyCtx());
    const fs = t.kind === 'named' ? (C.tyCtx().fields.get(t.name) ?? []) : [];
    /* 合成的多值记录（`mv…`）摊成"几格值中间一个空格"。 */
    if (t.kind === 'named' && /^mv\d+$/.test(t.name) && fs.length > 0) {
      const tmp = C.fresh('mvp');
      C.bind(tmp, t);
      const parts = fs.map((f) => ({ kind: 'field', obj: nameRef(tmp), name: f.name }));
      return [
        { kind: 'let', name: tmp, type: t, init: values[0] },
        { kind: 'print', values: [joinWithSpace(parts, C)] },
      ];
    }
    return [{ kind: 'print', values: [values[0]] }];
  }
  return [{ kind: 'print', values: [joinWithSpace(values, C)] }];
}

/** 几格值 → 一格串（中间一个空格）。 */
function joinWithSpace(values, C) {
  const s = (v) => (typeOf(v, C.tyCtx()).kind === 'string' ? v : { kind: 'builtin', name: 'tostr', args: [v] });
  return values.map(s).reduce((acc, v) => ({
    kind: 'binop', op: '+', left: { kind: 'binop', op: '+', left: acc, right: str(' ') }, right: v,
  }));
}

/** 语句位置上的表达式：印那一族与 `panic` 各自是一格语句。 */
function exprStmts(inner, C) {
  if (tag(inner) === 'call') {
    const fnTok = kids(inner)[0];
    const argsTok = part(inner, 'args');
    const as = argsTok === undefined ? [] : kids(argsTok);
    if (tag(fnTok) === 'sel' && tag(kids(fnTok)[0]) === 'name'
      && C.imports.has(nameOf(kids(fnTok)[0]))) {
      const m = String(leaf(kids(fnTok)[1]));
      if (PRINTS.has(m)) {
        /* `fmt.Printf` = `Sprintf` 再印一趟（换行归 `print`，见 `printfOf`）。 */
        if (m === 'Printf') return printfStmts(as, C);
        return printStmts(as.map((a) => exprOf(a, C)), C);
      }
      /* 别的库函数**照普通调用走**（`sort.Float64s(xs)` 那一族）—— `exprOf` 那边接。 */
    }
    const nm = tag(fnTok) === 'name' ? nameOf(fnTok) : '';
    if (nm === 'println' || nm === 'print') return printStmts(as.map((a) => exprOf(a, C)), C);
    if (nm === 'panic') {
      const msg = as.length === 0 ? str('panic') : exprOf(as[0], C);
      const line = typeOf(msg, C.tyCtx()).kind === 'string' ? msg : { kind: 'builtin', name: 'tostr', args: [msg] };
      return [
        { kind: 'print', values: [line] },
        { kind: 'builtin-stmt', name: 'fail', args: [line] },
      ];
    }
  }
  return [{ kind: 'expr-stmt', expr: exprOf(inner, C) }];
}

/** `x := e` / `a, b := f()` / `_, ok := m[k]`（comma-ok）/ `f := func(){…}`。 */
function defineStmts(x, C) {
  const targets = kids(part(x, 'lhs'));
  const values = kids(part(x, 'rhs'));
  /* **comma-ok**：`v, ok := m[k]` —— 第二格是"在不在"。 */
  if (targets.length === 2 && values.length === 1 && tag(values[0]) === 'index') {
    const obj = exprOf(kids(values[0])[0], C);
    const key = exprOf(kids(values[0])[1], C);
    if (typeOf(obj, C.tyCtx()).kind === 'map') {
      const mt = typeOf(obj, C.tyCtx());
      const out = [];
      const vName = C.ref(nameOf(targets[0]));
      const okName = C.ref(nameOf(targets[1]));
      const vt = mt.value;
      if (nameOf(targets[0]) !== '_') {
        C.bind(vName, vt);
        out.push({
          kind: 'let', name: vName, type: vt, init: dgetOr(obj, key, mt, C),
        });
      }
      if (nameOf(targets[1]) !== '_') {
        C.bind(okName, { kind: 'bool' });
        out.push({
          kind: 'let', name: okName, type: { kind: 'bool' },
          init: { kind: 'builtin', name: 'dhas', args: [obj, key] },
        });
      }
      return out;
    }
  }
  if (targets.length > 1 && values.length === 1) return destructure(targets, values[0], C);
  const out = [];
  targets.forEach((t, i) => {
    const raw = nameOf(t);
    const vTok = values[i];
    if (vTok !== undefined && tag(vTok) === 'fnlit' && raw !== '_') { C.lift(vTok, C.ref(raw)); return; }
    const value = exprOf(vTok, C);
    const type = typeOf(value, C.tyCtx());
    /* 被内层函数借走的那几格提成模块级 global（**先算初值再提名** —— `x := x + 1`
       右边那个 x 指的是外头那一格）。 */
    const g = raw === '_' ? null : C.promote(raw, type);
    if (g !== null) { out.push({ kind: 'assign', target: nameRef(g), value }); return; }
    const name = raw === '_' ? C.fresh('skip') : C.ref(raw);
    C.bind(name, type);
    out.push({ kind: 'let', name, type, init: value });
  });
  return out;
}

/** `a, b := f()`：先落一格记录，再逐格取字段。 */
function destructure(targets, vTok, C) {
  const value = exprOf(vTok, C);
  const ty = typeOf(value, C.tyCtx());
  const tmp = C.fresh('mv_');
  C.bind(tmp, ty);
  const out = [{ kind: 'let', name: tmp, type: ty, init: value }];
  const fs = ty.kind === 'named' ? (C.tyCtx().fields.get(ty.name) ?? []) : [];
  targets.forEach((t, i) => {
    const raw = nameOf(t);
    const type = fs[i] === undefined ? INT : fs[i].type;
    const name = raw === '_' ? C.fresh('skip') : C.ref(raw);
    C.bind(name, type);
    out.push({
      kind: 'let', name, type, init: { kind: 'field', obj: nameRef(tmp), name: `v${i}` },
    });
  });
  return out;
}

/** `var x T` / `var x = e` / `var a, b = 1, 2`（函数体里那一档）。 */
function varStmts(x, C) {
  const out = [];
  for (const s of kids(x)) {
    const names = kids(part(s, 'names')).map((n) => String(leaf(n)));
    const tyTok = kids(s).find((y) => !['names', 'init'].includes(tag(y)));
    const initTok = part(s, 'init');
    const inits = initTok === undefined ? [] : kids(initTok);
    names.forEach((n, i) => {
      const { type, value } = declValue(tyTok, inits[i], C);
      const g = n === '_' ? null : C.promote(n, type);
      if (g !== null) {
        out.push({ kind: 'assign', target: nameRef(g), value: value ?? C.zeroOf(type) });
        return;
      }
      const name = n === '_' ? C.fresh('skip') : C.ref(n);
      C.bind(name, type);
      out.push({
        kind: 'let', name, type, init: value ?? C.zeroOf(type),
      });
    });
  }
  return out;
}

/**
 * `var`（模块级与函数体里共用）那一格的类型与初值。
 * **写了类型就按它落**（无类型常量升格、省类型的字面量补类型）；没写就照初值算。
 * 刻意不"先算一遍再重算"：`exprOf` 会提升函数字面量、造临时量 —— 算两趟会多出一份声明。
 */
function declValue(tyTok, initTok, C) {
  if (tyTok !== undefined) {
    const type = typeOfTok(tyTok, C);
    return { type, value: valueOf(initTok, type, C) };
  }
  if (initTok === undefined) return { type: INT, value: null };
  const value = exprOf(initTok, C);
  return { type: typeOf(value, C.tyCtx()), value };
}

/** 赋值的左边那一格（字典的下标单独一档 —— 它发的是 `dset`）。 */
function lhsOf(t, C) {
  if (tag(t) === 'paren') return lhsOf(kids(t)[0], C);
  if (tag(t) === 'deref') return lhsOf(kids(t)[0], C);
  if (tag(t) === 'sel') {
    return { kind: 'field', obj: exprOf(kids(t)[0], C), name: String(leaf(kids(t)[1])) };
  }
  if (tag(t) === 'index') {
    const obj = exprOf(kids(t)[0], C);
    const index = exprOf(kids(t)[1], C);
    return { kind: typeOf(obj, C.tyCtx()).kind === 'map' ? 'dict' : 'index', obj, index };
  }
  if (tag(t) === 'name') return nameRef(C.ref(nameOf(t)));
  throw new Error(`go->IR: 赋值的左边是 ${tag(t)} —— 还没接`);
}

/** 赋值左边那一格装的是什么类型（`dset` 那一档 typeOf 认不出来，这儿补上）。 */
function targetType(t, C) {
  if (t.kind === 'dict') {
    const mt = typeOf(t.obj, C.tyCtx());
    return mt.kind === 'map' ? mt.value : INT;
  }
  return typeOf(t, C.tyCtx());
}

function assignStmts(x, C) {
  const o = String(leaf(kids(x)[0]));
  const aug = o === '=' ? null : AUG.get(o.replace('=', ''));
  if (o !== '=' && aug === undefined) throw new Error(`go->IR: 这个复合赋值还没接：${o}`);
  const targets = kids(part(x, 'lhs'));
  const values = kids(part(x, 'rhs'));
  if (targets.length > 1 && values.length === 1) {
    /* `a, b = f()` —— 先落一格记录再逐格写回。 */
    const value = exprOf(values[0], C);
    const ty = typeOf(value, C.tyCtx());
    const tmp = C.fresh('mv_');
    C.bind(tmp, ty);
    const out = [{ kind: 'let', name: tmp, type: ty, init: value }];
    targets.forEach((t, i) => {
      if (nameOf(t) === '_') return;
      out.push({
        kind: 'assign',
        target: lhsOf(t, C),
        value: { kind: 'field', obj: nameRef(tmp), name: `v${i}` },
      });
    });
    return out;
  }
  /**
   * **`x, y = y, x` 要先把右边全算进临时量**（go 的多重赋值是"先全算右边、再全写左边"）——
   * 一格一格顺着写是**静默的错答案**（`22-swap.go` 量出来的：7/9 换出来成了 9/9）。
   */
  if (targets.length > 1 && values.length === targets.length) {
    const pre = [];
    const lhs = targets.map((t) => (tag(t) === 'name' && nameOf(t) === '_' ? null : lhsOf(t, C)));
    const tmps = values.map((v, i) => {
      const val = valueOf(v, lhs[i] === null ? null : targetType(lhs[i], C), C);
      const t = typeOf(val, C.tyCtx());
      const tmp = C.fresh('asn_');
      C.bind(tmp, t);
      pre.push({ kind: 'let', name: tmp, type: t, init: val });
      return nameRef(tmp);
    });
    lhs.forEach((target, i) => {
      if (target === null) return;
      if (target.kind === 'dict') {
        pre.push({ kind: 'builtin-stmt', name: 'dset', args: [target.obj, target.index, tmps[i]] });
        return;
      }
      pre.push({ kind: 'assign', target, value: tmps[i] });
    });
    return pre;
  }
  return targets.flatMap((t, i) => {
    if (tag(t) === 'name' && nameOf(t) === '_') return [{ kind: 'expr-stmt', expr: exprOf(values[i], C) }];
    const target = lhsOf(t, C);
    const tt = targetType(target, C);
    const read = target.kind === 'dict' ? dgetOr(target.obj, target.index, typeOf(target.obj, C.tyCtx()), C) : target;
    const rhs = valueOf(values[i], tt, C);
    const value = aug === null ? rhs : { kind: 'binop', op: aug, left: read, right: rhs };
    if (target.kind === 'dict') {
      return [{ kind: 'builtin-stmt', name: 'dset', args: [target.obj, target.index, value] }];
    }
    return [{ kind: 'assign', target, value }];
  });
}

/** `if [init;] cond { … } else { … }`（`else` 里可以直接跟一格 `if`）。 */
function ifStmts(x, C) {
  const initTok = part(x, 'init');
  C.push();
  const pre = initTok === undefined ? [] : kids(initTok).flatMap((s) => stmtsOf(s, C));
  const condTok = kids(x).find((y) => !['init', 'block', 'else'].includes(tag(y)));
  const cond = condOf(condTok, C);
  const then = C.blockStmts(part(x, 'block'));
  const elseTok = part(x, 'else');
  let els = null;
  if (elseTok !== undefined) {
    const inner = kids(elseTok)[0];
    els = tag(inner) === 'block' ? C.blockStmts(inner) : stmtsOf(inner, C);
  }
  C.pop();
  const one = { kind: 'if', cond, then, else_: els };
  /* init 那一格归这格 if（`(do …)` 自己一层作用域）。 */
  return pre.length === 0 ? [one] : [{ kind: 'block', stmts: [...pre, one] }];
}

/**
 * `switch` 三种形状落成同一条 if 链：
 *   带主语（`switch k { case 4: }`）—— 每一支是"主语 == 那几个值"（`||` 串起来）；
 *   不带主语（`switch { case n > 0: }`）—— 每一支是自己的条件；
 *   带 init（`switch k := …; k {`）—— init 摆在前面，整格包一层作用域。
 * **`default` 那一支的位置随便放**（go 允许），所以按标签挑，不按次序。
 */
function switchStmts(x, C) {
  C.push();
  const initTok = part(x, 'init');
  const pre = initTok === undefined ? [] : kids(initTok).flatMap((s) => stmtsOf(s, C));
  const tagTok = part(x, 'tag');
  let subj = null;
  if (tagTok !== undefined) {
    subj = exprOf(kids(tagTok)[0], C);
    if (subj.kind !== 'name') {
      const tmp = C.fresh('sub');
      const t = typeOf(subj, C.tyCtx());
      C.bind(tmp, t);
      pre.push({ kind: 'let', name: tmp, type: t, init: subj });
      subj = nameRef(tmp);
    }
  }
  const arms = [];
  let els = null;
  for (const c of kids(x)) {
    if (tag(c) === 'default') { els = C.blockStmts(part(c, 'body')); continue; }
    if (tag(c) !== 'case') continue;
    const items = kids(part(c, 'items'));
    const cond = items.map((v) => (subj === null
      ? condOf(v, C)
      : { kind: 'binop', op: '==', left: subj, right: exprOf(v, C) }))
      .reduce((acc, one) => ({ kind: 'binop', op: '||', left: acc, right: one }));
    arms.push({ cond, body: C.blockStmts(part(c, 'body')) });
  }
  let out = els;
  for (let i = arms.length - 1; i >= 0; i--) {
    out = [{ kind: 'if', cond: arms[i].cond, then: arms[i].body, else_: out }];
  }
  C.pop();
  const all = [...pre, ...(out ?? [])];
  return pre.length === 0 ? all : [{ kind: 'block', stmts: all }];
}

/** 三段式 `for`（哪一段都可以没有；没有条件就是死循环）。 */
function forStmts(x, C) {
  const has = (t) => t !== undefined && kids(t).length > 0 && tag(kids(t)[0]) !== 'none';
  const initTok = part(x, 'init');
  const condTok = part(x, 'cond');
  const postTok = part(x, 'post');
  C.push();
  const init = has(initTok) ? stmtsOf(kids(initTok)[0], C) : [];
  /* `for cond { }` 那一档：条件既可能在 `(cond …)` 里，也可能是光秃秃的一格。 */
  const bareCond = kids(x).find((y) => !['init', 'cond', 'post', 'block'].includes(tag(y)));
  const cond = has(condTok) ? condOf(kids(condTok)[0], C)
    : (bareCond === undefined ? null : condOf(bareCond, C));
  const post = has(postTok) ? stmtsOf(kids(postTok)[0], C) : [];
  const body = C.blockStmts(part(x, 'block'));
  C.pop();
  if (post.length > 1) throw new Error('go->IR: for 的步进那一段不止一句 —— 还没接');
  return [...init.slice(0, -1), {
    kind: 'for',
    init: init[init.length - 1] ?? null,
    cond: cond ?? { kind: 'bool', value: true },
    post: post[0] ?? null,
    body,
  }];
}

/**
 * `for i, v := range xs` / `for range xs` / `for j, e = range xs`。
 * **表上按键走一遍当场报**：方言里没有能装下那格键列表的类型 —— 那是一次语言决定
 * （与 nim / V 同一格）。
 */
function forRangeStmts(x, C) {
  const declTok = kids(x).find((y) => tag(y) === 'define' || tag(y) === 'assign');
  const names = declTok === undefined ? [] : kids(declTok).map((n) => nameOf(n));
  const valTok = kids(part(x, 'values'))[0];
  const step = (n) => ({ kind: 'assign', target: nameRef(n), value: plus1(nameRef(n)) });
  const declare = declTok === undefined || tag(declTok) === 'define';

  const pre = [];
  let box = exprOf(valTok, C);
  const t = typeOf(box, C.tyCtx());
  /* **通道上的 range**（收到关为止）—— 见 `conc.js`。 */
  if (t.chan !== undefined) return rangeChanStmts(x, C, box, names, declare, stmtsOf);
  if (t.kind === 'map') {
    throw new Error('go->IR: 按键遍历（`for k, v := range m`）：方言里没有能装下那格键列表的类型'
      + '（只有 `(arr T)`，而 `keys` 出的是 `list<K>`，它在方言里一个操作都没有）——'
      + ' 要先给方言加一格，是一次语言决定');
  }
  if (t.kind !== 'arr' && t.kind !== 'string') {
    throw new Error(`go->IR: \`for … range\` 只接数组与串（这一格装的是 ${t.kind}）`);
  }
  if (box.kind !== 'name') {
    const tmp = C.fresh('iter_');
    C.bind(tmp, t);
    pre.push({ kind: 'let', name: tmp, type: t, init: box });
    box = nameRef(tmp);
  }
  const lenOf = { kind: 'builtin', name: t.kind === 'string' ? 'slen' : 'alen', args: [box] };
  const elemT = t.kind === 'string' ? STR : t.elem;
  const idxRaw = names[0];
  const elemRaw = names[1];
  /* **下标用一格藏起来的计数器**，用户那格量在**体里**写一次 —— go 是每一趟赋一次值，
     所以循环结束之后它停在**最后一趟**的下标上（`forrange.go` 里 `j + e` 要 32，
     用步进那格量会得到 33 —— 量出来的）。 */
  const hidden = C.fresh('for_i');
  C.push();
  C.bind(hidden, INT);
  const body = [];
  if (idxRaw !== undefined && idxRaw !== '_') {
    const iname = C.ref(idxRaw);
    C.bind(iname, INT);
    body.push(declare
      ? { kind: 'let', name: iname, type: INT, init: nameRef(hidden) }
      : { kind: 'assign', target: nameRef(iname), value: nameRef(hidden) });
  }
  if (elemRaw !== undefined && elemRaw !== '_') {
    const elem = C.ref(elemRaw);
    C.bind(elem, elemT);
    const read = t.kind === 'string'
      ? { kind: 'builtin', name: 'ssub', args: [box, nameRef(hidden), { kind: 'int', value: 1 }] }
      : { kind: 'index', obj: box, index: nameRef(hidden) };
    body.push(declare
      ? { kind: 'let', name: elem, type: elemT, init: read }
      : { kind: 'assign', target: nameRef(elem), value: read });
  }
  body.push(...C.blockStmts(part(x, 'block')));
  C.pop();
  return [...pre, {
    kind: 'for',
    init: { kind: 'let', name: hidden, type: INT, init: { kind: 'int', value: 0 } },
    cond: { kind: 'binop', op: '<', left: nameRef(hidden), right: lenOf },
    post: step(hidden),
    body,
  }];
}

/** `return` —— 多值合成一格记录（签名那一侧落的也是它）。 */
function returnStmts(x, C) {
  return returnValues(kids(x), C);
}

/**
 * 几格 `return` 的实参（一格都没有 = 具名返回值那一档，交那几格局部量）。
 * 每一格都按**声明的返回类型**落（`u = 1` 在 `(u float64)` 上要是 1.0）。
 */
function returnValues(vs, C) {
  const pre = exitStmts(C);
  const res = C.cur.results ?? [];
  const tys = res.map((r) => r.type);
  const nres = C.cur.named ?? [];
  if (vs.length === 0 && nres.length > 0) {
    const reads = nres.map((r) => nameRef(r.name));
    return [...pre, { kind: 'return', values: [nres.length === 1 ? reads[0] : mvOf(reads, tys, C)] }];
  }
  if (vs.length === 0) return [...pre, { kind: 'return', values: [] }];
  if (vs.length === 1) return [...pre, { kind: 'return', values: [valueOf(vs[0], tys[0], C)] }];
  const parts = vs.map((v, i) => valueOf(v, tys[i], C));
  return [...pre, { kind: 'return', values: [mvOf(parts, tys, C)] }];
}

/** 几格值 → 一格合成的多值记录。 */
function mvOf(parts, tys, C) {
  const ty = C.mvType(parts.map((p, i) => tys[i] ?? typeOf(p, C.tyCtx())));
  return {
    kind: 'new-record',
    type: ty,
    ref: false,
    fields: parts.map((p, i) => ({ name: `v${i}`, value: p })),
  };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. `expr.js` 文件末尾那四条（引用语义 · any · 库里的东西 · 相等）。
//   2. 泛型只把类型参数当 int（明说的近似，不做单态化）。
//   3. `fallthrough` / 带标号的 break/continue / goto 没接。
//   4. **模块级 var 的初始化不是真的依赖排序**：这一层分两趟（纯字面量的先赋、
//      带调用的后赋）。真依赖排序要一张"函数读了哪些全局"的表。
//   5. 按键遍历字典（`for k := range m`）当场报 —— 方言里没有能装下那格键列表的类型。

/**
 * **这份文件 import 了哪几格**（驱动那一层拿它去旁边找同名的 `.go`）。
 * `import "./util"` -> `./util`（`drive.js` 去掉 `./` 再找）；`import "fmt"` 旁边没有
 * `fmt.go`，于是照旧交给 adapter。
 */
export function goImports(tree) {
  const out = [];
  for (const d of kids(tree)) {
    if (tag(d) !== 'import') continue;
    for (const p of kids(d)) {
      const path = String(leaf(kids(p)[0]) ?? '');
      if (path !== '') out.push(path);
    }
  }
  return out;
}

