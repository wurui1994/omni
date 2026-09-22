// ext/go/adapter/iface.js —— **go 的接口**（ADR-0040 的形状，落在 ADR-0044 的公共降级器上）
//
// 一格接口值是**一格方法闭包的记录**（方言的 `(class …)`，字段是 `(fnty …)`）：
//
//   (class Shape (__type int) (Area (fnty () int)) (Name (fnty () string)) (__as_Sq (fnty () Sq)))
//
//   * `__type` 是**具体类型的号**（类型 switch 按它分支 —— 比字段，不调运行期函数）；
//   * 每个方法一格闭包字段，捕获的是接收者（`x.Area()` 落成 `(callfn (fld x Area))`）；
//   * `__as_T` 是**降回去那一格**：`switch t := s.(type) { case *Sphere: t.Radius }` 要拿回
//     接收者，而记录上压根没有它。自己那一份交回 `(cap self)`、别人那几份交回 `(null T)`。
//     名字与类型对同一个接口的**所有**实现者逐字相同 —— 所以 `[]Shape` 还是单态的
//     （那正是不能把接收者直接摆一格字段的原因：那一格的类型跟着具体类型变）。
//
// **nil 接口就是 `(null I)`**（图那条路上是"全是桩的记录"，这儿不必 —— 名字是明写的类，
// 空引用现成）。于是 `s == nil` 就是句柄比较，与 go 对齐。
//
// **装箱要记忆**：`__box_T__I(x)` 每调一次造一格新箱子的话，同一个接收者装出来的两格句柄
// 不同，于是 `h.Shape == a` 恒为假（答案静默地错，`39-iface-eq.go` 判的正是这条）。
// 所以每个实现者身上加一格隐藏字段 `__boxof_I`：装箱先看它、没有再造。

import { tag, kids, leaf, part } from '../../../src/core/lower/cst.js';
import { INT, named } from '../../../src/core/lower/ty-of.js';
import { typeOfTok, retTypeOf, paramsOf, nameOf } from './expr.js';

const nameRef = (n) => ({ kind: 'name', name: n });

/** 一格接口的类型描述（`iface: true` 那一位是"别再装箱"与"零值是 null"的判据）。 */
export const ifaceType = (n) => ({ kind: 'named', name: n, ref: true, iface: true });

/** `(interface (m 名 (sig …)) …)` → 那几格方法（嵌入的接口摊平）。 */
export function ifaceMethodToks(declTok, ifaceDecls, seen = new Set()) {
  const out = [];
  for (const m of kids(declTok)) {
    if (tag(m) === 'm') { out.push(m); continue; }
    /* 嵌入的接口（`interface { Reader; Writer }`）—— 摊平，环上只走一趟。 */
    const n = nameOf(m);
    if (!ifaceDecls.has(n) || seen.has(n)) continue;
    out.push(...ifaceMethodToks(ifaceDecls.get(n), ifaceDecls, new Set([...seen, n])));
  }
  return out;
}

/** 一格 `(m 名 (sig …))` → `{ name, params, ret }`（形参名按位置编，不看源码里那几个）。 */
export function ifaceMethodSig(mTok, C) {
  const name = String(leaf(kids(mTok)[0]));
  const sigTok = part(mTok, 'sig');
  const params = paramsOf(sigTok === undefined ? undefined : part(sigTok, 'in'), C)
    .map((p, i) => ({ name: `a${i}`, type: p.type }));
  const ret = retTypeOf(sigTok === undefined ? undefined : part(sigTok, 'out'), C);
  return { name, params, ret };
}

/** 一格方法闭包字段的类型。 */
export const methodFieldType = (sig) => ({
  kind: 'fn-type', params: sig.params.map((p) => p.type), ret: sig.ret,
});

/**
 * 接口 I 那格记录的字段表：`__type` + 每个方法一格闭包 + 每个要降回去的类型一格 `__as_T`。
 * 次序按名字排（同一个接口的所有箱子形状要逐字相同）。
 */
export function ifaceFields(ifn, C) {
  const ms = C.ifaces.get(ifn) ?? [];
  const out = [{ name: '__type', type: INT }];
  for (const sig of [...ms].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    out.push({ name: sig.name, type: methodFieldType(sig) });
  }
  for (const tn of narrowedFor(ifn, C)) {
    out.push({
      name: `__as_${tn}`,
      type: { kind: 'fn-type', params: [], ret: named(tn, true) },
    });
  }
  return out;
}

/** 这个接口要给哪几个具体类型留"降回去"那一格（按名字排）。 */
export function narrowedFor(ifn, C) {
  return [...C.narrow].filter((tn) => implementsIface(tn, ifn, C)).sort();
}

/** 具体类型 tn 实现了接口 ifn 吗（方法名全有就算 —— 这一层不比签名）。 */
export function implementsIface(tn, ifn, C) {
  const ms = C.ifaces.get(ifn) ?? [];
  if (ms.length === 0) return false;
  return ms.every((sig) => C.methods.has(`${tn}.${sig.name}`));
}

/** 装箱记忆那格隐藏字段的名字。 */
export const boxMemoName = (ifn) => `__boxof_${ifn}`;

/**
 * **把一格具体类型的值装进接口**。`__box_T__I` 造一次、记在接收者身上（见文件头那段话）。
 * 回一格调用表达式。
 */
export function boxOf(value, ifn, tn, C) {
  return { kind: 'call', fn: nameRef(ensureBoxFn(tn, ifn, C)), args: [value] };
}

/** 造（或找回）`__box_T__I`。 */
export function ensureBoxFn(tn, ifn, C) {
  const name = `__box_${tn}__${ifn}`;
  if (C.fns.has(name)) return name;
  const self = named(tn, true);
  const ity = ifaceType(ifn);
  const params = [{ name: '__self', type: self }];
  C.fns.set(name, { params, ret: ity, results: [{ name: null, type: ity }] });

  const memo = boxMemoName(ifn);
  const memoRead = { kind: 'field', obj: nameRef('__self'), name: memo };
  const box = '__box';
  const body = [];
  /* 记忆那一格：已经装过就交回同一格箱子（接口之间的 `==` 靠它）。 */
  body.push({
    kind: 'if',
    cond: { kind: 'binop', op: '!=', left: memoRead, right: { kind: 'null', type: ity } },
    then: [{ kind: 'return', values: [memoRead] }],
    else_: null,
  });
  body.push({
    kind: 'let', name: box, type: ity, init: { kind: 'new-record', type: ity, ref: true, fields: [] },
  });
  body.push({
    kind: 'assign',
    target: { kind: 'field', obj: nameRef(box), name: '__type' },
    value: { kind: 'int', value: C.typeId(tn) },
  });
  for (const sig of C.ifaces.get(ifn) ?? []) {
    body.push({
      kind: 'assign',
      target: { kind: 'field', obj: nameRef(box), name: sig.name },
      value: {
        kind: 'make-closure',
        name: ensureMethodClosure(tn, ifn, sig, C),
        caps: [nameRef('__self')],
        type: methodFieldType(sig),
      },
    });
  }
  for (const un of narrowedFor(ifn, C)) {
    body.push({
      kind: 'assign',
      target: { kind: 'field', obj: nameRef(box), name: `__as_${un}` },
      value: {
        kind: 'make-closure',
        name: ensureDownClosure(tn, un, C),
        caps: [nameRef('__self')],
        type: { kind: 'fn-type', params: [], ret: named(un, true) },
      },
    });
  }
  body.push({ kind: 'assign', target: memoRead, value: nameRef(box) });
  body.push({ kind: 'return', values: [nameRef(box)] });
  C.decls.push({
    kind: 'fn', name, params, ret: ity, body,
  });
  return name;
}

/** 一格方法闭包：捕获接收者，体里是一次普通调用。 */
function ensureMethodClosure(tn, ifn, sig, C) {
  const name = `__bm_${tn}__${ifn}__${sig.name}`;
  if (C.closures.has(name)) return name;
  C.closures.add(name);
  const self = named(tn, true);
  const target = C.methods.get(`${tn}.${sig.name}`);
  if (target === undefined) throw new Error(`go->IR: ${tn} 上没有方法 ${sig.name}（装不进 ${ifn}）`);
  const args = [{ kind: 'capture', name: '__self', type: self },
    ...sig.params.map((p) => ({ kind: 'name', name: p.name }))];
  const call = { kind: 'call', fn: nameRef(target.name), args };
  C.decls.push({
    kind: 'closure',
    name,
    caps: [{ name: '__self', type: self }],
    params: sig.params,
    ret: sig.ret,
    body: [sig.ret.kind === 'void'
      ? { kind: 'expr-stmt', expr: call }
      : { kind: 'return', values: [call] }],
  });
  return name;
}

/** 降回去那一格闭包：自己那一份交回接收者，别人那几份交回空引用。 */
function ensureDownClosure(tn, un, C) {
  const name = `__bas_${tn}__${un}`;
  if (C.closures.has(name)) return name;
  C.closures.add(name);
  const self = named(tn, true);
  const ret = named(un, true);
  C.decls.push({
    kind: 'closure',
    name,
    caps: [{ name: '__self', type: self }],
    params: [],
    ret,
    body: [{
      kind: 'return',
      values: [tn === un
        ? { kind: 'capture', name: '__self', type: self }
        : { kind: 'null', type: ret }],
    }],
  });
  return name;
}

/**
 * **哪几个具体类型要"降回去"**：`switch t := s.(type) { case *Sphere: … }` 那种
 * "只有一个类型名、而且带绑定"的支。go 在"一支收多个类型"里本来也不收窄，所以只收这一族。
 * 预扫描（不是边走边置）：装箱可能在看到那处 switch 之前就落出来了，而箱子的形状得一次定死。
 */
export function collectNarrow(top) {
  const out = new Set();
  const walk = (n) => {
    if (n === null || n === undefined || !Array.isArray(n.items ?? null)) return;
    if (tag(n) === 'tswitch' && part(n, 'bind') !== undefined) {
      for (const c of kids(n)) {
        if (tag(c) !== 'case') continue;
        const items = kids(part(c, 'items'));
        if (items.length !== 1) continue;
        const tn = bareTypeName(items[0]);
        if (tn !== null) out.add(tn);
      }
    }
    for (const k of kids(n)) walk(k);
  };
  for (const t of top) walk(t);
  return out;
}

/** `*Sphere` / `Sphere` → `Sphere`；`nil` 与别的形状回 null。 */
export function bareTypeName(tok) {
  if (tok === undefined || tok === null) return null;
  if (tag(tok) === 'ptr' || tag(tok) === 'paren') return bareTypeName(kids(tok)[0]);
  if (tag(tok) !== 'tname' && tag(tok) !== 'name') return null;
  const n = nameOf(tok);
  return n === 'nil' ? null : n.split('.').pop();
}

/**
 * `switch [v :=] s.(type) { case *T: … }` → if 链。
 * 每支的条件是 `s != nil && s.__type == 号`（`case nil` 那支是 `s == nil`）。
 * **只有"一个类型名 + 带绑定"那一支才收窄**（`v := s.__as_T()`），别的支里 v 还是接口。
 */
export function typeSwitchStmts(x, C, stmtsOf) {
  const bindTok = part(x, 'bind');
  const raw = bindTok === undefined ? null : String(leaf(kids(bindTok)[0]));
  const subj = C.exprOf(kids(part(x, 'subject'))[0]);
  const ity = C.typeOfIR(subj);
  if (ity.iface !== true) {
    throw new Error(`go->IR: \`switch … .(type)\` 的主语不是接口（装的是 ${ity.name ?? ity.kind}）`);
  }
  C.push();
  const pre = [];
  let box = subj;
  if (box.kind !== 'name') {
    const tmp = C.fresh('tsw');
    C.bind(tmp, ity);
    pre.push({ kind: 'let', name: tmp, type: ity, init: box });
    box = nameRef(tmp);
  }
  const isNull = (op) => ({ kind: 'binop', op, left: box, right: { kind: 'null', type: ity } });
  const arms = [];
  let els = null;
  const bodyWith = (bodyTok, narrowTo) => {
    C.push();
    const head = [];
    if (raw !== null && raw !== '_') {
      const nm = C.ref(raw);
      if (narrowTo === null) {
        C.bind(nm, ity);
        head.push({ kind: 'let', name: nm, type: ity, init: box });
      } else {
        const t = named(narrowTo, true);
        C.bind(nm, t);
        head.push({
          kind: 'let',
          name: nm,
          type: t,
          init: {
            kind: 'call-value',
            fn: { kind: 'field', obj: box, name: `__as_${narrowTo}` },
            args: [],
          },
        });
      }
    }
    const out = [...head, ...kids(bodyTok ?? { kind: 'list', items: [] }).flatMap((s) => stmtsOf(s, C))];
    C.pop();
    return out;
  };
  for (const c of kids(x)) {
    if (tag(c) === 'default') { els = bodyWith(part(c, 'body'), null); continue; }
    if (tag(c) !== 'case') continue;
    const items = kids(part(c, 'items'));
    const conds = items.map((it) => {
      const tn = bareTypeName(it);
      if (tn === null) return isNull('==');       // `case nil:`
      return {
        kind: 'binop',
        op: '&&',
        left: isNull('!='),
        right: {
          kind: 'binop',
          op: '==',
          left: { kind: 'field', obj: box, name: '__type' },
          right: { kind: 'int', value: C.typeId(tn) },
        },
      };
    });
    const one = conds.reduce((a, b) => ({ kind: 'binop', op: '||', left: a, right: b }));
    /* 收窄只在"一个类型名、不是 nil、而且那个类型留了 `__as_T`"那一支上。 */
    const only = items.length === 1 ? bareTypeName(items[0]) : null;
    const narrowTo = only !== null && C.narrow.has(only) && implementsIface(only, ity.name, C)
      ? only : null;
    arms.push({ cond: one, body: bodyWith(part(c, 'body'), narrowTo) });
  }
  let out = els;
  for (let i = arms.length - 1; i >= 0; i--) {
    out = [{ kind: 'if', cond: arms[i].cond, then: arms[i].body, else_: out }];
  }
  C.pop();
  const all = [...pre, ...(out ?? [])];
  return pre.length === 0 ? all : [{ kind: 'block', stmts: all }];
}
