// src/lang/jnc/emit-type.js —— 类型往方言那一侧发：**三个位置一张表**
//
// 旧的降级里这是三个函数（`frontend-jnc/lower.js:832-879`）：
//   `tyText`     值位置（一格变量/实参/返回值里放什么）
//   `slotText`   存储位置（结构体是**一段内存**，所以那一格里放 `(ptr S)`）
//   `fieldText`  字段位置（结构体内嵌写 `S`、数组内嵌写 `(blk T N)`）
// 三个函数彼此只差几格，差在哪儿是隐式的。这一份把它写成**一张三栏的表**：一行一种类型，
// 三栏是三个位置。于是"结构体在哪一格怎么写"这件事能一眼看完，也能被尺子逐格对。
//
// 期望不是我编的：尺子拿**旧降级的真输出**当外部尺（`node src/cli.js emit sx x.jnc`），
// 一行一行对（tests/lib/jnc-emit-type.js）。

/** 数组的**块**写法（`(blk T N)`，元素是数组就递归 —— 多维）。 */
export function blkText(t) {
  const el = t.el.k === 'arr' ? blkText(t.el) : emitType(t.el, 'value');
  return `(blk ${el} ${t.n})`;
}

/**
 * 三栏表。每格是一个函数（类型对象 → 方言写法），`null` 表示"这一格与值位置同写法"。
 * 键是旧降级里那个 `t.k`（int / enum / struct / class / ptr / tptr / arr / fnptr / mc）。
 */
export const TY_TABLE = {
  int: { value: () => 'int', slot: null, field: null },
  // 枚举在方言里就是它的基整数（第三十九刀）
  enum: { value: () => 'int', slot: null, field: null },
  bool: { value: () => 'bool', slot: null, field: null },
  real: { value: () => 'real', slot: null, field: null },
  void: { value: () => 'void', slot: null, field: null },
  string: { value: () => 'string', slot: null, field: null },
  // 结构体：值位置是名字；**存储**位置是一段内存的地址；字段位置内嵌，还是名字
  struct: { value: (t) => t.name, slot: (t) => `(ptr ${t.name})`, field: null },
  // 类是一条引用（第五十二刀），一整条继承链共用一格结构体（第五十六刀，`clsRoot`）
  class: { value: (t, ctx) => `(ptr ${ctx.clsRoot(t.name)})`, slot: null, field: null },
  // `T(*)[N]`（第二十刀）：指向一整块与那块自己在方言里是同一个写法
  ptr: {
    value: (t) => (t.target.k === 'arr' ? `(ptr ${blkText(t.target)})` : `(ptr ${emitType(t.target, 'value')})`),
    slot: null,
    field: null,
  },
  tptr: { value: (t) => `(tptr ${emitType(t.target, 'value')})`, slot: null, field: null },
  // 数组**变量**里放的是块地址；**字段**是内嵌的那 N 格
  arr: { value: (t) => `(ptr ${blkText(t)})`, slot: null, field: (t) => blkText(t) },
  // 函数指针就是方言的函数值那一格（第五十五刀）
  fnptr: {
    value: (t) => `(fnty (${t.params.map((p) => emitType(p, 'slot')).join(' ')}) ${emitType(t.ret, 'slot')})`,
    slot: null,
    field: null,
  },
  // 多播（第七十三刀）：元素是函数值的数组
  mc: {
    value: (t) => `(arr (fnty (${t.params.map((p) => emitType(p, 'slot')).join(' ')}) void))`,
    slot: null,
    field: null,
  },
};

/** 默认的"继承链根"：不给就用名字自己（尺子里的单继承例子够用）。 */
const DEFAULT_CTX = { clsRoot: (n) => n };

/**
 * 按位置发一格类型。`pos` ∈ 'value' | 'slot' | 'field'。
 * 表里没有这一格就退回 `t.k`（与旧降级最后那一行同一个兜底）。
 */
export function emitType(t, pos = 'value', ctx = DEFAULT_CTX) {
  if (t === null || t === undefined) return '';
  const row = TY_TABLE[t.k];
  if (row === undefined) return String(t.k);
  const cell = row[pos] ?? row.value;
  return cell(t, ctx);
}

/**
 * **这一格类型在 jancy 那一侧的身份**（第五十八刀）。与 `emitType` 是两件事：那一格答的是
 * "方言里怎么写"，而方言里 `enum Code` 与 `int` 写出来是**同一个字**、一条继承链上的几格类
 * 写出来是**同一个根** —— 拿它比"两条重载的实参签名是否一样"就会把 `q(int)` 与 `q(Code)`
 * 并成一格（135-overloadcheap.jnc 量的正是这一格）。所以身份要按类型记录自己的种类与名字算。
 */
export function tyKey(t) {
  if (t === null || t === undefined) return '?';
  if (t.k === 'int') return `int${t.w ?? 32}${t.u === true ? 'u' : ''}`;
  if (t.k === 'ptr' || t.k === 'tptr') return `ptr(${tyKey(t.target)})`;
  if (t.k === 'arr') return `arr(${tyKey(t.el)},${t.n})`;
  if (t.k === 'fnptr') return `fn(${(t.params ?? []).map(tyKey).join(',')})${tyKey(t.ret)}`;
  if (t.k === 'struct' || t.k === 'class' || t.k === 'enum') return `${t.k}:${t.name}`;
  return String(t.k);
}
