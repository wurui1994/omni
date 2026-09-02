/**
 * MIR 的文本形式。**只印，不解析** —— 它的身份是快照测试的比对对象和读代码用的视图，
 * 不是第二条输入路径（真源是 OIR 降下来的那份，见 mir/from_oir.js；要持久化就用
 * mir/bytes.js 的字节形式）。
 *
 * 两条格式约定，都是为了快照能当回归门槛用：
 *   - 每条指令一行，字段列宽固定，`op` 后面按操作数模式表印 —— 加一条 op 不用改这里。
 *   - **按区域深度缩进**：结构化控制流是 MIR 的不变量（ADR-0014 决策 6），
 *     缩进错位就是 IF/END 不配对，看一眼就发现，不用等后端。
 */

import {
  OP, OP_NAMES, OP_MODES, REF_NONE, refText, typeText, CVT_NAMES, isConstRef, memDescText,
} from './ir.js';

/** 常量的文本：字符串要转义（快照里得能看出空白与换行）。 */
function constText(c) {
  if (c.kind === 'str') return JSON.stringify(c.text);
  /* 字节串（第九刀第三十片）：`text` 本来就是十六进制，加个前缀好认。 */
  if (c.kind === 'bytes') return `bytes"${c.text}"`;
  return c.text;
}

function pad(s, n) {
  let r = s;
  while (r.length < n) r = r + ' ';
  return r;
}

/** 一条指令的操作数部分。角色表决定怎么印，所以 op 表加一行这里自动跟上。 */
function operands(mod, f, i) {
  const op = f.op[i];
  const mode = OP_MODES[op];
  const vals = [f.a[i], f.b[i], f.aux[i]];
  const out = [];
  for (let k = 0; k < 3; k++) {
    const role = mode[k];
    const v = vals[k];
    if (role === '-') continue;
    if (role === 'r') { if (v !== REF_NONE) out.push(refText(v)); continue; }
    if (role === 's') { out.push(`slot${v}:${f.slots[v] === undefined ? '?' : f.slots[v].name}`); continue; }
    if (role === 'p') {
      const items = f.argsOf(v).map(refText);
      out.push(`(${items.join(' ')})`);
      continue;
    }
    if (role === 'j') {
      // 跳表（第三刀）：印成 `[^0 ^2 ^0]`。带 `^` 是因为这一串是**层数**，
      // 与 'p' 的 ref 只差一个字母，快照里得能一眼分开。
      out.push(`[${f.levelsOf(v).map((lv) => `^${lv}`).join(' ')}]`);
      continue;
    }
    // 'n'：整数字面量。语义值得印成名字的那几个 op 单列 —— 快照要能读。
    if (op === OP.CVT) { out.push(CVT_NAMES[v]); continue; }
    if (op === OP.CALL) { out.push(mod.funcs[v] === undefined ? `fn?${v}` : mod.funcs[v].name); continue; }
    if (op === OP.CALLOP) { out.push(opText(mod, v)); continue; }
    if (op === OP.CCALL) { out.push(mod.cabi[v] === undefined ? `c?${v}` : mod.cabi[v]); continue; }
    if (op === OP.CLOSURE) { out.push(mod.closures[v] === undefined ? `cl?${v}` : mod.closures[v].make); continue; }
    if (op === OP.NEW || op === OP.COPY || op === OP.ETAG || op === OP.IDXGET
        || op === OP.IDXSET || op === OP.AGGLIT || op === OP.MKENUM) {
      out.push(typeNameOf(mod, v));
      continue;
    }
    if (op === OP.FLD || op === OP.FLDSET) { out.push(accText(mod, v)); continue; }
    if (op === OP.GLOAD || op === OP.GSTORE) { out.push(`g_${mod.globals[v]}`); continue; }
    if (op === OP.BR || op === OP.BRIF || op === OP.BRTABLE) { out.push(`^${v}`); continue; }
    if (op === OP.VINS || op === OP.VEXT) { out.push(`lane${v}`); continue; }
    if (op === OP.MLOAD || op === OP.MSTORE) { out.push(memDescText(v, op === OP.MLOAD)); continue; }
    out.push(String(v));
  }
  return out.join(' ');
}

function opText(mod, no) {
  const o = mod.ops[no];
  if (o === undefined) return `op?${no}`;
  return o.lits.length === 0 ? o.name : `${o.name}[${o.lits.map((x) => JSON.stringify(x)).join(' ')}]`;
}

function accText(mod, no) {
  const a = mod.accs[no];
  if (a === undefined) return `acc?${no}`;
  const ty = mod.types[a.type];
  return `${ty === undefined ? `T?${a.type}` : ty.name}.${a.field}`;
}

function typeNameOf(mod, no) {
  const ty = mod.types[no];
  if (ty === undefined) return `T?${no}`;
  return `${ty.kind}:${ty.name}`;
}

export function printMir(mod) {
  const L = [];
  L.push(`;; mir module  entry=${mod.entry}`);
  L.push(`;; ${mod.funcs.length} funcs, ${mod.consts.items.length} consts, ${mod.types.length} types, ${mod.globals.length} globals, ${mod.ops.length} ops`);

  for (let i = 0; i < mod.types.length; i++) {
    const ty = mod.types[i];
    const fs = ty.fields === undefined ? '' : `  (${ty.fields.join(' ')})`;
    L.push(`type T${i}  ${ty.kind} ${ty.name}${fs}`);
  }
  for (let i = 0; i < mod.consts.items.length; i++) {
    const c = mod.consts.items[i];
    L.push(`const ${pad(`k${i}`, 6)} ${pad(typeText(c.t), 6)} ${constText(c)}`);
  }
  for (const g of mod.globals) L.push(`global g_${g}`);
  // 线性内存（第二刀）：页数与 data 段。data 的字节印成十六进制 —— 快照要能一眼看出
  // "初始字节到底是哪几个"，而这正是 JS 与 C 两套实现最容易分叉的地方（字节序）。
  if (mod.mem !== null) {
    L.push(`memory ${mod.mem.min} ${mod.mem.max === 0 ? 'unbounded' : mod.mem.max} pages`);
    for (const d of mod.mem.data) {
      const hex = d.bytes.map((b) => (b < 16 ? `0${b.toString(16)}` : b.toString(16))).join('');
      L.push(`data @${d.off} ${d.bytes.length} bytes  ${hex}`);
    }
  }
  for (const c of mod.closures) L.push(`closure ${c.make} -> ${c.funcName}  captures: ${c.captures.join(' ')}`);
  for (let i = 0; i < mod.ops.length; i++) L.push(`op ${pad(`o${i}`, 5)} ${opText(mod, i)}`);
  for (let i = 0; i < mod.cabi.length; i++) L.push(`cabi c${i} ${mod.cabi[i]}`);

  for (const f of mod.funcs) L.push('', ...printFunc(mod, f));
  return L.join('\n') + '\n';
}

export function printFunc(mod, f) {
  const L = [];
  const ps = f.params.map((p) => `${p.name}:${typeText(p.t)}`).join(' ');
  const self = f.closureId === undefined ? '' : ' [closure]';
  L.push(`func ${f.name}(${ps}) -> ${typeText(f.ret)}${self}   ${f.slots.length} slots, ${f.count()} insns`);

  let depth = 0;
  for (let i = 0; i < f.count(); i++) {
    const op = f.op[i];
    // END/ELSE 先退一格再印，读起来才和括号对齐
    if (op === OP.END || op === OP.ELSE) depth--;
    const head = pad(refText(i + 0x8000), 7);
    const body = `${pad(OP_NAMES[op], 8)} ${pad(typeText(f.t[i]), 7)} ${operands(mod, f, i)}`;
    L.push(`  ${head}${'  '.repeat(depth < 0 ? 0 : depth)}${body}`.replace(/\s+$/, ''));
    if (op === OP.IF || op === OP.LOOP || op === OP.BLOCK || op === OP.ELSE) depth++;
  }
  if (depth !== 0) L.push(`  ;; !! 区域不配对：结束时深度 ${depth}`);
  return L;
}

/** 只给诊断用：把一条指令印成一行（不带缩进）。 */
export function printInsn(mod, f, ref) {
  const i = isConstRef(ref) ? -1 : f.at(ref);
  if (i < 0) return `${refText(ref)} = ${constText(mod.consts.get(ref))}`;
  return `${refText(ref)} ${OP_NAMES[f.op[i]]} ${typeText(f.t[i])} ${operands(mod, f, i)}`;
}
