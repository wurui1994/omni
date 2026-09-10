/**
 * MIR 的字节形式：**一条指令 8 字节**，以及按内容算出来的函数哈希。
 *
 * 存在的理由是增量编译（ADR-0014 决策 5）：缓存键 =
 * `hash(函数的 MIR 字节 + 它调用的那些函数的签名哈希)`。所以这一层要做到两件事：
 *
 *   1. **同一个函数体两次编译得到同一串字节**。常量池去重、op 池按 (名字, 字面量) 去重、
 *      类型池按 typeKey 去重 —— 都是为了这条。
 *   2. **别的函数改了实现不失效我**。所以哈希里出现的是**名字**而不是池下标：下标依赖
 *      整个模块的构造顺序，名字只依赖这个函数自己引用了谁。这一条是量出来的教训的反面 ——
 *      如果哈希里带下标，改任何一个函数都会让它后面所有函数的哈希变化，增量就退化成全量。
 *      （所以哈希的输入不是字节本身，而是字节的**规范化文本**，见 funcDigestText。）
 *
 * 字段布局（小端，与 LuaJIT 的 `IRIns` 同形，`lj_ir.h:493..529`）：
 *   [0] op   [1] t   [2..3] a   [4..5] b   [6..7] aux
 *
 * 宿主约束：没有 TypedArray（封闭 ABI，ADR-0011 决策 2），所以「字节」是一个
 * 0..255 的数字数组。要落盘时再由宿主 op 转成真字节。
 */

import { hash16 } from '../host/hash.js';
import { OP, OP_NAMES, OP_MODES, REF_BIAS, REF_NONE, isConstRef, typeText, CVT_NAMES, memDescText, callLdRet, CALL_LDRET } from './ir.js';

/** 一条指令 -> 8 个字节。 */
function insnBytes(f, i, out) {
  const a = f.a[i];
  const b = f.b[i];
  const x = f.aux[i];
  out.push(f.op[i] % 256);
  out.push(f.t[i] % 256);
  out.push(a % 256);
  out.push((a - (a % 256)) / 256);
  out.push(b % 256);
  out.push((b - (b % 256)) / 256);
  out.push(x % 256);
  out.push((x - (x % 256)) / 256);
}

/** 一个函数体的全部指令字节。长度恒为 `8 * 指令数` —— 这一条是定长编码的意义所在。 */
export function funcBytes(f) {
  const out = [];
  let i = 0;
  while (i < f.count()) {
    insnBytes(f, i, out);
    i++;
  }
  return out;
}

/**
 * 哈希用的规范文本。
 *
 * 这里**不能直接哈希指令字节**，虽然决策 5 的原话是「hash(函数的 MIR 字节 + …)」——
 * 字节里的 `a`/`b`/`aux` 有一半是**池下标**：CALL 的被调函数下标、GLOAD 的全局下标、
 * AGGLIT 的类型下标、常量 ref 落在 `REF_BIAS` 以下也是常量池下标。下标依赖整个模块的
 * 构造顺序，于是「在文件开头插一个新函数」会让它后面每一个函数的字节都变 —— 增量
 * 立刻退化成全量，正是文件头第 2 条要避免的那件事。
 *
 * 所以规范化：**函数内的东西按下标，跨函数的东西按名字**。
 *   - 指令 ref、槽位号、`br` 的层数 —— 函数内的编号，原样保留（它们本来就只在本函数内有意义）。
 *   - 常量 —— 按**值**（`k#0` 是「本函数用到的第一个常量」，值紧随其后）。
 *   - 函数 / 全局 / 类型 / 字段 / op / 外部 C 符号 / 闭包 —— 按名字。
 *
 * 换句话说：字节形式是给机器和持久化的（`funcBytes`，那里下标是对的），
 * 规范文本是给缓存键的。两者信息量相同，只有「跨模块还认不认」这一条不同。
 */
export function funcDigestText(mod, f) {
  const L = [];
  L.push(`fn ${f.name} -> ${typeText(f.ret)}`);
  // 变参那一位（第二十四片）：形参表一样、指令一样，可是 `...` 在不在决定了序言要不要
  // 泼寄存器 —— 两个函数生成的机器码不同，哈希就不能相同。
  if (f.variadic) L.push('variadic');
  for (const p of f.params) L.push(`param ${typeText(p.t)}`);
  for (const s of f.slots) L.push(`slot ${typeText(s.t)}`);
  // 帧块（第十八片）：大小与对齐都进哈希 —— 「同一个函数，把一个 int 局部量换成 long」
  // 生成的指令可以一模一样（都是 FRAME %0），差别全在这张表上。
  for (const b of f.frames) L.push(`frame ${b.size} ${b.align}`);
  const ks = new Map();   // 常量 ref -> 本函数内的序号（键是数字，所以是 Map）
  let i = 0;
  while (i < f.count()) {
    L.push(`insn ${OP_NAMES[f.op[i]]} ${typeText(f.t[i])} ${digestOperands(mod, f, i, ks)}`);
    i++;
  }
  return L.join('\n');
}

/** 一条指令的操作数，规范化之后的样子。角色表决定怎么写 —— 加一条 op 这里自动跟上。 */
function digestOperands(mod, f, i, ks) {
  const op = f.op[i];
  const mode = OP_MODES[op];
  const vals = [f.a[i], f.b[i], f.aux[i]];
  const out = [];
  let k = 0;
  while (k < 3) {
    const role = mode[k];
    const v = vals[k];
    if (role === 'r') out.push(refDigest(mod, v, ks));
    if (role === 's') out.push(`s${v}`);
    if (role === 'p') out.push(`(${f.argsOf(v).map((r) => refDigest(mod, r, ks)).join(' ')})`);
    // 'j'（第三刀）：层数表。**不能走 refDigest** —— 层数 3 会被写成 `k#…` 或 `%3`，
    // 于是「跳第 3 层」和「用 %3 那条指令」在哈希里成了同一串字节。
    if (role === 'j') out.push(`[${f.levelsOf(v).map((lv) => `^${lv}`).join(' ')}]`);
    if (role === 'n') out.push(auxDigest(mod, op, v, k));
    k++;
  }
  return out.join(' ');
}

/** 一个 ref：常量按值（附本函数内的序号），指令按函数内的编号。 */
function refDigest(mod, ref, ks) {
  if (ref === REF_NONE) return '-';
  if (!isConstRef(ref)) return `%${ref - REF_BIAS}`;
  if (!ks.has(ref)) ks.set(ref, ks.size);
  const c = mod.consts.get(ref);
  return `k#${ks.get(ref)}:${typeText(c.t)}:${c.kind}:${c.text}`;
}

/** 调用点 aux 的摘要：`vafix:3`，点了 st0 那一位再加个后缀（第一百一十二片）。
 * 没点那一位时的写法与从前一字不差 —— 既有的哈希不能因为多了一件事就全变。 */
function callAuxDigest(v) {
  const vafix = `vafix:${v % CALL_LDRET}`;
  return callLdRet(v) ? `${vafix}+ldret` : vafix;
}

/** `aux` 里的整数：是池下标的换成名字，是层数/kind 的原样留着。 */
/** aux（或 a）上那个数字。`k` 是它是第几个字段 —— CCALL 的 a 与 aux **都是数字、
 * 意思不同**（入口号 / 变参分界），少了 `k` 会把「固定实参 2 个」印成一个 C 入口名。 */
function auxDigest(mod, op, v, k) {
  /* 签名也进摘要（ADR-0022 的 J4b）：同一个名字、不同签名是**两个**外部符号，
     不带它的话「把 `(ptr)->void` 改成 `(ptr,i32)->void`」这种改动摘要一个字都不变。 */
  if (op === OP.CCALL) {
    if (k !== 0) return callAuxDigest(v);
    const sig = (mod.cabiSig ?? [])[v];
    return `cabi:${mod.cabi[v]}${sig === undefined ? '' : sig.text}`;
  }

  if (op === OP.CALLI) return callAuxDigest(v);
  if (op === OP.CALL) return `func:${mod.funcs[v].name}`;
  if (op === OP.FADDR) return `faddr:${mod.funcs[v].name}`;
  if (op === OP.CALLOP) return `op:${mod.ops[v].name}[${JSON.stringify(mod.ops[v].lits)}]`;
  if (op === OP.CLOSURE) return `closure:${mod.closures[v].make}`;
  if (op === OP.GLOAD || op === OP.GSTORE || op === OP.GADDR) return `global:${mod.globals[v]}`;
  if (op === OP.FLD || op === OP.FLDSET) {
    const acc = mod.accs[v];
    return `field:${mod.types[acc.type].name}.${acc.field}`;
  }
  if (op === OP.NEW || op === OP.COPY || op === OP.ETAG || op === OP.IDXGET
    || op === OP.IDXSET || op === OP.AGGLIT || op === OP.MKENUM
    // 数组那五条也是类型号（第十八刀）：aux 上是**数组类型**，元素身份挂在它的 oir 上。
    || op === OP.ANEW || op === OP.AGET || op === OP.ASET || op === OP.APUSH || op === OP.APOP) {
    return `type:${mod.types[v].kind}:${mod.types[v].name}`;
  }
  if (op === OP.CVT) return `cvt:${CVT_NAMES[v]}`;
  // 内存访问描述符（第二刀）：印成 `mem:i32u@8`。原样留个数字也是对的（打包是确定的），
  // 但哈希摘要是给人读的诊断文本，宽度与偏移分开看才认得出"两次降级差在哪"。
  if (op === OP.MLOAD || op === OP.MSTORE) return `mem:${memDescText(v, op === OP.MLOAD)}`;
  return String(v);
}

/**
 * 函数的内容哈希。**不含被调函数的函数体** —— 只含它们的名字（见 refNameOf），
 * 所以「改实现不失效调用者」成立。调用方要把被调者的**签名哈希**拌进来，
 * 那一步属于增量编译的缓存层，不在这里（这里只给「这个函数自己」的哈希）。
 */
export function funcHash(mod, f) {
  return hash16(funcDigestText(mod, f));
}

/** 签名哈希：只看形参与返回类型。被调者的实现改了它不变，这正是决策 5 要的。 */
export function sigHash(f) {
  const parts = [`-> ${typeText(f.ret)}`];
  for (const p of f.params) parts.push(typeText(p.t));
  return hash16(parts.join('|'));
}

/** 整个模块的哈希表：函数名 -> {body, sig}。增量编译的入口数据。 */
export function moduleHashes(mod) {
  const out = new Map();
  for (const f of mod.funcs) out.set(f.name, { body: funcHash(mod, f), sig: sigHash(f) });
  return out;
}

/** 调试/快照用：印出字节形式的摘要，不印全部字节（那个太长，没人读）。 */
export function dumpBytes(mod) {
  const L = [];
  let total = 0;
  for (const f of mod.funcs) total += f.count() * 8;
  L.push(`;; mir bytes  ${mod.funcs.length} funcs, ${total} bytes (8 per insn)`);
  for (const f of mod.funcs) {
    L.push(`${f.name}  ${f.count() * 8} bytes  body=${funcHash(mod, f)}  sig=${sigHash(f)}`);
  }
  return L.join('\n') + '\n';
}
