// Omni stage0 — 类型、类型键、隐式转换图
// 隐式转换来自 Asymptote：一张有代价的转换图，重载解析按总代价择优。

export const INT = { k: 'int' };
export const REAL = { k: 'real' };
export const BOOL = { k: 'bool' };
export const STRING = { k: 'string' };
export const VOID = { k: 'void' };
/** 动态值域；`json` 是它的可序列化子集（ADR-0006），不是独立类型 */
export const DYNAMIC = { k: 'dynamic' };
/** `null` 字面量的类型，可赋给 class 引用与 dynamic */
export const NULLT = { k: 'null' };

export const BUILTINS = {
  int: INT, real: REAL, bool: BOOL, string: STRING, void: VOID,
  dynamic: DYNAMIC, json: DYNAMIC,
};

export function structType(name, fields) { return { k: 'struct', name, fields }; }
export function classType(name, fields) { return { k: 'class', name, fields }; }
/**
 * tagged union（ADR-0012）。`variants` 是有序的 `{name, fields}`，下标就是运行期标签值 ——
 * 顺序是声明顺序，所以标签是源码里看得见的东西，不依赖任何哈希。
 */
export function enumType(name, variants) { return { k: 'enum', name, variants }; }
export function listType(elem) { return { k: 'list', elem }; }
export function dictType(key, val) { return { k: 'dict', key, val }; }
export function setType(elem) { return { k: 'set', elem }; }
/**
 * 函数值类型（ADR-0010）。只有签名，没有参数名 —— 参数名属于 lambda，不属于类型，
 * 否则 `fn(int a)->int` 和 `fn(int b)->int` 会是两个类型。
 */
export function fnType(params, ret) { return { k: 'fn', params, ret }; }
/**
 * 定长向量（ADR-0014 决策 6 / 门槛 6）。`elem` 只能是 int 或 real，`lanes` 是 2 的幂。
 *
 * 为什么它必须出现在 **OIR** 而不只是 MIR：C 后端与 JS 后端消费的是 OIR，MIR 只喂
 * LLVM 与 MIR 解释器。门槛 6 要的「LLVM 向量路径 == C 标量化路径逐位相同」
 * 因此两层都得有它 —— 只放 MIR 的话 C 那条腿根本看不见向量，比对无从谈起。
 *
 * 值语义（赋值即拷贝，同 struct）：向量是一串数，不是对象。所以 isRef 里没有它。
 */
export function vecType(elem, lanes) { return { k: 'vec', elem, lanes }; }
/**
 * 缓冲（ADR-0014 门槛 7 的第一阶段）。`elem` 只能是 int 或 real，长度是**运行期**的。
 *
 * 为什么不用 `list<T>`：list 是 Omni 的容器，带长度/容量/增删和一整套按值语义的
 * 拷贝规则，把它映到 GPU 上等于把 Omni 的容器 ABI 搬进 SPIR-V。缓冲刻意只有
 * 「一段连续的 T + 一个长度」：`bget` / `bset` / `blen`，没有增删、没有拷贝、
 * 不能装箱进 dynamic。这样它在六个执行器上的实现都是几行，而且和 GPU 上
 * StorageBuffer 里的 runtime array 是同一个形状。
 *
 * 引用语义（赋值共享同一段存储）：所以 isRef 里有它。
 */
export function bufType(elem) { return { k: 'buf', elem }; }
/**
 * 可增长数组（ADR-0014 门槛 2 的第四刀：asy 的 `T[]`）。`elem` 是四种标量之一，
 * 长度是运行期的，而且**会变**（push/pop）。
 *
 * 为什么不是 buf：buf 是按值传的 `{长度, 指针}`，引用语义靠"副本里的指针指向同一段存储"
 * 得来 —— 但 push 要改长度，而长度在每份副本里各有一个。所以数组的句柄必须是**指针**，
 * len/cap/items 都在被指向的头里。buf 的形状不动：GPU 那条腿要的正是按值的 {len, ptr}。
 *
 * 为什么不是 `list<T>`：list 是 `.omni` 那门语言的容器，带装箱进 dynamic、UFCS 方法表、
 * 值语义拷贝规则一整套；而 LLVM 那条腿根本没实现 list（grep 不到一处）。数组刻意只有
 * new/len/get/set/push/pop 六条，于是五条腿都能实现，实现还都在运行时里共用同一份。
 *
 * 引用语义：所以 isRef 里有它。
 */
export function arrType(elem) { return { k: 'arr', elem }; }

/** 引用语义的类型（赋值传引用，不拷贝） */
export function isRef(t) {
  return t.k === 'list' || t.k === 'dict' || t.k === 'set' || t.k === 'class' || t.k === 'fn'
    || t.k === 'buf' || t.k === 'arr';
}

/** 规范化类型键：同时用于类型相等判断、容器实例化去重、C 符号命名 */
export function typeKey(t) {
  switch (t.k) {
    case 'struct': return `S${t.name}`;
    case 'class': return `C${t.name}`;
    case 'enum': return `E${t.name}`;
    case 'list': return `list_${typeKey(t.elem)}`;
    case 'dict': return `dict_${typeKey(t.key)}_${typeKey(t.val)}`;
    case 'set': return `set_${typeKey(t.elem)}`;
    case 'vec': return `vec_${typeKey(t.elem)}_${t.lanes}`;
    case 'buf': return `buf_${typeKey(t.elem)}`;
    case 'arr': return `arr_${typeKey(t.elem)}`;
    // 参数与返回之间用 `__` 分隔：参数之间是 `_`，所以零参也不会和别的键撞
    case 'fn': return `fn_${t.params.map(typeKey).join('_')}__${typeKey(t.ret)}`;
    default: return t.k;
  }
}

export function typeName(t) {
  if (!t) return '<unknown>';
  switch (t.k) {
    case 'struct': case 'class': case 'enum': return t.name;
    case 'list': return `list<${typeName(t.elem)}>`;
    case 'dict': return `dict<${typeName(t.key)}, ${typeName(t.val)}>`;
    case 'set': return `set<${typeName(t.elem)}>`;
    case 'vec': return `vec<${typeName(t.elem)}, ${t.lanes}>`;
    case 'buf': return `buf<${typeName(t.elem)}>`;
    case 'arr': return `arr<${typeName(t.elem)}>`;
    case 'fn': return `fn(${t.params.map(typeName).join(', ')}) -> ${typeName(t.ret)}`;
    default: return t.k;
  }
}

export function same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return typeKey(a) === typeKey(b);
}

export function isNumeric(t) {
  return t.k === 'int' || t.k === 'real';
}

/** 可作为 dict 键的类型：需要稳定的 hash + 相等语义 */
export function isHashable(t) {
  return t.k === 'int' || t.k === 'real' || t.k === 'bool' || t.k === 'string';
}

/** 可以装箱进 dynamic 的类型 */
export function boxable(t) {
  return isHashable(t) || t.k === 'dynamic' || t.k === 'null'
    || (t.k === 'list' && t.elem.k === 'dynamic')
    || (t.k === 'dict' && t.key.k === 'string' && t.val.k === 'dynamic');
}

/**
 * 隐式转换代价：0 = 完全匹配，>0 = 需要转换，-1 = 不可转换。
 * 只有三类边：int->real、null->引用/dynamic、T->dynamic（装箱）。
 * 每加一条边都要在 ADR 里写清理由，否则隐式转换图会变成重载解析的噩梦。
 */
export function castCost(from, to) {
  if (same(from, to)) return 0;
  if (from.k === 'int' && to.k === 'real') return 1;
  if (from.k === 'null') return (to.k === 'class' || to.k === 'dynamic' || to.k === 'fn') ? 0 : -1;
  // 装箱代价刻意高于 int->real，保证重载解析优先选具体类型
  if (to.k === 'dynamic' && boxable(from)) return 2;
  return -1;
}

export function assignable(from, to) {
  return castCost(from, to) >= 0;
}

/** 二元算术/比较/三元分支的公共类型 */
export function commonType(a, b) {
  if (same(a, b)) return a;
  if (isNumeric(a) && isNumeric(b)) return REAL;
  if (a.k === 'null' && (b.k === 'class' || b.k === 'dynamic' || b.k === 'fn')) return b;
  if (b.k === 'null' && (a.k === 'class' || a.k === 'dynamic' || a.k === 'fn')) return a;
  if (a.k === 'dynamic' && boxable(b)) return DYNAMIC;
  if (b.k === 'dynamic' && boxable(a)) return DYNAMIC;
  return null;
}

/** C 后端的类型拼写 */
export function cTypeName(t) {
  switch (t.k) {
    case 'int': return 'int64_t';
    case 'real': return 'double';
    case 'bool': return 'bool';
    case 'string': return 'omni_str';
    case 'void': return 'void';
    case 'dynamic': return 'omni_dyn';
    case 'struct': return `s_${t.name}`;
    case 'class': return `c_${t.name}`;
    case 'enum': return `e_${t.name}`;
    // 所有函数值在 C 里是同一个指针类型；签名只出现在调用处的强制转换里
    case 'fn': return 'omni_fn';
    case 'list': case 'dict': case 'set': return `omni_${typeKey(t)}`;
    // 向量在 C 侧是一个按值传的定长数组结构体，按 (元素, 宽度) 生成，与容器同一套路。
    // C 备选路径上向量是**标量化**的（ADR-0014 决策 6 唯一许可的合法化），
    // 所以这里不是 `double __attribute__((vector_size(32)))` 之类的编译器扩展 ——
    // 那会把「两条腿逐位相同」的责任交给 clang 的自动向量化，而它不保证求值顺序。
    case 'vec': return `omni_${typeKey(t)}`;
    // 缓冲在 C 侧是 `{长度, 指针}` 按值传（16 字节）。长度跟着值走，不放在别处：
    // 六个执行器里 blen 都要 O(1) 拿到它，而"长度存在调用方"意味着每条腿各自记一份。
    case 'buf': return `omni_${typeKey(t)}`;
    // 数组在 C 侧就是运行时那四个 typedef 之一（`omni_arr_i64` 等）：一个指针。
    // 不按 typeKey 拼名字，因为实现不是逐形状生成的，是运行时里已经单态好的四份。
    case 'arr': return `omni_arr_${arrSuffix(t.elem)}`;
    default: throw new Error(`cTypeName: ${t.k}`);
  }
}

/** 数组的元素后缀：运行时符号名（omni_arr_i64_get 之类）和 LLVM 那条腿共用这一份 */
export function arrSuffix(elem) {
  switch (elem.k) {
    case 'int': return 'i64';
    case 'real': return 'f64';
    case 'bool': return 'b8';
    case 'string': return 'str';
    default: throw new Error(`arrSuffix: ${elem.k}`);
  }
}

/** 变量声明未给 init 时的默认值（OIR 节点）。容器默认是新建的空容器，class 默认 null。 */
export function zeroValue(t) {
  switch (t.k) {
    case 'int': return { kind: 'Const', type: t, value: 0n };
    case 'real': return { kind: 'Const', type: t, value: 0 };
    case 'bool': return { kind: 'Const', type: t, value: false };
    case 'string': return { kind: 'Const', type: t, value: '' };
    case 'struct': return { kind: 'ZeroStruct', type: t };
    // enum 的零值 = **第一个变体**，载荷取各自的零值（ADR-0012）。选"第一个"而不是
    // 造一个 invalid 标签：那会让每次 match 都要处理一个源码里不存在的状态。
    case 'enum': return { kind: 'ZeroEnum', type: t };
    case 'dynamic': return { kind: 'DynNull', type: t };
    case 'class': return { kind: 'NullRef', type: t };
    case 'fn': return { kind: 'NullFn', type: t };
    case 'list': case 'dict': case 'set': return { kind: 'NewContainer', type: t };
    // 向量的零值就是「零值 splat」，不另开一个 ZeroVec 节点：每多一种 OIR 节点，
    // 三个 OIR 消费者（C / JS / 解释器）就各多一处分支，而这里的语义已经有节点表达了。
    case 'vec': return { kind: 'VecSplat', type: t, value: zeroValue(t.elem) };
    // 缓冲的零值是**空缓冲**（长度 0），不是空指针：`blen` 在任何缓冲上都得能答，
    // 而"有时候是 null"意味着六条腿各要一处判空。
    case 'buf': return { kind: 'BufNew', type: t, count: { kind: 'Const', type: INT, value: 0n } };
    // 数组的零值同理：长度 0 的空数组，不是空指针。`alen`/`apush` 在它上面都得能用。
    // 元素零值当**子节点**挂着（跟 VecSplat 一个套路）：这样四个消费者都只是"求一个表达式"，
    // 不必各自知道"string 的零"在自己那条腿上怎么拼。
    case 'arr': return {
      kind: 'ArrNew', type: t,
      count: { kind: 'Const', type: INT, value: 0n },
      zero: zeroValue(t.elem),
    };
    default: return null;
  }
}
