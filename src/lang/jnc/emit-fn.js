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
import { readDeclType } from './types.js';
import { nameText, allInChain, readDcl } from './declare.js';
import { headOf, named } from './adapt.js';

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
      out.push({ name: t === null ? nameText(named(fn.dcl)?.name) : t.name, type: t, varargs: false });
      continue;
    }
    if (h === 'formal-anon') {
      /* 只写类型不写名字（`void f(int);`）—— 名字这一格是 null，类型照读
         （`formal-anon` 的洞是 specs + ptrs，没有 dcl）。 */
      out.push({ name: null, type: readDeclType(fn.specs, null), varargs: false });
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
export function fnName(m) {
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
  /* **裸写**的 `get` / `set`：带着体的那一种是下标算符 `op$index$get` / `$set`
     （130-opindex.jnc 的 `Box$op$index$get`）；只有原型的那一种体写在别处
     （127-outerget.jnc），这一格不发 —— 那一族要等"体外定义"那一刀。 */
  if (dc.bareAccessor !== null) {
    return headOf(m.at) === 'fn-def' ? `op$index$${dc.bareAccessor}` : null;
  }
  /* **体外定义**：点串名字整串用 `$` 接起来（`C1.p.get` → `C1$p$get`，127-outerget.jnc）。 */
  if (dc.path !== null) {
    const leaf = leafName(dc.path.leaf);
    return leaf === null ? null : [...dc.path.segs, leaf].join('$');
  }
  return null;
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
  const base = fnName(m);
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
  for (const f of fs) {
    if (f.type === null) return { head: null, why: '形参的类型读不出来' };
    if (f.name === null) return { head: null, why: '形参没有名字（记账）' };
    const r = resolveType(f.type, env);
    if (r.type === null) return { head: null, why: `形参 ${f.name}：${r.why}` };
    parts.push(`(${f.name === 'this' ? '$this' : f.name} ${emitType(r.type, 'slot', tc)})`);
  }
  const ret = retText(m, base, env, tc);
  if (ret === null) return { head: null, why: '返回类型解不出来' };
  const sym = ctx.owner === null ? base : `${ctx.owner}$${base}`;
  const dup = ctx.dup ?? 0;
  const name = dup > 0 ? `${sym}$o${dup}` : sym;
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
