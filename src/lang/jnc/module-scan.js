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
import { tyKey } from './emit-type.js';
import { readFormals, fnName, overloadSuffix } from './emit-fn.js';
import { classRoot, basePaths, lastIdent, hasStatements } from './emit-agg.js';
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
    /* **声明**一格虚槽的是 `virtual` / `abstract`（`override` 是**接**上头那一格）——
       分派函数的东家就是声明它的那个类（`B$$vd$show`，78-notype.jnc 的真输出）。 */
    declVirt: words.includes('virtual') || words.includes('abstract'),
  };
}

/**
 * **默认实参攒着看**（第二百六十刀）：原型与体外那个定义是同一格函数，而 jancy 把默认值
 * 写在**声明**那一格上（decl_function.rst 那一族；`ui_PropertyGrid.jnc:233` 声明、`:414`
 * 定义）。后来那一格没写默认值不该把先前记下的抹掉 —— 逐格取"谁有算谁的"。
 */
function keepDefaults(prev, next) {
  const a = next ?? [];
  const b = prev ?? [];
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => a[i] ?? b[i] ?? null);
}

/** 最小的那份探子：形参与局部量的类型表。 *//**
 * **同名的那一族里第几格**（第五十八刀 A，76-overload.jnc 的 `f` / `f$o1` / `f$o2`）。
 *
 * jancy 判两条同名声明合不合法只看**实参那一串的签名**（`FunctionType::getArgSignature`），
 * 所以同名的几格在方言那一侧要各有一个名字 —— 号按**声明次序**排，拼法由
 * `overloadSuffix` 那一格说（取/存与算符那两族从 2 起，普通名字从 1 起）。
 *
 * 只有**普通名字**那几族收：`construct` / `destruct` / 取存 / 算符重载的调用点各走各的路
 * （造对象、属性、算符），那几处还没有"挑一格"这一步 —— 收进来就等于让它们静静地调第一格。
 * 那几族照旧记在 `overloads` 里，发的那一层明说不收。
 */
function plainName(leaf) {
  if (leaf === 'get' || leaf === 'set' || leaf === 'destruct') return false;
  return !leaf.includes('op$') && !leaf.startsWith('construct$');
}

/**
 * **算符重载那一族也进这张族表**（第二百零七刀，184-opovl.jnc / 190-opassigndecl.jnc）：
 * 量出来语料里就是它 —— `std.StringBuilder` 上三条 `operator +=`（收 `string` /
 * `char const*` / 一格字符），逐份榜上 31 对；`operator :=` 同族另 31 对。
 *
 * "按实参类型挑"这一层早就有（第五十八刀那套 `pickOvl` / `argCost`），欠的只是**名字**与
 * **那张表**：改名照 `overloadSuffix` 那条（算符从第二条起加 `$o2`），族记进 `ovl`，
 * 调用点问一次 `pickOvl`。所以这一格与普通名字同收；`construct$static` / 取存 / `destruct`
 * 那几族的调用点各走各的路、还没有"挑一格"这一步，照旧记在 `overloads` 里明说不收。
 */
function ovlName(leaf) {
  return plainName(leaf) || leaf.includes('op$');
}

/**
 * **实参那一串的签名**（`getArgSignature` 那一句）：解得出来就是一串方言类型，
 * 有一格解不出来就答 null（那时宁可把两条当**两格**看 —— 挑那一层会照实说"分不出来"，
 * 而合成一格是**静静地调错**）。
 */
function argSig(params, env) {
  const out = [];
  for (const p of params ?? []) {
    if (p === null || p === undefined) return null;
    const r = resolveType(p, env);
    if (r === null || r.type === null) return null;
    out.push(tyKey(r.type));
  }
  return out.join(',');
}

/**
 * 往"同名那一族"里添一格：回 { key, dup }。族里那几格记的是 `{ key, asig }`。
 *
 * **实参签名一样的两条不是重载，是同一格**（jancy 判重定义就看这一句）—— 类体里那句原型
 * 与体外那个定义、`int f();` 与后面 `int f(){…}` 都走这一条，不然会凭空多出一格 `$o1`。
 */
function ovlAdd(fam, base, leaf, params, env) {
  const had = fam.get(base);
  const mine = argSig(params, env);
  if (had === undefined) { fam.set(base, [{ key: base, asig: mine }]); return { key: base, dup: 0 }; }
  if (mine !== null) {
    const i = had.findIndex((e) => e.asig === mine);
    if (i >= 0) return { key: had[i].key, dup: i };
  }
  const dup = had.length;
  const key = `${base}${overloadSuffix(leaf, dup)}`;
  fam.set(base, [...had, { key, asig: mine }]);
  return { key, dup };
}

/** 顶层那几格函数的签名（名字 → { params, ret }）—— 调用那一族要它。 */
export function scanFns(tree, env, ovl = new Map()) {
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
      /* **顶层的 reactor 不是一格普通函数**（第二百五十六刀）：`reactor g_r { … }` 落出来的是
         `g_r$start` / `g_r$stop` 加一串反应 —— 收进函数表，调用点查着的是一格签名读不出来的
         "函数"，报的是"反应器那一族（另发 $start / $stop）"。它那一格在 `emitReactors` 里。 */
      if (t !== null && t.shape === 'fn' && !(t.mods ?? []).includes('reactor')) {
        if (t.name !== null) {
          const base = ns === null ? t.name : `${ns}$${t.name}`;
          /* **重载**：同名的第二格起换个方言名（`f$o1`）。号按声明次序，与发码那一头
             （`fnHead` 的 `ctx.dup`）走的是同一格 `overloadSuffix`。 */
          const sig0 = sigOf(nm, env, base);
          const one = plainName(t.name) && sig0 !== null
            ? ovlAdd(ovl, base, t.name, sig0.params, env) : { key: base, dup: 0 };
          const sig = one.key === base ? sig0 : sigOf(nm, env, one.key);
          if (sig !== null) {
            out.set(one.key, { ...sig, dup: one.dup, node: n });
            /* 不带前缀的那个名字指着**头一格**（命名空间里裸写的调用查的是它）。 */
            if (ns !== null && one.dup === 0) out.set(t.name, { ...sig, dup: 0, node: n });
            if (ns !== null && plainName(t.name)) {
              const fam = ovl.get(base);
              if (fam !== undefined) ovl.set(t.name, fam);
            }
          }
        } else {
          /* **体外定义的方法**（`int P.scaled(int k) { … }`）：名字是点串，在方言那一侧
             整串用 `$` 接起来（`fnName`）。它按东家那一格登记 —— 调用那一层查的就是它。 */
          const dotted = fnName({ name: null, type: t, at: n });
          if (dotted !== null) {
            const base = ns === null ? dotted : `${ns}$${dotted}`;
            const leaf = base.slice(base.lastIndexOf('$') + 1);
            const sig0 = sigOf(nm, env, base);
            const one = plainName(leaf) && sig0 !== null
              ? ovlAdd(ovl, base, leaf, sig0.params, env) : { key: base, dup: 0 };
            const sig = one.key === base ? sig0 : sigOf(nm, env, one.key);
            if (sig !== null) out.set(one.key, { ...sig, dup: one.dup, node: n });
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
 * 别名右边那**一条路**（`alias m_head = m_list.m_head;` → `['m_list','m_head']`）。
 * 只认"名字 + 一串取字段"这一种形状，别的答 null（下游照实说查不着，不猜）。
 */
export function aliasPath(m) {
  const ini = memberInit(m);
  if (ini === null || ini.curly === true) return null;
  const walk = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return null;
    const h = headOf(n);
    if (h === 'paren') return walk(named(n)?.inner);
    if (h === 'name') {
      const s = String(named(n)?.text?.value ?? '');
      return s === '' ? null : [s];
    }
    if (h === 'field' || h === 'ptr-field') {
      const o = walk(named(n)?.obj);
      const leaf = String(named(n)?.name?.value ?? '');
      return o === null || leaf === '' ? null : [...o, leaf];
    }
    return null;
  };
  return walk(ini.value);
}

/**
 * 顶层那几格**聚合体**：一边把名字记进 `env`（`resolveType` 要它才认得 `Inner`），
 * 一边攒一张**字段表**（`emitName` → 名字 → 那一格的声明类型）—— 取字段与"往字段里写"
 * 两侧都从它出发。位域、别名路径、属性那几族**不收**（`member-table.js` 的七格里那几条
 * 各有自己的一套，收进来就等于拿普通字段那一支把它们悄悄接走了）。
 */
export function scanAggs(tree, env, ovl = new Map()) {
  const fields = new Map();
  /** union 里套的匿名 struct 那几格：东家 → 名字 → `{ steps, type }`（一串取字段）。 */
  const fieldPaths = new Map();
  /** 体里的 `alias`：东家 → 名字 → 目标那一段（查方法/查字段先解一跳）。 */
  const aggAliases = new Map();
  /** 顶层与函数体里的 `alias`：名字 → 目标那一段（"值那一面"—— 查函数那一处先解一跳）。 */
  const gAlias = new Map();
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
          /**
           * **体里那两格带修饰词的成员**（第二百五十一刀，73-propfullauto.jnc）：
           *   - `autoget int m_x;` —— prop_full.rst:34 那句"体里那格带 `autoget` 的字段让**整格
           *     属性** autoget"。取值器于是是生成的，而那格存储的**名字是写的人定的**（默认
           *     才叫 `m_value`，prop_autoget.rst:26）；
           *   - `bindable event m_e();` —— 同理让整格属性 bindable，`bindingof(属性)` 说的就是
           *     它（默认名才是 `m_onChanged`，prop_bindable.rst:23-29）。
           * 所以两个名字都记下来（`autoPath` / `mcPath`）—— 拿默认名去发就是发一个不存在的全局。
           * 体里那条 `alias` 同理（第二百五十三刀）：那两格**不生成**，用的是外层已有的那格。
           */
          let auto0 = null;
          let autoPath0 = null;
          let mcPath0 = null;
          const emit1 = owner === null ? ft.name : `${owner}$${ft.name}`;
          const body1 = named(n)?.body;
          if (headOf(body1) === 'compound') {
            for (const im of readBodyMembers(body1)) {
              if (im.name === null) continue;
              const iws = [...(im.storage ?? []), ...(im.type?.mods ?? [])];
              if (iws.includes('alias')) {
                const tv = memberInit(im)?.value ?? null;
                const tn = headOf(tv) === 'name' ? String(named(tv)?.text?.value ?? '') : null;
                if (tn === null) continue;
                if (iws.includes('autoget')) autoPath0 = owner === null ? tn : `${owner}$${tn}`;
                if (iws.includes('bindable')) mcPath0 = owner === null ? tn : `${owner}$${tn}`;
                continue;
              }
              if (im.type === null) continue;
              if (im.shape === 'event') {
                store.set(im.name, im.type);
                if (iws.includes('bindable')) mcPath0 = `${emit1}$${im.name}`;
                continue;
              }
              if (im.shape !== 'data') continue;
              store.set(im.name, im.type);
              if (iws.includes('autoget') || iws.includes('bindable')) {
                auto0 = im.type; autoPath0 = `${emit1}$${im.name}`;
              }
            }
          }
          const mods = ft.mods ?? [];
          if (mods.includes('autoget') || mods.includes('bindable')) store.set('m_value', ft);
          if (mods.includes('bindable') && mcPath0 === null) mcPath0 = `${emit1}$m_onChanged`;
          gProps.set(ft.name, {
            emit: emit1,
            type: ft,
            store,
            auto: auto0,
            autoPath: autoPath0,
            mcPath: mcPath0,
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
        /* 要反字节序那几格（`bigendian`）：名字 → 一条路 + "要反"。与位域同一张表。 */
        const be0 = new Map();
        for (const m of a.members) {
          if (m.name === null || m.type === null) continue;
          if (m.shape === 'bitfield' || m.shape === 'prop') continue;
          /* **类里的事件是一格字段**（第二百五十二刀，80-class-event.jnc）：jancy 那边它与
             bindable 属性那格 `m_onChanged` 同一支（jnc_ct_Property.cpp:131-134），发结构体
             那一层早就把它发成字段了 —— 所以字段表也得有它，不然 `b.m_onClick` 查不着。 */
          if (m.shape === 'typedef' || m.shape === 'nested-type' || m.shape === 'friend') continue;
          if (m.shape === 'fn') { if (m.name === 'construct') ctors.add(emitName); continue; }
          /* **`alias twice = doubled;` 不是一格字段**（第二百五十四刀）：它压根没有类型
             （写的是"这个名字指着谁"），收进字段表就等于拿一格 no-type 的字段把它接走了
             （192-unionalias.jnc）。它那一格在下面 `al` 那张表里。 */
          if (m.storage.includes('alias')) continue;
          if (m.storage.includes('static')) continue;                // 不进对象（落成模块级那一格）
          /* **字段写了初值**（`int m_x = 5;` / `Point m_p = { 1, 2 };`）：jancy 把这几句插到
             `construct` 开头，没写 `construct` 的还要**合成**一格（第七十八刀）。这一层还没接
             那一步，所以先记下"这一格有初值"—— 造对象的那一处要靠它明说不收，不然交出去的是
             一段全零的内存。 */
          if (headOf(m.at) === 'var-decl-curly'
            || allInChain(named(m.at)?.dcls, 'dcls-add', 'dcls').some((d) => headOf(d) === 'init')) {
            fieldInits.add(emitName);
          }
          /* **bigendian 的字段读写各要一次字节序反转**（第一百二十六刀，118-bigendian.jnc）：
             它是一格真字段，可当普通字段收进这张表就把那一步**静静地**丢了。所以它进的是
             下面那张"路径"表（`be`：一条路 + "要反字节序"），读写两侧照它算。 */
          if ((m.type.mods ?? []).includes('bigendian')) { be0.set(m.name, { steps: [m.name], type: m.type, be: true }); continue; }
          /**
           * **bindable / autoget 的 data 不是一格字段**（第二百四十八刀，81-propbindmem.jnc）：
           * `int bindable m_state;` 是一格"整个由编译器实现的属性"（samples/jnc/34_Bindable
           * Properties.jnc:87-90 那句 "bindable data is a wholly compiler-implemented property"）
           * —— 对象里那两格叫 `<东家>$<名字>$m_value` 与 `$m_onChanged`（发结构体那一层早就照
           * 这个发了，emit-agg.js:345）。收进字段表就等于凭空多出一格叫 `m_state` 的字段：
           * 读写落成 `(pfield … m_state)`，而结构体里压根没有它 —— 这一层于是**一句账都不记地**
           * 发出一段引不着的码（下游那格检查器把它顶回来）。它那一格在下面 `ps` 那张属性表里。
           */
          if ((m.type.mods ?? []).includes('bindable') || (m.type.mods ?? []).includes('autoget')) continue;
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
            /* **`alias` 不是一格字段**（与上头那一遍同一条界）：这一遍先前少了这一句，于是
               `alias m_alias = m_pad;` 又被塞回字段表里，报的是"字段 'm_alias'：认不出基类型
               'no-type'"（199-aliasfield.jnc / 95-aliaspath.jnc 量的正是这一格）。 */
            if (m.storage.includes('alias')) continue;
            /* **bigendian 的字段**（第一百二十六刀）：它是一格真字段（匿名 union 摊平之后
               名字直接长在外面那格结构体上），可读写各要一次字节序反转 —— 所以进的是路径表
               那一格 `be`，当普通字段收进来就把那一步静静地丢了（118-bigendian.jnc 的 `Ov`）。 */
            if ((m.type.mods ?? []).includes('bigendian')) {
              if (!be0.has(m.name)) be0.set(m.name, { steps: [m.name], type: m.type, be: true });
              continue;
            }
            /* **bindable / autoget 的 data 不是字段**（与上头那一遍同一条界，第二百四十八刀）：
               少这一句，它又被这一遍塞回字段表里，读写照旧落成引不着的 `(pfield … m_state)`。 */
            if ((m.type.mods ?? []).includes('bindable') || (m.type.mods ?? []).includes('autoget')) continue;
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
              if (fs.has(f.name) || ps0.has(f.name)) continue;           // 撞名的不猜（先来的胜）
              /* 要反字节序那一格也是一条路 —— 只是路的尽头还要反一次（第一百二十六刀）。 */
              const be = (f.type.mods ?? []).includes('bigendian');
              ps0.set(f.name, { steps: [slot, f.name], type: f.type, ...(be ? { be: true } : {}) });
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
        /* 要反字节序那几格（上头两遍攒的）与字段路径进**同一张**表：读写那一处一问就查得着。 */
        for (const [k, v] of be0) if (!ps0.has(k)) ps0.set(k, v);
        /**
         * **类里的字段路径别名**（`alias m_head = m_list.m_head;`，95-aliaspath.jnc /
         * 199-aliasfield.jnc）：右边是**一条路**、不是一个名字 —— 与匿名 struct 那一族落成的
         * 是同一种东西（一格名字对一串 `(pfield (pfield … m_list) m_head)`），所以进同一张表。
         * 只指一个名字的那种（`alias m_alias = m_pad;`）照旧走"解一跳"那张表（`aggAliases`）。
         * 中途哪一格解不出聚合体（跨文件、还没扫到）就不记 —— 下游照实说查不着，不猜。
         */
        for (const m of a.members) {
          if (m.name === null || !m.storage.includes('alias')) continue;
          const path = aliasPath(m);
          if (path === null || path.length < 2) continue;
          const steps = [];
          let cur = fs;
          let ty = null;
          for (const [i, seg] of path.entries()) {
            const t0 = cur === undefined ? undefined : cur.get(seg);
            if (t0 === undefined) { ty = null; break; }
            steps.push(seg);
            ty = t0;
            if (i === path.length - 1) break;
            const r0 = resolveType(t0, env);
            const bn = r0.type !== null && (r0.type.k === 'struct' || r0.type.k === 'class')
              ? r0.type.name : null;
            cur = bn === null ? undefined : fields.get(bn);
          }
          if (ty !== null && steps.length === path.length && !fs.has(m.name)) ps0.set(m.name, { steps, type: ty });
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
            /* **`autoget` 那个词写在体里那一格存储上**（`int property m_v { int autoget m_value; … }`，
               141-propfullmem.jnc）：那格属性的取值器照旧是**生成**出来的 —— 与写在属性上
               （`int autoget property m_v;`）同一件事，差别只在"类型听谁的"。所以把那一格的
               类型记下来（`auto`），发的那一层照它生成。 */
            let auto = null;
            let autoPath = null;
            let mcPath = null;
            const emit0 = `${emitName}$${m.name}`;
            const body1 = named(m.at)?.body;
            /* **简写取值器那对花括号里是语句、不是成员表**（第一百三十九刀，140-propgetbody.jnc
               里 `int t = m_twice;` 是取值器体里的**局部量**）—— 照成员表读就等于给这个类
               凭空添了一格"写了初值的字段"，于是造对象那一处报"字段写了初值可它没有构造"。 */
            if (headOf(body1) === 'compound' && !hasStatements(body1)) {
              for (const im of readBodyMembers(body1)) {
                if (im.name === null) continue;
                const ims = [...(im.storage ?? []), ...(im.type?.mods ?? [])];
                /**
                 * **属性那一层里的 `alias`**（第二百五十三刀，142-propalias.jnc）：**等号右边那格
                 * 才是真东西**（`Parser::declareAlias`，jnc_ct_Parser.cpp:1346-1365 ——
                 * 带 `bindable` 就 `setOnChanged(alias)`、带 `autoget` 就 `setAutoGetValue(alias)`）。
                 * 所以这两句的意思是"这格属性的存储/事件**不生成**，就用外层已经有的那格成员"，
                 * 左边那个名字只是属性这一层里的**另一个名字**（`alias doesn't need a type`）。
                 */
                if (ims.includes('alias')) {
                  const tv = memberInit(im)?.value ?? null;
                  const tn = headOf(tv) === 'name' ? String(named(tv)?.text?.value ?? '') : null;
                  if (tn === null) continue;                 // 认不出目标：那一格照旧记账（发的那层）
                  if (ims.includes('autoget')) {
                    autoPath = tn;
                    const tm = a.members.find((x) => x.name === tn && x.type !== null);
                    auto = tm === undefined ? null : tm.type;
                  }
                  if (ims.includes('bindable')) mcPath = tn;
                  continue;
                }
                if (im.type === null) continue;
                /* 体里那格**事件**（`bindable event m_e();`，第二百五十一刀）：名字是写的人定的
                   —— 存值器体里裸写它就是"通知"，`bindingof(属性)` 说的也是它。 */
                if (im.shape === 'event') {
                  propStore.set(im.name, im.type);
                  if (ims.includes('bindable')) mcPath = `${emit0}$${im.name}`;
                  continue;
                }
                if (im.shape === 'data') {
                  propStore.set(im.name, im.type);
                  if (ims.includes('autoget') || ims.includes('bindable')) {
                    auto = im.type; autoPath = `${emit0}$${im.name}`;
                  }
                  /* **体里那格字段写了初值**（`property m_p { int m_v = 7; … }`）：它就是这个类的
                     一格字段（`C$m_p$m_v`），所以"这一格里有初值"要记上 —— 合成构造那一步
                     靠它才知道该发（152-propfieldinit.jnc）。 */
                  if (memberInit(im) !== null) fieldInits.add(emitName);
                }
              }
            }
            const mods2 = m.type?.mods ?? [];
            if (mods2.includes('autoget') || mods2.includes('bindable')) propStore.set('m_value', m.type);
            if (mods2.includes('bindable') && mcPath === null) mcPath = `${emit0}$m_onChanged`;
            ps.set(m.name, {
              name: m.name, owner: emitName, emit: emit0, type: m.type, at: m.at,
              store: propStore,
              auto,
              autoPath,
              mcPath,
            });
            continue;
          }
          /**
           * **bindable / autoget 的 data 也是一格属性**（第二百四十八刀，81-propbindmem.jnc）：
           * 取/存两格都是**生成**出来的（`Property::createOnChanged` 与 `compileAutoSetter`），
           * 存储是 `<东家>$<名字>$m_value`（bindable 还多一格 `$m_onChanged`）。所以这儿把它
           * 记进属性表 —— 与写全了 `int autoget bindable property m_p;` 那一格进的是同一张表，
           * 往下（读写、`bindingof`、生成取/存）一个字都不用分开写。
           */
          if ((m.shape === 'data' || m.shape === 'array' || m.shape === 'fnptr')
            && ((m.type.mods ?? []).includes('bindable') || (m.type.mods ?? []).includes('autoget'))) {
            const propStore = new Map();
            propStore.set('m_value', m.type);
            ps.set(m.name, {
              name: m.name, owner: emitName, emit: `${emitName}$${m.name}`, type: m.type, at: m.at,
              store: propStore,
              auto: m.type,
              autoPath: `${emitName}$${m.name}$m_value`,
              mcPath: (m.type.mods ?? []).includes('bindable')
                ? `${emitName}$${m.name}$m_onChanged` : null,
              data: true,
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
          /* **reactor 也不是方法**（第二百五十六刀）：`reactor m_uiReactor;` 在树上是一格函数
             声明（`reactor` 那个词落在类型的 mods 里，types.js:31 把它归到 `fn`），可它落出来的
             是 `$start` / `$stop` 两格加一串反应 —— 收进方法表，`m_uiReactor.start()` 那一句就把
             它当一格**函数值**，报的是"叫方法时 '.' 的左边不是结构体/类（fnptr）"，指着别处。 */
          if ((m.type?.mods ?? []).includes('reactor')) continue;

          /* 名字走 `fnName`：`construct` / `destruct` / 算符重载那几格**没有普通名字**
             （`m.name` 是 null），而它们正是方法那一族里最要紧的几个。 */
          const mname = fnName({ name: m.name, type: m.type, at: m.at });
          if (mname === null) continue;
          /* **"这一格有构造吗"要从这儿记**（第二百一十六刀）：`construct` 压根没有普通名字
             （名字是 `fnName` 从特名那一支认出来的），所以上头那条按 `m.name === 'construct'`
             记的从来没命中过 —— `aggCtors` 一直是空的。用它的三处（内嵌字段要不要构造、
             局部量 `S s;` 要不要紧跟一句、`new S(…)`）于是全落在"还没接"上。 */
          if (mname === 'construct') ctors.add(emitName);
          const base = `${emitName}$${mname}`;
          /* **重载**（同一格东家上同名的两格方法）：普通名字那几族按声明次序换名
             （`C$put` / `C$put$o1`，第五十八刀）；`construct` / 取存 / 算符那几族的调用点
             各走各的路、还没有"挑一格"这一步 —— 照旧记账，发的那一层明说不收。 */
          const sig0 = sigOf(named(m.at), env, base, m.type);
          if (sig0 === null) continue;
          const one = ovlName(mname)
            ? ovlAdd(ovl, base, mname, sig0.params, env) : { key: base, dup: 0 };
          if (!ovlName(mname) && methods.has(base)) overloads.add(base);
          const key = one.key;
          const sig = key === base ? sig0 : sigOf(named(m.at), env, key, m.type);
          if (sig === null) continue;
          methods.set(key, {
            ...sig,
            dup: one.dup,
            owner: emitName,
            name: mname,
            node: m.at,
            /* 原型 + 体外那个定义是**同一格**（签名一样）：`hasBody` 要**攒**着看 ——
               后来那一格是原型不能把先前记下的"有体"抹掉。 */
            hasBody: mh === 'fn-def' || methods.get(key)?.hasBody === true,
            /* **默认实参也要攒**（第二百六十刀）：jancy 把它写在**声明**那一格上，而体外那个
               定义的形参表上一个默认值都没有（`ui_PropertyGrid.jnc:233` 声明、`:414` 定义）。
               后来那一格把先前的抹掉，于是 `createGroupProperty(,, name, toolTip)` 那两个空槽
               就"没有默认值"了 —— 真语料 662 份上量出来 84 处。 */
            defaults: keepDefaults(methods.get(key)?.defaults, sig.defaults),
          });
        }

        /**
         * **体里的 `alias`**（`alias twice = doubled;`，第二百五十四刀）：它是"这个名字指着谁"
         * —— 没有存储、没有类型。所以记一张"名字 → 目标那一段"，查方法/查字段两处**先解一跳**
         * 再照旧查（`u.twice()` 落出来就是 `(call U$doubled …)`）。
         * 目标只认**一个名字**（点串取末段）；认不出来的不记（宁可让下游报"查不着"）。
         */
        const al = new Map();
        for (const m of a.members) {
          if (m.name === null || !m.storage.includes('alias')) continue;
          /* **右边是一条路的那几格不在这儿**（`alias m_head = m_list.m_head;`）：它落成的是
             一串取字段，已经进了上头那张路径表。按末段记一跳会指到一个**不存在**的字段上
             （199-aliasfield.jnc 的 `m_deep2` 先前就被记成了"指着 m_deep"）。 */
          const p = aliasPath(m);
          if (p !== null && p.length > 1) continue;
          const ini = memberInit(m);
          const tgt = ini === null || ini.curly === true ? null : lastIdent(ini.value);
          if (tgt !== null && tgt !== m.name) al.set(m.name, tgt);
          /* **指着一格类型的那种**（`alias Shade = Color;` / `alias K = Num;`，83-alias.jnc）：
             它与体里的 typedef 同一条 —— 提到类型环境里，名字带上东家那一段前缀（点串写法
             `Box.K k;` 在 `baseOf` 那头要拿它核对）。指着方法/字段的那几格记在这儿也无妨：
             只有写在**类型位置**上才会去解它，那时解不出来照旧记账。 */
          if (tgt !== null && tgt !== m.name && !env.has(m.name)) {
            env.set(m.name, { kind: 'alias', to: tgt, name: `${emitName}$${m.name}` });
          }
        }
        if (al.size > 0) aggAliases.set(emitName, al);
      }
    } else if (h === 'extension') {
      /**
       * **`extension T: Base { … }`**（第一百〇七刀）：给一格**已有的类型**添方法。
       * 落法一句话 —— 那几格方法**直接长在目标类型上**（`extension C1Ext: C1` 里的 `bar`
       * 落成 `C1$bar`，`this` 是 `(ptr C1)`），与写在类体里的一模一样。所以这儿走的是
       * 与类体那一遍**同一段登记**：方法表、重载账、`hasBody` 三样都同一个口径。
       *
       * `using extension …` 这一层**收下不看**（偏差记在 98-extension.jnc 顶上那段）：
       * extension 的方法一律直接长在目标类型上，不看引没引。
       * 字段不收 —— jancy 的 extension 加不了字段（那会改布局）。
       */
      const xn = named(n);
      const tgt = lastIdent(xn?.bases);
      const te = tgt === null ? undefined : env.get(tgt);
      const ownerT = te === undefined ? null : (te.name ?? tgt);
      if (ownerT !== null) {
        /* extension 的体是**顶层那样的一条链**（节点表 :228 记的洞类是 `member`，形状与
           `unit` 那条一样）—— 所以按 `unit-add` 摊平，一格一格看。 */
        for (const it of allInChain(xn.body, 'unit-add', 'unit')) {
          const it0 = headOf(it) === 'attributed' ? (named(it)?.decl ?? it) : it;
          const mh = headOf(it0);
          if (mh !== 'fn-def' && mh !== 'fn-proto') continue;
          const fm = named(it0);
          const t = fm === null ? null : readDeclType(fm.specs, fm.dcl);
          if (t === null || t.shape === 'prop' || t.shape === 'event') continue;
          const mname = fnName({ name: t.name, type: t, at: it0 });
          if (mname === null) continue;
          const base = `${ownerT}$${mname}`;
          const sig0 = sigOf(fm, env, base, t);
          if (sig0 === null) continue;
          const one = ovlName(mname)
            ? ovlAdd(ovl, base, mname, sig0.params, env) : { key: base, dup: 0 };
          if (!ovlName(mname) && methods.has(base)) overloads.add(base);
          const sig = one.key === base ? sig0 : sigOf(fm, env, one.key, t);
          if (sig === null) continue;
          methods.set(one.key, {
            ...sig,
            dup: one.dup,
            owner: ownerT,
            name: mname,
            node: it0,
            hasBody: mh === 'fn-def' || methods.get(one.key)?.hasBody === true,
            /* 默认实参也要攒（理由同上，第二百六十刀）。 */
            defaults: keepDefaults(methods.get(one.key)?.defaults, sig.defaults),
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
    } else if (h === 'var-decl' && !inAgg
      && (readSpecs(named(n)?.specs)?.words ?? []).includes('alias')) {
      /**
       * **`alias plus = add;` / `alias P = Point;`**（第八十七 / 二百六十二刀）：它不是一格量
       * —— 没有存储、没有类型，只是"这个名字指着谁"。所以进的是两张别名表：类型环境那一格
       * （`resolveType` 的 `alias` 那一支顺着它再查一跳）与"值那一面"（查函数那一处先解一跳）。
       * 收进 `vars` 就等于拿一格 no-type 的量把它接走了。
       *
       * **写在函数体里的也在这儿收**（`fn-body × alias`，197-localalias.jnc）：与体里的
       * typedef / enum / struct 同一条 —— jancy 把它们提到那一层的命名空间里。
       * 代价同那三刀：名字提到外面那层（矩阵里记成 T-005）。
       */
      const vn0 = named(n);
      for (const d of allInChain(vn0.dcls, 'dcls-add', 'dcls')) {
        const dc = headOf(d) === 'init' ? named(d)?.dcl : d;
        const t0 = readDeclType(vn0.specs, dc);
        const tgt = headOf(d) === 'init' ? lastIdent(named(d)?.value) : null;
        if (t0 === null || t0.name === null || tgt === null || tgt === t0.name) continue;
        env.set(t0.name, { kind: 'alias', to: tgt });
        gAlias.set(t0.name, tgt);
      }
      return;
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
          /**
           * **顶层的函数原型不是一格量**（`int later(int x);`，15-forward.jnc / 180-topmixovl.jnc）：
           * 它在树上与模块级那几格量长在同一个节点里（声明符尾巴上多一对括号），可它说的是
           * "有这么个函数"。收进 `vars` 的话查名那一层会当普通量算 —— 调用点于是走"从一格
           * 函数值上调"那条，报的是"'later'：函数那一族（fn）"这种认错人的账。
           * 它那一格在函数表里（`scanFns` 收 `fn-proto` 与这种两样）。
           */
          if (t !== null && t.shape === 'fn') continue;
          if (t !== null && t.name !== null) {
            /* **`bindable` 的数据**（`int bindable g_d;`）与属性同族：取/存是**生成**出来的
               （第二百四十九刀）—— 所以它也不是一格量，收进 `vars` 就等于让读写落成一句
               `(var g_d)`，而方言那一侧压根没有那个名字（发的是 `g_d$m_value`）。 */
            const bdata = bind && t.shape !== 'prop';
            /* **属性不是一格量**（第六十九刀）：它没有内存，读写各是一次调用 —— 收进
               `vars` 的话查名那一层会当普通量算，报的是"属性/事件（prop）"这种认错人的账。
               它那一格在下面的 `gProps` 里。 */
            if (t.shape !== 'prop' && !bdata) vars.set(t.name, t);
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
              const emit2 = owner === null ? t.name : `${owner}$${t.name}`;
              gProps.set(t.name, {
                emit: emit2,
                type: t,
                store,
                autoPath: `${emit2}$m_value`,
                mcPath: mods.includes('bindable') ? `${emit2}$m_onChanged` : null,
              });
            }

            /* **`bindable` 的数据**（`bindable int g_d;`）：那一格的取/存是**生成**出来的。
               写了 `property` 的那几格不算 —— 它们在上面那张属性表里（先前这儿把
               `int autoget property g;` 也记成了"bindable data"，于是读它报的是那一族的账）。 */
            if (bdata) bindable.add(t.name);
            /* 那一格也进属性表（第二百四十九刀）：读它是 `(call g_d$get)`、写它是
               `(call g_d$set …)` —— 与写全了的属性同一张表，`auto` 记上"取值器要生成"。 */
            if (bdata) {
              const store2 = new Map();
              store2.set('m_value', t);
              const emit3 = owner === null ? t.name : `${owner}$${t.name}`;
              gProps.set(t.name, {
                emit: emit3,
                type: t,
                store: store2,
                auto: t,
                autoPath: `${emit3}$m_value`,
                mcPath: `${emit3}$m_onChanged`,
                data: true,
              });
            }
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
  /**
   * **类体里的 typedef 先过一遍**（第二百一十一刀，129-baseparam.jnc）：那几格 typedef 提到顶层
   * 是一次**声明**，而查它的地方（另一格聚合体里某个方法的返回类型）可能排在它**前面** ——
   * 泛型那一族尤其如此：造出来的实例插在顶层链**最前头**（第一百一十刀），于是
   * `struct ImplS<B>: B { Entry val() {…} }` 那一格的 `Entry` 要在 `BaseS` 登记它之前就解。
   *
   * 少这一遍，`val` 的返回类型解不出来、整格当 void 记 —— `%d` 那一处报的
   * "碰上这一格类型（void）"就是它（而那不是"欠着的一族"，只是次序）。
   *
   * 这一遍只登记、一个字都不发；口径与下头那一遍同一条（**同名的不盖**，先声明的胜出），
   * 走的次序也一样，所以撞名时的赢家不变。
   */
  const preTypedefs = (n, owner) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    const h = headOf(n);
    let inner = owner;
    if (h === 'namespace') {
      const nm0 = nameText(named(n)?.name);
      if (nm0 !== null) inner = owner === null ? nm0 : `${owner}$${nm0}`;
    } else if (h === 'agg') {
      const a0 = readAgg(n);
      const nm0 = a0 === null ? null : nameText(a0.name);
      if (a0 !== null && nm0 !== null) {
        inner = owner === null ? nm0 : `${owner}$${nm0}`;
        for (const m of a0.members) {
          if (m.shape !== 'typedef' || m.name === null || m.type === null) continue;
          if (env.has(m.name)) continue;
          env.set(m.name, { kind: 'typedef', type: m.type, name: `${inner}$${m.name}` });
        }
      }
    }
    for (const it of n.items) preTypedefs(it, inner);
  };
  preTypedefs(tree, null);
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
    aggAliases,
    gAlias,
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
    ovl,
  };
}
