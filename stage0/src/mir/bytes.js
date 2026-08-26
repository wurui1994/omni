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
 *
 * 字段布局（小端，与 LuaJIT 的 `IRIns` 同形，`lj_ir.h:493..529`）：
 *   [0] op   [1] t   [2..3] a   [4..5] b   [6..7] aux
 *
 * 宿主约束：没有 TypedArray（封闭 ABI，ADR-0011 决策 2），所以「字节」是一个
 * 0..255 的数字数组。要落盘时再由宿主 op 转成真字节。
 */

import { hash16 } from '../host/hash.js';
import { OP, OP_MODES, isConstRef, typeText, CVT_NAMES } from './ir.js';

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
 * 哈希用的规范文本。字节之外还要带上「这个函数引用了哪些外部名字」——
 * 见文件头第 2 条：名字进哈希，下标不进。
 */
export function funcDigestText(mod, f) {
  const L = [];
  L.push(`fn ${f.name} -> ${typeText(f.ret)}`);
  for (const p of f.params) L.push(`param ${typeText(p.t)}`);
  for (const s of f.slots) L.push(`slot ${typeText(s.t)}`);
  // 指令字节
  const bs = funcBytes(f);
  L.push(`bytes ${bs.length}`);
  let k = 0;
  let line = '';
  while (k < bs.length) {
    line = line + ',' + bs[k];
    if (k % 64 === 63) { L.push(line); line = ''; }
    k++;
  }
  if (line.length > 0) L.push(line);
  // 引用到的名字，按指令顺序列出（顺序也是内容的一部分）
  let i = 0;
  while (i < f.count()) {
    const nm = refNameOf(mod, f, i);
    if (nm !== null) L.push(`ref ${nm}`);
    i++;
  }
  // 常量：只列这个函数真的用到的那些，按用到的顺序
  for (const c of usedConsts(mod, f)) L.push(`k ${typeText(c.t)} ${c.kind} ${c.text}`);
  return L.join('\n');
}

/** 这一条指令引用的外部实体名（没有就是 null）。 */
function refNameOf(mod, f, i) {
  const op = f.op[i];
  const a = f.a[i];
  const x = f.aux[i];
  if (op === OP.CALL) return `func:${mod.funcs[a].name}`;
  if (op === OP.CALLOP) return `op:${mod.ops[a].name}[${JSON.stringify(mod.ops[a].lits)}]`;
  if (op === OP.CCALL) return `cabi:${mod.cabi[a]}`;
  if (op === OP.CLOSURE) return `closure:${mod.closures[a].make}`;
  if (op === OP.GLOAD || op === OP.GSTORE) return `global:${mod.globals[x]}`;
  if (op === OP.FLD || op === OP.FLDSET) {
    const acc = mod.accs[x];
    return `field:${mod.types[acc.type].name}.${acc.field}`;
  }
  if (op === OP.NEW || op === OP.COPY || op === OP.ETAG || op === OP.IDXGET
    || op === OP.IDXSET || op === OP.AGGLIT || op === OP.MKENUM) {
    return `type:${mod.types[x].kind}:${mod.types[x].name}`;
  }
  if (op === OP.CVT) return `cvt:${CVT_NAMES[x]}`;
  return null;
}

/** 函数用到的常量，按第一次用到的顺序。 */
function usedConsts(mod, f) {
  const seen = new Set();
  const out = [];
  const take = (ref) => {
    if (ref === undefined || !isConstRef(ref) || seen.has(ref)) return;
    seen.add(ref);
    out.push(mod.consts.get(ref));
  };
  let i = 0;
  while (i < f.count()) {
    const mode = OP_MODES[f.op[i]];
    if (mode[0] === 'r') take(f.a[i]);
    if (mode[1] === 'r') take(f.b[i]);
    if (mode[1] === 'p') for (const r of f.argsOf(f.b[i])) take(r);
    i++;
  }
  return out;
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
