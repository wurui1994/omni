// src/lang/jnc/resolve-type.js —— 把**写法**上的类型（syntactic）解成**类型对象**
//
// `types.js` 读出来的是写法：基类型那一格的文本 + 修饰词 + `*` 层数 + 后缀链。
// 要发给方言还差一步：那个名字到底是结构体、类还是枚举？`int` 在方言里是几号？
// 这一份就干这一步，靠两张表 + 一份环境（名字 → 那是什么）：
//
//   WORD_TYPES   关键字 → 方言那一侧的种类（`int`/`char`/`short`… 在这一层都是 int）
//   env          名字 → { kind: 'struct' | 'class' | 'enum' | 'typedef', name, to? }
//
// 解不出来的**不猜**：答 `null`，调用方记账。那是这一层唯一诚实的答法。

import { evalConst } from './const-eval.js';

/** 关键字基类型 → 类型对象（出处：`frontend-jnc/lower.js` 的 tyText 与四种位宽都发 int）。 */
export const WORD_TYPES = {
  int: { k: 'int' }, char: { k: 'int' }, short: { k: 'int' }, long: { k: 'int' },
  intptr: { k: 'int' }, bool: { k: 'bool' }, float: { k: 'real' }, double: { k: 'real' },
  void: { k: 'void' },
};

/**
 * 整数那一族的**底宽**（位）。方言里它们一律是 `int`，宽度只在两处要用：
 * 位域怎么挤成一格（见 `emit-agg.js` 那条规则）、以后的截断规则。
 * 出处：jancy 的 `setupStdTypedef`（`jnc_ct_TypeMgr.cpp:1759-1782`）与那几个关键字的 TypeKind。
 */
export const INT_BITS = {
  char: 8, short: 16, int: 32, long: 64, intptr: 64,
  int8_t: 8, uint8_t: 8, utf8_t: 8, uchar_t: 8, byte_t: 8,
  int16_t: 16, uint16_t: 16, utf16_t: 16, ushort_t: 16, word_t: 16,
  int32_t: 32, uint32_t: 32, utf32_t: 32, dword_t: 32, uint_t: 32,
  int64_t: 64, uint64_t: 64, ulong_t: 64, qword_t: 64,
  size_t: 64, intptr_t: 64, uintptr_t: 64,
};


/** 标准 typedef 里"整数那一族"（`size_t` / `uint8_t` …）—— 方言里都是 int。 */
export const STD_INT_TYPEDEFS = new Set([
  'uint_t', 'intptr_t', 'uintptr_t', 'size_t', 'int8_t', 'utf8_t', 'uint8_t', 'uchar_t',
  'byte_t', 'int16_t', 'utf16_t', 'uint16_t', 'ushort_t', 'word_t', 'int32_t', 'utf32_t',
  'uint32_t', 'dword_t', 'int64_t', 'uint64_t', 'ulong_t', 'qword_t',
]);

/**
 * 解一格类型。`t` 是 `readDeclType` 的结果，`env` 是"名字 → 那是什么"。
 * 答 `{ type, why }`：解出来 `type` 是类型对象、`why` 为 null；解不出来 `type` 为 null、
 * `why` 说卡在哪一格（记账用）。
 */
export function resolveType(t, env = new Map(), depth = 0) {
  if (t === null || t === undefined) return { type: null, why: '没有类型' };
  if (depth > 8) return { type: null, why: 'typedef 绕回来了（深度上限）' };
  /* 事件那一格**没有基类型**（`event m_onClick(int code);` 压根没写类型，回的永远是 void），
     所以别拿它去查基类型 —— 先前查了，`no-type` 就把整格挡在这一行（尺子上是
     `m_onClick: 认不出基类型 'no-type'`），下面那条事件规则压根走不到。 */
  const base = t.shape === 'event' ? { k: 'void' } : baseOf(t, env, depth);
  if (base === null) return { type: null, why: `认不出基类型 '${t.base.text || '(空)'}'` };
  if (t.shape === 'fnptr') {
    /* 函数指针（`int function* m_op(int, int)` → `(fnty (int int) int)`）：
       返回类型是基类型加上**除掉函数指针自己那一个 `*`** 的层数，形参从 fn-suffix 的
       形参表里一格一格解。解不动一格就整格记账（不猜）。 */
    const fn = fnParts(t, env);
    if (fn === null) return { type: null, why: '函数指针的形参/返回还解不出来' };
    return { type: fn, why: null };
  }
  if (t.shape === 'event') {
    /* 事件那一格在方言里是**元素是函数值的数组**（多播，第七十三刀）：
       `event m_onAny()` → `(arr (fnty () void))`（142-propalias.jnc）。 */
    /* 事件**不看基类型**（`event m_onClick(int code);` 压根没写类型，回的永远是 void）——
       只要形参。先前套用函数指针那条路，于是 `no-type` 把整格挡下了（80-class-event.jnc）。 */
    const ps = eventParams(t, env);
    if (ps === null) return { type: null, why: '事件的形参还解不出来' };
    return { type: { k: 'mc', params: ps }, why: null };
  }
  if (t.shape === 'fn') return { type: null, why: '函数那一族（fn）' };
  if (t.shape === 'prop' || t.shape === 'event') return { type: null, why: `属性/事件（${t.shape}）` };
  if (t.shape === 'bitfield') return { type: null, why: '位域' };

  /* **`*` 先套、数组后套** —— 声明符的读法就是这个次序：`C* m_items[3]` 是"C* 的数组"，
     不是"数组的指针"。先前反着写，尺子上就是 `(ptr (blk (ptr C) 3))` 对 `(blk (ptr C) 3)`。
     类那一族**吞掉一个 `*`**：jancy 里"是指针的就得看着像指针"，一格类变量写成 `C*`，
     而它在方言里本来就是 `(ptr 根)`（第五十二刀）。少这一条，`Node* m_next` 会多一层。 */
  let el = base;
  /* 类与**函数类型**那两族吞掉一个 `*`（`C* p` / `Fn* m_f` 里那一个星号是它们自己的形状）。 */
  const stars = base.k === 'class' || base.k === 'fnptr' ? Math.max(t.ptrs - 1, 0) : t.ptrs;
  for (let i = 0; i < stars; i += 1) el = { k: 'ptr', target: el };

  /* 多维数组按**源码次序**读长度（`int m_grid[2][3]` 是 [2,3]），从里往外套：
     元素是 `(blk int 3)`、整格是 `(blk (blk int 3) 2)`。先前每一维都取"第一格后缀"的长度，
     于是两维都成了 3 —— 尺子一次就抓出来。 */
  const dims = arrayDims(t, env);
  if (dims === null) return { type: null, why: '数组长度不是字面量' };
  for (let i = dims.length - 1; i >= 0; i -= 1) el = { k: 'arr', el, n: dims[i] };
  return { type: el, why: null };
}

/** 基类型那一格。 */
function baseOf(t, env, depth = 0) {
  const text = t.base.text;
  if (t.base.kind === 'word' || WORD_TYPES[text] !== undefined) {
    return WORD_TYPES[text] ?? null;
  }
  if (t.base.kind === 'named' || t.base.kind === 'generic') {
    const name = nameText(t);
    if (name === null) return null;
    if (STD_INT_TYPEDEFS.has(name)) return { k: 'int' };
    if (name === 'string_t') return { k: 'string' };
    /* `variant_t` 在方言里是一格**固定形状的结构体** `jnc$variant`
       （`($t int) ($n int) ($r real) ($s string)`，第一百一十三刀）—— 出处是旧降级的真输出
       （105-variant.jnc）。字段位置写它的名字，与别的结构体同一条规矩。 */
    if (name === 'variant_t') return { k: 'struct', name: 'jnc$variant' };
    const e = env.get(name);
    if (e === undefined) return null;
    /* 用**环境里记的名字**，不是源码里那个 —— 嵌套类型在方言那一侧叫 `Outer$Inner`。
       先前这儿写的是源码名，尺子上就是 `Outer.m_in：旧 Outer$Inner / 新 Inner`。 */
    const emitName = e.name ?? name;
    if (e.kind === 'struct' || e.kind === 'union') return { k: 'struct', name: emitName };
    if (e.kind === 'class') return { k: 'class', name: emitName };
    if (e.kind === 'enum') return { k: 'enum', name: emitName };
    /* **typedef 再走一跳**：`typedef int X; X m_v;` 里 `X` 的目标类型就是它的写法，
       接着解一遍（带深度上限防环）。少这一跳，typedef / alias 那一摊十几个聚合体
       全拼不出来（尺子的"拼不出来的那几处"里几乎全是它）。 */
    /* **alias 类型别名**（`alias State = iox.SshChannel.State;`，第八十七刀）：环境里记的是
       "它指向哪个名字"，顺着再查一跳（与 typedef 同族，jancy 里两者都是存储类）。 */
    if (e.kind === 'alias' && typeof e.to === 'string') {
      const inner = env.get(e.to);
      if (inner === undefined || depth > 8) return null;
      return aliasBase(inner, e.to, env, depth);
    }
    if (e.kind === 'typedef' && e.type !== undefined) {
      /* **函数类型的 typedef**（`typedef Num Fn(int a, int b);`）：它本身是一格函数类型，
         字段写 `Fn* m_f;` 发的是 `(fnty (int int) int)`（116-structtypedef.jnc）——
         那一个 `*` 是函数指针自己的，所以下面 `stars` 那儿要吞掉一个。 */
      if (e.type.shape === 'fn') {
        const inner = fnParts({ ...e.type, ptrs: e.type.ptrs + 1, shape: 'fnptr' }, env);
        return inner;
      }
      const r = resolveType(e.type, env, depth + 1);
      return r.type;
    }
    return null;
  }
  return null;
}

/** 基类型是个名字时，那个名字的文本（`readDeclType` 只留了头名，名字在原树上）。 */
function nameText(t) {
  const specs = t.raw?.specs;
  if (specs === null || specs === undefined || !Array.isArray(specs.items)) return null;
  return firstIdent(specs.items[1]);                 // `(specs 类型 前 后)` 的第一格
}

/** 往下找第一个标识符记号。 */
function firstIdent(n) {
  if (n === null || n === undefined || typeof n !== 'object') return null;
  if (!Array.isArray(n.items)) return typeof n.value === 'string' ? n.value : null;
  for (const it of n.items.slice(1)) {
    const s = firstIdent(it);
    if (s !== null) return s;
  }
  return null;
}

/** alias 指向的那一格（名字已经查着了，直接按它的种类答）。 */
function aliasBase(e, name, env, depth) {
  if (e.kind === 'struct' || e.kind === 'union') return { k: 'struct', name: e.name ?? name };
  if (e.kind === 'class') return { k: 'class', name: e.name ?? name };
  if (e.kind === 'enum') return { k: 'enum', name: e.name ?? name };
  if (e.kind === 'typedef' && e.type !== undefined) {
    const r = resolveType(e.type, env, depth + 1);
    return r.type;
  }
  if (e.kind === 'alias' && typeof e.to === 'string') {
    const nxt = env.get(e.to);
    return nxt === undefined || depth > 8 ? null : aliasBase(nxt, e.to, env, depth + 1);
  }
  return null;
}

/** 基类型是整数那一族时的**底宽**（位）；不是整数或认不出答 null。 */export function baseIntBits(t) {
  if (t === null || t === undefined) return null;
  const w = t.base.kind === 'word' ? t.base.text : nameText(t);
  if (w === null || w === undefined) return null;
  return INT_BITS[w] ?? null;
}

/** 位域那一格占几位（`uint8_t m_a : 4` 答 4）；不是位域答 null。 */
export function bitfieldBits(t) {
  const dcl = t?.raw?.dcl;
  if (dcl === null || dcl === undefined || !Array.isArray(dcl.items)) return null;
  for (const s of suffixChain(dcl.items[3])) {
    if (s?.items?.[0]?.value !== 'bitfield') continue;
    const n = Number(s.items[1]?.value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** 数组每一维的长度，**按源码次序**（`int m_grid[2][3]` 答 `[2, 3]`）。有一维不是字面量答 null。 */
function arrayDims(t, env) {
  const dcl = t.raw?.dcl;
  if (dcl === null || dcl === undefined || !Array.isArray(dcl.items)) return [];
  const out = [];
  for (const s of suffixChain(dcl.items[3])) {
    if (s?.items?.[0]?.value !== 'array-suffix') continue;
    /* 长度不一定是字面量：`m_pad[ReportSize - 1]` / `m_actionTable[ActionId._Count]` 那一族
       要算一格常量表达式（`const-eval.js`，枚举项从环境来）。算不出来才记账。 */
    const n = evalConst(s.items[1], env);
    if (n === null || !Number.isInteger(n) || n < 0) return null;
    out.push(n);
  }
  return out;
}

/**
 * 函数指针那一格：`{ k:'fnptr', params, ret }`。
 * 返回类型 = 基类型 + （`*` 层数 − 1）（那一个 `*` 是函数指针自己的）；
 * 形参从 fn-suffix 的形参表一格一格解（无名形参就是"说明符 + `*`"那种形状）。
 */
function fnParts(t, env) {
  const base = baseOf(t, env);
  if (base === null) return null;
  let ret = base;
  for (let i = 0; i < Math.max(t.ptrs - 1, 0); i += 1) ret = { k: 'ptr', target: ret };
  const fnSuffix = suffixChain(t.raw?.dcl?.items?.[3]).find((s) => s?.items?.[0]?.value === 'fn-suffix');
  if (fnSuffix === undefined) return null;
  const params = [];
  for (const f of formalList(fnSuffix.items[1])) {
    const p = formalType(f, env);
    if (p === null) return null;
    params.push(p);
  }
  return { k: 'fnptr', params, ret };
}

/** 事件那一格的形参（不看基类型）。 */
function eventParams(t, env) {
  const fnSuffix = suffixChain(t.raw?.dcl?.items?.[3]).find((s) => s?.items?.[0]?.value === 'fn-suffix');
  if (fnSuffix === undefined) return null;
  const out = [];
  for (const f of formalList(fnSuffix.items[1])) {
    const p = formalType(f, env);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

/** 形参表里的每一格（`formals` / `formals-add` / `formals-varargs`，按源码次序）。 */
function formalList(node) {
  const out = [];
  let cur = node;
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    const h = cur.items[0]?.value;
    if (h === 'formals-add') { out.unshift(cur.items[2]); cur = cur.items[1]; continue; }
    if (h === 'formals') { if (cur.items.length > 1) out.unshift(cur.items[1]); break; }
    if (h === 'formals-varargs') { cur = cur.items[1]; continue; }
    break;
  }
  return out;
}

/** 一格形参的类型（`formal specs dcl` / `formal-anon specs ptrs`）。 */
function formalType(f, env) {
  const h = f?.items?.[0]?.value;
  if (h === 'formal') {
    const t = { base: null };
    void t;
    const syn = { specs: f.items[1], dcl: f.items[2] };
    return resolveSyn(syn, env);
  }
  if (h === 'formal-anon') {
    return resolveSyn({ specs: f.items[1], ptrs: f.items[2] }, env);
  }
  return null;
}

/** 拿一格"说明符 + 声明符/`*` 串"当类型解（形参那一族用）。 */
function resolveSyn(syn, env) {
  const specsHead = syn.specs?.items?.[1];
  const kindOf = specsHead === null || specsHead === undefined ? 'none'
    : (typeof specsHead.value === 'string' && !Array.isArray(specsHead.items) ? 'word' : 'named');
  const text = kindOf === 'word' ? String(specsHead.value) : (specsHead?.items?.[0]?.value ?? '');
  let ptrs = 0;
  if (syn.dcl !== undefined) {
    let cur = syn.dcl.items?.[1];
    while (cur !== null && cur !== undefined && cur.items?.[0]?.value === 'ptrs-add') { ptrs += 1; cur = cur.items[1]; }
  } else {
    let cur = syn.ptrs;
    while (cur !== null && cur !== undefined && cur.items?.[0]?.value === 'ptrs-add') { ptrs += 1; cur = cur.items[1]; }
  }
  const t = {
    base: { kind: kindOf, text },
    mods: [],
    ptrs,
    suffixes: [],
    shape: 'data',
    raw: { specs: syn.specs, dcl: syn.dcl },
  };
  const r = resolveType(t, env);
  return r.type;
}

/** 后缀链上的每一格，**按源码次序**（左递归链倒着塞）。这一层按位置走，省一次循环依赖。 */function suffixChain(chain) {
  const out = [];
  let cur = chain;
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    if (cur.items[0]?.value !== 'suffixes-add') break;
    out.unshift(cur.items[2]);
    cur = cur.items[1];
  }
  return out;
}
