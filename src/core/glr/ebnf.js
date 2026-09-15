// src/core/glr/ebnf.js —— W3C / bottlecaps 风的 `.ebnf` 直接读进来（`.y` 那一格的孪生兄弟）
//
// 为什么要有这一格：`.y` 那个入口的道理是"语法这件事外面已经写了几十年，别手抄"。EBNF 这一支
// 更甚 —— **标准里那份语法本身**就是 EBNF。`cpp-grammars/` 那个仓库里躺着 21 份：
// C++11/14/17/20/23、C99/11/17/23、carbon-lang、cfront1/2/3、cppfront、elsa、g++-3.3.6、
// open-watcom-v2、rose、satya-das。手抄 C++ 的语法抄一遍就是抄一遍的错（这一趟已经验过：
// 手写那一份 351 份只过 16）。
//
// 做法与 `.y` 一模一样：**`.ebnf` 转成我们那份 `(grammar …)` 文本，再走同一条路**
// （readSexpr -> readGrammar -> buildTable）。于是：
//   - 语法的语义只有 grammar.js 那一份说法；
//   - 构表的内容寻址缓存照旧生效（键是转出来的文本，`.ebnf` 改一个字符键就变）；
//   - 转出来的东西人能读、能 diff、能进快照 —— 这一格唯一诚实的判据。
//
// 收的方言（照那 21 份文件里**实际出现**的写法定，不照哪一份标准文本）：
//
//   规则     `name ::= 右部`，右部里 `|` 分支，续行靠缩进（下一条规则从行首那个 `name ::=` 起）
//   注释     `//` 到行尾；`/* … */`（`/*empty*/` 就是空产生式，那一支自然收成 `()`）
//   终结符   `"…"` 与 `'…'`
//   后缀     `?`（可选）`*`（零次以上）`+`（一次以上）
//   分组     `( … )`，里面还能有 `|`
//
// 三处**定义**（写在这儿是为了别人翻到这儿就知道口径）：
//
//   - **`?` `*` `+` 与分组在转换期展开成辅助规则**，不进 LR 表。`X?` 出 `X-opt`、
//     `X*` 出 `X-star`、`X+` 出 `X-plus`、`( … )` 出 `g<N>`。同一个形状只出一份
//     （按结构做键缓存）—— 不然 C++23 那份 304 处 `?` 会生出 304 条一样的规则。
//   - **没有 `(lex …)`**。EBNF 里那些 `identifier`、`pp-number` 是**词法**层的东西，
//     一份 `.ebnf` 不带词法实现。所以转出来的语法能建表、能拿现成的记号表分析，
//     **不能直接吃源文本** —— 与真 bison 的 `.y` 一样，`omni glr parse` 会照实说。
//     这不是缺陷，是这类文件的性质：它答"什么串合法"，不答"字符怎么切成记号"。
//   - **没被任何规则定义的名字就是终结符**（记号）。EBNF 不区分终结符与非终结符，
//     唯一能判的就是"有没有人 `::=` 过它"。这一条也是转换报告里最值得看的一栏：
//     终结符数目突然变大，往往是某条规则名拼错了。
//
// 起始符号取**第一条规则**（这几份文件都把入口写在最前面）。

import { span as mkSpan } from '../source/diag.js';

/** 这条路径是不是一份 EBNF。 */
export const isEbnfPath = (p) => p.endsWith('.ebnf');

/** 把文件名折成一个合法的语法名：`c++23.ebnf` -> `cpp23`、`elsa-cc.gr.ebnf` -> `elsa-cc-gr`。 */
function grammarNameOf(path) {
  let base = path.replace(/^.*[/\\]/, '').replace(/\.ebnf$/, '');
  base = base.replace(/\+\+/g, 'pp').replace(/[^A-Za-z0-9_-]+/g, '-');
  base = base.replace(/^-+|-+$/g, '');
  return base === '' ? 'ebnf' : base;
}

/** 把一段文本转成 `.grammar` 里的串字面量（反斜杠与引号要转义 —— 散文终结符里什么都有）。 */
function q(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + '"';
}

/* ------------------------------------------------------------------------- *
 * 扫描：先把注释抹掉，再按"行首那个 `name ::=`"切成一条条规则
 * ------------------------------------------------------------------------- */

/**
 * 把注释抹成空格（**不删字符**）—— 位置要留住，报错的 caret 才指得准。
 * `/*empty* /` 这一族抹掉之后那一支就是空的，正好收成空产生式。
 */
function blankComments(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // 串里面的 `//` 不是注释。反斜杠在这一层也不是转义（见 readString 那段注释）。
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote && src[i] !== '\n') i++;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 一个名字：字母数字、下划线、连字符、点（`elsa.cc.kandr` 那种规则名里有点）。 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*/;

/**
 * 名字折成 `.grammar` 里的原子：点换成连字符。
 * （`.grammar` 的原子里点没有特殊意义，但换掉之后与别处的命名风格一致，也好读。）
 */
const norm = (s) => s.replace(/\./g, '-');

/**
 * 切规则。答 `[{name, at, body, bodyAt}]`。
 *
 * 判据：**一行里出现 `name ::=`，且 `name` 前面除了空白只允许一个 `|`**。
 *
 * 那个 `|` 是上游的排版毛病，不是语法：c++17 / c++20 那两份里有
 *   `  | init-statement ::=`
 * —— 前一条规则的分支表还没写完就接了下一条规则的头。这时那个 `|` 谁也不属于，
 * 前一条规则的正文在它**之前**结束。不认这一种的话那两份直接转不动（量过）。
 */
function splitRules(src, file, diags) {
  const rules = [];
  const re = /(^|\n)([ \t]*)(\|[ \t]*)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*::=/g;
  const heads = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const indent = m[1].length + m[2].length;
    heads.push({
      name: m[4],
      cut: m.index + indent,                    // 前一条规则的正文切到这儿（含那个 `|` 之前）
      at: m.index + indent + (m[3] === undefined ? 0 : m[3].length),
      end: re.lastIndex,
    });
  }
  if (heads.length === 0) {
    diags.error(mkSpan(file, 0, Math.min(src.length, 40)), 'no `name ::= …` rule found — is this really an EBNF file?');
    return rules;
  }
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    const stop = k + 1 < heads.length ? heads[k + 1].cut : src.length;
    rules.push({ name: norm(h.name), at: h.at, body: src.slice(h.end, stop), bodyAt: h.end });
  }
  return rules;
}

/* ------------------------------------------------------------------------- *
 * 右部：分支 -> 序列 -> 项（名字 / 串 / 分组）+ 后缀
 * ------------------------------------------------------------------------- */

/** 右部的词法器。项之间的空白（含换行）都是分隔符。 */
class Rx {
  constructor(text, base, file, diags) {
    this.s = text;
    this.i = 0;
    this.base = base;
    this.file = file;
    this.diags = diags;
    this.bad = false;
  }

  ws() {
    while (this.i < this.s.length && /[ \t\r\n]/.test(this.s[this.i])) this.i++;
  }

  eof() {
    this.ws();
    return this.i >= this.s.length;
  }

  peek() {
    this.ws();
    return this.i < this.s.length ? this.s[this.i] : '';
  }

  span(from) {
    return mkSpan(this.file, this.base + from, this.base + Math.max(from + 1, this.i));
  }

  fail(from, msg) {
    if (!this.bad) this.diags.error(this.span(from), msg);
    this.bad = true;
  }
}

/**
 * 一个串字面量。EBNF 里 `"…"` 与 `'…'` 等价（`'"'` 就是那个双引号）。
 *
 * **反斜杠在这一层不是转义**：`"\"` 就是一个反斜杠字符，`"\u"` 是反斜杠加 u
 * （C++ 的 universal-character-name 以它开头）。所以这儿一直读到闭引号为止，
 * 中间什么都照原样收。代价是"串里放不下自己的引号"—— 那正是这几份文件用 `'"'`
 * 表示双引号的原因，口径自洽。
 */
function readString(rx) {
  const from = rx.i;
  const quote = rx.s[rx.i];
  rx.i++;
  let out = '';
  while (rx.i < rx.s.length && rx.s[rx.i] !== quote && rx.s[rx.i] !== '\n') {
    out += rx.s[rx.i];
    rx.i++;
  }
  if (rx.i >= rx.s.length || rx.s[rx.i] !== quote) {
    rx.fail(from, 'unterminated string in EBNF right-hand side');
    return null;
  }
  rx.i++;
  return out;
}

/**
 * 右部的语法（内部表示都是普通对象，好做结构键）：
 *   alts  = [seq…]              分支表
 *   seq   = [term…]             一支里的序列（可以是空的 —— 空产生式）
 *   term  = {k:'name', v} | {k:'str', v} | {k:'group', alts} | {k:'opt'|'star'|'plus', t}
 */
function parseAlts(rx) {
  const alts = [parseSeq(rx)];
  while (!rx.bad && rx.peek() === '|') {
    rx.i++;
    alts.push(parseSeq(rx));
  }
  return alts;
}

function parseSeq(rx) {
  const seq = [];
  for (;;) {
    if (rx.bad) break;
    const c = rx.peek();
    if (c === '' || c === '|' || c === ')') break;
    const t = parsePostfix(rx);
    if (t === null) break;
    seq.push(t);
  }
  return seq;
}

function parsePostfix(rx) {
  let t = parseAtom(rx);
  if (t === null) return null;
  for (;;) {
    const c = rx.i < rx.s.length ? rx.s[rx.i] : '';
    /* 后缀**必须紧贴**前一项：`a ?` 与 `a?` 在这几份文件里没有区别，但 `a | ? b` 那种
       写法不存在，所以不必区分 —— 这儿仍然按"跳过空白再看"处理，宽一点没坏处。 */
    if (c === '?') { rx.i++; t = { k: 'opt', t }; continue; }
    if (c === '*') { rx.i++; t = { k: 'star', t }; continue; }
    if (c === '+') { rx.i++; t = { k: 'plus', t }; continue; }
    break;
  }
  return t;
}

function parseAtom(rx) {
  const from = rx.i;
  const c = rx.peek();
  if (c === '') return null;
  if (c === '"' || c === "'") {
    const v = readString(rx);
    return v === null ? null : { k: 'str', v };
  }
  if (c === '(') {
    rx.i++;
    const alts = parseAlts(rx);
    if (rx.peek() !== ')') { rx.fail(from, 'unclosed `(` in EBNF right-hand side'); return null; }
    rx.i++;
    return { k: 'group', alts };
  }
  const m = NAME_RE.exec(rx.s.slice(rx.i));
  if (m !== null) {
    rx.i += m[0].length;
    return { k: 'name', v: norm(m[0]) };
  }
  /* `[` 单说一句：这一族文件里 `[` 有两种可能，我们两种都不收，但要说清是哪一种。
     rose 那一份写的是 `"#pragma" [^\n]+` —— 正则的字符类，那是它自己加的扩展，
     不是 EBNF；字符类属于词法层，这一格不带词法（见文件头第二处定义）。
     ISO EBNF 里 `[ … ]` 是"可选"，但这 20 份没有一份这么用（`?` 才是），
     所以不去猜 —— 猜错会静悄悄地把一份语法读歪，照实报比读歪好。 */
  if (c === '[') {
    rx.fail(from, 'unsupported `[` in EBNF right-hand side — 字符类（`[^\\n]+`）是词法层的东西，这一格不收；可选请写 `?`');
    return null;
  }
  rx.fail(from, `unexpected character ${JSON.stringify(c)} in EBNF right-hand side`);
  return null;
}

/* ------------------------------------------------------------------------- *
 * 展开：`?` `*` `+` 与分组变成辅助规则
 * ------------------------------------------------------------------------- */

/** 一个项的结构键 —— 同形状的辅助规则只出一份。 */
function keyOf(t) {
  if (t.k === 'name') return `n:${t.v}`;
  if (t.k === 'str') return `s:${t.v}`;
  if (t.k === 'opt' || t.k === 'star' || t.k === 'plus') return `${t.k}(${keyOf(t.t)})`;
  return `g(${t.alts.map((s) => s.map(keyOf).join(' ')).join('|')})`;
}

/** 一个只含字母数字与连字符的短名字，用来给辅助规则起名。 */
function slug(t) {
  if (t.k === 'name') return t.v.replace(/[^A-Za-z0-9_-]/g, '-');
  if (t.k === 'str') {
    const s = t.v.replace(/[^A-Za-z0-9]/g, '');
    return s === '' ? 'lit' : s.slice(0, 12);
  }
  if (t.k === 'opt') return `${slug(t.t)}-opt`;
  if (t.k === 'star') return `${slug(t.t)}-star`;
  if (t.k === 'plus') return `${slug(t.t)}-plus`;
  /* 分组：拿里头**第一个非终结符名**当名字（`("else" stmt)` -> `stmt-g`）。
     光叫 `g` 的话 c++23 那份会出几十个 `g-17` —— 转出来的文本是给人读的，编号读不出所以然。
     里头一个名字都没有（纯标点的分组，如 `("+" | "-")`）才退回 `g`。 */
  const nm = firstName(t);
  return nm === null ? 'g' : `${nm}-g`;
}

/** 深度优先找一个分组里的第一个名字项。 */
function firstName(t) {
  if (t.k === 'name') return t.v.replace(/[^A-Za-z0-9_-]/g, '-');
  if (t.k === 'str') return null;
  if (t.k === 'opt' || t.k === 'star' || t.k === 'plus') return firstName(t.t);
  for (const seq of t.alts) {
    for (const x of seq) {
      const n = firstName(x);
      if (n !== null) return n;
    }
  }
  return null;
}

/**
 * 展开器。`emit(name, alts)` 把一条规则的分支表落成产生式文本；辅助规则也走同一条路。
 * `defined` 记哪些名字被定义过（用来分终结符/非终结符），`used` 记哪些名字被引用过。
 */
class Expander {
  constructor() {
    this.out = [];          // [{name, prods:[{rhs:[…], }]}]
    this.byName = new Map();
    this.helpers = new Map(); // 结构键 -> 辅助规则名
    this.serial = 0;
  }

  rule(name) {
    let r = this.byName.get(name);
    if (r === undefined) {
      r = { name, prods: [] };
      this.byName.set(name, r);
      this.out.push(r);
    }
    return r;
  }

  /** 给一个名字腾出一个没被占用的辅助规则名。 */
  fresh(base) {
    let nm = base;
    if (this.byName.has(nm) || nm === '') {
      this.serial++;
      nm = `${base === '' ? 'g' : base}-${this.serial}`;
      while (this.byName.has(nm)) { this.serial++; nm = `${base === '' ? 'g' : base}-${this.serial}`; }
    }
    return nm;
  }

  /** 把一个项折成"一个符号名"（必要时造辅助规则）。答 `{sym, lit}`：lit 为真表示它是串字面量。 */
  symOf(t) {
    if (t.k === 'name') return { sym: t.v, lit: false };
    if (t.k === 'str') return { sym: t.v, lit: true };
    const key = keyOf(t);
    const had = this.helpers.get(key);
    if (had !== undefined) return { sym: had, lit: false };
    const nm = this.fresh(slug(t));
    this.helpers.set(key, nm);
    const r = this.rule(nm);
    if (t.k === 'opt') {
      r.prods.push([]);
      r.prods.push([this.symOf(t.t)]);
    } else if (t.k === 'star') {
      r.prods.push([]);
      r.prods.push([{ sym: nm, lit: false }, this.symOf(t.t)]);
    } else if (t.k === 'plus') {
      r.prods.push([this.symOf(t.t)]);
      r.prods.push([{ sym: nm, lit: false }, this.symOf(t.t)]);
    } else {
      for (const seq of t.alts) r.prods.push(seq.map((x) => this.symOf(x)));
    }
    return { sym: nm, lit: false };
  }

  add(name, alts) {
    const r = this.rule(name);
    for (const seq of alts) r.prods.push(seq.map((t) => this.symOf(t)));
  }
}

/* ------------------------------------------------------------------------- *
 * 出口
 * ------------------------------------------------------------------------- */

/**
 * 把一份 `.ebnf` 转成 `(grammar …)` 文本。转不动就往 `diags` 里记错并答 `null`
 * （与 `yaccToGrammarText` 同一个约定）。
 */
export function ebnfToGrammarText(file, diags) {
  const src = blankComments(file.text);
  const rules = splitRules(src, file, diags);
  if (rules.length === 0) return null;

  const ex = new Expander();
  const declared = new Set();
  for (const r of rules) declared.add(r.name);

  for (const r of rules) {
    const rx = new Rx(r.body, r.bodyAt, file, diags);
    const alts = parseAlts(rx);
    if (!rx.eof() && !rx.bad) rx.fail(rx.i, 'trailing junk in EBNF right-hand side');
    if (rx.bad) continue;
    ex.add(r.name, alts);
  }
  if (diags.hasErrors()) return null;

  /* 终结符 = 被引用过、却没人 `::=` 过的名字（见文件头第三处定义）。
     串字面量不进 `(tokens …)` —— 它们在 `.grammar` 里就是字面量终结符。 */
  const defined = new Set(ex.out.map((r) => r.name));
  const tokens = [];
  const seen = new Set();
  for (const r of ex.out) {
    for (const p of r.prods) {
      for (const s of p) {
        if (s.lit || defined.has(s.sym) || seen.has(s.sym)) continue;
        seen.add(s.sym);
        tokens.push(s.sym);
      }
    }
  }
  tokens.sort();

  const name = grammarNameOf(file.path);
  const start = rules[0].name;
  const out = [];
  out.push(`;; 由 ${file.path} 自动转成 —— 别手改这一份，改上游那个 .ebnf。`);
  out.push(';;');
  out.push(';; `?` `*` `+` 与分组在转换期展开成了辅助规则（`-opt` / `-star` / `-plus` / `g…`）。');
  out.push(';; 没有 `(lex …)`：一份 .ebnf 不带词法实现，所以这份语法能建表、不能直接吃源文本。');
  out.push(`(grammar ${name}`);
  if (tokens.length > 0) {
    /* 一行放不下就折行 —— 转出来的文本是给人读的。 */
    const lines = [];
    let cur = '  (tokens';
    for (const t of tokens) {
      if (cur.length + t.length + 1 > 96) { lines.push(cur); cur = '   '; }
      cur += ` ${t}`;
    }
    lines.push(`${cur})`);
    out.push(...lines);
  } else {
    out.push('  (tokens)');
  }
  out.push(`  (start ${start})`);
  for (const r of ex.out) {
    const prods = [];
    const dedup = new Set();
    for (const p of r.prods) {
      const rhs = p.map((s) => (s.lit ? q(s.sym) : s.sym));
      const key = rhs.join(' ');
      if (dedup.has(key)) continue;
      dedup.add(key);
      const holes = rhs.map((_, k) => `$${k + 1}`);
      prods.push(`    (-> (${rhs.join(' ')}) (${[r.name, ...holes].join(' ')}))`);
    }
    /* 一条规则一个也没有产生式的情况不会出现（`::=` 至少给一支，空的那支就是空产生式），
       但真出现了也别写出坏文本 —— 补一条空产生式。 */
    if (prods.length === 0) prods.push(`    (-> () (${r.name}))`);
    out.push(`  (rule ${r.name}`);
    out.push(prods.join('\n'));
    /* 每条规则的最后一行收掉这条 `(rule …)` */
    out[out.length - 1] += ')';
  }
  /* 最后一条规则那一行再多一个右括号，收掉 `(grammar …)` */
  out[out.length - 1] += ')';
  return `${out.join('\n')}\n`;
}
