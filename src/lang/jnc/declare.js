// src/lang/jnc/declare.js —— 按节点表读一个**声明符**（`dcl`）：名字、指针层数、后缀链、构造实参
//
// 这一份是"新读取器"：只靠节点表 + `named()` 的洞名，不碰位置索引，也不碰
// `frontend-jnc/lower.js` 里那段带着历史账的 `declarator`。两边并跑、逐格对账
// （`tests/lib/jnc-declare.js`），对得上才谈替换 —— 这样重写不必大爆炸（ADR-0030 第 3 节）。
//
// 读出来的是**结构化**的东西，不是字符串：
//   { name, ptrs, suffixes: [{kind, node}], ctor }

import { named, headOf } from './adapt.js';

/**
 * 左递归的列表：`X`（空基例）与 `X-add`（两格：list / one）走成一串。
 * **只对"空基例"那一族**（`mods` / `ptrs` / `suffixes` / `unit` —— 树里 0 格子项）。
 * 基例自己带一项的那一族（`dcls` / `enums` / `args` / `formals` / `items` / `exprs` /
 * `attrs` / `targs` / `qnames`，形状是 `(X 第一项)`）要用 `allInChain` —— 拿这一份走会
 * **把第一项丢掉**。这不是假想的坑：`readEnum` 头一版就是这么写的，584 个枚举各差一项。
 */
export function chainOf(node, addHead) {
  const out = [];
  let cur = node;
  while (cur !== null && cur !== undefined) {
    const h = headOf(cur);
    if (h === addHead) {
      const nm = named(cur);
      if (nm === null) break;
      out.unshift(nm.one);                      // 左递归：后来的在右边，倒着塞
      cur = nm.list;
      continue;
    }
    break;                                       // 到了空基例（`ptrs` / `suffixes`）
  }
  return out;
}

/**
 * 走**整条**左递归链：`add` 那几格 + 基例里带的那一格。
 * 基例形状是 `(X 第一项)` 的那一族（`dcls` / `enums` / `args` / `formals` / `items` /
 * `exprs` / `attrs` / `targs` / `qnames`）都用它。空基例那一族用 `chainOf` 就够
 * （它们的基例里没有洞，走过去也拿不出东西）。
 */
export function allInChain(node, addHead, baseHead) {
  const out = [];
  let cur = node;
  while (cur !== null && cur !== undefined) {
    const h = headOf(cur);
    if (h === addHead) {
      const nm = named(cur);
      if (nm === null) break;
      out.unshift(nm.one);
      cur = nm.list;
      continue;
    }
    if (h === baseHead) {
      const nm = named(cur);
      if (nm !== null && nm.first !== undefined) out.unshift(nm.first);
      break;
    }
    out.unshift(cur);                              // 光一个（没裹基例壳的那种写法）
    break;
  }
  return out;
}

/** 一个 `name` 节点的字面文本（`name` 裹着一格记号）。 */export function nameText(node) {
  if (headOf(node) !== 'name') return null;
  const nm = named(node);
  const t = nm === null ? undefined : nm.text;
  return t !== null && t !== undefined && t.value !== undefined ? String(t.value) : null;
}

/**
 * 读一个 `dcl`。读不了（形状不认得）答 `null` —— 调用方照旧走老路，于是能一族一族搬。
 */
export function readDcl(node) {
  const nm = named(node);
  if (nm === null || nm.kind !== 'dcl') return null;
  const ptrs = chainOf(nm.ptrs, 'ptrs-add');
  return {
    name: nameText(nm.name),
    nameNode: nm.name,
    /* **特名**那一族：`construct` / `destruct` / `operator +` 那几个不是 `name` 节点，
       而是 `(special "construct")`（node 表 :77）。名字那一格照旧只认 `name`（别的读取器
       与尺子都按它对账），特名单独一格照实带出来 —— 发函数头那一层要它（旧降级发的是
       `<东家>$construct`，86-multibase.jnc 的真输出）。 */
    special: specialText(nm.name),
    /* **算符**那一族的名字也不是 `name`：`(operator "++")` / `(postfix-operator "++")`
       （节点表 :141-142）。照实带出来（源码里那个算符 + 前/后置），拼成什么名字是发那一层的事。 */
    operator: operatorOf(nm.name),
    /* **属性的取/存**（`int m_val.get()` / `void m_val.set(int x)`）：名字写成
       `(qualified-special (name m_val) (accessor "get"))`（节点表 :89 与 :141 那一族）。
       照实读成两格 —— 拼成 `<属性名>$get` 是发那一层的事（旧降级的真输出是
       `C$m_val$get` / `C$m_val$set`，107-psetexpr.jnc）。 */
    accessor: accessorOf(nm.name),
    /* **裸写**的 `get` / `set`（名字前面什么都没写）：`(accessor "get")`。类体里带着体的
       那一种是**下标算符**（jancy 的 `c[10] = 100` 走 set，test90.jnc:12-24；旧降级发
       `Owner$op$index$get`，130-opindex.jnc）；只有原型的那一种是"体写在别处"
       （127-outerget.jnc 的 `int get();` + `int C0.get(){…}`）。两者形状同、意思不同，
       所以这一层只照实说"它是裸写的取/存"，判在发那一层。 */
    bareAccessor: bareAccessorOf(nm.name),
    ptrs: ptrs.length,
    /* **跟在 `*` 后面的修饰词**也要读出来（`ptr-group -> "*" mods`）：
       `Inner* property m_p;` 里的 `property` 就落在这儿，不在说明符表里 ——
       那是尺子逼出来的（108-propdot.jnc：不读它就把一格属性当了数据字段）。 */
    ptrMods: ptrs.flatMap((p) => modsOfPtr(p)),
    suffixes: chainOf(nm.suffixes, 'suffixes-add').map((s) => ({ kind: headOf(s), node: s })),
    ctor: headOf(nm.ctor) === 'ctor',
    raw: node,
  };
}

/** 特名（`(special "construct")`）的那个词；不是特名答 null。 */
function specialText(node) {
  if (headOf(node) !== 'special') return null;
  const nm = named(node);
  const t = nm === null ? undefined : nm.text;
  return t !== null && t !== undefined && t.value !== undefined ? String(t.value) : null;
}

/** 算符名：`(operator "++")` / `(postfix-operator "++")` → `{ op, postfix }`；不是算符答 null。 */
function operatorOf(node) {
  const h = headOf(node);
  if (h !== 'operator' && h !== 'postfix-operator') return null;
  const nm = named(node);
  const t = nm === null ? undefined : nm.op;
  const op = t !== null && t !== undefined && t.value !== undefined ? String(t.value) : null;
  return op === null ? null : { op, postfix: h === 'postfix-operator' };
}

/** 属性的取/存：`(qualified-special (name m_val) (accessor "get"))` → `{ path, which }`。 */
function accessorOf(node) {
  if (headOf(node) !== 'qualified-special') return null;
  const nm = named(node);
  if (nm === null) return null;
  const path = nameText(nm.left);
  const r = named(nm.right);
  const t = r === null ? undefined : r.text;
  const which = t !== null && t !== undefined && t.value !== undefined ? String(t.value) : null;
  return path === null || which === null ? null : { path, which };
}

/** 裸写的取/存：`(accessor "get")` → `'get'`；不是就 null。 */
function bareAccessorOf(node) {
  if (headOf(node) !== 'accessor') return null;
  const nm = named(node);
  const t = nm === null ? undefined : nm.text;
  return t !== null && t !== undefined && t.value !== undefined ? String(t.value) : null;
}

/** 一格 `ptr` 节点里那串修饰词（`(ptr mods)`）。 */
function modsOfPtr(p) {
  if (headOf(p) !== 'ptr') return [];
  const nm = named(p);
  if (nm === null) return [];
  return chainOf(nm.mods, 'mods-add')
    .map((m) => (m === null || m === undefined ? null : (m.value === undefined ? null : String(m.value))))
    .filter((w) => w !== null);
}
