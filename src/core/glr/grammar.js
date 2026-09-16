// Omni stage0 — 语法描述的读入与规范化（ADR-0014 决策 2）
//
// 语法文件本身就写成 S 表达式，读它用的是 `sexpr/read.js` —— 不再写第二个词法层。
// 这不是省事：语法、映射模板、映射出来的结果三者同一种语法，「加一门语言 = grammar +
// 映射标注」才谈得上是一件事而不是三件。
//
// 形状：
//
//   (grammar asy
//     (tokens ID LIT STRING)          ;; 终结符。字面量终结符直接在规则里写字符串，不用声明
//     (prec left "+" "-")             ;; 优先级从低到高，一行一级 —— 和 bison 的 %left 一样
//     (prec left "*" "/")
//     (prec right "^")
//     (prec nonassoc "<" ">")
//     (start Exp)
//     (lex ...)                       ;; 词法规格，形状见 lex.js；可以没有（自己喂 token 表）
//     (rule Exp
//       (-> (Exp "+" Exp)      (bin "+" $1 $3))
//       (-> ("-" Exp) (prec UNARY) (neg $2))
//       (-> (LIT)              $1)))
//
// 规矩：
// - `(rule N ...)` 声明的名字是非终结符，`(tokens ...)` 里的与字符串字面量是终结符。
//   两边都没有的名字是错误 —— 不猜。
// - `(-> (RHS...) ACTION)`，RHS 为空表示空产生式。ACTION 是一段 s-expr 模板，
//   里面的 `$1`..`$n` 按 RHS 位置替换；整个 ACTION 就是一个 `$k` 表示原样传上去。
// - `(prec X)` 可选，紧跟在 RHS 之后，等价于 bison 的 `%prec`。
// - 优先级只认终结符（包括只用来标 `%prec` 的伪终结符：在 `tokens` 里声明就行）。
// - `(prefer N)` 可选，与 `(prec X)` 同位置、可换序，N 是整数，默认 0。它**不参与建表**，
//   只在运行期"两支都归约成功、值又不同"的时候定胜负（见 driver.js 头部）。这就是 bison 的
//   `%dprec`：GLR 下处理真歧义的唯一声明式手段，C 系语言的「声明 vs 表达式」绕不开它。
// - **回问三条**（同位置、可换序，参数是 RHS 的位置 `1..n`）—— C 系语言的「这个名字登记成
//   类型了吗」，也就是 bison 里做不到、靠 C 代码回问符号表的那件事：
//     `(declares-type K)`   这一支归约成功之后，第 K 格里那个名字**登记成类型**；
//     `(needs-type K)`      第 K 格那个名字**登记过**才许归约；
//     `(needs-non-type K)`  第 K 格那个名字**没登记过**才许归约。
//   与 `prefer` 一样**不参与建表**（表还是那张 LALR 表），只在运行期判。登记表是**每支
//   分析各一份**的（见 driver.js）—— GLR 会分叉，一支里的 typedef 不能影响另一支。
//   有了这三条，`T * x;` 那类歧义不必再靠 `prefer` 猜：`T` 登记过就只有声明说得通，
//   没登记过就只有乘法说得通。

import { isList, isAtom, isStr, head } from '../sexpr/read.js';
import { readLexSpec, litName } from './lex.js';

/**
 * 读一份语法。返回规范化后的语法对象：
 *   {name, terms: Map<string,{name,lit}>, nonterms: Map<string,{name,rules:number[]}>,
 *    rules: [{lhs, rhs: string[], action, prec: string|null, span}],
 *    start: string, prec: Map<string,{level,assoc}>}
 */
export function readGrammar(nodes, diags) {
  const err = (n, msg) => diags.error(n === undefined || n === null ? null : n.span, msg);
  const top = nodes.length === 1 && head(nodes[0]) === 'grammar' ? nodes[0] : null;
  if (top === null) {
    err(nodes[0], 'a grammar file must be exactly one (grammar NAME ...) form');
    return null;
  }
  const items = top.items.slice(1);
  const name = isAtom(items[0]) ? items[0].value : '?';

  const terms = new Map();
  const nonterms = new Map();
  const rules = [];
  const prec = new Map();
  let precLevel = 0;
  let start = null;
  let lexNode = null;

  const declTerm = (nm, lit) => {
    if (!terms.has(nm)) terms.set(nm, { name: nm, lit });
  };
  declTerm('$end', null);

  // 第一遍：声明。规则体第二遍再读，那时终结符/非终结符都齐了
  for (const it of items.slice(1)) {
    const h = head(it);
    if (h === 'tokens') {
      for (const t of it.items.slice(1)) {
        if (isAtom(t)) declTerm(t.value, null);
        else if (isStr(t)) declTerm(litName(t.value), t.value);
        else err(t, 'a token must be a name or a string literal');
      }
      continue;
    }
    if (h === 'prec') {
      const assoc = isAtom(it.items[1]) ? it.items[1].value : null;
      if (assoc !== 'left' && assoc !== 'right' && assoc !== 'nonassoc') {
        err(it, "(prec ...) needs 'left', 'right' or 'nonassoc'");
        continue;
      }
      precLevel++;
      for (const t of it.items.slice(2)) {
        const nm = isAtom(t) ? t.value : isStr(t) ? litName(t.value) : null;
        if (nm === null) { err(t, 'a precedence entry must be a name or a string literal'); continue; }
        if (isStr(t)) declTerm(nm, t.value);
        if (!terms.has(nm)) { err(t, `'${nm}' is not a declared token; precedence only applies to terminals`); continue; }
        prec.set(nm, { level: precLevel, assoc });
      }
      continue;
    }
    if (h === 'start') {
      if (!isAtom(it.items[1])) err(it, '(start N) needs a nonterminal name');
      else start = it.items[1].value;
      continue;
    }
    if (h === 'rule') {
      const nm = isAtom(it.items[1]) ? it.items[1].value : null;
      if (nm === null) { err(it, '(rule N ...) needs a nonterminal name'); continue; }
      if (!nonterms.has(nm)) nonterms.set(nm, { name: nm, rules: [] });
      continue;
    }
    if (h === 'lex') {
      if (lexNode !== null) err(it, 'a grammar may have at most one (lex ...) form');
      lexNode = it;
      continue;
    }
    err(it, `unknown grammar field '${h === null ? '?' : h}'`);
  }

  // 第二遍：规则体
  for (const it of items.slice(1)) {
    if (head(it) !== 'rule' || !isAtom(it.items[1])) continue;
    const lhs = it.items[1].value;
    for (const alt of it.items.slice(2)) {
      if (head(alt) !== '->') { err(alt, 'a rule alternative must be (-> (RHS...) ACTION)'); continue; }
      const parts = alt.items.slice(1);
      if (!isList(parts[0])) { err(alt, 'the right-hand side must be a list, possibly empty'); continue; }
      const rhs = [];
      for (const s of parts[0].items) {
        if (isStr(s)) { declTerm(litName(s.value), s.value); rhs.push(litName(s.value)); continue; }
        if (!isAtom(s)) { err(s, 'a right-hand side symbol must be a name or a string literal'); continue; }
        if (!terms.has(s.value) && !nonterms.has(s.value)) {
          err(s, `'${s.value}' is neither a declared token nor a rule`);
          continue;
        }
        rhs.push(s.value);
      }
      let k = 1;
      let rulePrec = null;
      let prefer = 0;
      let declaresType = null;
      let needsType = null;
      let needsNonType = null;
      /**
       * 一格标注要一个**位置**（`1..rhs.length`）。三条"回问"标注共用这一格判断 ——
       * 位置写错（不是整数、越界）是语法自己写错了，当场报，不猜。
       */
      const posOf = (form, what) => {
        const p = form.items[1];
        const txt = isAtom(p) ? p.value : '';
        if (!/^[0-9]+$/.test(txt)) { err(form, `(${what} K) needs a right-hand side position`); return null; }
        const n = Number(txt);
        if (n < 1 || n > rhs.length) { err(form, `(${what} ${n}) is out of range (rhs has ${rhs.length})`); return null; }
        return n;
      };
      const ANNOT = new Set(['prec', 'prefer', 'declares-type', 'needs-type', 'needs-non-type']);
      // 标注可以有零到几个，次序不限 —— 每条各判一次，判到就往后挪
      while (ANNOT.has(head(parts[k]))) {
        const h = head(parts[k]);
        if (h === 'prec') {
          const p = parts[k].items[1];
          const nm = isAtom(p) ? p.value : isStr(p) ? litName(p.value) : null;
          if (nm === null || !prec.has(nm)) err(parts[k], `(prec X) needs a terminal that has a precedence level`);
          else rulePrec = nm;
        } else if (h === 'prefer') {
          const p = parts[k].items[1];
          // 刻意不用 Number.isInteger：它不在封闭 ABI 里。正则字面量在（从字面量降下来的那几个）
          const txt = isAtom(p) ? p.value : '';
          if (!/^-?[0-9]+$/.test(txt)) err(parts[k], '(prefer N) needs an integer');
          else prefer = Number(txt);
        } else if (h === 'declares-type') {
          declaresType = posOf(parts[k], 'declares-type');
        } else if (h === 'needs-type') {
          needsType = posOf(parts[k], 'needs-type');
        } else {
          needsNonType = posOf(parts[k], 'needs-non-type');
        }
        k++;
      }
      const action = parts[k] ?? null;
      if (action === null) err(alt, 'a rule alternative needs an action template');
      nonterms.get(lhs).rules.push(rules.length);
      rules.push({
        lhs, rhs, action, prec: rulePrec, prefer, declaresType, needsType, needsNonType, span: alt.span,
      });
    }
  }

  if (start === null) {
    err(top, 'the grammar needs a (start N) field');
    return null;
  }
  if (!nonterms.has(start)) {
    err(top, `the start symbol '${start}' has no (rule ...)`);
    return null;
  }
  for (const nt of nonterms.values()) {
    if (nt.rules.length === 0) err(top, `nonterminal '${nt.name}' has no alternatives`);
  }

  // 词法规格。放在最后读：`(op "+")` 声明的终结符名要跟规则里 `"+"` 隐式声明的那个对上，
  // 而后者要等第二遍读完才齐。对不上就报错 —— 词法器发一个语法根本接不住的 token，
  // 症状会是运行期一句莫名的 "unexpected"，那种错不该拖到运行期。
  let lexSpec = null;
  if (lexNode !== null) {
    lexSpec = readLexSpec(lexNode, diags);
    if (lexSpec !== null) {
      for (const r of lexSpec.rules) {
        if (!terms.has(r.type)) err(top, `the lexer can produce ${r.type}, which is not a terminal of this grammar`);
      }
      for (const [type, words] of lexSpec.keywords) {
        for (const [w, target] of words) {
          if (!terms.has(target)) err(top, `the keyword '${w}' becomes ${target}, which is not a terminal of this grammar`);
        }
        if (!terms.has(type)) err(top, `(keyword ${type} ...) names a token type that is not a terminal`);
      }
      /* 自动分号补出来的那一格也是词法器发的记号 —— 同一条规矩：语法接不住就当场报错。
         不查的话症状会是"某个换行处莫名一句 unexpected"，那种错最难找。 */
      if (lexSpec.autoSemi !== null && !terms.has(lexSpec.autoSemi.type)) {
        err(top, `(auto-semi ...) inserts ${lexSpec.autoSemi.type}, which is not a terminal of this grammar`);
      }
      /* 缩进那三格同理：它们是词法器发的记号，语法接不住就当场报。 */
      if (lexSpec.indent !== null) {
        for (const t of [lexSpec.indent.nl, lexSpec.indent.indent, lexSpec.indent.dedent]) {
          if (!terms.has(t)) err(top, `(indent ...) emits ${t}, which is not a terminal of this grammar`);
        }
      }
    }
  }
  return { name, terms, nonterms, rules, start, prec, lex: lexSpec };
}

/**
 * 产生式的优先级：显式 `(prec X)` 优先，否则取 RHS 里**最后一个**有优先级的终结符。
 * 这条是 bison 的规矩，照抄 —— `exp: exp '+' exp` 的优先级于是就是 `'+'` 的。
 */
export function rulePrecOf(g, r) {
  if (r.prec !== null) return g.prec.get(r.prec) ?? null;
  let found = null;
  for (const s of r.rhs) {
    const p = g.prec.get(s);
    if (p !== undefined) found = p;
  }
  return found;
}
