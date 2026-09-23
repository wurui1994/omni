// src/core/lower/fmt.js —— **公共降级器的格式串**（ADR-0044，搬自 src/lang/common/fmt.js）
//
// 家在公共这一层（ADR-0031 轴 B）：`%08.3f` 该长什么样是**C 的规矩**，不是 jancy 的 ——
// C 前端那一侧要印格式串时读的该是同一份。方言长出"格式化"那一格之后（ADR-0031 §3 第五条），
// 这一整份塌成一次调用。
//
// 从旧降级 `fmtRun`（`frontend-jnc/lower.js:11847-11930`）读出来。分出来的理由是
// **"算法只该有一处家"**：`printf("%08.3f", x)` 与 `$"%08.3f"(x)` 该长什么样必须一个字不差
// （第六十一刀那次 `q /= three` 的教训就是同一个形状 —— 两处各写一遍，其中一处写错）。
//
// 两种口径：
//   - `'stmt'`：按 `\n` 把格式串**切成若干段**，带换行的段发 `(print …)`（它自带换行），
//     末段没有换行时发 `(write …)`。`printf` 走这条，回的是**几行语句**；
//   - `'str'` ：一个都不切（换行就是串里的一个字符），整条拼成**一格字符串的代码**。
//     格式化字面量 `$"…"` 走这条 —— 它产出的是一格值（literals.rst:62），不是一次输出。

import { intConvCode } from './int.js';
import { STR, typeOf } from './ty-of.js';

/** 段里那几块（字符串常量与 `(tostr …)`）拼起来：**左结合**的 `(bin "+" …)`。 */
export function joinPieces(pieces) {
  if (pieces.length === 0) return null;
  let code = pieces[0];
  for (let k = 1; k < pieces.length; k += 1) code = `(bin "+" ${code} ${pieces[k]})`;
  return code;
}

/**
 * 格式化字面量里**没写 spec** 时按静态类型挑的那个转换字母（jancy 的 Parser.cpp:3670-3691）：
 * 整数 ≤4 字节 `d` / `u`、64 位 `lld` / `llu`、浮点 `f`、字符串 `s`；别的答 null（jancy 那儿
 * 也是一句 "don't know how to format"）。bool 一字节，所以是 `d`。
 */
export function fmtDefault(t) {
  if (t === null || t === undefined) return null;
  if (t.k === 'real') return 'f';
  if (t.k === 'string') return 's';
  if (t.k === 'bool') return 'd';
  const b = t.k === 'enum' ? (t.base ?? null) : t;
  if (b !== null && b.k === 'int') return b.w <= 32 ? (b.u ? 'u' : 'd') : (b.u ? 'llu' : 'lld');
  return null;
}

/**
 * spec 与默认字母并起来（`prepareFormatString`，CoreLib.cpp:702-723）：没写就是 `%` 加默认；
 * 写了但开头不是 `%` 就补一个；**末尾不是字母**时把默认那个字母接上（`8` → `%8d`）。
 */
export function fmtMergeSpec(spec, dflt) {
  if (spec === null) return `%${dflt}`;
  const s = spec.startsWith('%') ? spec : `%${spec}`;
  return /[A-Za-z]$/.test(s) ? s : s + dflt;
}

/**
 * `$(…)` / `%(…)` 那一格的范围（词法那儿 `lit_fmt_opener` 收 `(` 与 `{` 两种，Lexer.rl:132）。
 * **顶层第一个 `;` 后面是 spec**（Lexer.rl:455 的 onSemicolon 切到 lit_fmt_expr_spec）。
 * 括号没配上答 null。
 */
export function fmtSplitSite(s, open) {
  const closer = s[open] === '(' ? ')' : '}';
  let depth = 0;
  let semi = -1;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (c === '(' || c === '{') depth += 1;
    else if (c === ')' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        if (c !== closer) return null;
        const spec = semi < 0 ? null : s.slice(semi + 1, i).trim();
        return {
          body: semi < 0 ? s.slice(open + 1, i) : s.slice(open + 1, semi),
          spec: spec === null || spec === '' ? null : spec,
          end: i + 1,
        };
      }
    } else if (c === ';' && depth === 1 && semi < 0) semi = i;
  }
  return null;
}

/**
 * **一格转换说明**：`%` [标志] [宽度] [`.` 精度] 转换字符。
 * 五个标志都收（第二十九刀）：`-` 左对齐、`0` 补零、`+` 与空格给符号、`#` 另一种形式；
 * 宽度与精度收十进制常量，也收 `*` / `.*`（**从实参来**，第二十七刀）。
 * 读不动答 `null`（那时那个 `%` 就是字面的一个百分号）。
 */
export function readSpec(fmt, at) {
  let j = at + 1;
  const flags = {
    left: false, zero: false, plus: false, space: false, alt: false,
  };
  for (;; j += 1) {
    if (fmt[j] === '-') { flags.left = true; continue; }
    if (fmt[j] === '0') { flags.zero = true; continue; }
    if (fmt[j] === '+') { flags.plus = true; continue; }
    if (fmt[j] === ' ') { flags.space = true; continue; }
    if (fmt[j] === '#') { flags.alt = true; continue; }
    break;
  }
  let width = null;
  if (fmt[j] === '*') { width = '*'; j += 1; } else {
    let w = '';
    while (/[0-9]/.test(fmt[j] ?? '')) { w += fmt[j]; j += 1; }
    if (w !== '') width = Number(w);
  }
  let prec = null;
  if (fmt[j] === '.') {
    j += 1;
    if (fmt[j] === '*') { prec = '*'; j += 1; } else {
      let p = '';
      while (/[0-9]/.test(fmt[j] ?? '')) { p += fmt[j]; j += 1; }
      prec = p === '' ? 0 : Number(p);
    }
  }
  /* **长度修饰**（`hh` / `h` / `l` / `ll`，第四十四刀）：它改的是"按几位读"，
     所以是这一格自己的一栏，不是转换字符的一部分。`z` / `j` / `t` / `L` 那几格
     宽度由平台的 typedef 定，这一层没有那一格 —— 读出来交给上头记账。 */
  let mod = '';
  while (/[hljztL]/.test(fmt[j] ?? '')) { mod += fmt[j]; j += 1; }
  const conv = fmt[j];
  if (conv === undefined) return null;
  return {
    flags, width, prec, mod, conv, end: j,
  };
}

/** 长度修饰说的"按几位读"（`0` = 没写，听类型的）。 */
export function modBits(mod) {
  if (mod === 'hh') return 8;
  if (mod === 'h') return 16;
  if (mod === 'l' || mod === 'll') return 64;
  return 0;
}

/**
 * **一格转换说明发出来的那一块**（lower.js:11975-12080 那张表）。`v` 是 `{ code, type }`，
 * `c` 给谓词与整数转换（`isInt` / `isBool` / `isReal` / `intConv(code, from, to)`）。
 * 认不出的答 `null` —— 调用方记账。**宽度与精度那一层不在这儿**（padTo 是另一张表）。
 *
 * 几处不是"随手选的写法"：
 *   - `%c` 是一个码位 → 一个字符（`(chr E)`）；
 *   - `%d` 碰上 bool 要 `sel` 成 1 / 0，**不能** `(tostr b)`（那印 true / false）；
 *   - `%d` 碰上**无符号**那一格是"按有符号读"（第三十三刀）：`printf("%d", (unsigned)…)`
 *     在 C 里印负数，所以先转到同宽的有符号格；
 *   - `%x/%X/%o/%u` 把实参当 **unsigned** 读，位数是**默认实参提升之后**那一格 ——
 *     `printf("%x", (char)-56)` 印 `ffffffc8` 而不是 `c8`；
 *   - `%f` 是 C 的 `%.6f`（默认精度 6，第八刀）—— `(tostr …)` 是 `%.6g`，两者不一样；
 *   - `%s` 碰上**字符串本来就是一格字符串**，不套 `tostr`（第一百四十六刀那一族）。
 */
export function specPiece(spec, v, c, pCode = null) {
  const promo = (w) => ((w ?? 32) < 32 ? 32 : (w ?? 32));
  const t = v.type;
  const conv = spec.conv;
  const mw = modBits(spec.mod ?? '');
  const alt = spec.flags?.alt === true;
  /* 浮点那三格的精度：没写是 C 的 6；`.*` 的实参是负数时"等于没写"，那一格的判断落到
     运行期（`sel`）—— 与旧降级同一条（第二十七 / 三十刀）。 */
  const nf = pCode === null ? '(int 6)'
    : (spec.prec === '*' ? `(sel (bin "<" ${pCode} (int 0)) (int 6) ${pCode})` : pCode);
  if (conv === 'c') return c.isInt(t) ? `(chr ${v.code})` : null;
  if (conv === 'd' || conv === 'i') {
    if (c.isBool(t)) return `(tostr (sel ${v.code} (int 1) (int 0)))`;
    if (!c.isInt(t)) return null;
    return `(tostr ${intConvCode(v.code, t, { k: 'int', w: mw > 0 ? mw : promo(t.w), u: false })})`;
  }
  if (conv === 'x' || conv === 'X' || conv === 'o' || conv === 'u') {
    let code = null;
    let w = 32;
    if (c.isBool(t)) code = `(sel ${v.code} (int 1) (int 0))`;
    else if (c.isInt(t)) { code = v.code; w = promo(t.w); } else return null;
    if (mw > 0) w = mw;
    if (w < 64) code = `(bin "&" ${code} (int ${(1n << BigInt(w)) - 1n}))`;
    const base = conv === 'o' ? 8 : (conv === 'u' ? 10 : 16);
    const piece = `(sbase ${code} (int ${base}))`;
    return conv === 'X' ? `(supper ${piece})` : piece;
  }
  if (conv === 'f') return c.isReal(t) ? `(sfix ${v.code} ${nf})` : null;
  /* `%e` / `%E`（第三十刀）与 `%g` / `%G`（第三十一刀）：方言的 `(ssci …)` / `(sgen …)`。
     `#` 在 `%g` 上是"尾随零留着"（另一个算子 `sgenk`）；`%e` 上那个 `#` 要把点插在 `e`
     前头，那一格由 `specDress` 收（它有临时量）。 */
  /* `%e` / `%E`（第三十刀）与 `%g` / `%G`（第三十一刀）：方言的 `(ssci …)` / `(sgen …)`。
     `#` 在 `%g` 上是"尾随零留着"（另一个算子 `sgenk`）；`%e` 上那个 `#` 要把点插在 `e`
     前头，那一格由 `specDress` 收（它有临时量）—— 所以 `%E` 的**转大写也在那儿**，
     不在这儿：先转了大写，那一步找 `"e"` 就找不着了（29-printf-sci.jnc 量的正是 `%#.0E`）。 */
  if (conv === 'e' || conv === 'E') {
    if (!c.isReal(t)) return null;
    return `(ssci ${v.code} ${nf})`;
  }
  if (conv === 'g' || conv === 'G') {
    if (!c.isReal(t)) return null;
    const piece = `(${alt ? 'sgenk' : 'sgen'} ${v.code} ${nf})`;
    return conv === 'G' ? `(supper ${piece})` : piece;
  }
  if (conv === 's') return t !== null && t !== undefined && t.k === 'string' ? v.code : `(tostr ${v.code})`;
  return null;
}

/** 整数上的精度：`%.3d` 是"**至少**三位数字"，零补在符号**后面**（第二十七刀）。
    精度 0 而值是 0 时一个字符都不印（C99 7.19.6.1）—— 那一截等于 `"0"` 只可能是值为 0。 */
export function precInt(code, pCode) {
  const d = `(sel (bin "==" ${code} (str "0"))`
    + ` (sel (bin "==" ${pCode} (int 0)) (str "") (str "0")) ${code})`;
  return `(bin "+" (srep (str "0") (bin "-" ${pCode} (slen ${d}))) ${d})`;
}

/** `%s` 上的精度：`%.5s` 是"**最多**五个字符"。`ssub` 不夹范围，所以这儿自己夹。 */
export function precStr(code, pCode) {
  const cut = `(sel (bin ">" (slen ${code}) ${pCode}) (ssub ${code} (int 0) ${pCode}) ${code})`;
  return `(sel (bin "<" ${pCode} (int 0)) ${code} ${cut})`;
}

/**
 * 补到至少 `wCode` 个字符宽。**前缀单独一段**（第二十九刀）：`0` 补的零排在前缀
 * **后面** —— `%05d` 印 -42 是 `-0042`。`zero` 收 `false` / `true` / 一段运行期的 bool。
 * `pfx` 与 `code` 都会被读好几次，调用方必须先落成局部量。
 */
export function padTo(pfx, code, wCode, left, zero) {
  const len = pfx === null ? `(slen ${code})` : `(bin "+" (slen ${pfx}) (slen ${code}))`;
  const gap = (fill) => `(srep (str "${fill}") (bin "-" ${wCode} ${len}))`;
  const whole = pfx === null ? code : `(bin "+" ${pfx} ${code})`;
  if (left) return `(bin "+" ${whole} ${gap(' ')})`;
  const sp = `(bin "+" ${gap(' ')} ${whole})`;
  if (zero === false) return sp;
  const zp = pfx === null ? `(bin "+" ${gap('0')} ${code})`
    : `(bin "+" ${pfx} (bin "+" ${gap('0')} ${code}))`;
  return zero === true ? zp : `(sel ${zero} ${zp} ${sp})`;
}

/**
 * **一格转换说明的排版那一层**（lower.js:12077-12151 那一段）：前缀（符号 / `0x`）、
 * 精度、`#` 的那几支、最后补到宽度。`piece` 是 `specPiece` 发出来的主体。
 *
 *   spill(code, ty)   把一段要读好几次的东西落成局部量、回它的读法（调用方给）
 *   wCode / pCode     宽度与精度那两段代码（`null` = 没写）
 *
 * 三处 C 的**未定义行为**（`%c` 上的精度、非有符号转换上的 `+`/空格、`%d`/`%s`/`%c` 上的
 * `#`）答 `{ nope: 原因 }` —— 没有可对的答案，所以不猜。
 */
export function specDress(o) {
  const {
    spec, wCode = null, pCode = null, spill,
  } = o;
  let piece = o.piece;
  const conv = spec.conv;
  const f = spec.flags ?? {};
  const intSpec = conv === 'd' || conv === 'i' || conv === 'x' || conv === 'X'
    || conv === 'o' || conv === 'u';
  const hexConv = conv === 'x' || conv === 'X';
  const signed = conv === 'd' || conv === 'i' || conv === 'f'
    || conv === 'e' || conv === 'E' || conv === 'g' || conv === 'G';
  if (pCode !== null && conv === 'c') return { nope: '`%c` 上的精度（C 里它是未定义行为）' };
  if ((f.plus || f.space) && !signed) {
    return { nope: `'%${conv}' 上的 '${f.plus ? '+' : ' '}' 标志（C 里它是未定义行为）` };
  }
  if (f.alt && !hexConv && conv !== 'o' && conv !== 'f' && conv !== 'e' && conv !== 'E'
    && conv !== 'g' && conv !== 'G') {
    return { nope: `'%${conv}' 上的 '#' 标志（C 里它是未定义行为）` };
  }
  /* 整数上一写精度 `0` 标志就作废；`.*` 的实参是负数时它又活着 —— 那一格落到运行期。 */
  let zeroF = f.zero === true && f.left !== true && conv !== 's' && conv !== 'c';
  if (intSpec && pCode !== null) zeroF = zeroF && spec.prec === '*' ? `(bin "<" ${pCode} (int 0))` : false;
  /* **前缀**（第二十九刀）：符号与 `#` 的 `0x`，排在补零**外面**。摘符号要一次 spill 加
     两个 sel，所以只在真用得上时摘。 */
  let pfx = null;
  if (signed && (f.plus === true || f.space === true || zeroF !== false
    || (intSpec && pCode !== null))) {
    const t = spill(piece, 'string');
    const neg = `(bin "==" (ssub ${t} (int 0) (int 1)) (str "-"))`;
    const other = f.plus === true ? '+' : (f.space === true ? ' ' : '');
    pfx = `(sel ${neg} (str "-") (str "${other}"))`;
    piece = `(sel ${neg} (ssub ${t} (int 1) (bin "-" (slen ${t}) (int 1))) ${t})`;
  }
  /* `#` 在 `%x` / `%X` 上是 `0x` / `0X`，**值为 0 时不加**；判的是补零之前那几位。 */
  if (f.alt === true && hexConv) {
    const t = spill(piece, 'string');
    pfx = `(sel (bin "==" ${t} (str "0")) (str "") (str "${conv === 'x' ? '0x' : '0X'}"))`;
    piece = t;
  }
  /* `#` 在 `%e` / `%E` 上是"小数点一定印出来"，而点插在 `e` **前面**。 */
  if (f.alt === true && (conv === 'e' || conv === 'E')) {
    const t = spill(piece, 'string');
    const ix = spill(`(sfind ${t} (str "e"))`, 'int');
    const ins = `(bin "+" (ssub ${t} (int 0) ${ix})`
      + ` (bin "+" (str ".") (ssub ${t} ${ix} (bin "-" (slen ${t}) ${ix}))))`;
    piece = `(sel (bin "<" ${ix} (int 0)) ${t}`
      + ` (sel (bin "<" (sfind ${t} (str ".")) (int 0)) ${ins} ${t}))`;
  }
  /* `%E` 的**转大写排在插点之后**（`ssci` 只给小写的 `e`，而上面那一步认的就是它）。 */
  if (conv === 'E') piece = `(supper ${piece})`;
  if (pCode !== null && (intSpec || conv === 's')) {
    const t = spill(piece, 'string');
    piece = intSpec ? precInt(t, pCode) : precStr(t, pCode);
  }
  /* `#` 在 `%o` 上是"逼出一个前导 0"，所以排在精度**之后**；空串那一支先挡掉。 */
  if (f.alt === true && conv === 'o') {
    const t = spill(piece, 'string');
    piece = `(sel (bin "==" (slen ${t}) (int 0)) (str "0")`
      + ` (sel (bin "==" (ssub ${t} (int 0) (int 1)) (str "0")) ${t} (bin "+" (str "0") ${t})))`;
  }
  /* `#` 在 `%f` 上是"小数点一定印出来"（补在末尾）。 */
  if (f.alt === true && conv === 'f') {
    const t = spill(piece, 'string');
    piece = `(sel (bin "<" (sfind ${t} (str ".")) (int 0)) (bin "+" ${t} (str ".")) ${t})`;
  }
  if (wCode === null) {
    return { code: pfx === null ? piece : `(bin "+" ${pfx} ${piece})` };
  }
  const t = spill(piece, 'string');
  const p = pfx === null ? null : spill(pfx, 'string');
  if (spec.width !== '*') return { code: padTo(p, t, wCode, f.left === true, zeroF) };
  /* `%*d` 的宽度是负数时"等于写了 `-`、宽度取绝对值"（C99 7.19.6.1）。 */
  const aw = `(sel (bin "<" ${wCode} (int 0)) (un "-" ${wCode}) ${wCode})`;
  return {
    code: `(sel (bin "<" ${wCode} (int 0)) ${padTo(p, t, aw, true, false)}`
      + ` ${padTo(p, t, aw, f.left === true, zeroF)})`,
  };
}

/**
 * 把一个格式串切成**要发的那几行/那一格**。`emitValue(spec, index)` 由调用方给
 * （它答一整块 —— 宽度与精度怎么摆由 `specDress` 收）。`index` 是这一格转换**第一个**
 * 实参的序号：`*` / `.*` 各自也吃掉一个（C 的次序是宽度、精度、值），所以往前走的步数
 * 是 `1 + 有没有 * + 有没有 .*`。
 *
 * `mode === 'stmt'` 答 `{ lines }`；`mode === 'str'` 答 `{ code }`。
 * 空段又带换行时发 `(print (str ""))` —— 那正是 `printf("\n")`。
 */
export function fmtRun(fmt, mode, emitValue, pad = '') {
  const lines = [];
  let pieces = [];
  let lit = '';
  let ai = 0;
  const flushLit = () => {
    if (lit !== '') { pieces.push(`(str ${JSON.stringify(lit)})`); lit = ''; }
  };
  const flush = (nl) => {
    flushLit();
    if (pieces.length === 0) {
      if (nl) lines.push(`${pad}(print (str ""))`);
      pieces = [];
      return;
    }
    lines.push(`${pad}(${nl ? 'print' : 'write'} ${joinPieces(pieces)})`);
    pieces = [];
  };
  for (let i = 0; i < fmt.length; i += 1) {
    const c = fmt[i];
    if (c === '\n' && mode === 'stmt') { flush(true); continue; }
    if (c !== '%') { lit += c; continue; }
    if (fmt[i + 1] === '%') { lit += '%'; i += 1; continue; }
    const spec = readSpec(fmt, i);
    if (spec === null) { lit += c; continue; }
    flushLit();
    /* 第三格是**落临时量**的口子（`specDress` 的 `spill` 最后落在这儿）：那几行 `(let …)`
       要排在这一段的 `(print …)` **前面**，所以直接进 `lines` —— 段是在这之后才 flush 的。 */
    const one = emitValue(spec, ai, (l) => lines.push(l));
    if (one === null) return null;                                   // 调用方记账
    pieces.push(one);
    ai += 1 + (spec.width === '*' ? 1 : 0) + (spec.prec === '*' ? 1 : 0);
    i = spec.end;
  }
  if (mode === 'str') {
    flushLit();
    return { code: joinPieces(pieces) ?? '(str "")', lines };
  }
  flush(false);
  return { lines };
}

/* ─── 标准 IR 那一侧（ADR-0044 的 adapter 走这条）──────────────────────────────
 *
 * 上头那一整套发的是 **`.sx` 的文字**（jancy 那条路直接写 sx）。ADR-0044 的 adapter
 * 交的是**标准 IR 的节点**，所以这儿要一份按节点搭的。
 *
 * **为什么不另开一份文件**：`readSpec` 那张表（标志 / 宽度 / 精度 / 长度修饰怎么读）
 * 是同一个算法，抄第二份就会分叉 —— 那正是这份文件头上写的教训。所以两侧共用
 * `readSpec`，只有"一格转换发什么"分两个函数，挨着摆、同一张表往下读。
 *
 * IR 那一侧接的范围：`%d` / `%s` / `%v` / `%c` / `%g` / `%f` / `%e` / `%x` / `%o` / `%b`
 * × 宽度 / `-` / `0` / `+` / 空格 / `#` / 精度 / `*`（宽度或精度从实参来）——
 * **这一侧现在与 sx 那一半一样齐**（长度修饰 `hh` / `l` 那一族由上头的 `modBits` 读、
 * 这一侧还没用上，它改的是"按几位读"，等定宽整数那一格再接）。
 */

/** C 的转义（格式串在树上是**原文**，`\n` 是两个字符）。 */
export function cUnescape(s) {
  return String(s).replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '0') return '\0';
    return c;                                  // `\\` / `\"` / `\'` 都是它自己
  });
}

/**
 * **一格转换 → 一格标准 IR 的串表达式**（与上头 `specPiece` 是同一张表的两头）。
 * 每一格都拿本机 `printf` 对过：`%d`→`tostr`、`%g`→`sgen`（`%#g` 是 `sgenk`）、
 * `%.2f`→`sfix`、`%.3e`→`ssci`、`%x`→`sbase 16`。认不出的当场报。
 *
 * **`%E` 有意不在这儿转大写**：`#` 那一支要在 `e` 前面插小数点，先转了大写就找不着那个
 * `e` 了 —— 与 sx 那一半同一条（见 `specDress` 里那段话）。
 */
export function specPieceIR(spec, v, tyCtx, who, precE = null) {
  const t = typeOf(v, tyCtx);
  const int = (n) => ({ kind: 'int', value: n });
  const bi = (name, ...rest) => ({ kind: 'builtin', name, args: rest });
  const real = () => (t.kind === 'real' ? v : bi('toreal', v));
  /* 精度是**一段表达式**（`.*` 那一格从实参来）。`.*` 收到负数时"等于没写"，
     那一格判断落到运行期 —— C99 7.19.6.1，与 sx 那一半的 `nf` 同一条。 */
  const digits = precE === null
    ? int(spec.prec === null ? 6 : spec.prec)
    : selIR(cmpIR('<', precE, int(0)), int(6), precE, { kind: 'int' });
  const alt = spec.flags?.alt === true;
  const at = `%${spec.conv}`;
  switch (spec.conv) {
    case 'd': case 'i': case 'u':
      if (t.kind === 'string') throw new Error(`${who}: \`${at}\` 收到的是一格串`);
      return bi('tostr', t.kind === 'real' ? bi('toint', v) : v);
    /* `%v` 是 go 的"按默认样子印"；`%s` 碰上串就是串本身（别套 `tostr`）。 */
    case 's': case 'v':
      return t.kind === 'string' ? v : bi('tostr', v);
    /* `%c` 是**一个码位 → 一个字符**（`(chr E)`）；本来就是串就照原样。 */
    case 'c':
      if (t.kind === 'string') return v;
      if (t.kind !== 'int') throw new Error(`${who}: \`%c\` 收到的是 ${t.kind}`);
      return bi('chr', v);
    /* `#` 在 `%g` 上是"尾随零留着"（另一个算子 `sgenk`）。 */
    case 'g': return bi(alt ? 'sgenk' : 'sgen', real(), digits);
    case 'G': return bi('supper', bi(alt ? 'sgenk' : 'sgen', real(), digits));
    case 'f': case 'F': return bi('sfix', real(), digits);
    case 'e': case 'E': return bi('ssci', real(), digits);
    case 'x': return bi('sbase', v, int(16));
    case 'X': return bi('supper', bi('sbase', v, int(16)));
    case 'o': return bi('sbase', v, int(8));
    case 'b': return bi('sbase', v, int(2));
    default:
      throw new Error(`${who}: \`${at}\` 这一格转换还没接`);
  }
}

/** 两格串接起来。 */
const catIR = (a, b) => ({ kind: 'binop', op: '+', left: a, right: b });
/** 一格串内建。 */
const biIR = (name, ...args) => ({ kind: 'builtin', name, args });
const intIR = (n) => ({ kind: 'int', value: n });
const strIR = (s) => ({ kind: 'string', value: s });
const cmpIR = (op, a, b) => ({ kind: 'binop', op, left: a, right: b });
const selIR = (cond, then, els, type = STR) => ({
  kind: 'if-expr', type, cond, then, else_: els,
});

/**
 * **补到至少 `wE` 个字符宽**（与上头 `padTo` 是同一条规矩）。`t` / `p` 必须**已经
 * 落成临时量** —— 它们被读好几次，直接抄几遍会把实参那格表达式多跑几趟。
 * `wE` 是**一段表达式**（`%*d` 那一格的宽度从实参来）。
 *
 * **前缀单独一段**：`0` 补的零排在前缀**后面** —— `%05d` 印 -42 是 `-0042`。
 */
function padToIR(p, t, wE, left, zero) {
  const len = p === null ? biIR('slen', t) : cmpIR('+', biIR('slen', p), biIR('slen', t));
  const gap = (fill) => biIR('srep', strIR(fill), cmpIR('-', wE, len));
  const whole = p === null ? t : catIR(p, t);
  if (left) return catIR(whole, gap(' '));
  const sp = catIR(gap(' '), whole);
  if (zero === false) return sp;
  const zp = p === null ? catIR(gap('0'), t) : catIR(p, catIR(gap('0'), t));
  return zero === true ? zp : selIR(zero, zp, sp);
}

/** `%.3d` 是"**至少**三位数字"，零补在符号**后面**（与上头 `precInt` 同一条）。 */
function precIntIR(t, nE) {
  const d = selIR(cmpIR('==', t, strIR('0')),
    selIR(cmpIR('==', nE, intIR(0)), strIR(''), strIR('0')), t);
  return catIR(biIR('srep', strIR('0'), cmpIR('-', nE, biIR('slen', d))), d);
}

/** `%.3s` 是"**最多**三个字符"；精度是负数时等于没写（与上头 `precStr` 同一条）。 */
const precStrIR = (t, nE) => selIR(cmpIR('<', nE, intIR(0)), t,
  selIR(cmpIR('>', biIR('slen', t), nE), biIR('ssub', t, intIR(0), nE), t));

/**
 * **一格转换说明的排版那一层**（与上头 `specDress` 是同一张表的两头、同一个次序）：
 * 前缀（符号 / `0x`）、精度、`#` 的那几支、最后补到宽度。
 *
 * 要读好几次的东西一律先落成临时量（`block-expr` + `let`）。三处 C 的**未定义行为**
 * 当场报（`%c` 上的精度、非有符号转换上的 `+`/空格、别处的 `#`）—— 没有可对的答案。
 */
function dressIR(spec, body, fresh, who, wE = null, pE = null) {
  const f = spec.flags ?? {};
  const conv = spec.conv;
  const at = `%${conv}`;
  const intSpec = 'dixXou'.includes(conv);
  const hexConv = conv === 'x' || conv === 'X';
  const signed = 'difeEgG'.includes(conv);
  const lets = [];
  const spill = (v, type = STR) => {
    const name = fresh('__f');
    lets.push({ kind: 'let', name, type, init: v });
    return { kind: 'name', name };
  };
  let piece = body;
  let pfx = null;
  if (spec.prec !== null && conv === 'c') {
    throw new Error(`${who}: \`${at}\` 上的精度（C 里它是未定义行为）`);
  }
  if ((f.plus || f.space) && !signed) {
    throw new Error(`${who}: \`${at}\` 上的 \`${f.plus ? '+' : '空格'}\` 标志（C 里它是未定义行为）`);
  }
  if (f.alt && !hexConv && !'ofeEgG'.includes(conv)) {
    throw new Error(`${who}: \`${at}\` 上的 \`#\` 标志（C 里它是未定义行为）`);
  }
  /**
   * 整数上一写精度，`0` 标志就作废；`.*` 那一格的实参是**负数时它又活着**
   * （负精度等于没写）—— 所以那一格是一段运行期的 bool，不是 true / false。
   */
  let zeroF = f.zero === true && f.left !== true && conv !== 's' && conv !== 'v' && conv !== 'c';
  if (intSpec && spec.prec !== null) {
    zeroF = zeroF && spec.prec === '*' ? cmpIR('<', pE, intIR(0)) : false;
  }
  /* **前缀**：符号与 `#` 的 `0x`，排在补零**外面**。 */
  if (signed && (f.plus === true || f.space === true || zeroF !== false
    || (intSpec && spec.prec !== null))) {
    const t = spill(piece);
    const neg = cmpIR('==', biIR('ssub', t, intIR(0), intIR(1)), strIR('-'));
    const other = f.plus === true ? '+' : (f.space === true ? ' ' : '');
    pfx = selIR(neg, strIR('-'), strIR(other));
    piece = selIR(neg, biIR('ssub', t, intIR(1), cmpIR('-', biIR('slen', t), intIR(1))), t);
  }
  /* `#` 在 `%x` / `%X` 上是 `0x` / `0X`，**值为 0 时不加**。 */
  if (f.alt === true && hexConv) {
    const t = spill(piece);
    pfx = selIR(cmpIR('==', t, strIR('0')), strIR(''), strIR(conv === 'x' ? '0x' : '0X'));
    piece = t;
  }
  /* `#` 在 `%e` / `%E` 上是"小数点一定印出来"，而点插在 `e` **前面**。 */
  if (f.alt === true && (conv === 'e' || conv === 'E')) {
    const t = spill(piece);
    const ix = spill(biIR('sfind', t, strIR('e')), { kind: 'int' });
    const ins = catIR(biIR('ssub', t, intIR(0), ix),
      catIR(strIR('.'), biIR('ssub', t, ix, cmpIR('-', biIR('slen', t), ix))));
    piece = selIR(cmpIR('<', ix, intIR(0)), t,
      selIR(cmpIR('<', biIR('sfind', t, strIR('.')), intIR(0)), ins, t));
  }
  /* `%E` 的**转大写排在插点之后**（`ssci` 给的是小写 `e`，上一步认的就是它）。 */
  if (conv === 'E') piece = biIR('supper', piece);
  if (spec.prec !== null && (intSpec || conv === 's' || conv === 'v')) {
    const t = spill(piece);
    const nE = spec.prec === '*' ? pE : intIR(spec.prec);
    piece = intSpec ? precIntIR(t, nE) : precStrIR(t, nE);
  } else if (spec.prec !== null && !'fFeEgG'.includes(conv)) {
    throw new Error(`${who}: \`${at}\` 上的精度还没接`);
  }
  /* `#` 在 `%o` 上是"逼出一个前导 0"，排在精度**之后**。 */
  if (f.alt === true && conv === 'o') {
    const t = spill(piece);
    piece = selIR(cmpIR('==', biIR('slen', t), intIR(0)), strIR('0'),
      selIR(cmpIR('==', biIR('ssub', t, intIR(0), intIR(1)), strIR('0')), t, catIR(strIR('0'), t)));
  }
  /* `#` 在 `%f` 上是"小数点一定印出来"（补在末尾）。 */
  if (f.alt === true && (conv === 'f' || conv === 'F')) {
    const t = spill(piece);
    piece = selIR(cmpIR('<', biIR('sfind', t, strIR('.')), intIR(0)), catIR(t, strIR('.')), t);
  }
  if (spec.width !== null) {
    const t = spill(piece);
    const p = pfx === null ? null : spill(pfx);
    if (spec.width !== '*') {
      piece = padToIR(p, t, intIR(spec.width), f.left === true, zeroF);
    } else {
      /* `%*d` 的宽度是负数时"等于写了 `-`、宽度取绝对值"（C99 7.19.6.1）。 */
      const aw = selIR(cmpIR('<', wE, intIR(0)), { kind: 'unop', op: '-', operand: wE }, wE,
        { kind: 'int' });
      piece = selIR(cmpIR('<', wE, intIR(0)),
        padToIR(p, t, aw, true, false),
        padToIR(p, t, aw, f.left === true, zeroF));
    }
  } else if (pfx !== null) {
    piece = catIR(pfx, piece);
  }
  return lets.length === 0 ? piece : { kind: 'block-expr', stmts: lets, value: piece };
}

/**
 * 走一遍格式串，答**若干段**：`[{ parts, nl }]`。`split` 为真时按 `\n` 切段
 * （带换行的段 `nl` 为真）—— `printf` 那一侧要这个；`Sprintf` 那一侧 `split` 为假，
 * 换行就是串里的一个字符，整条只有一段。
 */
function fmtWalk(fmt, args, tyCtx, who, fresh, split) {
  const segs = [];
  let parts = [];
  let lit = '';
  let ai = 0;
  const flushLit = () => {
    if (lit !== '') { parts.push(strIR(lit)); lit = ''; }
  };
  const endSeg = (nl) => { flushLit(); segs.push({ parts, nl }); parts = []; };
  const need = (what) => {
    if (fresh === null) {
      throw new Error(`${who}: ${what} 要一格临时量，可这个调用点没给取名字的口子`);
    }
    return fresh;
  };
  for (let i = 0; i < fmt.length; i += 1) {
    const c = fmt[i];
    if (c === '\n' && split) { endSeg(true); continue; }
    if (c !== '%') { lit += c; continue; }
    if (fmt[i + 1] === '%') { lit += '%'; i += 1; continue; }
    const spec = readSpec(fmt, i);
    if (spec === null) { lit += c; continue; }
    const f = spec.flags ?? {};
    const at = fmt.slice(i, spec.end + 1);
    /**
     * **`*` 各自也吃掉一个实参**，而 C 的次序是"宽度、精度、值"（C99 7.19.6.1）——
     * 数错这一格会把后头所有实参错位，而且不报错。
     */
    const wE = spec.width === '*' ? args[ai] : null;
    if (spec.width === '*') ai += 1;
    const pE = spec.prec === '*' ? args[ai] : null;
    if (spec.prec === '*') ai += 1;
    if (spec.width === '*' && wE === undefined) {
      throw new Error(`${who}: \`${at}\` 的宽度要一格实参，可是没给`);
    }
    if (spec.prec === '*' && pE === undefined) {
      throw new Error(`${who}: \`${at}\` 的精度要一格实参，可是没给`);
    }
    const v = args[ai];
    if (v === undefined) {
      throw new Error(`${who}: 格式串要第 ${ai + 1} 格实参，可是没给（${JSON.stringify(fmt)}）`);
    }
    flushLit();
    /* 排版那一层要落临时量（宽度 / 精度 / `#` 都会把那一段读好几次）。 */
    const dressed = spec.width !== null || spec.prec !== null
      || f.left || f.zero || f.plus || f.space || f.alt;
    let piece = specPieceIR(spec, v, tyCtx, who, spec.prec === '*' ? pE : null);
    if (dressed || spec.conv === 'E') {
      piece = dressIR(spec, piece, need(`\`${at}\``), who, wE, pE);
    }
    parts.push(piece);
    ai += 1;
    i = spec.end;
  }
  endSeg(false);
  if (ai < args.length) {
    throw new Error(`${who}: 格式串只用了 ${ai} 格实参，给了 ${args.length} 格`
      + `（${JSON.stringify(fmt)}）`);
  }
  return segs;
}

/** 一段里那几块拼成一格串（一块都没有就是空串）。 */
const joinIR = (parts) => (parts.length === 0 ? strIR('') : parts.reduce(catIR));

/**
 * `fmt` 那句话 + 那几格实参 → **一格标准 IR 的串表达式**（`(bin "+" …)` 串起来）。
 * `fmt` 要**已经解过转义**（调用方先过 `cUnescape`）。`who` 是报错时的前缀。
 * `fresh(前缀)` 给一个没用过的名字 —— 宽度与 `%.Ns` 要落临时量，没给就当场报。
 *
 * 实参给多给少都**当场报**：C 那边多给的会悄悄丢掉、少给的读到垃圾，两样都是
 * "答案静默地错"，所以这儿不跟着糊弄。
 */
export function fmtToIR(fmt, args, tyCtx, who, fresh = null) {
  return joinIR(fmtWalk(fmt, args, tyCtx, who, fresh, false)[0].parts);
}

/**
 * `printf` 那一侧：`fmt` → **几行语句**。按 `\n` 切段 —— 带换行的段发 `print`
 * （它自带换行），末段没有换行时发 `write`。空段又带换行就是 `printf("\n")`。
 *
 * 这与 sx 那一半的 `fmtRun(mode='stmt')` 是同一条口径（那一份发的是 sx 文字）。
 */
export function fmtToStmts(fmt, args, tyCtx, who, fresh = null) {
  const segs = fmtWalk(fmt, args, tyCtx, who, fresh, true);
  const out = [];
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (last && !seg.nl && seg.parts.length === 0) return;      // 末尾那一段是空的：不发
    out.push({ kind: seg.nl ? 'print' : 'write', values: [joinIR(seg.parts)] });
  });
  return out;
}
