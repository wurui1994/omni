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
import { readAgg, readEnum, readBodyMembers } from './agg.js';
import { enumBase } from './const-eval.js';
import { resolveType } from './resolve-type.js';
import { readFormals, fnName } from './emit-fn.js';
import { classRoot, basePaths } from './emit-agg.js';
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
    /* **虚方法那一族**（`virtual` / `override` / `abstract`）：调它要走派发表（`$$vd$`），
       不是一句 `(call B$step …)` —— 沿基类链找方法的那一处靠这一格明说不收（54-virtual.jnc）。 */
    virt: words.includes('virtual') || words.includes('override') || words.includes('abstract'),
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
 * 一格成员写的**初值**那一整条表达式（`static int m_count = 10;` 里右边那一格）。
 * 花括号那一族（`static int m_table[] = { … }`）另算 —— 记一格 `curly` 让上层明说不收。
 */
export function memberInit(m) {
  const nm = named(m.at);
  if (nm === null || nm === undefined) return null;
  if (headOf(m.at) === 'var-decl-curly') return { curly: true, value: nm.value ?? null };
  for (const d of allInChain(nm.dcls, 'dcls-add', 'dcls')) {
    if (headOf(d) !== 'init') continue;
    const dd = named(d);
    const t = readDeclType(nm.specs, dd?.dcl);
    if (t !== null && t.name === m.name) return { curly: false, value: dd?.value ?? null };
  }
  return null;
}

/**
 * 顶层那几格**聚合体**：一边把名字记进 `env`（`resolveType` 要它才认得 `Inner`），
 * 一边攒一张**字段表**（`emitName` → 名字 → 那一格的声明类型）—— 取字段与"往字段里写"
 * 两侧都从它出发。位域、别名路径、属性那几族**不收**（`member-table.js` 的七格里那几条
 * 各有自己的一套，收进来就等于拿普通字段那一支把它们悄悄接走了）。
 */
export function scanAggs(tree, env) {
  const fields = new Map();
  /** union 里套的匿名 struct 那几格：东家 → 名字 → `{ steps, type }`（一串取字段）。 */
  const fieldPaths = new Map();
  const ctors = new Set();                                           // 有 construct 的那几格
  const vars = new Map();                                            // 模块级那几格量（名字 → 声明类型）
  const gEmit = new Map();                                           // 名字 → 方言那一侧的名字（带命名空间前缀）
  const methods = new Map();                                         // `东家$方法名` → 签名 + 那个节点
  const gProps = new Map();                                          // 模块级那几格**写出来的属性**（读写各是一次调用）
  const fieldInits = new Set();                                      // 里头有"写了初值的字段"的那几格
  const bindable = new Set();                                        // 里头带取/存两格的那几个
  const aggs = [];                                                   // 收齐了好算继承链的根
  /**
   * **静态字段**（第二百一十五刀）：`static int m_count;` 不在对象里 —— 它是"类那一层上的
   * 模块级量"，方言那一侧的名字就是 `东家$名字`。所以这一格与命名空间里的模块级量
   * （第五十一刀）是**同一件事**，发它、读它、写它三处全走那一套，不另造机器。
   * 键是东家，值是"名字 → 那一格"。
   */
  const statics = new Map();
  /**
   * **成员属性**（第六十九刀）：`int property m_value;` 不是一格内存 —— 读它是
   * `(call 东家$属性$get $this)`、写它是 `(call 东家$属性$set $this 值)`。取/存那两个体
   * 在方法表（写在类里）或顶层函数表（写在类外）里已经有了，所以这一格只记"它是属性"。
   */
  const props = new Map();
  /** 同名撞车的那几格方法（重载）—— 这张表按名字存，所以撞了要记下来，发的那一层明说不收。 */
  const overloads = new Set();
  const scan = (n, owner, inAgg, inFn = false) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    let agg = inAgg;
    let fn0 = inFn;
    /**
     * 函数体那一段：**局部量不收**（那是体那一层的事），可**体里声明的类型要收** ——
     * 写在函数体里的 `typedef` / `enum` / `struct`（第二百一十九 / 二百五十 / 二百六十刀）
     * 与写在顶层是同一件事：jancy 把它们提到那一层的命名空间里，方言那一侧就是一格
     * 普通的 `(struct Color …)`（196-localstruct.jnc 的真输出，名字不带函数名前缀）。
     * 所以这儿**往下走**，只把"是不是在函数体里"记成一格状态（`inFn`）。
     */
    if (h === 'fn-def' || h === 'fn-proto') {
      /**
       * **完整声明式的属性**（`property g_p { int get() {…} … }`，prop_full.rst:15）在树上是
       * 一格函数声明 —— 可它是一格**属性**：读它是 `(call g_p$get)`、写它是 `(call g_p$set …)`。
       * 简单声明式那一种（`int property g_p;`）在下面 `var-decl` 那一支收，两种收进**同一张表**。
       */
      if (!inAgg && !inFn) {
        const fm = named(n);
        const ft = fm === null ? null : readDeclType(fm.specs, fm.dcl);
        if (ft !== null && ft.shape === 'prop' && ft.name !== null) {
          /* **完整声明式属性里的字段**也收进 store —— 与成员属性同一条。 */
          const store = new Map();
          const body1 = named(n)?.body;
          if (headOf(body1) === 'compound') {
            for (const im of readBodyMembers(body1)) {
              if (im.shape === 'data' && im.name !== null && im.type !== null) {
                store.set(im.name, im.type);
              }
            }
          }
          const mods = ft.mods ?? [];
          if (mods.includes('autoget') || mods.includes('bindable')) store.set('m_value', ft);
          gProps.set(ft.name, {
            emit: owner === null ? ft.name : `${owner}$${ft.name}`, type: ft, store,
          });
        }
      }
      /* 体里的类型声明照收，别的（形参、局部量、语句）不看 —— 所以只往**体**那一格里走。 */
      const body0 = named(n)?.body;
      if (body0 !== null && body0 !== undefined) scan(body0, owner, false, true);
      return;
    }
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
          /* **字段写了初值**（`int m_x = 5;` / `Point m_p = { 1, 2 };`）：jancy 把这几句插到
             `construct` 开头，没写 `construct` 的还要**合成**一格（第七十八刀）。这一层还没接
             那一步，所以先记下"这一格有初值"—— 造对象的那一处要靠它明说不收，不然交出去的是
             一段全零的内存。 */
          if (headOf(m.at) === 'var-decl-curly'
            || allInChain(named(m.at)?.dcls, 'dcls-add', 'dcls').some((d) => headOf(d) === 'init')) {
            fieldInits.add(emitName);
          }
          fs.set(m.name, m.type);
        }
        fields.set(emitName, fs);
        /**
         * **匿名 union 的成员摊进外面这一格**（第一百一十刀）：方言那一侧发的就是
         * `(union (m_a int) (m_b int))` —— 那几格字段**直接**长在外面这个结构体上，所以
         * 字段表也得摊。里头再套匿名 union 同理。
         *
         * 套的是**匿名 struct** 那一格不摊（166-unionnamed.jnc 发的是 `($s0 Bits$u0$s0)`）：
         * 读它是一条**路径** `(pfield (pfield … $s0) m_x)`，那是"字段路径"另一族。
         */
        const flat = (a2, seen = new Set()) => {
          for (const m of a2.members) {
            if (m.shape === 'nested-type') {
              const n2 = m.nested;
              if (n2 !== null && n2 !== undefined && n2.word === 'union'
                && nameText(n2.name) === null && !seen.has(n2)) {
                seen.add(n2);
                flat(n2, seen);
              }
              continue;
            }
            if (m.name === null || m.type === null || fs.has(m.name)) continue;
            if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') continue;
            if (m.storage.includes('static')) continue;
            /* **bigendian 的字段不收**（第一百二十六刀）：它是一格真字段，可读写各要一次
               字节序反转 —— 当普通字段收进来就把那一步**静静地**丢了（118-bigendian.jnc）。 */
            if ((m.type.mods ?? []).includes('bigendian')) continue;
            fs.set(m.name, m.type);
          }
        };
        flat(a);

        /**
         * **union 里套的匿名 struct**（第一百〇四刀那张"字段路径"表）：那一格在方言那一侧是
         * 一格真字段 `$s<第几个匿名 struct>`（类型是合成出来的 `<东家>$u<N>$s<M>`），所以
         * 源码里裸写 `h.m_a` 落出来是**一串**取字段 `(pfield (pfield 基 $s0) m_a)`。
         * 普通字段表收不下它（那张表一格名字对一格类型），所以另记一张"名字 → 路径"。
         *
         * 两种落处，路径的形状**一模一样**（差别只在合成那格 struct 叫什么，而路径不看名字）：
         *   - 匿名 union 摊进外面这个结构体（`struct H { union { struct {…} struct {…} } }`）；
         *   - union 自己体里就写着匿名 struct（`union Bits { int m_value; struct {…} }`）。
         * 嵌套只做一层 —— 再往里套的那一族留着记账（与旧降级同一条界）。
         */
        const ps0 = new Map();
        const pathsIn = (uni) => {
          let j = 0;
          for (const im of uni.members) {
            if (im.shape !== 'nested-type') continue;
            const s = im.nested;
            if (s === null || s === undefined || s.word !== 'struct') continue;
            if (nameText(s.name) !== null) continue;                 // 带名字的是另一格类型
            const slot = `$s${j}`;
            j += 1;
            for (const f of s.members) {
              if (f.name === null || f.type === null) continue;
              if (f.shape !== 'data' && f.shape !== 'array' && f.shape !== 'fnptr') continue;
              if ((f.type.mods ?? []).includes('bigendian')) continue;   // 那一族要反字节序，不收
              if (fs.has(f.name) || ps0.has(f.name)) continue;           // 撞名的不猜（先来的胜）
              ps0.set(f.name, { steps: [slot, f.name], type: f.type });
            }
          }
        };
        if (a.word === 'union') pathsIn(a);
        for (const m of a.members) {
          if (m.shape !== 'nested-type') continue;
          const n2 = m.nested;
          if (n2 === null || n2 === undefined || n2.word !== 'union') continue;
          if (nameText(n2.name) !== null) continue;                  // 带名字的 union 不摊
          pathsIn(n2);
        }
        if (ps0.size > 0) fieldPaths.set(emitName, ps0);

        /* **静态字段与成员属性各收一张表**（次序即规则：这两族在上面那张字段表里刻意
           不收 —— 一个不进对象、一个不是内存，被"普通字段"那一支接走就是静静地错）。 */
        const st = new Map();
        const ps = new Map();
        for (const m of a.members) {
          if (m.name === null || m.type === null) continue;
          if (m.shape === 'prop') {
            /* **完整声明式属性里的字段**是属性自己的存储（`property m_p { int m_v; … }`，
               prop_full.rst:15）：取/存的体里裸写 `m_v` 查的就是 `propScope.store`。所以这儿
               把那些字段收进 `store` —— 与 `autoget` 生成的 `m_value` 进的是同一张表。 */
            const propStore = new Map();
            const body1 = named(m.at)?.body;
            if (headOf(body1) === 'compound') {
              for (const im of readBodyMembers(body1)) {
                if (im.shape === 'data' && im.name !== null && im.type !== null) {
                  propStore.set(im.name, im.type);
                }
              }
            }
            const mods2 = m.type?.mods ?? [];
            if (mods2.includes('autoget') || mods2.includes('bindable')) propStore.set('m_value', m.type);
            ps.set(m.name, {
              name: m.name, owner: emitName, emit: `${emitName}$${m.name}`, type: m.type, at: m.at,
              store: propStore,
            });
            continue;
          }
          if (!m.storage.includes('static')) continue;
          if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') continue;
          st.set(m.name, {
            name: m.name,
            owner: emitName,
            emit: `${emitName}$${m.name}`,
            type: m.type,
            shape: m.shape,
            storage: m.storage,
            at: m.at,
            init: memberInit(m),
            curlyValue: headOf(m.at) === 'var-decl-curly' ? named(m.at)?.value ?? null : null,
          });
        }
        statics.set(emitName, st);
        props.set(emitName, ps);

        /**
         * **类体里的 `typedef`**（第一百〇六刀）：它与嵌套类型走**同一条路** —— 提到顶层那一批里
         * （jancy 的 aggHoist），名字前头挂着这个类。所以这儿把它记进类型环境：键是它自己那一段
         * （`Num`），点串写法（`C.Num`）由 `baseOf` 那一头按末段查。
         * **同名的不盖**（先声明的那一格胜出）：两个类里同名的 typedef 指到两格不同类型时
         * 按名字查是猜，宁可让后来那一格报"认不出基类型"。
         */
        for (const m of a.members) {
          if (m.shape !== 'typedef' || m.name === null || m.type === null) continue;
          if (env.has(m.name)) continue;
          env.set(m.name, { kind: 'typedef', type: m.type, name: `${emitName}$${m.name}` });
        }

        /* **方法那一族**（`<东家>$<方法名>`，第五十二刀）：一格一格记下签名与那个节点。
           体写在类里的（`fn-def`）由这一层发；只写原型的（`fn-proto`）体在外面，那一格
           由顶层那条路发 —— 两处登记的是**同一个名字**，所以调用那一层只查一张表。 */
        for (const m of a.members) {
          const mh = headOf(m.at);
          /* 三种写法都是方法：带体的（`fn-def`）、类里只写原型的（那一格落成 `var-decl`，
             `m.shape === 'fn'`）、以及独立的原型节点（`fn-proto`）。 */
          if (mh !== 'fn-def' && mh !== 'fn-proto' && m.shape !== 'fn') continue;
          /* **完整声明式的属性**（`int property m_p { get() {…} … }`）在树上也是一格函数声明，
             可那对花括号里是取/存两个体 —— 不是方法。整族另算，别混进方法表。 */
          if (m.shape === 'prop' || m.shape === 'event' || m.shape === 'reactor') continue;

          /* 名字走 `fnName`：`construct` / `destruct` / 算符重载那几格**没有普通名字**
             （`m.name` 是 null），而它们正是方法那一族里最要紧的几个。 */
          const mname = fnName({ name: m.name, type: m.type, at: m.at });
          if (mname === null) continue;
          const key = `${emitName}$${mname}`;
          const sig = sigOf(named(m.at), env, key, m.type);
          if (sig === null) continue;
          /* **重载**（同一格东家上同名的两格方法）：按实参挑哪一格是一整族规则
             （`frontend-engine/overload.js` 那一套）。这一层还没接 —— 这张表按名字存，
             第二格会**把第一格盖掉**，所以在这儿记下来，发的那一层照它明说不收。 */
          if (methods.has(key)) overloads.add(key);
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
          /* **方言那一侧的名字带着主人那几段前缀**（类体里的 `typedef int Num;` 是 `Stat$Num`、
             命名空间里的是 `ns$T`）—— 与聚合体、枚举那两支同一条口径。少这一格，点串写法
             （`Stat.Num k;`）在 `baseOf` 那头核对不上（查着的名字是 `Num`、要的是 `Stat$Num`），
             报的是"认不出基类型 'qualified'"（97-classtypedef.jnc）。
             这一支**在类体那一遍之后**才走到（递归在后头），所以它写的名字得自己带前缀，
             不然刚记好的 `Stat$Num` 又被盖成了 `Num`。 */
          if (t !== null && t.name !== null) {
            env.set(t.name, {
              kind: 'typedef', type: t, name: owner === null ? t.name : `${owner}$${t.name}`,
            });
          }
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
          /* 名字带上主人那几段前缀（与聚合体、typedef 同一条口径）：点串写法 `a.Kind kk;`
             在 `baseOf` 那头要拿它核对（48-namespace.jnc）。方言那一侧枚举就是 int，
             所以这一格只用来查名与对账。 */
          name: owner === null ? nm : `${owner}$${nm}`,
          base: { k: 'int', w: b.w, u: b.u },
          bits: String(e.word ?? '').includes('bitflag'),
        });
      }
    } else if ((h === 'var-decl' || h === 'var-decl-curly') && !inAgg && !inFn) {
      /* **模块级那几格量**（`int calls = 0;`）：裸名字查名的第一步就要看得见它们
         （`NAME_LOOKUP_ORDER` 的 `var` 那一格里"模块级"也算）。`static` 的照收 ——
         它在方言那一侧的名字与普通的一样（模块级本来就只有一格）。

         **带花括号初值的那一格是另一个节点**（`var-decl-curly`：一格 `dcl`，不是 `dcl*` 那条链）
         —— 少收它，`int table[3] = { 10, 20, 30 };` 这个名字压根不在表里，于是函数体里
         裸写 `table` 报的是"查不着"（11-globals.jnc 量出来的）。 */
      const vn = named(n);
      if (vn !== null) {
        const sp = readSpecs(vn.specs);
        const bind = sp !== null && (sp.words.includes('bindable') || sp.words.includes('property'));
        const dcls = h === 'var-decl-curly'
          ? [vn.dcl] : allInChain(vn.dcls, 'dcls-add', 'dcls');
        for (const d of dcls) {
          const dcl = headOf(d) === 'init' ? named(d)?.dcl : d;
          const t = readDeclType(vn.specs, dcl);
          if (t !== null && t.name !== null) {
            /* **属性不是一格量**（第六十九刀）：它没有内存，读写各是一次调用 —— 收进
               `vars` 的话查名那一层会当普通量算，报的是"属性/事件（prop）"这种认错人的账。
               它那一格在下面的 `gProps` 里。 */
            if (t.shape !== 'prop') vars.set(t.name, t);
            /* 方言那一侧的名字带**命名空间前缀**（`ns.g` 是 `ns$g`）—— 读写那两处都要它。 */
            if (owner !== null) gEmit.set(t.name, `${owner}$${t.name}`);
            /* **写出来的属性**（`int property g_p { get; set; }`）：读它是 `(call g_p$get)`、
               写它是 `(call g_p$set …)`（第六十九刀）—— 它不是一格内存，所以单独记一张表。
               `bindable` 的**数据**（`bindable int g_d;`）不算：那一格的取/存是**生成**出来的
               （还没接），与"取/存是人写的"这一族两码事。 */
            if (t.shape === 'prop') {
              /* **`autoget` / `bindable` 的属性有一格生成的存储**（`<属性名>$m_value`，
                 prop_autoget.rst:26）：取/存那两个体里裸写的就是 `m_value` —— 它在方言那一侧是
                 一格模块级的量，所以连类型一起记下来（不记，取值器里那一句就报"查不着"）。 */
              const store = new Map();
              const mods = t.mods ?? [];
              if (mods.includes('autoget') || mods.includes('bindable')) store.set('m_value', t);
              gProps.set(t.name, {
                emit: owner === null ? t.name : `${owner}$${t.name}`, type: t, store,
              });
            }

            /* **`bindable` 的数据**（`bindable int g_d;`）：那一格的取/存是**生成**出来的。
               写了 `property` 的那几格不算 —— 它们在上面那张属性表里（先前这儿把
               `int autoget property g;` 也记成了"bindable data"，于是读它报的是那一族的账）。 */
            if (bind && t.shape !== 'prop') bindable.add(t.name);
          }
        }
      }
    }
    for (const it of n.items) scan(it, inner, agg, fn0);
  };
  /**
   * **名字先过一遍**（次序无关）：jancy 的顶层没有"先声明后使用"这条 —— 一格结构体的方法
   * 返回类型写在它前头声明的那个类型上，照样成立。而这一层的细活儿（方法签名、静态字段、
   * 枚举底类型）**当场就要解类型**，所以名字得在那之前全登记好。
   *
   * 泛型接上之后这一格是硬要求：造出来的实例插在顶层链最前头（它们是别人字段的类型，
   * 方言要求先声明），于是 `Box$Node` 排在 `struct Node` **前面** —— 少了这一遍，
   * `Box$Node` 里那格 `Entry val()` 的返回类型报的是"认不出基类型 'name'"，
   * 落出来是 void（123-genericname.jnc 的 `b.val().m_x`）。
   *
   * 只登记"这个名字是什么"，一格类型都不解 —— 解类型的活儿照旧在下面那一遍。
   */
  const names0 = (n, owner) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    if (h === 'namespace') {
      const nm = nameText(named(n)?.name);
      if (nm !== null) inner = owner === null ? nm : `${owner}$${nm}`;
    } else if (h === 'agg') {
      const a = readAgg(n);
      const nm = a === null ? null : nameText(a.name);
      if (a !== null && nm !== null) {
        const emitName = owner === null ? nm : `${owner}$${nm}`;
        inner = emitName;
        if (!env.has(nm)) {
          env.set(nm, {
            kind: a.word === 'union' ? 'union' : (a.word === 'struct' ? 'struct' : 'class'),
            name: emitName,
            agg: a,
          });
        }
      }
    }
    for (const it of n.items) names0(it, inner);
  };
  names0(tree, null);
  scan(tree, null, false, false);
  /**
   * **基类那几格字段也算这一格自己的**（第五十六刀：一整条继承链共用一格结构体）。所以
   * 派生类的字段表要把基类的并进来 —— 不并的话方法体里裸写 `m_legs`（写在基类里的那一格）
   * 就查不着，而它明明就在同一段内存里。自己那几格**盖住**同名的基类字段（次序即规则）。
   */
  const byName = new Map();
  for (const a of aggs) {
    const n2 = nameText(a.name);
    if (n2 !== null) byName.set(n2, a);
  }
  const mergedFields = (a, seen = new Set()) => {
    const own = fields.get(a.emitName) ?? new Map();
    if (seen.has(a.emitName)) return own;
    seen.add(a.emitName);
    const out = new Map();
    for (const b of basePaths(a)) {
      const ba = byName.get(b);
      if (ba === undefined) continue;
      for (const [k, v] of mergedFields(ba, seen)) out.set(k, v);
    }
    for (const [k, v] of own) out.set(k, v);
    return out;
  };
  for (const a of aggs) fields.set(a.emitName, mergedFields(a));

  /* **静态字段与成员属性沿基类链也看得见**（与字段那一条同一条：一整条继承链共用一格结构体，
     `Derived` 里裸写基类的属性 `m_value` 就该找得着 —— 65-propmem.jnc 的 `Derived$mine`）。
     自己那一格盖住同名的基类那一格（次序即规则）。 */
  const mergedOf = (table) => {
    const walk = (a, seen = new Set()) => {
      const own = table.get(a.emitName) ?? new Map();
      if (seen.has(a.emitName)) return own;
      seen.add(a.emitName);
      const out = new Map();
      for (const b of basePaths(a)) {
        const ba = byName.get(b);
        if (ba === undefined) continue;
        for (const [k, v] of walk(ba, seen)) out.set(k, v);
      }
      for (const [k, v] of own) out.set(k, v);
      return out;
    };
    const next = new Map();
    for (const a of aggs) next.set(a.emitName, walk(a));
    return next;
  };
  const staticsAll = mergedOf(statics);
  const propsAll = mergedOf(props);

  /* **每一格的直接基类**（方言那一侧的名字，按声明次序）：`basetype` / `basetype1` 是第一格、
     `basetype2` 是第二格（type_class.rst:226）—— `basetype.construct(…)` 那一族要它。 */
  const bases = new Map();
  for (const a of aggs) {
    const list = [];
    for (const b of basePaths(a)) {
      const ba = byName.get(b);
      if (ba !== undefined && ba.emitName !== null && ba.emitName !== undefined) list.push(ba.emitName);
    }
    bases.set(a.emitName, list);
  }

  /* **一整条继承链共用一格结构体**（第五十六刀的 `clsRoot`）：类那一族在方言里写的是
     连通块的**根**。字段表按各自的名字收，写类型时换成根 —— 两件事分开。 */
  const roots = new Map();
  for (const a of aggs) {
    if (a.word !== 'class' && a.word !== 'opaque class') continue;
    const r = classRoot(a, aggs, env);
    if (a.emitName !== null && r.emitName !== undefined) roots.set(a.emitName, r.emitName);
  }
  return {
    fields,
    fieldPaths,
    ctors,
    vars,
    gEmit,
    gProps,
    methods,
    fieldInits,
    bindable,
    roots,
    aggs,
    statics: staticsAll,
    props: propsAll,
    bases,
    overloads,
  };
}
