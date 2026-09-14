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
/* 位宽那张表只有一处家（`resolve-type.js` 的 `INT_BITS`）。两份模块互相 import 是**成环**的，
   可这一格只在**调用时**才用到它（不在模块体里），所以环是安全的 —— 换成再抄一份表才是错。 */
import { INT_BITS } from './resolve-type.js';

/**
 * 一格常量表达式的值；算不出来答 null。
 *
 * 值是 **BigInt**（不是 JS 的 number）：`bitflag enum … : uint64_t` 里
 * `Top = 0x8000000000000000` 这一格用双精度存下来印出来是 `9223372036854776000`
 * —— 少了最后三位。字面量那一层本来就是 BigInt（`intLitKind`），常量这一层跟它对齐。
 */
export function evalConst(node, env, depth = 0) {
  if (node === null || node === undefined || depth > 16) return null;
  if (!Array.isArray(node.items)) {                       // 光一个记号
    const s = String(node.value);
    if (/^0[xX][0-9a-fA-F]+$/.test(s) || /^[0-9]+$/.test(s)) return BigInt(s);
    return lookupConst(s, env);
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
    const bytes = [...txt].slice(-8).map((c) => BigInt(c.charCodeAt(0) & 0xff));
    if (bytes.length === 0) return 0n;                         // `'\0'` 那一格
    return bytes.reduce((acc, b) => acc * 256n + b, 0n);
  }
  if (h === 'name') return lookupConst(nameText(node) ?? '', env);
  /* `true` / `false` 各是一格节点（节点表 :184），不是名字 —— `Zero = false` 要这一条。 */
  if (h === 'true') return 1n;
  if (h === 'false') return 0n;
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
  if (h === 'paren' && nm !== null) return evalConst(nm.inner, env, depth + 1);
  if (h === 'binary' && nm !== null) {
    const op = nm.op === undefined || nm.op === null ? '' : String(nm.op.value ?? '');
    const a = evalConst(nm.a, env, depth + 1);
    const b = evalConst(nm.b, env, depth + 1);
    if (a === null || b === null) return null;
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    if (op === '/') return b === 0n ? null : a / b;
    if (op === '%') return b === 0n ? null : a % b;
    if (op === '<<') return a << b;
    if (op === '>>') return a >> b;
    if (op === '|') return a | b;
    if (op === '&') return a & b;
    if (op === '^') return a ^ b;
    /* **比较与逻辑那两族也是常量**（`Cmp = 3 > 2` 在 45-constfold.jnc 里就是枚举项的值）：
       结果是 1 / 0 —— C 与 jancy 同（`bool` 底下就是 int8）。 */
    if (op === '>') return a > b ? 1n : 0n;
    if (op === '<') return a < b ? 1n : 0n;
    if (op === '>=') return a >= b ? 1n : 0n;
    if (op === '<=') return a <= b ? 1n : 0n;
    if (op === '==') return a === b ? 1n : 0n;
    if (op === '!=') return a !== b ? 1n : 0n;
    if (op === '&&') return a !== 0n && b !== 0n ? 1n : 0n;
    if (op === '||') return a !== 0n || b !== 0n ? 1n : 0n;
    return null;
  }
  if (h === 'unary' && nm !== null) {
    const op = nm.op === undefined || nm.op === null ? '' : String(nm.op.value ?? '');
    const a = evalConst(nm.a, env, depth + 1);
    if (a === null) return null;
    if (op === '-') return -a;
    if (op === '+') return a;
    if (op === '~') return ~a;
    if (op === '!') return a === 0n ? 1n : 0n;
    return null;
  }
  /* 别的形状（调用、字段…）不算常量 —— 那正是"长度不是字面量"该记的账。 */
  return null;
}

/** 环境里的常量。`true` / `false` 也算 —— jancy 的 bool 底下就是 int8（`Zero = false`）。 */
function lookupConst(name, env) {
  if (name === 'true') return 1n;
  if (name === 'false') return 0n;
  const e = env === undefined || env === null ? undefined : env.get(name);
  return e !== undefined && e.kind === 'const' && typeof e.value === 'bigint' ? e.value : null;
}

/**
 * 把一格 `enum` 的项塞进环境（**两个键**：`项名` 与 `枚举名.项名`）。
 *
 * 三条规则，都不是随手定的：
 *   - 普通枚举：没写值的按"上一格 + 1"，从 0 起（jancy 与 C 同）；
 *   - **`bitflag enum`**（第四十七刀）：取值序列是 1 / 2 / 4 / 8 —— 照抄
 *     `calcBitflagEnumConstValues`（jnc_ct_EnumType.cpp:286-306）那一句
 *     `value = value ? 2 << getHiBitIdx64(value) : 1`：**不是乘二**，是"最高位再往上一位"，
 *     所以显式写了 `0x30`（两个位）之后下一个也是 `0x40`。下一格按**无符号那一面**算
 *     （第一百四十二刀）：`0x8000000000000000` 在 64 位里就是最高位，按 signed 看是负数，
 *     而 jancy 的 `getHiBitIdx64` 收的是 `uint64_t` —— 它从来没见过负数；
 *   - 每一格都**按底类型的宽度与符号性折一下**（`wrapVal`）：`Top = 0x8000000000000000`
 *     存进 64 位有符号那一格就是 `-9223372036854775808`，印出来正是这个数。
 *
 * 写了值但算不出来的那一格**断链** —— 后面的项也不猜。
 */
export function enumConsts(enumNode, env) {
  const e = readEnum(enumNode);
  if (e === null) return;
  const ename = nameText(e.name);
  const bits = String(e.word ?? '').includes('bitflag');
  const { w, u } = enumBase(e.base);
  /* **bitflag 的头一格是 1**，不是 0（`calcBitflagEnumConstValues` 里那个 `: 1`）——
     普通枚举从 0 起。 */
  let next = bits ? 1n : 0n;
  let broke = false;
  for (const it of e.items) {
    let v = null;
    if (it.value === null || it.value === undefined) v = broke ? null : next;
    else v = evalConst(it.value, env);
    if (v === null) { broke = true; continue; }               // 断了就断了，不往下猜
    broke = false;
    const val = wrapVal(v, w, u);
    if (!bits) next = v + 1n;
    else {
      const uv = v < 0n ? v + (1n << BigInt(w)) : v;
      next = uv === 0n ? 1n : 2n ** BigInt(uv.toString(2).length);
    }
    if (it.name !== null) {
      env.set(it.name, { kind: 'const', value: val, enum: ename });
      if (ename !== null) env.set(`${ename}.${it.name}`, { kind: 'const', value: val, enum: ename });
    }
  }
}

/** 枚举的**底类型**（`enum E: uint64_t` 那一格）：答它的位宽与符号性，没写就是 32 位有符号。 */
export function enumBase(base) {
  if (base === null || base === undefined) return { w: 32, u: false };
  /* 那一格里躺的是一格类型说明符 —— 只要它头一个**记号的文字**（`uint64_t` / `char` …）。 */
  let word = null;
  const dig = (n) => {
    if (word !== null || n === null || n === undefined) return;
    if (!Array.isArray(n.items)) { if (typeof n.value === 'string' && /^[A-Za-z_]/.test(n.value)) word = n.value; return; }
    for (const it of n.items.slice(1)) dig(it);
  };
  dig(base);
  if (word === null) return { w: 32, u: false };
  const u = /^(uint|uchar|ushort|ulong)/.test(word)
    || ['byte_t', 'word_t', 'dword_t', 'qword_t', 'size_t'].includes(word);
  return { w: INT_BITS[word] ?? 32, u };
}

/** 一格整数按 `w` 位、有/无符号折一下（枚举项存进底类型那一格时就是这一步）。 */
function wrapVal(v, w, u) {
  return u ? BigInt.asUintN(w, v) : BigInt.asIntN(w, v);
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
