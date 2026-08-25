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
export function listType(elem) { return { k: 'list', elem }; }
export function dictType(key, val) { return { k: 'dict', key, val }; }
export function setType(elem) { return { k: 'set', elem }; }
/**
 * 函数值类型（ADR-0010）。只有签名，没有参数名 —— 参数名属于 lambda，不属于类型，
 * 否则 `fn(int a)->int` 和 `fn(int b)->int` 会是两个类型。
 */
export function fnType(params, ret) { return { k: 'fn', params, ret }; }

/** 引用语义的类型（赋值传引用，不拷贝） */
export function isRef(t) {
  return t.k === 'list' || t.k === 'dict' || t.k === 'set' || t.k === 'class' || t.k === 'fn';
}

/** 规范化类型键：同时用于类型相等判断、容器实例化去重、C 符号命名 */
export function typeKey(t) {
  switch (t.k) {
    case 'struct': return `S${t.name}`;
    case 'class': return `C${t.name}`;
    case 'list': return `list_${typeKey(t.elem)}`;
    case 'dict': return `dict_${typeKey(t.key)}_${typeKey(t.val)}`;
    case 'set': return `set_${typeKey(t.elem)}`;
    // 参数与返回之间用 `__` 分隔：参数之间是 `_`，所以零参也不会和别的键撞
    case 'fn': return `fn_${t.params.map(typeKey).join('_')}__${typeKey(t.ret)}`;
    default: return t.k;
  }
}

export function typeName(t) {
  if (!t) return '<unknown>';
  switch (t.k) {
    case 'struct': case 'class': return t.name;
    case 'list': return `list<${typeName(t.elem)}>`;
    case 'dict': return `dict<${typeName(t.key)}, ${typeName(t.val)}>`;
    case 'set': return `set<${typeName(t.elem)}>`;
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
    // 所有函数值在 C 里是同一个指针类型；签名只出现在调用处的强制转换里
    case 'fn': return 'omni_fn';
    case 'list': case 'dict': case 'set': return `omni_${typeKey(t)}`;
    default: throw new Error(`cTypeName: ${t.k}`);
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
    case 'dynamic': return { kind: 'DynNull', type: t };
    case 'class': return { kind: 'NullRef', type: t };
    case 'fn': return { kind: 'NullFn', type: t };
    case 'list': case 'dict': case 'set': return { kind: 'NewContainer', type: t };
    default: return null;
  }
}
