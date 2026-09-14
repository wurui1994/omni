// src/lang/jnc/emit-global.js —— **顶层数据**那几行（`(global 名字 类型)`）
//
// 声明驱动的最后一片：聚合体发 `(struct …)`、函数发 `(fn …)`，顶层那几格数据发 `(global …)`。
// 名字与聚合体里同一条口径：命名空间只是前缀（`a$b$g_x`）；类型在**存储位置**
// （数组是 `(ptr (blk T N))`、结构体与类是 `(ptr S)`）。
//
// 编译器**生成**的那几格与聚合体里逐条同一条规则，只是东家换成了顶层那个名字：
//   - `autoget` / `bindable` 的存储叫 `m_value`（prop_autoget.rst:26）→ `<名字>$m_value`；
//   - `bindable` 多一格事件 `m_onChanged`（prop_bindable.rst:23-29）→ `<名字>$m_onChanged`，
//     类型是空签名的多播 `(arr (fnty () void))`；
//   - `reactor` 那一格生成两格 bool：`$on` / `$bound`；
//   - 完整声明式属性**体里**那几格字段落成 `<属性名>$<字段名>`。

import { headOf, named } from './adapt.js';
import { allInChain } from './declare.js';
import { readBodyMembers } from './agg.js';
import { resolveType } from './resolve-type.js';
import { emitType } from './emit-type.js';

/** 空签名的多播 —— `bindable` 生成的那格事件就是它。 */
const MC0 = { k: 'mc', params: [] };

/**
 * **取过地址就提一格**（第二十四刀）：模块级的标量被 `&` 取过时，那一格要提到一段自己的
 * 内存里去 —— 发的是 `(ptr T)`（外加一句 `pnew`，那是初始化那一遍的事）。
 * 能提的只有这几种（旧降级的 `liftable`，lower.js:3061）。
 */
const LIFTABLE = new Set(['int', 'real', 'bool', 'ptr', 'tptr', 'enum', 'class']);

/**
 * **提得动吗**（第九刀与第二十四刀共用这一条）：被 `&` 取过地址的名字要提到一段自己的内存上，
 * 提得动的只有上面那几种。结构体与数组**不在里头** —— 它们那一格里放的**本来就是**地址
 * （`&s` 一个字都不发）；别的（string / 函数值 / 多播）提不动。
 */
export function liftable(ty) {
  return ty !== null && ty !== undefined && LIFTABLE.has(ty.k);
}

/** 提上去那一格的类型：一格**指到它**的指针（局部量的单元与模块级那一格同一个写法）。 */
export function liftedType(ty, tc) {
  return lifted(ty, tc);
}

/** 提上去那一格的名字（`cellName`）：`名字$c`（`$` 不在 jancy 的标识符里，撞不上用户的名字）。 */
export function cellName(name) {
  return `${name}$c`;
}

/**
 * 整份源码里 `&名字` 取过的那些名字。属性生成的存储要多问一句 `m_value` —— 源码里写的是它。
 *
 * `retPtr` 为真时**多算一条**（第一百六十七刀）：`return entry;` 与 `return &entry;` 一样是
 * "地址逃出去了"，所以返回类型是**数据指针**的函数里，那一格也要提。只在那种函数上问，
 * 而且宁可多提一格 —— 多提只是多一次 `pnew`，漏提是**错答案**。
 */
export function addrTaken(trees, out = new Set(), retPtr = false) {
  const dig = (n) => {
    if (n === null || n === undefined || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'addr') {
      const a = named(n)?.a;
      if (a !== null && a !== undefined && Array.isArray(a.items) && headOf(a) === 'name') {
        const t = named(a)?.text;
        if (t !== null && t !== undefined && typeof t.value === 'string') out.add(t.value);
      }
    }
    if (retPtr === true && headOf(n) === 'return') {
      const v = named(n)?.value;
      if (v !== null && v !== undefined && Array.isArray(v.items) && headOf(v) === 'name') {
        const t = named(v)?.text;
        if (t !== null && t !== undefined && typeof t.value === 'string') out.add(t.value);
      }
    }
    for (const it of n.items) dig(it);
  };
  for (const t of (Array.isArray(trees) ? trees : [trees])) dig(t);
  return out;
}

/**
 * **长度没写、从花括号初值里数出来**的那一格数组（`static int m_table[] = { 10, 20, 12 };`
 * 发的是 `(ptr (blk int 3))`，183-staticcurly.jnc）。只对 `var-decl-curly` 那一格用 ——
 * 长度是常量表达式的那种（`int g_alpha['z' - 'a' + 1];`）不在这儿，那要常量折叠，记账。
 * 数不出来答 `null`。
 */
export function arrayFromCurly(m, env, initNode = null) {
  if (initNode === null && headOf(m.at) !== 'var-decl-curly') return null;
  /* `t.suffixes` 是一串**词**（`types.js` 里 `dc.suffixes.map((s) => s.kind)`），不是对象。 */
  const sfx = (m.type.suffixes ?? []).filter((x) => x === 'array-suffix');
  if (sfx.length !== 1) return null;
  /* 元素那一格：把**声明符**摘掉再解一遍 —— 长度是从 `raw.dcl` 上的后缀链读的
     （`resolveType` 的 `arrayDims`），光把 `suffixes` 清空不管用。 */
  const el = resolveType({ ...m.type, suffixes: [], raw: { specs: m.type.raw?.specs, dcl: null } }, env);
  if (el.type === null) return null;
  const init = initNode ?? named(m.at)?.value;
  if (headOf(init) !== 'curly') return null;
  const items = named(init)?.items;
  const n = items === null || items === undefined || !Array.isArray(items.items)
    ? 0 : chainCount(items);
  if (n === 0) return null;
  return { k: 'arr', el: el.type, n };
}

/**
 * `items` 那条链上**真有值**的项数。链是"基例带一项"那一族（`(items 第一项)` + `items-add`），
 * 所以要用 `allInChain` 摊平；摊出来的那几格里**没有头名的**（尾巴上那个逗号留下的空位）
 * 不算一项 —— 189-importcurly.jnc 与 196-localstruct.jnc 都是 `{ …, …, }` 这么写的。
 */
function chainCount(node) {
  return allInChain(node, 'items-add', 'items').filter((x) => {
    if (x === null || x === undefined) return false;                 // 尾巴上那个逗号留下的空位
    if (!Array.isArray(x.items)) return true;                        // 一格记号（`{ 1, 2, 3 }`）
    return x.items.length > 1;                                       // 空占位的 list 不算一项
  }).length;
}

/**
 * **`static construct` 那格一次性标志**：静态构造只跑一遍，标志就是那一格
 * （`(global C$construct$static$1 bool)`，50-construct.jnc / 193-staticctorns.jnc）。
 * `agg` 是聚合体的全名。
 */
export function staticCtorFlag(agg) {
  return `(global ${agg}$construct$static$1 bool)`;
}

/**
 * **函数里的 `static`**（第二十六刀）：那一格是**模块级**的内存
 * （decl_storage.rst："allocated at the program start"），名字是**源码里那个名字** +
 * `$s<临时号>`（`n$s0` / `v$s1` / `c$s2`，25-static-local.jnc）——不带函数名前缀。
 *
 * 闸门的判据是**"这一格要不要初始化一次"**：写了初值，或类型是类（一定要 new 一格）、
 * 或带构造的结构体。jancy 就地把初值包在 `once` 里（jnc_ct_Parser.cpp:2452），
 * 初值空着又不用构造就不包、也就没有闸门（同处 2454）。
 * `static Counter c;` 一个字的初值都没写，可旧降级照样发 `c$s0$1`（138-staticclass.jnc）。
 *
 * `idx` 是共用的临时号（与 `$newoN`、`jnc$once$N` 同一个计数器）。
 */
export function staticLocalLines(m, env, ctx = { idx: 0, hasInit: false }) {
  if (m === null || m === undefined || m.name === null) return { lines: [], why: '没有名字' };
  let rt = resolveType(m.type, env).type;
  if (rt === null) rt = arrayFromCurly(m, env);                      // 长度从花括号初值里数
  if (rt === null) return { lines: [], why: resolveType(m.type, env).why };
  const tc = { clsRoot: ctx.clsRoot ?? ((n) => n) };
  const base = `${m.name}$s${ctx.idx}`;
  /* **取过地址就提一格**：静态局部量与模块级变量同一条（`&c` 让 `c$s2` 成了 `(ptr int)`）。 */
  const taken = ctx.taken ?? new Set();
  const box = taken.has(m.name) && LIFTABLE.has(rt.k);
  const lines = [`(global ${base} ${box ? lifted(rt, tc) : emitType(rt, 'slot', tc)})`];
  const needsOnce = ctx.hasInit || rt.k === 'class'
    || (rt.k === 'struct' && (ctx.hasCtor ?? false));
  if (needsOnce) lines.push(`(global ${base}$1 bool)`);
  return { lines, why: null };
}

/** 带上命名空间前缀的全名。 */
function fullName(name, ns) {
  return ns === null || ns === undefined || ns === '' ? name : `${ns}$${name}`;
}

/** 提一格之后的类型文本（`int` → `(ptr int)`、`int*` → `(ptr (ptr int))`）。 */
function lifted(ty, tc) {
  return `(ptr ${emitType(ty, 'value', tc)})`;
}

/**
 * 一格顶层声明发出来的那几行 `(global …)`。
 * `m` 是顶层扫出来的那一格（`{ name, shape, type, at, storage }`，与聚合体的成员同一种记录），
 * `ctx.ns` 是命名空间前缀。拼不出来答 `{ lines: [], why }`。
 */
export function globalLines(m, env, ctx = { ns: null }) {
  if (m === null || m === undefined || m.name === null || m.type === null || m.type === undefined) {
    return { lines: [], why: '没有名字' };
  }
  const full = fullName(m.name, ctx.ns);
  const mods = m.type.mods ?? [];
  const tc = { clsRoot: ctx.clsRoot ?? ((n) => n) };
  const taken = ctx.taken ?? new Set();

  /* **reactor**：无论有没有体都生成两格 bool（与聚合体里那一条同一条）。 */
  if (mods.includes('reactor')) {
    return { lines: [`(global ${full}$on bool)`, `(global ${full}$bound bool)`], why: null };
  }

  /* **属性**（写了 `property`）：生成的存储 + 体里那几格字段。 */
  if (m.shape === 'prop') {
    const lines = [];
    if (mods.includes('autoget') || mods.includes('bindable')) {
      if (m.type.base.kind === 'none') return { lines: [], why: '属性没写类型（类型在取值器上）' };
      const r = resolveType({ ...m.type, shape: 'data' }, env);
      if (r.type === null) return { lines: [], why: `生成的存储：${r.why}` };
      /* 顶层这一格是**模块级变量**，所以类型在**存储位置**（类里那一格是字段位置）——
         `variant_t` 于是是 `(ptr jnc$variant)`（150-variantautoget.jnc）。
         `&` 数的是**源码里写的**名字，而源码里写的是 `m_value`（prop_autoget.rst:26），
         所以两个名字都问一遍（67-propauto.jnc 的四格全是提过的）。 */
      const box = (taken.has(m.name) || taken.has('m_value')) && LIFTABLE.has(r.type.k);
      lines.push(`(global ${full}$m_value ${box ? lifted(r.type, tc) : emitType(r.type, 'slot', tc)})`);
    }
    if (mods.includes('bindable')) {
      lines.push(`(global ${full}$m_onChanged ${emitType(MC0, 'value')})`);
    }
    /* 体里那几格**字段**（`property g_p { int m_v; … }` → `g_p$m_v`）。取/存那几格是函数、
       `alias` / `typedef` 不是字段，都不在这儿。 */
    const body = named(m.at)?.body;
    if (headOf(body) === 'compound') {
      for (const im of readBodyMembers(body)) {
        if (im.name === null) continue;
        /* 体里那格**事件**（`bindable event m_e();`，73-propfullauto.jnc）：名字是写的人定的，
           发的是 `<属性名>$<那个名字>`，类型是多播。 */
        if (im.shape === 'event') {
          const er = resolveType(im.type, env);
          if (er.type === null) return { lines: [], why: `体里的事件 ${im.name}：${er.why}` };
          lines.push(`(global ${full}$${im.name} ${emitType(er.type, 'value', tc)})`);
          continue;
        }
        if (im.shape !== 'data' && im.shape !== 'array' && im.shape !== 'fnptr') continue;
        const ir = resolveType(im.type, env);
        if (ir.type === null) return { lines: [], why: `体里的字段 ${im.name}：${ir.why}` };
        const ibox = taken.has(im.name) && LIFTABLE.has(ir.type.k);
        lines.push(`(global ${full}$${im.name} `
          + `${ibox ? lifted(ir.type, tc) : emitType(ir.type, 'slot', tc)})`);
      }
    }
    /* 不带 `autoget`/`bindable`、体里也没有字段的那种属性**本来就不发存储**（取/存两格
       都是写出来的函数，那是函数那条腿的事）—— 这是**对的行为**，不是还没做。 */
    if (lines.length === 0) return { lines: [], why: '这格属性不生成存储（对的行为）' };
    return { lines, why: null };
  }

  /* **顶层的事件**（`event g_onA();`）是一格模块级的多播：`(arr (fnty (…) void))`
     （162-oneventlist.jnc）。它就是一格数据，只是类型在事件那一条路上解。 */
  if (m.shape === 'event') {
    const r = resolveType(m.type, env);
    if (r.type === null) return { lines: [], why: `事件：${r.why}` };
    return { lines: [`(global ${full} ${emitType(r.type, 'value', tc)})`], why: null };
  }
  /* 函数那一族（前向声明 `int isOdd(int);` 在树上也是 `var-decl`，形状是 `fn`）**本来就不发**
     `(global …)` —— 那是函数那条腿的事。别的形状（typedef / 位域…）同理。 */
  if (m.shape !== 'data' && m.shape !== 'array' && m.shape !== 'fnptr') {
    return { lines: [], why: `不是数据那一族（${m.shape}）（对的行为）` };
  }

  /* **bindable 数据**：整格是生成的属性 —— 自己那一格不发，发的是存储与事件。 */
  if (mods.includes('bindable')) {
    const r = resolveType({ ...m.type, shape: 'data' }, env);
    if (r.type === null) return { lines: [], why: `生成的存储：${r.why}` };
    const box = (taken.has(m.name) || taken.has('m_value')) && LIFTABLE.has(r.type.k);
    return {
      lines: [
        `(global ${full}$m_value ${box ? lifted(r.type, tc) : emitType(r.type, 'slot', tc)})`,
        `(global ${full}$m_onChanged ${emitType(MC0, 'value')})`,
      ],
      why: null,
    };
  }

  let rt = resolveType(m.type, env).type;
  if (rt === null) rt = arrayFromCurly(m, env);                      // 长度从花括号初值里数
  if (rt === null) return { lines: [], why: resolveType(m.type, env).why };
  const r = { type: rt };
  const box = taken.has(m.name) && LIFTABLE.has(r.type.k);
  return {
    lines: [`(global ${full} ${box ? lifted(r.type, tc) : emitType(r.type, 'slot', tc)})`],
    why: null,
  };
}
