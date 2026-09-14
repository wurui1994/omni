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
  CONV_CHAIN, NULL_BY_WANT, intLitRadix, isRealLit, intLitKind, truthyCode, castValue, ptrBinary,
} from './expr-table.js';
import { intBinary, intUnary, intConvCode } from './int-table.js';

/**
 * **转手账的兜底**：里头那一层已经记过账（`acctSeen` 数变了）就不再补一条 —— 先前一律补，
 * 于是尺子上最大的几堆全是"这一格还拼不出来"这种转手账，**真原因被自己盖住了**。
 * 里头**没**记那才是这一层的 bug，那时候才说话。
 */
function soft(ctx, n0, why) {
  if ((ctx.acctSeen?.() ?? 0) === n0) ctx.acct(`${why}（里头没记账 —— 这一层的 bug）`);
  return null;
}

/**
 * **贴着写的几格串字面量是一格串**（`"hello" ", " "world"`，第五十四刀）：jancy 的词法把它们
 * 并成一格（与 C 同）—— 树上是 `(concat a b)` 套起来的。所以这是一次**编译期折叠**：
 * 折得动答那一整串正文，里头有一格不是串字面量答 null。
 * printf 的格式串与 `string_t s = …` 两处问的是同一件事，所以只有这一份。
 */
export function strLitFold(n) {
  if (n === null || n === undefined || typeof n !== 'object') return null;
  if (!Array.isArray(n.items)) {
    return n.kind === 'string' && typeof n.value === 'string' ? n.value : null;
  }
  if (headOf(n) !== 'concat') return null;
  const nm = named(n);
  const a = strLitFold(nm?.a);
  const b = strLitFold(nm?.b);
  return a === null || b === null ? null : a + b;
}

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
    return { code: intConvCode(cur.code, cur.type, want), type: want, hoisted: cur.hoisted };
  }
  return cur;
}

/** 按节点头降（不过转换链）。 */
export function emitExpr0(n, want, ctx) {
  if (n === null || n === undefined) { ctx.acct('空的表达式'); return null; }
  /* 光一个记号：数或串。 */
  if (!Array.isArray(n.items)) {
    const s = String(n.value ?? '');
    /**
     * **字符串那一格记号的 `value` 是解好转义的正文**（`{ kind:'string', value:'abc',
     * raw:'"abc"' }` —— printf 那一层早就量过这件事）。所以判据是 `kind`，不是"开头有没有
     * 引号"：照引号判的话 `"abc"` 落到最后一行去了，报的是"认不出的字面量 'abc'"。
     * 发出去要**重新编码**（`JSON.stringify`）—— 方言那一侧收的是带引号的字面量。
     */
    if (n.kind === 'string') return { code: `(str ${JSON.stringify(s)})`, type: ctx.T.string };
    if (typeof n.value === 'string' && n.value.startsWith('"')) {
      return { code: `(str ${n.value})`, type: ctx.T.string };
    }
    const r = intLitRadix(s);
    if (r !== null && r.radix !== null) {
      /* **按基数直接进 BigInt**：`parseInt` 是双精度 —— `9007199254740993`（2^53+1）那一格
         过它就少 1（41-printf-len.jnc 量的正是这个数）。 */
      const pre = { 16: '0x', 2: '0b', 8: '0o', 10: '' }[r.radix] ?? '';
      const k = intLitKind(BigInt(`${pre}${r.digits}`));
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
  /**
   * **`'a'` 是一个整数，不是一格串**（第九十七刀）：jancy 的词法把单引号那一格做成整数记号，
   * 头一个字节**最重**、最多 8 个（jnc_ct_Lexer.cpp:186-197 的
   * `result |= *p << shift; shift -= 8`）。所以 `'a'` 是 97、`'ab'` 是 0x6162。
   * 类型按"装不下 32 位就 long"（`intLitKind` —— 与整数字面量同一条）。
   */
  if (h === 'char') {
    const s = String(nm.text?.value ?? '');
    const bytes = [...s].map((c) => c.codePointAt(0));
    if (bytes.some((b) => b > 0xff)) {
      ctx.acct(`字符字面量 '${s}' 里有多字节的字符（源码那一侧按字节数，这一层还没接）`); return null;
    }
    if (bytes.length > 8) { ctx.acct(`字符字面量 '${s}' 超过 8 个字节`); return null; }
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    const k = intLitKind(v);
    if (k.kind === null) { ctx.acct(`字符字面量：${k.why}`); return null; }
    return { code: `(int ${k.value})`, type: ctx.T[k.kind] };
  }
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
    const bytes = [...txt].slice(-8).map((c) => BigInt(c.charCodeAt(0) & 0xff));
    const v = bytes.reduce((acc, b) => acc * 256n + b, 0n);
    const k = intLitKind(v);
    return { code: `(int ${k.value})`, type: ctx.T[k.kind] };
  }
  if (h === 'paren') return emitExpr0(nm.inner, want, ctx);
  /* **三目**：方言里就是 `(sel 条件 真 假)`。两支都按 `want` 降（于是回卷、装箱那几条各自落位）。
     两支是**惰性**位置 —— errorcode 的落点在那儿要关掉（`ctx.lazy`，见 `EC_HOIST` 那条注）。 */
  if (h === 'cond') {
    const c = ctx.cond?.(nm.cond) ?? null;
    if (c === null) return null;
    const run = () => {
      const x = emitExpr(nm.then ?? nm.a, want, ctx);
      const y = emitExpr(nm.else ?? nm.b, want, ctx);
      return x === null || y === null ? null : { x, y };
    };
    const two = ctx.lazy === undefined ? run() : ctx.lazy(run);
    if (two === null) return null;
    return { code: `(sel ${c} ${two.x.code} ${two.y.code})`, type: two.x.type };
  }

  /* **裸名字**：九步查名（`NAME_LOOKUP_ORDER`）由注入的探子走完 —— 那是作用域图那一层。
     `this` 走的是同一格探子（它在方法体里就是第一个形参 `$this`，第五十二刀）。 */
  if (h === 'name' || h === 'this') {
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
    /* **`&&` / `||`**：两边各自真值化，结果是 bool（右边惰性 —— 方言的 `bin` 本来就是惰性节点）。
       **右边是惰性位置**：errorcode 的落点在那儿要关掉（`ctx.lazy`），不然传播那两句就成了
       "无条件先调一遍"，短路语义与求值顺序一起被改掉。 */
    if (op === '&&' || op === '||') {
      const c1 = ctx.cond?.(nm.a);
      const c2 = ctx.lazy === undefined ? ctx.cond?.(nm.b) : ctx.lazy(() => ctx.cond?.(nm.b));
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
    /**
     * **算符重载那一族**（第一百二十二 / 一百三十二 / 二百零二刀）：结构体与类上写了
     * `operator ==` / `operator !=` 那几格时，`x == y` 落成一句 `(call S$op$eq …)`。
     *
     * 这一问要排在**指针互比那一支之前**：那一支比的是地址（`peq`），而写了算符的那一格上
     * 用户的意思是"问那个算符" —— 排错了就是静默的错答案（两个不同的对象、内容相同时
     * 该说相等，比地址会说不相等，132-opcmp.jnc 的 C1 那一格摆着量这件事）。
     * 跟 `null` 比不走这条（那一问是"这一格在不在"，与内容相等不是一件事）。
     *
     * 别的算子（这一层还没接的那几个）照旧明说不收 —— 落到底下会静静地比地址。
     */
    if (!aNull && !bNull) {
      const ov = ctx.opBin?.(op, x, y);
      if (ov !== null && ov !== undefined) return ov;
    }
    if (ctx.opFor?.(op, x.type, y.type) === true) {
      ctx.acct(`'${op}' 落在 ${x.type?.k ?? '?'} 上是算符重载（还没接）`); return null;
    }
    if (ctx.isStruct?.(x.type) === true || ctx.isStruct?.(y.type) === true) {
      ctx.acct(`'${op}' 的一边是结构体（算符重载那一族）还没接`); return null;
    }
    /* **指针与类引用那一族**（跟 `null` 比走 `pisnull`、互比走 `peq`、算术走 `padd`/`psub`）：
       要排在整数那一支之前 —— `p + 1` 是指针算术，不是加法。 */
    if (ctx.isPtr?.(x.type) === true || ctx.isPtr?.(y.type) === true
      || ctx.isClass?.(x.type) === true || ctx.isClass?.(y.type) === true) {
      const r = ptrBinary({
        op, a: x, b: y, aNull, bNull, c: ctx,
      });
      if (r === null) { ctx.acct(`指针/类引用上的 '${op}' 还没接`); return null; }
      return r;
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
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.fieldOf?.(n, want);
    if (r === null || r === undefined) return soft(ctx, n0, '取字段这一格还拼不出来');
    return r;
  }
  if (h === 'index') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.elemOf?.(n, want);
    if (r === null || r === undefined) return soft(ctx, n0, '下标这一格还拼不出来');
    return r;
  }
  /* **取地址**（第九 / 二十四刀）：`&x` 里那一格 x 早就被提到一段自己的内存上了，所以这一句
     发的**就是那一格单元**（一个字都不算）。结构体与数组的名字里放的本来就是地址，同理。
     由调用方给（它知道谁提过、单元叫什么）。 */
  if (h === 'addr') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.addrOf?.(nm.a, want);
    if (r === null || r === undefined) return soft(ctx, n0, '取地址这一格还拼不出来');
    return r;
  }
  if (h === 'indirect') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.derefOf?.(n, want);
    if (r === null || r === undefined) return soft(ctx, n0, '解引用这一格还拼不出来');
    return r;
  }
  /* **强制转换**：目标类型由调用方解（那是类型那条腿），转法照 `castValue` 那张表。 */
  if (h === 'cast') {
    const to = ctx.typeNameOf?.(nm.type) ?? null;
    if (to === null) { ctx.acct('强制转换的目标类型还解不出来'); return null; }
    const v = emitExpr(nm.value, to, ctx);
    if (v === null) return null;
    const r = castValue(v, to, ctx);
    if (r === null) { ctx.acct(`把 ${v.type?.k ?? '?'} 转成 ${to.k} 还没接`); return null; }
    return r;
  }
  /* **`new T` / `new T[n]`**（第五十二 / 一百二十九刀）：出来的是一格**指针**。造出来那一段
     内存怎么算由调用方那一层给（它知道类的根、有没有 construct、`$tag` 写什么）。 */
  if (h === 'new' || h === 'new-array') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.newOf?.(n, want);
    if (r === null || r === undefined) return soft(ctx, n0, `\`${h}\` 这一格还拼不出来`);
    return r;
  }
  /* 调用：谁被调（普通函数 / 方法 / 函数指针 / 算符 / CRT 助手）差别全在被调那一侧，
     所以整格交给调用方那张表（`ctx.callOf`）。 */
  if (h === 'call') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.callOf?.(n, want);
    if (r === null || r === undefined) return soft(ctx, n0, '调用这一格还拼不出来');
    return r;
  }

  /* **`countof(x)`**（定长数组有多少格）：一格编译期常量，由调用方那一层答（它知道类型）。 */
  if (h === 'countof') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.countOf?.(nm.arg);
    if (r === null || r === undefined) return soft(ctx, n0, 'countof 这一格还拼不出来');
    return r;
  }

  /* **赋值当表达式用**（`return m_i = v + 1;`、链式 `a = b = c`）：方言里赋值是一条语句，
     所以那一格落成"写进去再答那个值"的一次调用 —— 由调用方那一层给（它知道地址与助手）。 */
  if (h === 'assign') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.asgnExpr?.(n, want);
    if (r === null || r === undefined) return soft(ctx, n0, '赋值当表达式用还拼不出来');
    return r;
  }

  /**
   * **`try <表达式>`**（第五十九刀，exceptions.rst:60）：`try` 把那一格的**往上传关掉** ——
   * 算出来的值（可能正是那个出错值）原样交出去，由写的人自己比（`z == null`）。
   * 旧降级发的就是一句光的调用（124-errcptr.jnc 的 `(let a (ptr Entry) (call make (int 3)))`）。
   */
  if (h === 'try-expr') {
    const n0 = ctx.acctSeen?.() ?? 0;
    if (ctx.noEc === undefined) { ctx.acct('`try <表达式>` 这一格还没接'); return null; }
    const r = ctx.noEc(() => emitExpr(nm.a, want, ctx));
    if (r === null || r === undefined) return soft(ctx, n0, '`try` 底下那一格还拼不出来');
    return r;
  }

  /* **贴着写的几格串字面量**（`"hello" ", " "world"`）：折成一格串再发。折不动的
     （里头有一格不是串字面量）是"运行期拼接"那一族，还没接 —— 记账。 */
  if (h === 'concat') {    const s = strLitFold(n);
    if (s === null) { ctx.acct('串拼接：里头不是清一色的串字面量（那一族还没接）'); return null; }
    return { code: `(str ${JSON.stringify(s)})`, type: ctx.T.string };
  }
  /* **格式化字面量**（`$"n = $n"`，第二百刀）：产出的是**一格字符串的值**（literals.rst:62）——
     里头 `$名字` / `$(表达式)` 要按位置再解析一遍，所以整格交给调用方那一层（`ctx.fmtOf`）。 */
  if (h === 'fmt') {
    const n0 = ctx.acctSeen?.() ?? 0;
    const r = ctx.fmtOf?.(n);
    if (r === null || r === undefined) return soft(ctx, n0, '格式化字面量这一格还拼不出来');
    return r;
  }

  ctx.acct(`表里没有这一格表达式：${h}`);
  return null;
}
