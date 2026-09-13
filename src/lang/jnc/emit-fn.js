// src/lang/jnc/emit-fn.js —— 一格函数/方法发成方言的 `(fn 名字 (形参) 返回`
//
// 聚合体那一条腿（emit-agg.js）已经到 196/197，往上顶的下一格就是**函数的头**。规则同样是
// 从旧降级的真输出反出来的（尺子：tests/lib/jnc-fn-emit.js，外部尺 `omni emit sx x.jnc`）：
//
//   1. 名字：顶层就是它自己（带命名空间时是 `ns$名字`），类里的是 `<东家>$<方法名>`；
//   2. 方法头上多一格 `$this`，写法是**存储位置**的自己（类 → `(ptr 链的根)`，
//      结构体 → `(ptr S)`）—— 出处 lower.js:10155 那一行（`this` 在方言里叫 `$this`）
//      与 86-multibase.jnc 的真输出 `(fn I1$construct (($this (ptr I1)) (a int)) void`；
//   3. 形参用**源码里的名字**，类型在**存储位置**（lower.js:10155 的 `slotText(p.type)`）；
//   4. 返回类型也在存储位置（同一行的 `slotText(info.type)`）；`construct` / `destruct`
//      压根没写类型（基类型是 `no-type`），回的是 `void`。
//
// `static` 那一族不带 `$this`（它不在对象上）。变参（`formals-varargs`）与形参没名字那两族
// 先记账不猜。

import { resolveType } from './resolve-type.js';
import { emitType } from './emit-type.js';
import { readDeclType, readAnonType } from './types.js';
import { nameText, allInChain, readDcl } from './declare.js';
import { headOf, named } from './adapt.js';
import { readBodyMembers } from './agg.js';
import { basePaths } from './emit-agg.js';

/** 构造/析构那两格没有写类型 —— 回的是 void（jancy 的 construct 不写返回类型）。 */
const VOID_NAMES = new Set(['construct', 'destruct', 'construct$static', 'operator new']);

/**
 * **特名**在方言里叫什么：`construct` / `destruct` 照抄，`static construct` 发的是
 * `construct$static`（旧降级的真输出 193-staticctorns.jnc 的 `(fn C$construct$static () void`）。
 */
const SPECIAL_NAMES = {
  construct: 'construct', destruct: 'destruct', 'static construct': 'construct$static',
};

/**
 * **算符重载的符号名**：源码里那个算符 → `op$<名字>`（旧降级 lower.js:672-700 的 OP_NAME，
 * 真输出 122-opincdec.jnc 的 `It$op$inc` / `It$op$dec` / `It$op$inc$post`）。
 * 后置那两格自己带 `$post`（表里分开列，不在发的时候拼 —— 拼就成了隐式规则）。
 */
export const OP_NAMES = {
  ':=': 'assign', '++': 'inc', '--': 'dec', '*': 'mul', '->': 'arrow', '()': 'call',
  bool: 'bool', '==': 'eq', '!=': 'ne',
  '+=': 'addAssign', '-=': 'subAssign', '*=': 'mulAssign', '/=': 'divAssign',
  '%=': 'modAssign', '&=': 'andAssign', '|=': 'orAssign', '^=': 'xorAssign',
  '<<=': 'shlAssign', '>>=': 'shrAssign',
};
const OP_POSTFIX = { '++': 'inc$post', '--': 'dec$post' };

/**
 * 一格 `fn-suffix` 里的形参表：`[{ name, type }]`。
 * 变参与"没名字的形参"照实回（`name: null` / `varargs: true`），由发的那一层决定收不收。
 */
export function readFormals(fnSuffix) {
  const nm = named(fnSuffix);
  if (nm === null || nm.kind !== 'fn-suffix') return null;
  return formalList(nm.formals);
}

function formalList(formals) {
  if (formals === null || formals === undefined) return [];
  if (headOf(formals) === 'formals-varargs') {
    const inner = named(formals);
    const list = inner === null ? [] : formalList(inner.formals);
    return list === null ? null : [...list, { name: null, type: null, varargs: true }];
  }
  const out = [];
  for (const f of allInChain(formals, 'formals-add', 'formals')) {
    const h = headOf(f);
    const fn = named(f);
    if (fn === null) continue;
    if (h === 'formal') {
      const t = readDeclType(fn.specs, fn.dcl);
      /* 形参那一格的**节点**也带上 —— 默认实参（`int b = 2`）在它的 `init` 洞里，
         调用方要拿它定型（74-argdefault.jnc 那一格先前永远解不出来，就是因为没带）。 */
      out.push({
        name: t === null ? nameText(named(fn.dcl)?.name) : t.name, type: t, varargs: false, at: f,
      });
      continue;
    }
    if (h === 'formal-anon') {
      /* 只写类型不写名字（`int ignore(int, int b)`）：名字由这一层补 `$a<第几格>`
         （旧降级的真输出 `(fn ignore (($a0 int) (b int)) int`，176-anonformal.jnc）。
         这一格没有 `dcl`，类型从"说明符 + `*`"读（`readAnonType`）。 */
      out.push({ name: null, type: readAnonType(fn.specs, fn.ptrs), varargs: false, at: f });
      continue;
    }
  }
  return out;
}

/** 这一格声明符上那个 `fn-suffix`（没有就 null）。 */
function fnSuffixOf(t) {
  const dc = t === null || t === undefined ? null : readDcl(t.raw?.dcl);
  if (dc === null) return null;
  const s = dc.suffixes.find((x) => x.kind === 'fn-suffix');
  return s === undefined ? null : s.node;
}

/** 这一格函数的名字：普通名字、**特名**（`construct` / `destruct`）或**算符**（`op$inc`）。 */
export function fnName(m, inProp = false) {
  if (m === null || m === undefined) return null;
  if (m.name !== null && m.name !== undefined) return m.name;
  const dc = readDcl(m.type?.raw?.dcl);
  if (dc === null) return null;
  if (dc.special !== null) return SPECIAL_NAMES[dc.special] ?? null;
  if (dc.operator !== null) {
    const w = dc.operator.postfix ? OP_POSTFIX[dc.operator.op] : OP_NAMES[dc.operator.op];
    return w === undefined ? null : `op$${w}`;
  }
  /* 属性的取/存：`<属性名>$get` / `$set`（旧降级 107-psetexpr.jnc 的 `C$m_val$get`）。 */
  if (dc.accessor !== null) return `${dc.accessor.path}$${dc.accessor.which}`;
  /* **裸写**的 `get` / `set`：在**属性体里**它就是这格属性的取/存（prop_full.rst:15 那对花括号
     开的是一层命名空间）；在类体里带着体的那一种才是下标算符 `op$index$get` / `$set`
     （130-opindex.jnc 的 `Box$op$index$get`）；只有原型的那一种体写在别处（127-outerget.jnc），
     这一格不发。三种形状同名，靠"在哪儿 + 有没有体"分开。 */
  if (dc.bareAccessor !== null) {
    if (inProp) return dc.bareAccessor;
    return headOf(m.at) === 'fn-def' ? `op$index$${dc.bareAccessor}` : null;
  }
  /* **体外定义**：点串名字整串用 `$` 接起来（`C1.p.get` → `C1$p$get`，127-outerget.jnc）。 */
  if (dc.path !== null) {
    const leaf = leafName(dc.path.leaf);
    return leaf === null ? null : [...dc.path.segs, leaf].join('$');
  }
  return null;
}

/**
 * **reactor 那一族**发的是两格函数：`<东家>$<名字>$start` 与 `$stop`，形参只有 `$this`
 * （顶层那一格连 `$this` 都没有），回 void。出处是旧降级的真输出（82-reactor.jnc）：
 *   `(fn Sess$m_uiReactor$start (($this (ptr Sess))) void` / `$stop`
 *   `(fn g_r$start () void` / `$stop`
 * 体里那几格（一条语句一格 `$r<N>`、onevent 一格 `$e<N>`）是另一刀。
 */
export function reactorHeads(m, ctx = { owner: null, self: null }) {
  const base = fnName(m);
  if (base === null) return { heads: [], why: '没有名字' };
  const sym = ctx.owner === null || ctx.owner === undefined ? base : `${ctx.owner}$${base}`;
  const ps = ctx.self === null || ctx.self === undefined ? '' : `($this ${ctx.self})`;
  return {
    heads: [
      { name: `${sym}$start`, head: `(fn ${sym}$start (${ps}) void` },
      { name: `${sym}$stop`, head: `(fn ${sym}$stop (${ps}) void` },
    ],
    why: null,
  };
}

/** 这一格是不是 reactor（发的是上面那两格，不是一格普通函数）。 */
export function isReactor(m) {
  return m !== null && m !== undefined && m.type !== null && m.type !== undefined
    && m.type.mods.includes('reactor');
}

/**
 * **bindable data 生成的取/存**：`int bindable m_state;` 不写 `property`，可它在 jancy 那边是
 * "整个由编译器实现的属性"（samples/jnc/34_BindableProperties.jnc:87-90），所以编译器发两格
 * 函数。出处是旧降级的真输出（82-reactor.jnc）：
 *   `(fn Sess$m_state$get (($this (ptr Sess))) int`
 *   `(fn Sess$m_state$set (($this (ptr Sess)) (x int)) void`
 *   `(fn g_b$get () int` / `(fn g_b$set ((x int)) void`（顶层那一格没有 `$this`）
 * 形参名就叫 `x`（lower.js:3448 / 3495）。存的那一格回 void，取的那一格回它自己的类型
 * （**存储位置**）。
 */
export function dataAccessorHeads(m, env, ctx = { owner: null, self: null }) {
  if (m === null || m === undefined || m.type === null || m.name === null) {
    return { heads: [], why: '没有名字' };
  }
  const r = resolveType({ ...m.type, shape: 'data' }, env);
  if (r.type === null) return { heads: [], why: `类型解不出来（${r.why}）` };
  const tc = { clsRoot: ctx.clsRoot ?? ((n) => n) };
  const ty = emitType(r.type, 'slot', tc);
  const sym = ctx.owner === null || ctx.owner === undefined
    ? m.name : `${ctx.owner}$${m.name}`;
  const self = ctx.self === null || ctx.self === undefined ? null : `($this ${ctx.self})`;
  const g = self === null ? '' : self;
  const s = self === null ? `(x ${ty})` : `${self} (x ${ty})`;
  return {
    heads: [
      { name: `${sym}$get`, head: `(fn ${sym}$get (${g}) ${ty}` },
      { name: `${sym}$set`, head: `(fn ${sym}$set (${s}) void` },
    ],
    why: null,
  };
}

/** 这一格数据声明会不会**生成**取/存（`bindable` 那一族；写了 `property` 的是另一条路）。 */
export function isBindableData(m) {
  if (m === null || m === undefined || m.type === null || m.type === undefined) return false;
  if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') return false;
  return m.type.mods.includes('bindable') && !m.type.mods.includes('property');
}

/**
 * **autoget 属性生成的取值器**：`int autoget property g_clamp;` 的取值器不用写，编译器生成
 * 一格（prop_autoget.rst:15-17）。存值器照旧是**写出来的**那一格（`void g_clamp.set(int x)`），
 * 所以这儿只发 `$get`。出处是旧降级的真输出（67-propauto.jnc）：
 *   `(fn g_clamp$get () int`、`(fn Cell$m_v$get (($this (ptr Cell))) int`
 */
export function autogetGetterHead(m, env, ctx = { owner: null, self: null }) {
  if (m === null || m === undefined || m.type === null || m.name === null) {
    return { heads: [], why: '没有名字' };
  }
  /* 完整声明式的属性**压根不写类型**（类型是取值器的返回类型）—— 只写了存值器时，
     类型就是**存值器那个形参**的类型（141-propfullmem.jnc / 142-propalias.jnc），
     由调用方按成员表挑出来递进来（`ctx.typeOf`）。 */
  const src = ctx.typeOf ?? { ...m.type, shape: 'data' };
  const r = resolveType(src, env);
  if (r.type === null) return { heads: [], why: `类型解不出来（${r.why}）` };
  const tc = { clsRoot: ctx.clsRoot ?? ((n) => n) };
  const ty = emitType(r.type, 'slot', tc);
  const sym = ctx.owner === null || ctx.owner === undefined ? m.name : `${ctx.owner}$${m.name}`;
  const ps = ctx.self === null || ctx.self === undefined ? '' : `($this ${ctx.self})`;
  return { heads: [{ name: `${sym}$get`, head: `(fn ${sym}$get (${ps}) ${ty}` }], why: null };
}

/** 这一格属性声明会不会**生成取值器**（`autoget` 那一族）。 */
export function isAutogetProp(m) {
  if (m === null || m === undefined || m.type === null || m.type === undefined) return false;
  return m.shape === 'prop' && m.type.mods.includes('autoget');
}

/** 这一格方法是不是**虚**的（虚派发表按它发；一整条链上同名的只发一格）。 */
export function isVirtual(m) {
  if (m === null || m === undefined) return false;
  return ['virtual', 'abstract', 'override'].some((w) => m.storage.includes(w));
}

/**
 * **虚派发函数**：一整条继承链上同名的虚方法共用一格 `<链的根>$$vd$<方法名>`
 * （第五十七刀：对象里一格 int 标签 + 一串 if）。形参名一律 `$aN`（`$a0` 是 self），
 * 类型在**存储位置**，返回同普通函数。出处是旧降级的真输出（54-virtual.jnc）：
 *   `(fn Shape$$vd$area (($a0 (ptr Shape))) int`、`(fn Iface$$vd$val (($a0 (ptr Iface))) int`
 * 与 lower.js:7432 / 7453 那两行。
 */
export function dispatchHead(m, env, ctx = { root: null, self: null }) {
  const base = fnName(m);
  if (base === null) return { heads: [], why: '没有名字' };
  if (ctx.self === null || ctx.self === undefined) return { heads: [], why: '东家那一格解不出来' };
  const sfx = fnSuffixOf(m.type);
  const fs = sfx === null ? null : readFormals(sfx);
  if (fs === null) return { heads: [], why: '认不出形参表' };
  if (fs.some((f) => f.varargs)) return { heads: [], why: '变参那一族（…）' };
  const tc = { clsRoot: ctx.clsRoot ?? ((n) => n) };
  const parts = [`($a0 ${ctx.self})`];
  for (const [i, f] of fs.entries()) {
    if (f.type === null) return { heads: [], why: '形参的类型读不出来' };
    const r = resolveType(f.type, env);
    if (r.type === null) return { heads: [], why: `形参：${r.why}` };
    parts.push(`($a${i + 1} ${emitType(r.type, 'slot', tc)})`);
  }
  const ret = retText(m, base, env, tc);
  if (ret === null) return { heads: [], why: '返回类型解不出来' };
  const sym = `${ctx.root}$$vd$${base}`;
  return { heads: [{ name: sym, head: `(fn ${sym} (${parts.join(' ')}) ${ret}` }], why: null };
}


/**
 * **编译器生成的构造**：一格聚合体没有写 `construct`、可它需要初始化时，旧降级发一格
 * `(fn <东家>$construct (($this <自己>)) void`（lower.js:2188 与 :10119-10135 那几段 pre-lines）。
 * 需要初始化的判据是那几段各自要发的行：
 *   1. 字段带**默认值**（75-fielddefault.jnc）；
 *   2. 有**事件**成员（要在构造开头建单子，80-class-event.jnc）；
 *   3. 有 `bindable` / `autoget` 那一族（生成的存储同上要建单子，142-propalias / 152-propfieldinit）；
 *   4. 有 `static construct`（50-construct.jnc 的 `Reg`、193-staticctorns.jnc 的 `C`）；
 *   5. **基类**有（或同样生成）构造（53-inherit.jnc 的 `Sparrow`、65-propmem.jnc 的 `Derived`）；
 *   6. 有**成员**的类型是本文件里带（或生成）构造的聚合体（120-structctor.jnc 的 `Wrap`）。
 * 5/6 会往下追（带环的守卫），追不到的按"不需要"算 —— 那一格的账在尺子的两栏里看得见。
 */
export function needsCtor(agg, env, seen = new Set()) {
  if (agg === null || agg === undefined || seen.has(agg)) return false;
  seen.add(agg);
  if (hasWrittenCtor(agg) || hasStaticCtor(agg)) return true;
  for (const m of agg.members) {
    if (m.shape === 'event') return true;
    /* `bindable` 要在构造开头建那格多播的单子（第八十三刀）；`autoget` **不要** ——
       它只是一格存储，没有单子（67-propauto.jnc 的 `Cell` 旧降级就不发构造，
       那是"新腿发了、旧降级没这个名字"那一栏抓出来的）。 */
    if (m.type !== null && m.type !== undefined && m.type.mods.includes('bindable')) return true;
    if (hasInitValue(m)) return true;
    /* **属性体里那格字段带初值**（`property m_p { int m_v = 7; … }`，152-propfieldinit.jnc）
       —— 那一格存储也要在构造里写上默认值。 */
    if (m.shape === 'prop') {
      const body = named(m.at)?.body;
      const inner = headOf(body) === 'compound' ? readBodyMembers(body) : [];
      /* 只有**成员表**那种体才算（体里有取/存那两格）—— 简写取值器的体里也有带初值的
         局部量（140-propgetbody.jnc 的 `Box`，那是"新腿发了、旧降级没这个名字"抓出来的）。 */
      if (inner.some((im) => im.shape === 'fn') && inner.some((im) => hasInitValue(im))) {
        return true;
      }
    }
    /* 成员的类型是本文件里那格聚合体 —— 它带构造，外面这一格也要发一格。 */
    if (m.shape === 'data' && m.type !== null && m.type.ptrs === 0) {
      const nm = m.type.base.kind === 'named' ? memberTypeName(m) : null;
      const rec = nm === null ? undefined : env.get(nm);
      if (rec !== undefined && rec.agg !== undefined && needsCtor(rec.agg, env, seen)) return true;
    }
  }
  for (const b of basePaths(agg)) {
    const rec = env.get(b);
    if (rec !== undefined && rec.agg !== undefined && needsCtor(rec.agg, env, seen)) return true;
  }
  return false;
}

/** 这一格聚合体自己写了 `construct` / `static construct` 吗。 */
export function hasWrittenCtor(agg) {
  if (agg === null || agg === undefined) return false;
  return agg.members.some((m) => m.shape === 'fn' && fnName(m) === 'construct');
}

/**
 * 这一格聚合体有 `static construct` 吗。**它不算"写过构造"**：静态构造要在实例构造里带一句
 * "跑没跑过"的守卫，所以旧降级照样生成一格实例构造（50-construct.jnc 的 `Reg`、
 * 193-staticctorns.jnc 的 `C` —— 这两格是"还没试的"那一栏抓出来的）。
 */
export function hasStaticCtor(agg) {
  if (agg === null || agg === undefined) return false;
  return agg.members.some((m) => m.shape === 'fn' && fnName(m) === 'construct$static');
}

/**
 * 这一格成员声明带初值吗（`int m_x = 3;` / `Inner m_in(1)`）。
 * 只看**声明符自己那一层**：`alias` / `typedef` / `static` 那几族不算（前两族没有存储，
 * 第三族是模块级的），方法那一族更不能算 —— 它的体里满是局部量的 `init`
 * （先前整棵子树乱走，122-opincdec.jnc 的 `It` 就是这么被误判成"要构造"的）。
 */
function hasInitValue(m) {
  if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') return false;
  if (m.storage.includes('alias') || m.storage.includes('typedef')
    || m.storage.includes('static')) return false;
  const dc = readDcl(m.type?.raw?.dcl);
  if (dc !== null && dc.ctor) return true;                           // `Inner m_in(1)`
  const nm = named(m.at);
  if (nm === null || headOf(m.at) !== 'var-decl') return false;
  for (const d of allInChain(nm.dcls, 'dcls-add', 'dcls')) {
    const h = headOf(d);
    if (h !== 'init' && h !== 'ref-init') continue;
    /* 这一条 `init` 是**这格成员自己**的吗（同一条声明里可以并列好几格）。 */
    const dn = named(d);
    if (dn !== null && dn.dcl === m.type?.raw?.dcl) return true;
  }
  return false;
}

/** 一格数据成员的类型名（`Inner m_in;` → `Inner`）。 */
function memberTypeName(m) {
  const specs = m.type?.raw?.specs;
  if (specs === null || specs === undefined || !Array.isArray(specs.items)) return null;
  const t = specs.items[1];
  if (t === null || t === undefined) return null;
  if (!Array.isArray(t.items)) return t.value === undefined ? null : String(t.value);
  return nameText(t);
}

/** 生成的那一格构造的头（形参只有 `$this`，回 void）。 */
export function ctorHead(name, self) {
  const ps = self === null || self === undefined ? '' : `($this ${self})`;
  return { name: `${name}$construct`, head: `(fn ${name}$construct (${ps}) void` };
}


/**
 * **方法/函数的别名**（`alias dispose = close;`，第八十七刀）：旧降级发一格**转手函数**，
 * 签名照抄目标那一格，形参名换成 `$aN`（lower.js:3765-3766）。真输出（83-alias.jnc）：
 *   `(fn dbl (($a0 int)) int`（顶层的函数别名）
 *   `(fn File$dispose (($this (ptr File))) int`、`(fn Box$tripled (($this (ptr Box))) int`
 * `tgt` 是**目标那一格成员**（这一层不查名 —— 谁是目标由调用方按成员表定）。
 */
export function aliasHead(name, tgt, env, ctx = { owner: null, self: null }) {
  if (name === null || name === undefined) return { heads: [], why: '没有名字' };
  if (tgt === null || tgt === undefined || tgt.type === null) return { heads: [], why: '认不出目标' };
  const sfx = fnSuffixOf(tgt.type);
  const fs = sfx === null ? null : readFormals(sfx);
  if (fs === null) return { heads: [], why: '目标的形参表读不出来' };
  if (fs.some((f) => f.varargs)) return { heads: [], why: '变参那一族（…）' };
  const tc = { clsRoot: ctx.clsRoot ?? ((n) => n) };
  const parts = [];
  if (ctx.self !== null && ctx.self !== undefined && !tgt.storage.includes('static')) {
    parts.push(`($this ${ctx.self})`);
  }
  for (const [i, f] of fs.entries()) {
    if (f.type === null) return { heads: [], why: '目标形参的类型读不出来' };
    const r = resolveType(f.type, env);
    if (r.type === null) return { heads: [], why: `目标形参：${r.why}` };
    parts.push(`($a${i} ${emitType(r.type, 'slot', tc)})`);
  }
  const ret = retText(tgt, fnName(tgt) ?? name, env, tc);
  if (ret === null) return { heads: [], why: '目标的返回类型解不出来' };
  const sym = ctx.owner === null || ctx.owner === undefined ? name : `${ctx.owner}$${name}`;
  return { heads: [{ name: sym, head: `(fn ${sym} (${parts.join(' ')}) ${ret}` }], why: null };
}


/** 一格存值器的**头一个形参**的类型（完整声明式属性没写类型时，取值器回的就是它）。 */
export function setterParamType(setter) {
  const sfx = fnSuffixOf(setter?.type);
  const fs = sfx === null ? null : readFormals(sfx);
  if (fs === null || fs.length === 0) return null;
  return fs[0].type;
}


/**
 * **reactor 的体**：一条语句一格函数（第八十五刀"一条语句一格反应"）。序号在**整个体上**
 * 数一遍：`onevent` 那一条落成 `$e<i>`、别的落成 `$r<i>`。真输出（82-reactor.jnc）：
 *   `(fn Sess$m_uiReactor$r0 (($this (ptr Sess))) void`（体的第 0 条是赋值）
 *   `(fn Sess$m_uiReactor$e1 (($this (ptr Sess))) void`（第 1 条是 onevent）
 *   `(fn g_r$r0 () void` / `(fn g_r$r1 () void`（顶层那一格没有 `$this`）
 */
export function reactorBodyHeads(m, sym, self) {
  const body = named(m?.at)?.body;
  if (headOf(body) !== 'compound') return { heads: [], why: '这一格 reactor 没有体' };
  const nm = named(body);
  const ps = self === null || self === undefined ? '' : `($this ${self})`;
  const heads = [];
  let i = 0;
  for (const st of allInChain(nm.body, 'unit-add', 'unit')) {
    const tag = headOf(st) === 'onevent' ? 'e' : 'r';
    const name = `${sym}$${tag}${i}`;
    heads.push({ name, head: `(fn ${name} (${ps}) void` });
    i += 1;
  }
  return { heads, why: null };
}

/** 点串尾巴那一格的名字（四种：普通名字 / 取存 / 特名 / 算符）。 */
function leafName(leaf) {
  if (leaf.kind === 'special') return SPECIAL_NAMES[leaf.text] ?? null;
  /* 点串的尾巴是 `static construct` 时，语法上它是**一个记号**（不是 `special` 节点）——
     所以普通名字这一支也要过那张表（193-staticctorns.jnc 的 `void C.static construct()`）。 */
  if (leaf.kind === 'name') return SPECIAL_NAMES[leaf.text] ?? leaf.text;
  if (leaf.kind === 'accessor') return leaf.text;
  const w = leaf.postfix ? OP_POSTFIX[leaf.op] : OP_NAMES[leaf.op];
  return w === undefined ? null : `op$${w}`;
}

/** 体外定义的**东家**那几段（`int C1.p.get()` → `['C1','p']`）；不是体外定义答 null。 */
export function fnOwnerSegs(m) {
  const dc = readDcl(m?.type?.raw?.dcl);
  if (dc === null) return null;
  if (dc.accessor !== null) return [dc.accessor.path];
  return dc.path === null ? null : dc.path.segs;
}

/**
 * **重载改名**：同一个符号第二格起加 `$o<第几个>`（旧降级的真输出：135-overloadcheap.jnc 的
 * `q` / `q$o1` / `q$o2` / `q$o3`，158-overloadlit.jnc 的 `B$add` / `B$add$o1`）。
 * 用法：一份模块开一个，按**声明次序**每格函数问一次（拼不出来的那几格也要问 —— 旧降级
 * 那边它们照样占一个号）。
 */
/**
 * 重载的后缀。旧降级有**两套**号（都在真输出里）：
 *   - 普通函数/方法从 1 起：`q` / `q$o1` / `q$o2` / `q$o3`（135-overloadcheap.jnc）；
 *   - **取/存与算符**从 2 起：`g_p$set` / `g_p$set$o2`（153-propsetovl.jnc），
 *     `SB$op$addAssign` / `SB$op$addAssign$o2`（184-opovl.jnc）、`Cell$op$assign$o2`、
 *     190-opassigndecl.jnc 同 —— 与宿主面那条 `_o2` 是同一套（第一百八十一刀那句）。
 * 拼名字的两处（`fnHead` 与尺子算键）都走这一格，免得两边各写一遍。
 */
export function overloadSuffix(base, dup) {
  if (dup === 0) return '';
  const leaf = base.includes('$') ? base.slice(base.lastIndexOf('$') + 1) : base;
  const acc = leaf === 'get' || leaf === 'set' || base.includes('op$');
  return `$o${acc ? dup + 1 : dup}`;
}

export function overloadIndex() {
  const seen = new Map();
  return (sym) => {
    const n = seen.get(sym) ?? 0;
    seen.set(sym, n + 1);
    return n;
  };
}

/**
 * 拼一行 `(fn 名字 (形参) 返回`（**只到头**，体是下一刀的事）。
 * `m` 是 `readAgg` / 顶层扫出来的那一格成员（shape === 'fn'），`ctx` 带东家：
 *   { owner: 'C' | null, self: '(ptr I1)' | null }
 * 拼不出来答 `{ head: null, why }`。
 */
export function fnHead(m, env, ctx = { owner: null, self: null }) {
  if (m === null || m === undefined || m.type === null) return { head: null, why: '没有类型' };
  const base = fnName(m, ctx.inProp === true);
  if (base === null) return { head: null, why: '没有名字' };
  const sfx = fnSuffixOf(m.type);
  if (sfx === null) {
    /* **reactor 不是一格普通函数**：旧降级给它发的是 `<名字>$start` / `$stop` 那两格
       （82-reactor.jnc / 162-oneventlist.jnc）—— 另一族，不在这一刀里。 */
    if (m.type.mods.includes('reactor')) {
      return { head: null, why: '反应器那一族（另发 $start / $stop）' };
    }
    return { head: null, why: '认不出形参表（没有 fn-suffix）' };
  }
  const fs = readFormals(sfx);
  if (fs === null) return { head: null, why: '形参表读不出来' };
  if (fs.some((f) => f.varargs)) return { head: null, why: '变参那一族（…）' };
  const parts = [];
  /* `static construct` 那一格也不在对象上（旧降级发的是 `(fn C$construct$static () void`）。 */
  const isStatic = m.storage.includes('static')
    || base === 'construct$static' || base.endsWith('$construct$static');
  /* `$this` 那一格看的是"有没有东家"，不是"写在类体里还是类外" —— 体外定义
     （`int C0.get(){…}`）一样带（127-outerget.jnc 的 `(fn C0$get (($this (ptr C0))) int`）。
     `ctx.self` 为空就是"没有东家"（顶层函数、命名空间里的函数、`static` 那一格）。 */
  if (ctx.self !== null && ctx.self !== undefined && !isStatic) {
    parts.push(`($this ${ctx.self})`);
  }
  /* 类那一族在方言里写的是**连通块的根**（`(ptr 根)`，第五十六刀的 clsRoot）——
     53-inherit.jnc 的 `pick(int, Dog*, Puppy*)` 旧降级发的是三格 `(ptr Animal)`。
     所以形参与返回都得带着这张"谁的根是谁"的表发。 */
  const tc = { clsRoot: ctx.clsRoot ?? ((n) => n) };
  for (const [i, f] of fs.entries()) {
    if (f.type === null) return { head: null, why: '形参的类型读不出来' };
    const r = resolveType(f.type, env);
    if (r.type === null) return { head: null, why: `形参 ${f.name ?? `$a${i}`}：${r.why}` };
    /* 没写名字的形参由这一层补 `$a<第几格>`（176-anonformal.jnc 的 `$a0`）。 */
    const pn = f.name === null ? `$a${i}` : (f.name === 'this' ? '$this' : f.name);
    parts.push(`(${pn} ${emitType(r.type, 'slot', tc)})`);
  }
  const ret = retText(m, base, env, tc);
  if (ret === null) return { head: null, why: '返回类型解不出来' };
  const sym = ctx.owner === null ? base : `${ctx.owner}$${base}`;
  const name = `${sym}${overloadSuffix(base, ctx.dup ?? 0)}`;
  return { head: `(fn ${name} (${parts.join(' ')}) ${ret}`, why: null };
}

/**
 * 返回类型（存储位置）。`construct` 那几格压根没写类型 —— 直接 void，不去查 `no-type`
 * （与 `resolveType` 里事件那一条同一个道理：没写的东西别拿去查表）。
 * 别的一格就是"把 `fn` 这个形状摘掉再解一遍"：`*` 的层数与 `[N]` 那几格后缀本来就长在
 * 返回类型上（`int make() [3]` 回的是 `int[3]` → `(ptr (blk int 3))`，20-array-value.jnc；
 * `Node* mk()` 回的是 `(ptr Node)` —— 类自己吞掉那一个 `*`，49-class.jnc）。
 */
function retText(m, base, env, tc) {
  /* 判据看的是**尾巴那一段**：体外定义的名字是点串（`Counter.construct` → `Counter$construct`），
     整串比会漏掉（50-construct.jnc 的 `Counter$construct$o1` 先前就落在这儿）。 */
  const leaf = base.includes('$') ? base.slice(base.lastIndexOf('$') + 1) : base;
  if (VOID_NAMES.has(base) || VOID_NAMES.has(leaf) || base.endsWith('$construct$static')) return 'void';
  /* **压根没写返回类型**就是 void（jancy 收这种写法：`show() { … }`、`set(int x)`）——
     旧降级发的正是 `(fn B$show (($this (ptr B))) void`（78-notype.jnc）与
     `(fn g_p$set ((x int)) void`（64-prop.jnc / 67-propauto.jnc / 156-propstruct.jnc）。
     与事件那一条同一个道理：**没写的东西别拿去查表**（那儿查出来的是 `no-type`）。 */
  if (m.type.base.kind === 'none') return 'void';
  const r = resolveType({ ...m.type, shape: 'data' }, env);
  if (r.type === null) return null;
  return emitType(r.type, 'slot', tc);
}
