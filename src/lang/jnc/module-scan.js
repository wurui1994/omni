// src/lang/jnc/module-scan.js —— **一份模块扫一遍**：名字、类型、聚合体、函数、模块级那几格量
//
// 这一份回答"这份源码里有些什么"，供两处用：
//   - `lower.js`（真降级）：按声明序把 `(struct …)` / `(global …)` / `(fn …)` 发出来；
//   - `emit-ctx.js`（函数体那一层的探子）：裸名字查名、字段表、调用那一族要它。
//
// 一份规则只有一处家：这一份先前长在尺子里（tests/lib/jnc-body-emit.js 的 topAggs / topFns），
// 现在搬进 src/，尺子与真降级**用同一份**。

import { headOf, named } from './adapt.js';
import { nameText, allInChain, readDcl } from './declare.js';
import { readDeclType } from './types.js';
import { readSpecs } from './specs.js';
import { readAgg, readEnum } from './agg.js';
import { enumBase } from './const-eval.js';
import { resolveType } from './resolve-type.js';
import { readFormals, fnName } from './emit-fn.js';
import { classRoot } from './emit-agg.js';
/**
 * 一格函数/方法的**签名**（形参、默认实参、返回、`errorcode`、方言那一侧的名字）。
 * 顶层那条路与类里那条路共用它 —— 调用那一层问的是同一件事，不该有两份答案。
 */
export function sigOf(nm, env, emit, t0 = null) {
  const t = t0 ?? (nm === null || nm === undefined ? null : readDeclType(nm.specs, nm.dcl));
  if (t === null) return null;
  /* 声明符与说明符都从**类型自己**带的原树上取（`t.raw`）：类里只写原型的那一格
     （`int scaled(int k);`）是一格 `var-decl`，它的洞叫 `dcls` 而不是 `dcl` —— 照 `nm.dcl`
     读就永远是 undefined，那一格方法于是查不着（93-structmeth.jnc 的 `P$scaled`）。 */
  const dc = readDcl(t.raw?.dcl ?? nm?.dcl);
  const sf = dc === null ? undefined : dc.suffixes.find((x) => x.kind === 'fn-suffix');
  const fs = sf === undefined ? [] : (readFormals(sf.node) ?? []);
  const rr = t.base.kind === 'none' ? null : resolveType({ ...t, shape: 'data' }, env);
  const sp = readSpecs(t.raw?.specs ?? nm?.specs);
  const words = sp === null ? [] : sp.words;
  return {
    params: fs.map((f) => (f.type === null ? null : f.type)),
    /* **默认实参**（第一百七十五刀）：`void def(void function* cb() = null)` 里那一格
       躺在 `formal` 的 `init` 洞里（节点表 :51）。调用时实参给少了就按它补。 */
    defaults: fs.map((f) => named(f.at)?.init ?? null),
    ret: rr === null || rr.type === null || rr.type.k === 'void' ? null : rr.type,
    retDecl: t,
    /* 方言那一侧的名字（命名空间前缀 / 东家前缀都在里头）。 */
    emit,
    /* `errorcode` 那一族（第五十八刀）：调它的那一处要把"出错就跳"提上来（`EC_HOIST`）。 */
    ec: words.includes('errorcode'),
    stat: words.includes('static'),
  };
}

/** 最小的那份探子：形参与局部量的类型表。 */
/** 顶层那几格函数的签名（名字 → { params, ret }）—— 调用那一族要它。 */
export function scanFns(tree, env) {
  const out = new Map();
  const dig = (n, ns) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    if (h === 'agg') return;
    let inner = ns;
    /* **命名空间只是个前缀**（与聚合体那条腿同一口径）：`ns.f` 在方言里叫 `ns$f`。
       所以这一层要跟着走，不然调用那一处发的是 `(call f)` 而声明是 `(fn ns$f …)`。 */
    if (h === 'namespace') {
      const nsn = nameText(named(n)?.name);
      if (nsn !== null) inner = ns === null ? nsn : `${ns}$${nsn}`;
    }
    if (h === 'fn-def' || h === 'fn-proto') {
      const nm = named(n);
      const t = nm === null ? null : readDeclType(nm.specs, nm.dcl);
      if (t !== null && t.shape === 'fn') {
        if (t.name !== null) {
          const emit = ns === null ? t.name : `${ns}$${t.name}`;
          const sig = sigOf(nm, env, emit);
          if (sig !== null) {
            out.set(t.name, sig);
            if (ns !== null) out.set(emit, sig);
          }
        } else {
          /* **体外定义的方法**（`int P.scaled(int k) { … }`）：名字是点串，在方言那一侧
             整串用 `$` 接起来（`fnName`）。它按东家那一格登记 —— 调用那一层查的就是它。 */
          const dotted = fnName({ name: null, type: t, at: n });
          if (dotted !== null) {
            const sig = sigOf(nm, env, ns === null ? dotted : `${ns}$${dotted}`);
            if (sig !== null) out.set(ns === null ? dotted : `${ns}$${dotted}`, sig);
          }
        }
      }
      return;
    }
    for (const it of n.items) dig(it, inner);
  };
  dig(tree, null);
  return out;
}

/**
 * 顶层那几格**聚合体**：一边把名字记进 `env`（`resolveType` 要它才认得 `Inner`），
 * 一边攒一张**字段表**（`emitName` → 名字 → 那一格的声明类型）—— 取字段与"往字段里写"
 * 两侧都从它出发。位域、别名路径、属性那几族**不收**（`member-table.js` 的七格里那几条
 * 各有自己的一套，收进来就等于拿普通字段那一支把它们悄悄接走了）。
 */
export function scanAggs(tree, env) {
  const fields = new Map();
  const ctors = new Set();                                           // 有 construct 的那几格
  const vars = new Map();                                            // 模块级那几格量（名字 → 声明类型）
  const gEmit = new Map();                                           // 名字 → 方言那一侧的名字（带命名空间前缀）
  const methods = new Map();                                         // `东家$方法名` → 签名 + 那个节点
  const bindable = new Set();                                        // 里头带取/存两格的那几个
  const aggs = [];                                                   // 收齐了好算继承链的根
  const scan = (n, owner, inAgg) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    let agg = inAgg;
    /* 函数体里的东西不往下扫（局部量由体那一层管，局部类先不管）。 */
    if (h === 'fn-def' || h === 'fn-proto') return;
    if (h === 'namespace') {
      const nm = nameText(named(n)?.name);
      if (nm !== null) inner = owner === null ? nm : `${owner}$${nm}`;
    } else if (h === 'agg') {
      agg = true;
      const a = readAgg(n);
      const nm = a === null ? null : nameText(a.name);
      if (a !== null && nm !== null) {
        const emitName = owner === null ? nm : `${owner}$${nm}`;
        inner = emitName;
        a.emitName = emitName;
        aggs.push(a);
        env.set(nm, {
          kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
          name: emitName,
          agg: a,
        });
        const fs = new Map();
        for (const m of a.members) {
          if (m.name === null || m.type === null) continue;
          if (m.shape === 'bitfield' || m.shape === 'prop' || m.shape === 'event') continue;
          if (m.shape === 'typedef' || m.shape === 'nested-type' || m.shape === 'friend') continue;
          if (m.shape === 'fn') { if (m.name === 'construct') ctors.add(emitName); continue; }
          if (m.storage.includes('static')) continue;                // 不进对象（落成模块级那一格）
          fs.set(m.name, m.type);
        }
        fields.set(emitName, fs);
        /* **方法那一族**（`<东家>$<方法名>`，第五十二刀）：一格一格记下签名与那个节点。
           体写在类里的（`fn-def`）由这一层发；只写原型的（`fn-proto`）体在外面，那一格
           由顶层那条路发 —— 两处登记的是**同一个名字**，所以调用那一层只查一张表。 */
        for (const m of a.members) {
          const mh = headOf(m.at);
          /* 三种写法都是方法：带体的（`fn-def`）、类里只写原型的（那一格落成 `var-decl`，
             `m.shape === 'fn'`）、以及独立的原型节点（`fn-proto`）。 */
          if (mh !== 'fn-def' && mh !== 'fn-proto' && m.shape !== 'fn') continue;
          /* 名字走 `fnName`：`construct` / `destruct` / 算符重载那几格**没有普通名字**
             （`m.name` 是 null），而它们正是方法那一族里最要紧的几个。 */
          const mname = fnName({ name: m.name, type: m.type, at: m.at });
          if (mname === null) continue;
          const key = `${emitName}$${mname}`;
          const sig = sigOf(named(m.at), env, key, m.type);
          if (sig === null) continue;
          methods.set(key, {
            ...sig, owner: emitName, name: mname, node: m.at, hasBody: mh === 'fn-def',
          });
        }

      }
    } else if (h === 'typedef') {
      const tn = named(n);
      if (tn !== null) {
        for (const d of allInChain(tn.dcls, 'dcls-add', 'dcls')) {
          const t = readDeclType(tn.specs, d);
          if (t !== null && t.name !== null) env.set(t.name, { kind: 'typedef', type: t });
        }
      }
    } else if (h === 'enum') {
      const e = readEnum(n);
      const nm = e === null ? null : nameText(e.name);
      if (nm !== null) {
        /* 枚举那一格记上它的**底类型与 bitflag 位**：`enum E: uint8_t` 的值就存在 8 位那一格里，
           而 `%d` / 比较 / `|` 那几族都要问"底下那格整数是什么"（`enum-to-int` 那条规则）。 */
        const b = enumBase(e.base);
        env.set(nm, {
          kind: 'enum',
          name: nm,
          base: { k: 'int', w: b.w, u: b.u },
          bits: String(e.word ?? '').includes('bitflag'),
        });
      }
    } else if (h === 'var-decl' && !inAgg) {
      /* **模块级那几格量**（`int calls = 0;`）：裸名字查名的第一步就要看得见它们
         （`NAME_LOOKUP_ORDER` 的 `var` 那一格里"模块级"也算）。`static` 的照收 ——
         它在方言那一侧的名字与普通的一样（模块级本来就只有一格）。 */
      const vn = named(n);
      if (vn !== null) {
        const sp = readSpecs(vn.specs);
        const bind = sp !== null && (sp.words.includes('bindable') || sp.words.includes('property'));
        for (const d of allInChain(vn.dcls, 'dcls-add', 'dcls')) {
          const dcl = headOf(d) === 'init' ? named(d)?.dcl : d;
          const t = readDeclType(vn.specs, dcl);
          if (t !== null && t.name !== null) {
            vars.set(t.name, t);
            /* 方言那一侧的名字带**命名空间前缀**（`ns.g` 是 `ns$g`）—— 读写那两处都要它。 */
            if (owner !== null) gEmit.set(t.name, `${owner}$${t.name}`);
            if (bind) bindable.add(t.name);
          }
        }
      }
    }
    for (const it of n.items) scan(it, inner, agg);
  };
  scan(tree, null, false);
  /* **一整条继承链共用一格结构体**（第五十六刀的 `clsRoot`）：类那一族在方言里写的是
     连通块的**根**。字段表按各自的名字收，写类型时换成根 —— 两件事分开。 */
  const roots = new Map();
  for (const a of aggs) {
    if (a.word !== 'class' && a.word !== 'opaque class') continue;
    const r = classRoot(a, aggs, env);
    if (a.emitName !== null && r.emitName !== undefined) roots.set(a.emitName, r.emitName);
  }
  return {
    fields, ctors, vars, gEmit, methods, bindable, roots, aggs,
  };
}
