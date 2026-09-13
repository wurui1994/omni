// src/core/frontend-engine/parse-driver.js —— 解析器 = **读节点表的驱动器**（不是手写的分支树）
//
// 全部"这儿能写什么"的知识都在 nodes.js 的 `syn` 与洞的类别里。这一份只有**五台机器**：
//
//   1. matchSyn   照一个节点的 `syn` 逐项对：字面记号 / 叶子 / 名字表 / 可选组 / 重复组 / 洞
//   2. parseHole  按洞的**类别**去要东西（`exp` 爬优先级、`var`/`prefixexp` 走后缀链…）
//   3. parseExp   优先级爬升，档次直接问 tokens.js（`binop`/`unop`/`UNARY_PREC`）
//   4. suffixed   `name`/`(exp)` 起头，然后 `.k` `[k]` `:m()` `(args)` 的后缀循环
//   5. choose     有序选择 + 回溯：同一个引导记号下的候选按表序试，报"走得最远"的那个错
//
// 于是加一个节点 = 往 nodes.js 加一行；这儿一个字都不用改。gsl-shell 的公式子语言
// （`ext/gsl-shell`）就是靠这条性质只写增量。

import { lex, binop, unop } from './lexrules.js';
import { firstKeyOf } from './syntax.js';

/*
 * **回溯用的失败不该是个 Error。** 有序选择每试一个候选，失败一次就 `new ParseError`，
 * 而 V8 造 Error 时要抓栈 —— 一份 794KB 的语料上这是几万次抓栈。所以内部失败改成扔一个
 * **单例哨兵**（普通对象，没有栈），只在真要报错时才造一个 ParseError。
 * 量出来：语法 7.56 -> 见 ADR-0030 第 1 节。语义一格没变（错误的措辞与位置逐字相同）。
 */
const FAIL = { raw: '', tok: null };

function fail(msg, tok) {
  FAIL.raw = msg;
  FAIL.tok = tok;
  throw FAIL;
}

export class ParseError extends Error {
  constructor(msg, tok) {
    super(`${tok?.line ?? '?'} 行：${msg}`);
    this.name = 'ParseError';
    this.line = tok?.line;
    this.at = tok;
  }
}

class P {
  constructor(src, lang) {
    this.lang = lang;
    this.toks = lex(src, lang);
    this.i = 0;
  }

  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }

  get cur() { return this.peek(); }

  /** 记号与字面量对不对得上。关键字/算符看 `value`，叶子看 `kind`。 */
  is(lit) {
    const t = this.cur;
    return t.value === lit && t.kind !== 'string' && t.kind !== 'number' && t.kind !== 'name';
  }

  take(lit) {
    if (!this.is(lit)) fail(`要一个 '${lit}'，看到的是 '${this.cur.value}'`, this.cur);
    return this.toks[this.i++];
  }

  name() {
    if (this.cur.kind !== 'name') fail(`要一个名字，看到的是 '${this.cur.value}'`, this.cur);
    return this.toks[this.i++].value;
  }

  // ── 1. matchSyn ──────────────────────────────────────────────────────────
  /** 照 `n.syn` 对一遍，答一个节点对象。`syn` 变了这儿自动跟着变。 */
  matchSyn(n, syn = n.syn) {
    const out = { kind: n.name, line: this.cur.line };
    for (const it of syn) {
      if (typeof it === 'string') { this.take(it); continue; }
      if (it.opt !== undefined) {
        if (this.optStarts(it.opt)) this.matchInto(out, it.opt);
        continue;
      }
      if (it.rep !== undefined) {
        while (this.optStarts(it.rep)) {
          const frame = {};
          this.matchInto(frame, it.rep);
          for (const [k, v] of Object.entries(frame)) {
            if (out[k] === undefined) out[k] = [];
            out[k].push(v);
          }
        }
        continue;
      }
      this.matchItem(out, it);
    }
    return out;
  }

  matchInto(out, items) {
    for (const it of items) {
      if (typeof it === 'string') { this.take(it); continue; }
      if (it.opt !== undefined) { if (this.optStarts(it.opt)) this.matchInto(out, it.opt); continue; }
      this.matchItem(out, it);
    }
  }

  matchItem(out, it) {
    if (it.t !== undefined) {
      if (this.cur.kind !== it.t) fail(`要一个 ${it.t}`, this.cur);
      out[it.as] = this.toks[this.i++].value;
      return;
    }
    if (it.w !== undefined) { out[it.w] = this.name(); return; }
    if (it.n !== undefined) { out[it.n] = this.nameList(it); return; }
    if (it.b !== undefined) { out[it.b] = this.block().stats; return; }
    if (it.h !== undefined) { out[it.h] = this.hole(it); return; }
    if (it.l !== undefined) { out[it.l] = this.holeList(it); return; }
    throw new Error(`syn 里不认得的项：${JSON.stringify(it)}`);
  }

  /** 可选组/重复组要不要取：看组里第一项能不能起头。 */
  optStarts(items) {
    const first = items[0];
    if (typeof first === 'string') return this.is(first);
    if (first.l !== undefined || first.h !== undefined) return this.startsExp();
    if (first.w !== undefined || first.n !== undefined) return this.cur.kind === 'name';
    return false;
  }

  /**
   * 现在这个记号能不能起一个表达式。**这一格也是算出来的**：`lang.expLead` 由
   * "简单值"节点的 `syn` 第一项派生（见 lang.js 的 derive）。先前这儿硬写着
   * `['nil','true','false','...','(','{','function']` —— 那是把语言塞进驱动器，
   * gsl-shell 加个 `|x| e` 就得来改它。
   */
  startsExp() {
    const t = this.cur;
    if (this.lang.expLeadKinds.has(t.kind)) return true;
    if (unop(t, this.lang) !== undefined) return true;
    return t.kind !== 'string' && t.kind !== 'number' && this.lang.expLead.has(t.value);
  }

  nameList(it) {
    const sep = it.sep ?? ',';
    const out = [];
    for (;;) {
      if (it.vararg === true && this.is('...')) { this.take('...'); out.push('...'); break; }
      if (out.length > 0 || (it.min ?? 1) > 0 || this.cur.kind === 'name') out.push(this.name());
      if (!this.is(sep)) break;
      this.take(sep);
    }
    if (it.max !== undefined && out.length > it.max) {
      fail(`这儿只能有 ${it.max} 个名字`, this.cur);
    }
    return out;
  }

  /** 这个洞现在能不能起头（`min:0` 的列表与尾随分隔符都问它）。 */
  startsHole(it) {
    if (it.cls === 'field') return this.startsExp() || this.is('[');
    if (it.cls === 'block' || it.cls === 'funcbody') return true;
    return this.startsExp();
  }

  holeList(it) {
    const seps = [it.sep ?? ',', ...(it.alt ?? [])];
    const out = [];
    if ((it.min ?? 1) === 0 && !this.startsHole(it)) return out;
    out.push(this.hole(it));
    for (;;) {
      const s = seps.find((x) => this.is(x));
      if (s === undefined) break;
      this.take(s);
      if (it.trail === true && !this.startsHole(it)) break;   // 允许尾随一个分隔符
      out.push(this.hole(it));
    }
    return out;
  }

  // ── 2. parseHole：按洞的类别去要东西 ─────────────────────────────────────
  hole(it) {
    const cls = it.cls;
    if (cls === 'block') {
      /* 块洞：`block` 节点的 `syn` 若只是"一串语句"（Lua：`do`/`end` 由外层的 syn 吃），
         就直接收语句；带括号的（C 系的 `{ … }`）照它自己的 `syn` 走。 */
      const bn = this.lang.NODE.get('block');
      const bare = bn !== undefined && bn.syn.length === 1 && bn.syn[0].b !== undefined;
      return bare ? this.block() : this.matchSyn(bn);
    }
    if (cls === 'funcbody') return this.matchSyn(this.lang.NODE.get('funcbody'));
    if (cls === 'field') return this.field();
    if (cls === 'exp') return this.exp(0);
    // `var` / `prefixexp`：先按后缀链解析，再用**洞的类别**判它能不能填。
    const tok = this.cur;
    const e = this.suffixed();
    if (!this.lang.fits(e.kind, cls)) {
      fail(`'${e.kind}' 填不进 ${cls} 类的洞（${cls} 类只收 ${this.lang.membersOf(cls).join(' / ')}）`, tok);
    }
    if (it.only !== undefined && !it.only.includes(e.kind)) {
      fail(`这个位置只收 ${it.only.join(' / ')}，不是 '${e.kind}'`, tok);
    }
    return e;
  }

  field() {
    if (this.is('[')) return this.matchSyn(this.lang.NODE.get('field-index'));
    if (this.cur.kind === 'name' && this.peek(1).value === '=' && this.peek(1).kind === 'punct') {
      return this.matchSyn(this.lang.NODE.get('field-name'));
    }
    return this.matchSyn(this.lang.NODE.get('field-item'));
  }

  // ── 3. parseExp：优先级爬升（档次全问 tokens.js）─────────────────────────
  exp(limit) {
    let left;
    const u = unop(this.cur, this.lang);
    // `onlyAt` 是算符表上的一格：这个前缀算符只许出现在某一档。gsl-shell 的公式子语言
    // 要它 —— 那儿的一元 `-` 只在最外层（`expr-parse.lua:79` 的 `prio == 0`），
    // 所以 `a * -b` 在公式里是错的、在 Lua 里是对的。差别写在数据上，不写在驱动器里。
    if (u !== undefined && (u.onlyAt === undefined || u.onlyAt === limit)) {
      const op = this.toks[this.i++].value;
      left = { kind: 'prefix', op, a: this.exp(this.lang.unaryPrec) };
    } else {
      left = this.simple();
    }
    for (;;) {
      const b = binop(this.cur, this.lang);
      if (b === undefined || b.prec <= limit) break;
      const op = this.toks[this.i++].value;
      // 右结合就把自己的档次减一（`a..b..c` = `a..(b..c)`，`a^b^c` = `a^(b^c)`）
      const right = this.exp(b.assoc === 'right' ? b.prec - 1 : b.prec);
      left = { kind: 'binop', op, a: left, b: right };
    }
    return left;
  }

  simple() {
    // 有序选择 + 回溯（与 `stat()` 同一台机器）：能起头的候选按表序试。
    // 候选表是**派生好的**（`lang.simpleByLit` / `simpleByKind`），这儿一格数组都不新建
    // —— 先前拿 `[...byLit, ...byKind]` 拼一下，每个表达式一次分配，反而更慢（量过）。
    const start = this.i;
    const t = this.cur;
    const lit = t.kind === 'string' || t.kind === 'number'
      ? undefined : this.lang.simpleByLit.get(t.value);
    const kind = this.lang.simpleByKind.get(t.kind);
    let far = null;
    for (let pass = 0; pass < 2; pass += 1) {
      const list = pass === 0 ? lit : kind;
      if (list === undefined) continue;
      for (const n of list) {
        try {
          return this.matchSyn(n);
        } catch (err) {
          if (err !== FAIL) throw err;
          if (far === null || this.i >= far.at) far = { raw: FAIL.raw, tok: FAIL.tok, at: this.i };
          this.i = start;
        }
      }
    }
    if (far !== null && this.cur.kind !== 'name') throw new ParseError(far.raw, far.tok);
    return this.suffixed();
  }

  /** 这个节点的 `syn` 能不能在当前位置起头（第一项：字面记号 / 叶子 / 裸名字 / 洞）。 */
  canStart(n) {
    const f = n.syn[0];
    if (typeof f === 'string') return this.is(f);
    if (f.t !== undefined) return this.cur.kind === f.t;
    if (f.w !== undefined || f.n !== undefined) return this.cur.kind === 'name';
    if (f.h !== undefined || f.l !== undefined) return this.startsExp();
    return false;
  }

  // ── 4. suffixed：`name` / `(exp)` 起头，后缀循环 ─────────────────────────
  suffixed() {
    let e;
    if (this.is('(')) e = this.matchSyn(this.lang.NODE.get('paren'));
    else if (this.cur.kind === 'name') e = { kind: 'name', value: this.name(), line: this.cur.line };
    else fail(`这儿要一个表达式，看到的是 '${this.cur.value}'`, this.cur);
    for (;;) {
      if (this.is('.')) { this.take('.'); e = { kind: 'index', obj: e, key: this.name(), dot: true }; continue; }
      if (this.is('[')) {
        this.take('[');
        const key = this.exp(0);
        this.take(']');
        e = { kind: 'index', obj: e, key, dot: false };
        continue;
      }
      if (this.is(':')) {
        this.take(':');
        const method = this.name();
        e = { kind: 'method-call', obj: e, method, args: this.callArgs() };
        continue;
      }
      if (this.is('(') || this.is('{') || this.cur.kind === 'string') {
        e = { kind: 'call', fn: e, args: this.callArgs() };
        continue;
      }
      return e;
    }
  }

  /**
   * 调用实参。`f"s"` / `f{…}` 是 Lua 的糖，落成同一个 `call` 节点（只记 `sugar`，
   * `render` 一律写成括号形式 —— 语义一样，来回不必逐字相同）。
   */
  callArgs() {
    if (this.cur.kind === 'string') return [this.matchSyn(this.lang.NODE.get('string'))];
    if (this.is('{')) return [this.matchSyn(this.lang.NODE.get('table'))];
    this.take('(');
    const args = this.holeList({ cls: 'exp', min: 0 });
    this.take(')');
    return args;
  }

  // ── 5. choose：有序选择 + 回溯，报"走得最远"的那个错 ─────────────────────
  block() {
    const stats = [];
    for (;;) {
      if (this.cur.kind === 'eof' || this.lang.blockEndSet.has(this.cur.value)) break;
      if (this.is(';')) { this.take(';'); continue; }
      const st = this.stat();
      stats.push(st);
      if (this.is(';')) this.take(';');
      if (this.lang.NODE.get(st.kind).last === true) break;     // `return` / `break` 之后不能再有语句
    }
    return { kind: 'block', stats };
  }

  stat() {
    const start = this.i;
    const cands = this.lang.statCands.get(this.cur.value) ?? this.lang.statFallback;
    let far = null;
    for (const n of cands) {
      try {
        const got = this.matchSyn(n);
        if (this.statBoundary()) return got;
        far = far ?? { raw: `'${this.cur.value}' 在这儿多出来了`, tok: this.cur, at: this.i };
      } catch (err) {
        if (err !== FAIL) throw err;
        // `>=`：走得一样远时**取后来的**。候选按表序排（`local-function` 在 `local` 前），
        // 而后来的那个通常是更一般的形状，它的抱怨也更贴题（`local 1 = 2` 该说"要一个名字"，
        // 不该说"要一个 function"）。
        if (far === null || this.i >= far.at) far = { raw: FAIL.raw, tok: FAIL.tok, at: this.i };
      }
      this.i = start;
    }
    if (far !== null) throw new ParseError(far.raw, far.tok);
    throw new ParseError(`不认得的语句开头 '${this.cur.value}'`, this.cur);
  }

  /** 一条语句该在哪儿收：块尾、`;`、或者下一个记号能起一条语句。 */
  statBoundary() {
    const t = this.cur;
    if (t.kind === 'eof' || this.lang.blockEndSet.has(t.value) || t.value === ';') return true;
    return this.lang.LEAD.has(t.value) || t.kind === 'name' || t.value === '(';
  }
}

/**
 * 解析一段源码。起点由 `lang.start` 说（Lua 是 `block`，公式子语言是 `schema`）——
 * 于是"从哪儿开始认"也是数据，不是驱动器里写死的。
 */
export function parse(src, lang, start = lang.start) {
  const p = new P(src, lang);
  try {
    // 起点可以是一个**节点名**，也可以是一个**洞的类别**（`gdt.hist` 的实参就是一个 `exp`）。
    const b = start === 'block' ? p.block()
      : lang.NODE.has(start) ? p.matchSyn(lang.NODE.get(start))
        : p.hole({ cls: start });
    if (p.cur.kind !== 'eof') throw new ParseError(`到这儿该结束了，却还有 '${p.cur.value}'`, p.cur);
    return b;
  } catch (err) {
    /* **哨兵不许漏出去**：回溯用的那个失败是个普通对象（没有栈），到了这一层要换成真错。
       少了这一道，调用方 `err instanceof ParseError` 判不出来，就成了未捕获异常
       —— 一格扩展当场炸给我看了（`src/core` 里不许提任何语言的名字，所以这儿不点名；
       那条门槛由 tests/sexpr 的 no-per-language-code 守着）。 */
    if (err === FAIL) throw new ParseError(FAIL.raw, FAIL.tok);
    throw err;
  }
}
