// src/lang/jnc/const-eval.js —— 一格**常量表达式**算出来（数组长度那一族要它）
//
// 语料里的数组长度经常不是字面量，而是枚举项算出来的：
//   `char m_pad[ReportSize - 1];`         （179-structnested.jnc，源出 HID 那份 OutputReport）
//   `char m_pad2[Kind.Some + 3];`
//   `ui.Action* m_actionTable[ActionId._Count];`（178-nestedenumlen.jnc，源出 FileSession.jnc:62）
//
// 所以这一层要能算：整数字面量、枚举项（裸名与 `枚举名.项`）、`+ - * / %`、一元 `-`、括号。
// 算不出来的**答 null**（调用方记账，不猜）—— 与别的读取器同一条规矩。
//
// 常量从环境来：`env.get(名字)` 里 `{ kind: 'const', value }` 那一格（枚举项由
// `enumConsts` 填，项没写值就按"上一格 + 1"，从 0 起 —— jancy 与 C 同一条）。

import { headOf, named } from './adapt.js';
import { readEnum } from './agg.js';
import { nameText, allInChain } from './declare.js';

/** 一格常量表达式的值；算不出来答 null。 */
export function evalConst(node, env, depth = 0) {
  if (node === null || node === undefined || depth > 16) return null;
  if (!Array.isArray(node.items)) {                       // 光一个记号
    const n = Number(node.value);
    return Number.isFinite(n) ? n : lookupConst(String(node.value), env);
  }
  const h = headOf(node);
  const nm = named(node);
  if (h === 'char') {
    /* **`'a'` 是一个整数**（第九十七刀）。jancy 的词法把它做成 `TokenKind_Integer`：
       头一个字节**最重**、最多 8 个字节，多出来的截掉（jnc_ct_Lexer.cpp:186-197）——
       所以 `'a'` 是 97、`'ab'` 是 0x6162。少这一条，`int g_alpha['z' - 'a' + 1];`
       的长度就算不出来（88-charlit.jnc）。 */
    const txt = nm === null || nm.tok === undefined || nm.tok === null
      ? String(node.items?.[1]?.value ?? '') : String(nm.tok.value ?? '');
    const bytes = [...txt].slice(-8).map((c) => c.charCodeAt(0) & 0xff);
    if (bytes.length === 0) return 0;                          // `'\0'` 那一格
    return bytes.reduce((acc, b) => acc * 256 + b, 0);
  }
  if (h === 'name') return lookupConst(nameText(node) ?? '', env);
  if (h === 'qualified' && nm !== null) {
    /* `Kind.Some` / `ActionId._Count`：先试"枚举名.项"，再退回光一个项名
       （无名枚举的项在外层直接可见 —— 第九十六刀）。 */
    const left = nameText(nm.left) ?? '';
    const right = nm.right !== undefined && nm.right !== null ? String(nm.right.value ?? '') : '';
    const q = lookupConst(`${left}.${right}`, env);
    return q === null ? lookupConst(right, env) : q;
  }
  if (h === 'field' && nm !== null) {
    /* `Kind.Some` 在**表达式位置**是 `field`（`expr "." member`），不是 `qualified` ——
       那是产生式的差别，不是意思的差别。少这一条，`m_pad2[Kind.Some + 3]` 就算不出来。 */
    const left = nameText(nm.obj) ?? '';
    const right = nm.name !== undefined && nm.name !== null ? String(nm.name.value ?? '') : '';
    const q = lookupConst(`${left}.${right}`, env);
    return q === null ? lookupConst(right, env) : q;
  }
  if (h === 'binary' && nm !== null) {
    const op = nm.op === undefined || nm.op === null ? '' : String(nm.op.value ?? '');
    const a = evalConst(nm.a, env, depth + 1);
    const b = evalConst(nm.b, env, depth + 1);
    if (a === null || b === null) return null;
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    if (op === '/') return b === 0 ? null : Math.trunc(a / b);
    if (op === '%') return b === 0 ? null : a % b;
    if (op === '<<') return a << b;
    if (op === '>>') return a >> b;
    if (op === '|') return a | b;
    if (op === '&') return a & b;
    return null;
  }
  if (h === 'unary' && nm !== null) {
    const op = nm.op === undefined || nm.op === null ? '' : String(nm.op.value ?? '');
    const a = evalConst(nm.a, env, depth + 1);
    if (a === null) return null;
    if (op === '-') return -a;
    if (op === '+') return a;
    if (op === '~') return ~a;
    return null;
  }
  /* 别的形状（调用、字段…）不算常量 —— 那正是"长度不是字面量"该记的账。 */
  return null;
}

/** 环境里的常量。 */
function lookupConst(name, env) {
  const e = env === undefined || env === null ? undefined : env.get(name);
  return e !== undefined && e.kind === 'const' && Number.isFinite(e.value) ? e.value : null;
}

/**
 * 把一格 `enum` 的项塞进环境（**两个键**：`项名` 与 `枚举名.项名`）。
 * 没写值的项按"上一格 + 1"，从 0 起。写了值但算不出来的那一格**断链** —— 后面的项也不猜。
 */
export function enumConsts(enumNode, env) {
  const e = readEnum(enumNode);
  if (e === null) return;
  const ename = nameText(e.name);
  let next = 0;
  for (const it of e.items) {
    let v = null;
    if (it.value === null || it.value === undefined) v = next;
    else v = evalConst(it.value, env);
    if (v === null) { next = NaN; continue; }               // 断了就断了，不往下猜
    next = v + 1;
    if (it.name !== null) {
      env.set(it.name, { kind: 'const', value: v });
      if (ename !== null) env.set(`${ename}.${it.name}`, { kind: 'const', value: v });
    }
  }
}

/** 顺手：把一棵树里所有 `enum` 的项都塞进环境（尺子与降级都要先做这一步）。 */
export function collectEnumConsts(tree, env) {
  const visit = (n) => {
    if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
    if (headOf(n) === 'enum') enumConsts(n, env);
    for (const it of n.items) visit(it);
  };
  visit(tree);
  void allInChain;
}
