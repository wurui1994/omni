// src/lang/jnc/emit-expr.js —— **表达式驱动**：照 `expr-table.js` 那几张表把一格表达式降成方言文字
//
// 分两层，与旧降级同一个分法：
//   - `emitExpr0`：**按节点头**降出一格 `{ code, type }`（字面量、`null`、名字、一元/二元、
//     取字段、下标、调用…）；
//   - `emitExpr` ：在它外面过一遍**隐式转换链**（`CONV_CHAIN` —— 次序就是规则）。
//
// 名字那一层不在这儿：裸名字要走 `NAME_LOOKUP_ORDER` 那九步，探子由调用方注入
// （`ctx.lookup`）—— 真正的作用域图在 `bind.js`。类型判据也由调用方给（`ctx.is*`），
// 这一层只认"形状 → 文字"。认不出的**答 null 并记账**，绝不猜。

import { headOf, named } from './adapt.js';
import {
  CONV_CHAIN, NULL_BY_WANT, intLitRadix, isRealLit, intLitKind,
} from './expr-table.js';

/** 一格表达式 → `{ code, type }`（过转换链）。拼不出来答 null。 */
export function emitExpr(n, want, ctx) {
  const v = emitExpr0(n, want, ctx);
  if (v === null) return null;
  let cur = v;
  for (const rule of CONV_CHAIN) {
    if (!rule.when(cur, want, ctx)) continue;
    const next = rule.emit(cur, want, ctx);
    if (next === null) { ctx.acct(`${rule.why}：拼不出来`); return null; }
    cur = next;
    /* 数组退化那一格之后还要接着往下问（int→real 那几条也可能命中）；别的几条互斥，
       命中一条就够 —— 与旧降级那串 `if` 一一对应（那儿也是退化在最前、别的顺次问）。 */
    if (rule.name !== 'array-decay') break;
  }
  /* **回卷发生在"落进一格"的时候**，不是在算符上（尺子当场量出来的：`return x + y` 回卷了，
     可 `n % 2 == 0` 里那个 `%` 没有 —— 前者要落回 32 位的返回类型，后者只是比较的操作数）。
     所以这一句挂在**要一个具体类型**的这一层：`want` 是窄整数时掩一次。 */
  /* 落进一格：`wide` 的那一格在这儿掩（`want` 说不出类型时就按它自己的位宽掩）。 */
  if (cur.wide === true) {
    const w = ctx.wrap?.(cur.code, want ?? cur.type, cur.type);
    return { code: w ?? cur.code, type: cur.type };
  }
  const wrapped = ctx.wrap?.(cur.code, want, cur.type);
  return wrapped === undefined || wrapped === null ? cur : { code: wrapped, type: cur.type };
}

/** 按节点头降（不过转换链）。 */
export function emitExpr0(n, want, ctx) {
  if (n === null || n === undefined) { ctx.acct('空的表达式'); return null; }
  /* 光一个记号：数或串。 */
  if (!Array.isArray(n.items)) {
    const s = String(n.value ?? '');
    if (typeof n.value === 'string' && n.value.startsWith('"')) {
      return { code: `(str ${n.value})`, type: ctx.T.string };
    }
    const r = intLitRadix(s);
    if (r !== null && r.radix !== null) {
      const k = intLitKind(BigInt(parseInt(r.digits, r.radix).toString()));
      if (k.kind === null) { ctx.acct(`整数字面量：${k.why}`); return null; }
      return { code: `(int ${k.value})`, type: ctx.T[k.kind] };
    }
    if (isRealLit(s)) return { code: `(real ${s})`, type: ctx.T.real };
    ctx.acct(`认不出的字面量 '${s}'`);
    return null;
  }

  const h = headOf(n);
  const nm = named(n) ?? {};

  if (h === 'true') return { code: '(bool true)', type: ctx.T.bool };
  if (h === 'false') return { code: '(bool false)', type: ctx.T.bool };
  /* **`null` 按左边要什么定型**（六格按次序，最后一格是"问不出来"）。 */
  if (h === 'null') {
    for (const rule of NULL_BY_WANT) {
      if (!rule.when(want, ctx)) continue;
      const code = rule.emit(want, ctx);
      if (code === null) { ctx.acct('null 得从左边知道自己是哪种指针（这里问不出来）'); return null; }
      return { code, type: rule.name === 'string' ? ctx.T.string : want };
    }
    return null;
  }
  /* `'a'` 是一个整数（第九十七刀）：头一个字节最重、最多 8 个字节。 */
  if (h === 'char') {
    const txt = String(nm.tok?.value ?? '');
    const bytes = [...txt].slice(-8).map((c) => c.charCodeAt(0) & 0xff);
    const v = bytes.reduce((acc, b) => acc * 256 + b, 0);
    const k = intLitKind(BigInt(v));
    return { code: `(int ${k.value})`, type: ctx.T[k.kind] };
  }
  if (h === 'paren') return emitExpr0(nm.inner, want, ctx);
  /* **三目**：方言里就是 `(sel 条件 真 假)`。两支都按 `want` 降（于是回卷、装箱那几条各自落位）。
     两支是**惰性**位置 —— errorcode 的落点在那儿要关掉（见 `EC_HOIST` 那条注）。 */
  if (h === 'cond') {
    const c = ctx.condOf?.(nm.cond) ?? ctx.expr?.(nm.cond);
    const a2 = emitExpr(nm.then ?? nm.a, want, ctx);
    const b2 = emitExpr(nm.else ?? nm.b, want, ctx);
    if (c === null || c === undefined || a2 === null || b2 === null) return null;
    return { code: `(sel ${c} ${a2.code} ${b2.code})`, type: a2.type };
  }

  /* **裸名字**：九步查名（`NAME_LOOKUP_ORDER`）由注入的探子走完 —— 那是作用域图那一层。 */
  if (h === 'name') {
    const r = ctx.lookup(n, want);
    if (r === null) return null;                                     // 探子自己记过账
    return r;
  }

  /* 一元与二元：方言里就是 `(un "op" a)` 与 `(bin "op" a b)`。两边要什么由调用方定型
     （`ctx.wantOf` 答"这一格算符两边该要什么"），定不出来就照原样降。 */
  if (h === 'unary') {
    const a = emitExpr(nm.a, ctx.wantOf?.(n, 'a') ?? null, ctx);
    if (a === null) return null;
    const op = String(nm.op?.value ?? '');
    const t = ctx.typeOfUnary?.(op, a.type) ?? a.type;
    return { code: `(un ${JSON.stringify(op)} ${a.code})`, type: t };
  }
  if (h === 'binary') {
    const a = emitExpr(nm.a, ctx.wantOf?.(n, 'a') ?? null, ctx);
    const b = emitExpr(nm.b, ctx.wantOf?.(n, 'b') ?? null, ctx);
    if (a === null || b === null) return null;
    const op = String(nm.op?.value ?? '');
    const t = ctx.typeOfBinary?.(op, a.type, b.type) ?? a.type;
    /* **"还没掩的那一格"**（`wide`）：会溢出的算符（`+ - * <<`）出来的值超出了那一格的位宽，
       到了**要它落进一格**的地方才掩 —— 落进返回类型、落进一格变量、或**再喂给一次算术**
       （算术要求两边同型）。缩小的那几个（`/ % & | ^ >>`）与比较不产生 wide：
       `n % 2 == 0` 里那个 `%` 一个字都不掩，而 `a + b + c` 里内层那个 `a+b` 掩一次。 */
    const ac = a.wide === true ? (ctx.wrap?.(a.code, a.type, a.type) ?? a.code) : a.code;
    const bc = b.wide === true ? (ctx.wrap?.(b.code, b.type, b.type) ?? b.code) : b.code;
    const code = `(bin ${JSON.stringify(ctx.opOf?.(op, t) ?? op)} ${ac} ${bc})`;
    return { code, type: t, wide: ctx.overflows?.(op) === true };
  }

  /* 取字段与下标：地址那一层由调用方给（`ctx.fieldOf` / `ctx.elemOf`）—— 那两格要知道
     "这一格是类还是结构体、放的是地址还是内嵌"，属于类型那条腿。 */
  if (h === 'field') {
    const r = ctx.fieldOf?.(n, want);
    if (r === null || r === undefined) { ctx.acct('取字段这一格还拼不出来'); return null; }
    return r;
  }
  if (h === 'index') {
    const r = ctx.elemOf?.(n, want);
    if (r === null || r === undefined) { ctx.acct('下标这一格还拼不出来'); return null; }
    return r;
  }
  /* 调用：谁被调（普通函数 / 方法 / 函数指针 / 算符 / CRT 助手）差别全在被调那一侧，
     所以整格交给调用方那张表（`ctx.callOf`）。 */
  if (h === 'call') {
    const r = ctx.callOf?.(n, want);
    if (r === null || r === undefined) { ctx.acct('调用这一格还拼不出来'); return null; }
    return r;
  }

  ctx.acct(`表里没有这一格表达式：${h}`);
  return null;
}
