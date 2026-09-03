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
/**
 * 数据指针（ADR-0016 决策一）。jancy 的两种指针一一对应：
 *
 *   `(ptr T)`  —— **fat**，jancy 的默认指针。表示是**三字内联** `{addr, base, size}`，
 *                 解引用与算术都查范围（`type_ptr_data.rst`：range is checked on both
 *                 array accesses and pointer dereferences）。
 *   `(tptr T)` —— **thin**，jancy 的 `thin*`。只有地址，不查。只在 `(unsafe …)` 里可达。
 *
 * **值语义**（所以 isRef 里没有它）：指针本身是一串数，赋值就是把那三个字（或一个字）
 * 抄一份；被指向的那块内存才是共享的。这与 vec 同一档。
 *
 * `target` 收的：int / real / bool、结构体，与**指针自己**（`(ptr (ptr T))` / `(ptr (tptr T))`，
 * ADR-0016 第十六刀）。不收的与理由：
 *   - string / arr / buf / class / fn 在这一层是**宿主句柄**（JS 侧是对象，C 侧是指针），
 *     它们没有"一段可寻址的字节"这回事，指到它们身上没有意义。
 *
 * 指针自己的**存储**布局（第十六刀长出来的那一格）：fat 是三个字 24 字节、对齐 8，
 * thin 是一个字 8 字节。三个字的次序就是 `{addr, base, end}`，五条腿里都一样 ——
 * JS 那条腿写的是 arena 里的偏移、C 那条腿写的是真地址，值不同但**格子数与次序相同**，
 * 所以 `(psub p q)`、结构体字段偏移这些按字节算的东西在两套实现里对得上。
 */
export function ptrType(target) { return { k: 'ptr', target }; }
export function tptrType(target) { return { k: 'tptr', target }; }

/**
 * 指针能指向的类型吗（上面那段注释里的那张名单）。
 */
export function ptrTargetOk(t) {
  return t.k === 'int' || t.k === 'real' || t.k === 'bool' || t.k === 'struct'
    || t.k === 'ptr' || t.k === 'tptr' || t.k === 'blk';
}

/**
 * **一段 N 格的定长内存**（ADR-0016 第十八刀）。只在**指针的目标**位置合法 —— 它不是一个
 * 值：没有"整块的 load/store"，能对它做的只有"要它第 i 格的地址"（方言里那一句 `(pelem p)`
 * 把 `(ptr (blk T N))` 退回 `(ptr T)`，地址与范围都不变，纯是类型上的一步）。
 *
 * 逼出它的是 jancy 的多维数组 `int a[10][20]`：那是"10 格，每格是 `int[20]`"，
 * 而 `&a`（`T(*)[N]`）与结构体里的数组字段要的也是同一格。与第十六刀那一格是两回事：
 * 那一刀开的是"T 能是指针"，这一刀开的是"T 能是一段定长内存"。
 */
export const blkType = (el, n) => ({ k: 'blk', el, n });

/**
 * 内存布局（ADR-0016 决策二）：**一套语义，两套实现**——所以尺寸与对齐必须由这一层定死，
 * 不能各条腿自己算。C 那条腿也照这一份摆结构体（不吃编译器的自然布局），
 * 不然 `(psub p q)` 与结构体字段偏移在两套实现里会不一样。
 *
 * int / real 都是 8 字节：int 在 JS 侧本来就是 BigInt（prelude.js:7 的 `$W`），
 * DataView 的 `getBigInt64` 正好对上；real 是 float64。字节序**固定小端**。
 * bool 是 1 字节（0/1）。
 *
 * 结构体是"自然对齐、按声明顺序、尾部补齐到自身对齐"——与 C 的默认布局同一条规矩，
 * 所以把协议头结构体盖在缓冲上时两边看到的是同一件事（那是这门语言的用处所在，
 * 见 type_ptr_data.rst 开头那段 TCP/IP 包的例子）。
 */
export function alignOf(t) {
  if (t.k === 'bool') return 1;
  if (t.k === 'int' || t.k === 'real') return 8;
  // 指针自己落进内存时（第十六刀）：两种指针都按字对齐，fat 是三个字、thin 是一个字。
  if (t.k === 'ptr' || t.k === 'tptr') return 8;
  // 定长内存（第十八刀）：对齐就是元素的对齐 —— 与 C 的数组同一条。
  if (t.k === 'blk') return alignOf(t.el);
  if (t.k === 'struct') {
    let a = 1;
    for (const f of t.fields) a = Math.max(a, alignOf(f.type));
    return a;
  }
  return 0;   // 不可落地的类型：调用方要先问 ptrTargetOk / layoutOk
}

export function sizeOf(t) {
  if (t.k === 'bool') return 1;
  if (t.k === 'int' || t.k === 'real') return 8;
  if (t.k === 'ptr') return 24;
  if (t.k === 'tptr') return 8;
  // 定长内存（第十八刀）：N 格，每格按元素的**步长**（尺寸补齐到自己的对齐）—— 现有的
  // 四种目标里 sizeOf 本来就已经是 alignOf 的整数倍（bool 是 1/1），所以这一句是乘法。
  if (t.k === 'blk') {
    const s = sizeOf(t.el);
    return s === 0 ? 0 : Math.ceil(s / alignOf(t.el)) * alignOf(t.el) * t.n;
  }

  if (t.k === 'struct') {
    const l = structLayout(t);
    return l === null ? 0 : l.size;
  }
  return 0;
}

/** 结构体的逐字段偏移 + 总尺寸（null = 里面有落不了地的字段） */
export function structLayout(t) {
  const fields = [];
  let off = 0;
  let align = 1;
  for (const f of t.fields) {
    const a = alignOf(f.type);
    const s = sizeOf(f.type);
    if (a === 0 || s === 0) return null;
    off = Math.ceil(off / a) * a;
    fields.push({ name: f.name, type: f.type, off });
    off += s;
    align = Math.max(align, a);
  }
  return { fields, size: Math.ceil(off / align) * align, align };
}

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
    case 'ptr': return `ptr_${typeKey(t.target)}`;
    case 'tptr': return `tptr_${typeKey(t.target)}`;
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
    case 'ptr': return `${typeName(t.target)}*`;
    case 'tptr': return `${typeName(t.target)} thin*`;
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
    // 数组在 C 侧就是运行时那几个 typedef 之一（`omni_arr_i64` 等）：一个指针。
    // 不按 typeKey 拼名字，因为实现不是逐形状生成的，是运行时里已经单态好的四份 ——
    // 聚合元素（向量）没法单态在运行时里（那个结构体是逐形状生成在 .c 里的），
    // 走按字节的 `omni_arr_blob`，元素的 load/store 由两条腿自己发。
    case 'arr': return arrIsBlob(t.elem) ? 'omni_arr_blob' : `omni_arr_${arrSuffix(t.elem)}`;
    // 指针（ADR-0016）。这条腿是**真指针**：fat 是运行时那一个三字段结构体（不逐目标
    // 类型生成 —— 读写那两处本来就要按类型强转），thin 就是 char*。
    case 'ptr': return 'omni_ptr';
    case 'tptr': return 'char *';
    default: throw new Error(`cTypeName: ${t.k}`);
  }
}

/** 元素走按字节那一份（omni_arr.c 尾部）的判据：向量（值语义，格子里躺内容）、
 *  类与**数组**（引用语义，格子里躺一个句柄 —— 步长就是一个指针）。三者共用 blob 是因为
 *  运行时那四份单态是按**元素的 C 类型**生成的，而这几种的 C 类型是逐形状的。
 *  数组元素是多维数组那一刀加的（asy 的 `real[][]`：真 base 里到处是它 —— 量过，
 *  220 个 examples 里 163 个第一个撞的就是它）。 */
export function arrIsBlob(elem) {
  return elem.k === 'vec' || elem.k === 'class' || elem.k === 'arr' || elem.k === 'fn';
}

/**
 * 这个循环要不要带标签（第四十刀）。多层 `break` / `continue` 在 JS 里是 `break L` /
 * `continue L`，在 C 里是 `goto` —— 两条腿都得在**发射循环之前**就知道"有没有更里层
 * 的跳指着我"，所以先扫一遍。
 *
 * 判据：body 里存在一条 Break / Continue，它所在的嵌套循环层数 d 大于 0（也就是它在
 * 更里层的循环里），而 level 正好是 d + 1（正好指着这一层）。d === 0 那些是 C 与 JS
 * 自带的 `break;` / `continue;`，不用标签。
 *
 * 两条腿共用这一份，是因为"哪一层要标签"这个判断错了会静默地跳错地方 —— 各写一份迟早分叉。
 */
export function loopLabelNeeds(loop) {
  const need = { brk: false, cont: false };
  const walk = (s, d) => {
    if (s === null || s === undefined) return;
    switch (s.kind) {
      case 'Block': for (const x of s.stmts) walk(x, d); return;
      case 'If': walk(s.then, d); walk(s.otherwise, d); return;
      case 'While': case 'For': case 'ForIn': walk(s.body, d + 1); return;
      case 'Break': case 'Continue': {
        const lv = s.level === undefined || s.level === null ? 1 : s.level;
        if (d > 0 && lv === d + 1) {
          if (s.kind === 'Break') need.brk = true; else need.cont = true;
        }
        return;
      }
      default: return;
    }
  };
  walk(loop.body, 0);
  return need;
}

/**
 * 数组六条操作在 C 侧的名字前缀。标量元素直接就是运行时里那四份单态
 * （`omni_arr_i64_get` 之类）；聚合元素的**句柄类型**是同一个 `omni_arr_blob`，
 * 但六条操作要按形状各有一份（读写元素的类型不同），所以名字按 typeKey 生成，
 * 由 backend-c 逐形状发一组 static inline 包在 blob 那五个符号外面。
 */
export function cArrOps(t) {
  return arrIsBlob(t.elem) ? `omni_${typeKey(t)}` : `omni_arr_${arrSuffix(t.elem)}`;
}

/** 数组的元素后缀：运行时符号名（omni_arr_i64_get 之类）和 LLVM 那条腿共用这一份。
 *  聚合元素没有后缀（走 blob），调用方要先问 arrIsBlob。 */
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
    // 指针的零值是**空指针**（ADR-0016）。这一格与 buf/arr 的"零值是空容器"刻意不同：
    // jancy 那边没有"空指针指向的那块"这回事，`p == null` 是它自己就有的判据；
    // 而且 `type_ptr_data.rst` 说得很清楚——编译器保证每个变量在用户代码碰它之前都被清零，
    // 所以"未初始化的指针"在这门语言里不存在，零值必须是一个**能判**的值。
    case 'ptr': case 'tptr': return { kind: 'PtrNull', type: t };
    default: return null;
  }
}
