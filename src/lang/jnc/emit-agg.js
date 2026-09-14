// src/lang/jnc/emit-agg.js —— 一格聚合体发成方言的 `(struct …)`：**三条规则**
//
// 已经搬进这一份的规则（全是尺子从旧降级真输出里逼出来的，`tests/lib/jnc-struct-emit.js`）：
//   1. **类多头一格 `$tag int`**（第五十二/五十六刀）；
//   2. **基类的字段在前**（`struct Point3D: Point2D {…}` → `(m_x)(m_y)(m_z)`，递归摊平）；
//   3. 自己的字段按**源码次序**，收 data / array / fnptr 三族；
//   4. **匿名 union** 摊平再括回 `(union …)`（第一百一十刀）；
//   5. **位域**按底宽挤成 `$bN`（104-bitfield.jnc：4+4 进一格 uint8、5+5 挤不进、24+8 进一格 uint32）；
//   6. union 里套**匿名 struct** 各自发一行，名字 `<东家>$u<union 的成员序号>$s<第几个匿名 struct>`
//      （103-unionstruct.jnc；`$s` 数的是匿名 struct 的个数 —— 104 的 `Ctl` 把这一格钉死）。
//
// **类那一族的大规则（刚从尺子上看清，还没实现）**：旧降级**一整条继承链只发一格结构体**
// （第五十六刀的 `clsRoot`）—— 派生类不另发，它们的字段**并进根那一格**，按声明次序排在后面。
// 128-basetypedef.jnc 是最干净的一例：`class B0 {}` 加四个派生类，旧降级发的是
//   `(struct B0 ($tag int) (m_v int) (m_p B0$Pair) (m_mid int) (m_c int))`
// —— 那四格分别长在 D0/D1/D2/D3 上。129-baseparam.jnc 同理。这也解释了尺子那一栏
// "旧降级没发这个聚合体：34 个" —— 那 34 个就是派生类。
// 所以"一格聚合体发一行"对 struct 成立、对 class **不成立**：下一刀要按**链的根**分组，
// 根那一行把整条链的字段并起来（现在的 `baseFields` 是反着做的 —— 从派生类往上抄基类字段，
// 那是 struct 的规矩）。
//
// 另外三族（尺子每次都印，出处在括号里）：
//   - 属性的**隐藏存储字段** `<东家>$<属性名>$<字段名>`（141-propfullmem / 150-variantautoget /
//     151-propfield / 152-propfieldinit）；
//   - **事件字段**发 `(arr (fnty () void))`（142-propalias 的 `m_onAny`，多播那一格）；
//   - **带名字的 union** 也进字段表（166-unionnamed）。

import { resolveType, baseIntBits, bitfieldBits } from './resolve-type.js';
import { emitType } from './emit-type.js';
import { nameText, allInChain } from './declare.js';
import { headOf, named } from './adapt.js';
import { readBodyMembers } from './agg.js';

/** 类那一族头上那一格。 */
export const CLASS_TAG = '($tag int)';

/**
 * 拼一行 `(struct 名字 …)`。`env` 是 `名字 -> { kind, name, agg }`。
 * 有一格字段解不出来、或者碰上还没搬的那几族，答 `{ line: null, why }`。
 * `lines` 里还带上**顺带发出来的那几行**（union 里套的匿名 struct 各自一行，先发）。
 */
export function structLine(agg, env, allAggs = null) {
  const name = agg.emitName ?? nameText(agg.name);
  if (name === null) return { line: null, lines: [], why: '无名聚合体' };
  const isClass = agg.word === 'class' || agg.word === 'opaque class';
  /* **类那一族：一整个"由继承连起来的连通块"只发一格**（第五十六刀的 clsRoot）。判据是
     并查集，不是"顺着第一个基类往上走"：86-multibase.jnc 的 `class C3: I1, I2` 把 I1 与 I2
     连成一块，第二格基类自己带的 `m_b` 旧降级也并进了 I1 那一行。归并的口径与旧降级同
     （lower.js:7058-7079 的 par/find，与 :7118-7132 的 merged）：
       - 第一格基类：孩子的根指向基类的根（单继承时与"一路往上"一模一样）；
       - 第二格起：那一格的根指向孩子的根（所以 I2 归到 I1）；
       - 字段按**类的声明次序**并，撞名字**头一格胜出**（128-basetypedef.jnc 里两个派生类
         各有一格 `m_v`，旧降级只留一格）。 */
  if (isClass && allAggs !== null) {
    if (classRoot(agg, allAggs, env) !== agg) {
      return { line: null, lines: [], why: '派生类不另发（并进链的根）' };
    }
  }
  const parts = [];
  if (isClass) parts.push(CLASS_TAG);
  const bases = isClass && allAggs !== null ? [] : baseFields(agg, env);
  if (bases === null) return { line: null, lines: [], why: '基类那一格还解不出来' };
  parts.push(...bases);
  const extra = [];
  const fails = [];
  /* 生成物分两桶：**reactor 那几格在属性那几格之前**（82-reactor.jnc 的真输出里
     `m_state` 声明在 `m_uiReactor` 前头，可 `$on`/`$bound` 反倒排在 `$m_value` 前）。 */
  const tailR = [];
  const tail = [];
  if (isClass && allAggs !== null) {
    /* 连通块里每个类各出一份自己的字段，**按声明次序**（根不一定写在最前面）。 */
    const seen = new Set();
    for (const d of allAggs) {
      if (d.word !== 'class' && d.word !== 'opaque class') continue;
      if (classRoot(d, allAggs, env) !== agg) continue;
      const dn = d.emitName ?? nameText(d.name);
      const f = ownFields(d, env, { owner: dn ?? name, extra, fails, tail, tailR });
      if (f === null) {
        return { line: null, lines: [], why: `有字段还解不出来（${fails.join('；') || '?'}）` };
      }
      for (const one of f) {
        const fn = fieldName(one);
        if (fn !== null) {
          if (seen.has(fn)) continue;                                 // 撞名：头一格胜出
          seen.add(fn);
        }
        parts.push(one);
      }
    }
  } else {
    const own = ownFields(agg, env, { owner: name, extra, fails, tail, tailR });
    if (own === null) {
      return { line: null, lines: [], why: `有字段还解不出来（${fails.join('；') || '?'}）` };
    }
    parts.push(...own);
  }
  if (parts.length === 0) return { line: null, lines: [], why: '一格字段都没有' };
  parts.push(...tailR);                                             // reactor 生成的那几格
  parts.push(...tail);                                              // 属性生成的那几格排最后
  /* **union 自己那一行**：它的字段共用一段字节，所以整串括成一格 `(union …)`
     （166-unionnamed.jnc / 191-unionmeth.jnc / 192-unionalias.jnc / 179 的 `Outer$Pair`）。 */
  const body = agg.word === 'union' && parts.length > 0
    ? `(union ${parts.join(' ')})` : parts.join(' ');
  const line = `(struct ${name} ${body})`;
  return { line, lines: [...extra, line], why: null };
}

/** 基类（可能是一串、可能套几层）的字段，按继承次序摊平。 */
function baseFields(agg, env) {
  const out = [];
  for (const b of basePaths(agg)) {
    const rec = env.get(b);
    if (rec === undefined || rec.agg === undefined) return null;    // 跨文件的基类：还解不出来
    const up = baseFields(rec.agg, env);
    if (up === null) return null;
    out.push(...up);
    const own = ownFields(rec.agg, env);
    if (own === null) return null;
    out.push(...own);
  }
  return out;
}

/** 这一格体里有没有**语句**（有就说明它是取值器的体，不是成员表）。 */
function hasStatements(compound) {
  const DECLS = new Set(['var-decl', 'fn-def', 'fn-proto', 'typedef', 'type-decl',
    'attributed', 'access', 'friend', 'var-decl-curly', 'empty-stmt']);
  const nm = named(compound);
  if (nm === null) return false;
  for (const it of allInChain(nm.body, 'unit-add', 'unit')) {
    const h = headOf(it);
    if (h !== null && !DECLS.has(h)) return true;
  }
  return false;
}

/**
 * 一整个"由继承连起来的连通块"归到哪一格（旧降级 lower.js:7058-7079 的并查集）：
 *   - 第一格基类：孩子的根指向**基类**的根 —— 单继承时就是"顺着 bases 一路往上"；
 *   - 第二格起（多继承）：那一格的根指向**孩子**的根 —— 所以第二格基类归到第一格那边。
 * 这两条不一样，所以不能只顺第一个基类走：`class C3: I1, I2` 里 I2 与 I1 是同一块。
 * 一次算一整份 allAggs（结果挂在 allAggs 上缓存，`structLine` 每格聚合体都要问一遍）。
 */
const ROOTS = new WeakMap();
export function classRoot(agg, allAggs, env) {
  let m = ROOTS.get(allAggs);
  if (m === undefined) { m = buildRoots(allAggs, env); ROOTS.set(allAggs, m); }
  return m.get(agg) ?? agg;
}

function buildRoots(allAggs, env) {
  const isCls = (a) => a !== undefined && (a.word === 'class' || a.word === 'opaque class');
  const par = new Map();
  const find = (a) => {
    let r = a;
    const seen = new Set();
    while (par.get(r) !== undefined && par.get(r) !== r) {
      if (seen.has(r)) return r;                                     // 防环
      seen.add(r);
      r = par.get(r);
    }
    return r;
  };
  const aggOf = (nm) => {
    const rec = env.get(nm);
    return rec !== undefined && rec.agg !== undefined && rec.kind === 'class' ? rec.agg : undefined;
  };
  for (const c of allAggs) {
    if (!isCls(c)) continue;
    const bs = basePaths(c).map(aggOf).filter(isCls);
    if (bs.length > 0) {
      const rc = find(c);
      const rb = find(bs[0]);
      if (rc !== rb) par.set(rc, rb);
    }
    for (const mx of bs.slice(1)) {                                  // 第二格起：归到孩子这边
      const rm = find(mx);
      const rc = find(c);
      if (rm !== rc) par.set(rm, rc);
    }
  }
  const out = new Map();
  for (const c of allAggs) if (isCls(c)) out.set(c, find(c));
  return out;
}

/** 一格字段串 `(名字 类型)` 的名字（`(union …)` 那种没有名字，答 null）。 */
function fieldName(s) {
  const m = /^\(([A-Za-z_$][\w$]*) /.exec(s);
  if (m === null) return null;
  return m[1] === 'union' ? null : m[1];
}

/** 基类表里每一格的**最后一段名字**（`io.Base` 取 `Base`；空基类表答空）。 */
export function basePaths(agg) {
  const bases = agg.bases;
  if (bases === null || bases === undefined) return [];
  if (headOf(bases) === 'bases') return [];                         // `(bases)`：没有基类
  const out = [];
  for (const q of allInChain(bases, 'qnames-add', 'qnames')) {
    const n = lastIdent(q);
    if (n !== null) out.push(n);
  }
  return out;
}

/** 一格限定名的最后一段标识符（原树上按位置找 —— 这一层不借规整器）。 */
export function lastIdent(n) {
  if (n === null || n === undefined || typeof n !== 'object') return null;
  if (!Array.isArray(n.items)) return typeof n.value === 'string' ? n.value : null;
  for (let i = n.items.length - 1; i >= 1; i -= 1) {
    const s = lastIdent(n.items[i]);
    if (s !== null) return s;
  }
  return null;
}

/** 自己那几格数据字段。`ctx` 带着东家的名字与"顺带要发的那几行"。 */
function ownFields(agg, env, ctx = { owner: '', extra: [], fails: [], tail: [], tailR: [] }) {
  const out = [];
  /* 位域挤格子的状态：`bits` 是底宽、`used` 是已经占掉的位数。碰上非位域就**收口**。 */
  let pack = null;
  let anonStructs = 0;                                             // union 体里第几个匿名 struct
  const flush = () => {
    if (pack !== null) { out.push(`($b${out.length} int)`); pack = null; }
  };
  agg.members.forEach((m, i) => {
    /* **匿名 union**：成员摊进外面这个结构体，发的时候括回成 `(union …)`（第一百一十刀）。
       带名字的嵌套类型不摊 —— 它是另一格类型，字段表里没有它。 */
    if (m.shape === 'nested-type') {
      const n = m.nested;
      /* **union 自己体里的匿名 struct**：旧降级发的是 `($s0 <东家>$u0$s0)` 加单独一行
         （166-unionnamed.jnc 的 `(union (m_value int) ($s0 Bits$u0$s0))`）。
         `u0` 那一格是"这个 union 自己"，所以序号固定 0。 */
      if (agg.word === 'union' && n !== null && n !== undefined
        && n.word === 'struct' && nameText(n.name) === null) {
        const j = anonStructs;
        anonStructs += 1;
        const nm2 = `${ctx.owner}$u0$s${j}`;
        const f = ownFields(n, env, { ...ctx, owner: nm2 });
        if (f === null) { out.push(null); return; }
        ctx.extra?.push(`(struct ${nm2} ${f.join(' ')})`);
        out.push(`($s${j} ${nm2})`);
        return;
      }
      if (n === null || n === undefined || n.word !== 'union') return;
      if (nameText(n.name) !== null) return;                        // 有名字的 union 不摊
      flush();
      const inner = unionFields(n, env, ctx, i);
      if (inner === null) { out.push(null); return; }               // 里头有解不出来的：整格作废
      if (inner.length > 0) out.push(`(union ${inner.join(' ')})`);
      return;
    }
    if (m.shape === 'bitfield') {
      /* **连着的位域挤成一格**：同一个底宽、累计位数不超过那个宽就接着挤，否则另起一格。
         格名是 `$b<这一格的序号>`（规则从旧降级的真输出反出来，104-bitfield.jnc）。 */
      const bits = baseIntBits(m.type);
      const n = bitfieldBits(m.type);
      if (bits === null || n === null) {                            // 认不出底宽/位数：不猜
        ctx.fails?.push(`${m.name ?? '?'}: 位域的底宽/位数认不出`);
        out.push(null);
        return;
      }
      if (pack !== null && (pack.bits !== bits || pack.used + n > bits)) flush();
      if (pack === null) pack = { bits, used: 0 };
      pack.used += n;
      return;
    }
    /* **完整属性声明里的字段**是属性自己的存储，名字带上东家与属性名：
       `class C { property m_p { int m_v; … } }` 发 `(C$m_p$m_v int)`（151-propfield.jnc）。 */
    if (m.shape === 'prop') {
      if (m.name === null) return;
      /* **autoget 属性**：编译器生成那格存储，名字就叫 `m_value`（prop_autoget.rst:26），
         发成 `<东家>$<属性名>$m_value`，类型是属性自己的类型（150-variantautoget.jnc）。 */
      /* `autoget` / `bindable` 的属性由编译器生成存储：`m_value`（prop_autoget.rst:26），
         `bindable` 还多一格事件 `m_onChanged`（81-propbindmem.jnc）。
         这两格**排在自己那些真字段之后**（旧降级的次序：67-propauto.jnc 的
         `(m_hits int) (Cell$m_v$m_value int)`）—— 所以塞进 `ctx.tail`，最后再接上。 */
      const gen = m.type === null ? [] : m.type.mods;
      /* **reactor** 那一格生成两格 bool（`$on` / `$bound`，82-reactor.jnc 的真输出）。 */
      if (gen.includes('reactor')) {
        ctx.tailR?.push(`(${ctx.owner}$${m.name}$on bool)`);
        ctx.tailR?.push(`(${ctx.owner}$${m.name}$bound bool)`);
        return;
      }
      if (gen.includes('autoget') || gen.includes('bindable')) {
        const ar = resolveType({ ...m.type, shape: 'data' }, env);
        if (ar.type === null) { ctx.fails?.push(`${m.name}$m_value: ${ar.why}`); out.push(null); return; }
        ctx.tail?.push(`(${ctx.owner}$${m.name}$m_value ${emitType(ar.type, 'field')})`);
        if (gen.includes('bindable')) {
          ctx.tail?.push(`(${ctx.owner}$${m.name}$m_onChanged (arr (fnty () void)))`);
        }
        return;
      }
      const body = named(m.at)?.body;
      if (body === undefined || headOf(body) !== 'compound') return;
      /* **简写取值器**（`int const property m_desc { int t = …; return …; }`）：属性体就是
         取值器的体，里头的局部量不是字段（140-propgetbody.jnc 那一处我们先前多发了
         `Box$m_desc$t`）。判据：体里出现**语句**就当取值器体。 */
      if (readBodyMembers(body).length === 0 || hasStatements(body)) return;
      flush();
      for (const im of readBodyMembers(body)) {
        /* 属性体里的 `alias` / `typedef` 同样**不是字段**（`autoget alias m_value = m_av;`
           只是把属性的存储指到外面那格 `m_av` 上 —— 142-propalias.jnc）。 */
        if (im.storage.includes('alias') || im.storage.includes('typedef')) continue;
        if (im.shape !== 'data' && im.shape !== 'array' && im.shape !== 'fnptr') continue;
        if (im.name === null) { out.push(null); continue; }
        const ir = resolveType(im.type, env);
        if (ir.type === null) { ctx.fails?.push(`${m.name}.${im.name}: ${ir.why}`); out.push(null); continue; }
        out.push(`(${ctx.owner}$${m.name}$${im.name} ${emitType(ir.type, 'field')})`);
      }
      return;
    }
    /* 函数指针字段也是一格数据（`(m_op (fnty (int int) int))`，109-fnfield.jnc）。 */
    /* reactor 那一格无论有没有体，都生成 `$on` / `$bound` 两格（82-reactor.jnc）。 */
    if (m.type !== null && m.type.mods.includes('reactor') && m.name !== null) {
      ctx.tailR?.push(`(${ctx.owner}$${m.name}$on bool)`);
      ctx.tailR?.push(`(${ctx.owner}$${m.name}$bound bool)`);
      return;
    }
    /* **bindable data**：光写 `bindable` / `autoget`、不写 `property`，那也是一格
       "整个由编译器实现的属性"（samples/jnc/34_BindableProperties.jnc:87-90 那句
       "bindable data is a wholly compiler-implemented property"）—— 所以它**不是**一格叫
       `m_state` 的字段，而是生成 `<东家>$<名字>$m_value`（+ bindable 多一格 `$m_onChanged`），
       并且排在自己那些真字段之后（81-propbindmem.jnc / 82-reactor.jnc 的真输出）。 */
    if (m.type !== null && m.name !== null
      && (m.type.mods.includes('bindable') || m.type.mods.includes('autoget'))
      && (m.shape === 'data' || m.shape === 'array' || m.shape === 'fnptr')) {
      const br = resolveType(m.type, env);
      if (br.type === null) { ctx.fails?.push(`${m.name}$m_value: ${br.why}`); out.push(null); return; }
      ctx.tail?.push(`(${ctx.owner}$${m.name}$m_value ${emitType(br.type, 'field')})`);
      if (m.type.mods.includes('bindable')) {
        ctx.tail?.push(`(${ctx.owner}$${m.name}$m_onChanged (arr (fnty () void)))`);
      }
      return;
    }
    /* `static` 那一格是**模块级存储**，不躺在对象里（167-staticfield.jnc / 193-staticctorns.jnc
       旧降级都不发）。 */
    if (m.storage.includes('static')) return;
    /* `alias` / `typedef` 那两族**不是字段**（它们只是给已有的东西起个名字，没有自己的存储）
       —— 83-alias.jnc / 95-aliaspath.jnc / 199-aliasfield.jnc 那几处旧降级都不发。 */
    if (m.storage.includes('alias') || m.storage.includes('typedef')) return;
    /* 事件字段也进字段表（多播那一格：`(arr (fnty () void))`，142-propalias.jnc）。 */
    if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr' && m.shape !== 'event') return;
    if (m.name === null) { ctx.fails?.push('一格没有名字的成员'); out.push(null); return; }
    flush();
    const r = resolveType(m.type, env);
    if (r.type === null) { ctx.fails?.push(`${m.name}: ${r.why}`); out.push(null); return; }
    out.push(`(${m.name} ${emitType(r.type, 'field')})`);
  });
  flush();
  return out.some((x) => x === null) ? null : out;
}

/**
 * 匿名 union 里那几格。里头再套**匿名 struct** 时按旧降级的命名各自发一行：
 * `<东家>$u<union 的成员序号>$s<struct 在 union 里的序号>`，字段名是 `$s<同一个序号>`
 * （出处：103-unionstruct.jnc 的真输出 `(union ($s0 H$u1$s0) ($s1 H$u1$s1))`）。
 */
function unionFields(uni, env, ctx, unionAt) {
  const out = [];
  let bad = false;
  /* `$s` 那个序号数的是**匿名 struct 的个数**，不是成员的位置 —— `Ctl` 里 union 的第 0 格是
     `m_value`、第 1 格才是匿名 struct，而旧降级发的是 `$s0`（104-bitfield.jnc）。
     `H` 那处两格都是匿名 struct，两种数法看不出差别，是 `Ctl` 这一格把它钉死的。 */
  let sn = 0;
  uni.members.forEach((m) => {
    if (m.shape === 'nested-type') {
      const inner = m.nested;
      if (inner === null || inner === undefined) return;
      if (inner.word === 'struct' && nameText(inner.name) === null) {
        const j = sn;
        sn += 1;
        const nm = `${ctx.owner}$u${unionAt}$s${j}`;
        const fields = ownFields(inner, env, { owner: nm, extra: ctx.extra });
        if (fields === null) { bad = true; return; }
        ctx.extra.push(`(struct ${nm} ${fields.join(' ')})`);
        out.push(`($s${j} ${nm})`);
        return;
      }
      return;                                                       // 别的嵌套类型不摊
    }
    if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') return;
    if (m.name === null) { ctx.fails?.push('union 里一格没有名字的成员'); bad = true; return; }
    const r = resolveType(m.type, env);
    if (r.type === null) { ctx.fails?.push(`${m.name}: ${r.why}`); bad = true; return; }
    out.push(`(${m.name} ${emitType(r.type, 'field')})`);
  });
  return bad ? null : out;
}
