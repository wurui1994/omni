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
  CONV_CHAIN, NULL_BY_WANT, intLitRadix, isRealLit, intLitKind, truthyCode,
} from './expr-table.js';
import { intBinary, intUnary, intConvCode } from './int-table.js';

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
  /* **落进一格**只做"整数转到那一格"这一件事（`intConv`：同宽同符号一个字都不发）。
     回卷**不在这儿** —— 它发生在算子那一处（`intBinary` / `intUnary`）。先前这一层把
     "掩一次"挂在这里（`wide`），于是 `f(x)` 与 `return x` 多掩一圈、`x / 2` 少掩一圈。 */
  if (ctx.isInt?.(want) === true && ctx.isInt?.(cur.type) === true) {
    return { code: intConvCode(cur.code, cur.type, want), type: want };
  }
  return cur;
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
    const c = ctx.cond?.(nm.cond) ?? null;
    if (c === null) return null;
    const a2 = emitExpr(nm.then ?? nm.a, want, ctx);
    const b2 = emitExpr(nm.else ?? nm.b, want, ctx);
    if (a2 === null || b2 === null) return null;
    return { code: `(sel ${c} ${a2.code} ${b2.code})`, type: a2.type };
  }

  /* **裸名字**：九步查名（`NAME_LOOKUP_ORDER`）由注入的探子走完 —— 那是作用域图那一层。 */
  if (h === 'name') {
    const r = ctx.lookup(n, want);
    if (r === null) return null;                                     // 探子自己记过账
    return r;
  }

  /* 一元与二元：方言里就是 `(un "op" a)` 与 `(bin "op" a b)`。整数那一族的三步（提升、
     两边转到同一格、算完掩）由 `int-table.js` 那两格纯函数办 —— 那是规则，不是这层的活。 */
  if (h === 'unary') {
    const op = String(nm.op?.value ?? '');
    /* `!x` 先**真值化**再取反（`!p` / `!n` 在 jancy 与 C 里都成立）。 */
    if (op === '!') {
      const a0 = emitExpr(nm.a, ctx.T?.bool ?? null, ctx);
      if (a0 === null) return null;
      const t0 = truthyCode(a0.code, a0.type, ctx);
      if (t0 === null) { ctx.acct("'!' 的操作数当条件用还拼不出来"); return null; }
      return { code: `(un "!" ${t0})`, type: ctx.T.bool };
    }
    const a = emitExpr(nm.a, ctx.wantOf?.(n, 'a') ?? null, ctx);
    if (a === null) return null;
    /* 枚举落到基整数上再算（第四十七刀）—— `!` 不走这儿（上面那一支管）。 */
    const a1 = ctx.isEnum?.(a.type) === true && a.type.base !== undefined
      ? { code: a.code, type: a.type.base } : a;
    if (ctx.isInt?.(a1.type) === true) {
      const r = intUnary(op, a1);
      if (r === null) { ctx.acct(`一元 '${op}' 还没接`); return null; }
      return r;
    }
    const t = ctx.typeOfUnary?.(op, a1.type) ?? a1.type;
    return { code: `(un ${JSON.stringify(op)} ${a1.code})`, type: t };
  }
  if (h === 'binary') {
    const op = String(nm.op?.value ?? '');
    const CMP = ['==', '!=', '<', '<=', '>', '>='];
    /* **`&&` / `||`**：两边各自真值化，结果是 bool（右边惰性 —— 方言的 `bin` 本来就是惰性节点）。 */
    if (op === '&&' || op === '||') {
      const c1 = ctx.cond?.(nm.a);
      const c2 = ctx.cond?.(nm.b);
      if (c1 === null || c1 === undefined || c2 === null || c2 === undefined) return null;
      return { code: `(bin ${JSON.stringify(op)} ${c1} ${c2})`, type: ctx.T.bool };
    }
    /* **`x == null` 里 `null` 的类型从另一边来**：`null` 自己没有类型（见 `NULL_BY_WANT`），
       所以两边有一边是它时，先降另一边、拿那一边的类型当 `want`。 */
    const aNull = headOf(nm.a) === 'null';
    const bNull = headOf(nm.b) === 'null';
    let a = null;
    let b = null;
    if (bNull && !aNull) {
      a = emitExpr(nm.a, ctx.wantOf?.(n, 'a') ?? null, ctx);
      if (a === null) return null;
      b = emitExpr(nm.b, a.type, ctx);
    } else if (aNull && !bNull) {
      b = emitExpr(nm.b, ctx.wantOf?.(n, 'b') ?? null, ctx);
      if (b === null) return null;
      a = emitExpr(nm.a, b.type, ctx);
    } else {
      a = emitExpr(nm.a, ctx.wantOf?.(n, 'a') ?? null, ctx);
      b = emitExpr(nm.b, ctx.wantOf?.(n, 'b') ?? null, ctx);
    }
    if (a === null || b === null) return null;
    const cmp = CMP.includes(op);
    /* 枚举与整数混算：先落到基整数上（枚举 → 整数是隐式的）。两个同型枚举比就地比。 */
    let x = a;
    let y = b;
    if (ctx.isEnum?.(x.type) === true || ctx.isEnum?.(y.type) === true) {
      if (ctx.isEnum(x.type) && ctx.isEnum(y.type) && x.type.name === y.type.name && cmp) {
        return { code: `(bin ${JSON.stringify(op)} ${x.code} ${y.code})`, type: ctx.T.bool };
      }
      if (ctx.isEnum(x.type) && x.type.base !== undefined) x = { code: x.code, type: x.type.base };
      if (ctx.isEnum(y.type) && y.type.base !== undefined) y = { code: y.code, type: y.type.base };
    }
    /* **bool 参与整数运算**（第三十七刀）：提升表里 bool 落到 i32，所以 `(a > 0) + 1`
       是 int 上的加法。两个 bool 比相等是例外（方言的 bool 比较本来就精确）。 */
    const bothBoolEq = ctx.isBool?.(x.type) === true && ctx.isBool?.(y.type) === true
      && (op === '==' || op === '!=');
    if (!bothBoolEq) {
      if (ctx.isBool?.(x.type) === true && (ctx.isInt?.(y.type) === true || ctx.isBool?.(y.type) === true)) {
        x = { code: `(sel ${x.code} (int 1) (int 0))`, type: { k: 'int', w: 32, u: false } };
      }
      if (ctx.isBool?.(y.type) === true && ctx.isInt?.(x.type) === true) {
        y = { code: `(sel ${y.code} (int 1) (int 0))`, type: { k: 'int', w: 32, u: false } };
      }
    }
    if (ctx.isInt?.(x.type) === true && ctx.isInt?.(y.type) === true) {
      const r = intBinary(op, x, y, cmp);
      return { code: r.code, type: cmp ? ctx.T.bool : r.type };
    }
    /* 一边整数一边实数：加宽整数那一边。 */
    if (ctx.isInt?.(x.type) === true && ctx.isReal?.(y.type) === true) {
      x = { code: ctx.realOf(x.code, x.type), type: y.type };
    } else if (ctx.isReal?.(x.type) === true && ctx.isInt?.(y.type) === true) {
      y = { code: ctx.realOf(y.code, y.type), type: x.type };
    }
    const t = ctx.typeOfBinary?.(op, x.type, y.type) ?? x.type;
    return { code: `(bin ${JSON.stringify(op)} ${x.code} ${y.code})`, type: t };
  }

  /* 取字段、下标与解引用：地址那一层由调用方给（`ctx.fieldOf` / `ctx.elemOf` / `ctx.derefOf`）
     —— 那几格要知道"这一格是类还是结构体、放的是地址还是内嵌"，属于类型那条腿。
     `p->f` 与 `s.f` 落在**同一格**（第二十五刀：`.` 与 `->` 在 jancy 里是同一个算符）。 */
  if (h === 'field' || h === 'ptr-field') {
    const r = ctx.fieldOf?.(n, want);
    if (r === null || r === undefined) { ctx.acct('取字段这一格还拼不出来'); return null; }
    return r;
  }
  if (h === 'index') {
    const r = ctx.elemOf?.(n, want);
    if (r === null || r === undefined) { ctx.acct('下标这一格还拼不出来'); return null; }
    return r;
  }
  if (h === 'indirect') {
    const r = ctx.derefOf?.(n, want);
    if (r === null || r === undefined) { ctx.acct('解引用这一格还拼不出来'); return null; }
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
