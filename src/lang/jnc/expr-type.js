// src/lang/jnc/expr-type.js —— **表达式定型**的第一片（只回"这一格表达式是什么类型"）
//
// 语句/表达式那条腿要的第一件事就是它：`new C(x)` 的 `x`、花括号初值里那几格、
// `jnc$asgn$<类型>` / `jnc$var$<种类>` 那几族助手的名字，全靠"这一格表达式是什么类型"。
//
// 这一层**不查名**（与 `aliasHead` 同一条口径）：名字表由调用方给 ——
// `names` 是 `名字 -> readDeclType 出来的类型记录`，`env` 是聚合体/枚举/typedef 那张表。
// 认不出来的照实答 `null`，绝不猜（猜出来的类型会变成静默的错答案）。
//
// 现在收的：整数/实数/布尔/字符串字面量、名字、括号、算术与比较那几个二元算符、
// 一元 `-` / `+` / `~` / `!`。别的（成员访问、调用、下标、cast、new…）答 null，记账。

import { headOf, named } from './adapt.js';
import { resolveType } from './resolve-type.js';

/** 二元算符按"两边都认得出来"定型：算术回宽的那一边，比较回 bool。 */
const CMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);
const ARITH_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

/** 字面量的种类（记号那一层）。 */
function litType(tok) {
  if (tok === null || tok === undefined || typeof tok !== 'object') return null;
  if (Array.isArray(tok.items)) return null;
  const v = tok.value;
  if (typeof v === 'number') return Number.isInteger(v) ? { k: 'int' } : { k: 'real' };
  if (typeof v !== 'string') return null;
  if (/^-?\d+$/.test(v)) return { k: 'int' };
  if (/^-?\d+\.\d*$/.test(v)) return { k: 'real' };
  if (v === 'true' || v === 'false') return { k: 'bool' };
  if (v.startsWith('"')) return { k: 'string' };
  return null;
}

/**
 * 一格表达式的类型（方言那一侧的类型记录，与 `resolveType` 答的同一种）。
 * 认不出来答 `null`。
 */
export function typeOfExpr(n, names = new Map(), env = new Map()) {
  if (n === null || n === undefined || typeof n !== 'object') return null;
  if (!Array.isArray(n.items)) return litType(n);                    // 光一个记号
  const h = headOf(n);
  const nm = named(n);
  if (h === 'name') {
    /* 名字：在调用方给的那张表里查，查着了按它的声明解一遍。 */
    const t = nm === null ? undefined : names.get(String(nm.text?.value ?? ''));
    if (t === undefined) return null;
    const r = resolveType(t, env);
    return r.type;
  }
  /* 节点名与洞名照节点表来：一元是 `(unary op a)`、二元是 `(binary op a b)`（nodes.js:64/91）。 */
  if (h === 'unary') {
    const op = nm === null ? null : String(nm.op?.value ?? '');
    const in0 = typeOfExpr(nm?.a, names, env);
    if (in0 === null) return null;
    if (op === '!') return { k: 'bool' };
    return in0;                                                      // `-` / `+` / `~` 不改种类
  }
  /* **成员访问**（`(field obj name)`，节点表 :58）：先给对象定型，是结构体/类就在它的成员表里
     查那个名字（`p.m_x` 里 p 是指针，先剥一层）。这一层照旧不查名 —— 聚合体那张表由调用方给。 */
  if (h === 'field') {
    const ot = typeOfExpr(nm?.obj, names, env);
    if (ot === null) return null;
    const base = ot.k === 'ptr' || ot.k === 'tptr' ? ot.target : ot;
    if (base === null || base === undefined) return null;
    if (base.k !== 'struct' && base.k !== 'class') return null;
    let rec;
    for (const r of env.values()) {
      if (r !== null && r !== undefined && r.agg !== undefined && r.name === base.name) { rec = r; break; }
    }
    if (rec === undefined) return null;
    const fn = nm === null ? null : nm.name;
    const fname = fn === null || fn === undefined ? null
      : (Array.isArray(fn.items) ? String(named(fn)?.text?.value ?? '') : String(fn.value ?? ''));
    if (fname === null || fname === '') return null;
    const mm = rec.agg.members.find((x) => x.name === fname);
    if (mm === undefined || mm.type === null) return null;
    return resolveType(mm.type, env).type;
  }
  if (h === 'binary') {
    const op = nm === null ? null : String(nm.op?.value ?? '');
    const a = typeOfExpr(nm?.a, names, env);
    const b = typeOfExpr(nm?.b, names, env);
    if (a === null || b === null) return null;
    if (CMP_OPS.has(op)) return { k: 'bool' };
    if (!ARITH_OPS.has(op)) return null;
    /* 算术：一边是实数就回实数，别的回那一边（整数提升那一格由方言自己管）。 */
    if (a.k === 'real' || b.k === 'real') return { k: 'real' };
    if (a.k === 'string' || b.k === 'string') return { k: 'string' };
    return a.k === 'int' && b.k === 'int' ? { k: 'int' } : null;
  }
  return null;
}
