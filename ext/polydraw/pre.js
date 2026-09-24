// ext/polydraw/pre.js —— EVAL 两门语言的**预处理**（`#define` / `#if` 那一族）
//
// 语料里这一族是真在用的（134 份 `.kc` 里 43 处 `#if`、31 处 `#define`）：
//
//     #define WATER 1.333
//     #if 0
//        …这一段是作者留着的另一个版本
//     #else
//        …
//     #endif
//
// 所以它不是"C 的习惯带过来的"，是这门语言的一部分（`eval.c` 那侧也有一台）。
//
// ## 两条硬规矩
//
// 1. **行数不变**：指令行与被切掉的行都换成空行 —— 诊断里的行号得还是原文的行号
//    （这门语言的错误消息带行列，错一行就没法照着源码看）。
// 2. **第一个 `@` 之后原样不动**：那之后是着色器区段（`@v`/`@f`，GLSL 或 ARB 汇编原文），
//    里头 `#version` / `#ADD d,a,…` 这种行**不是**我们的指令。词法层也是从第一个 `@`
//    整段跳过去的（见 `polydraw.grammar` 的头注），两处口径一致。
//
// ## 支持到哪儿（明写）
//
// * `#define 名字 内容`（**只有对象型宏**：语料里一个带括号的函数型宏都没有）、`#undef`；
// * `#if 表达式` / `#ifdef 名` / `#ifndef 名` / `#elif 表达式` / `#else` / `#endif`（可嵌套）；
// * 表达式里认：十进制/十六进制数、`defined(名)`、宏名（没定义的算 0）、
//   `! - ~`、`* / % + - << >> < <= > >= == != & ^ | && ||`、括号。
//   认不出的形状**当场报**（不许悄悄当 0 —— 那会把一整段代码静默切掉）。
// * `#include` 没有（语料里也没有）；碰到就报。

/** 一行是不是指令行（前头可以有空白）。 */
const DIRECTIVE = /^[ \t]*#[ \t]*([A-Za-z]+)[ \t]*(.*)$/;

/** 宏名 -> 展开的文本。 */
function expand(s, macros, depth = 0) {
  if (depth > 8 || macros.size === 0) return s;
  let out = '';
  let i = 0;
  let changed = false;
  while (i < s.length) {
    const c = s[i];
    /* 串里的内容不动（`"WATER"` 是那五个字母，不是那个数）。 */
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      out += s.slice(i, j < 0 ? s.length : j + 1);
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j++;
      const w = s.slice(i, j);
      if (macros.has(w)) { out += macros.get(w); changed = true; } else out += w;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return changed ? expand(out, macros, depth + 1) : out;
}

/* ─── `#if` 那一行的表达式 ─────────────────────────────────────────────
 *
 * 一台最小的递归下降：切词 -> 按优先级往下。**整数语义**（C 的预处理器也是整数），
 * 没定义的名字算 0。认不出的词当场报 —— 悄悄当 0 会把一整段代码静默切掉。
 */
function tokens(s, where) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]+)/.exec(s.slice(i));
      out.push({ t: 'num', v: Number(m[1]) });
      i += m[1].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i));
      out.push({ t: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>=', '<<', '>>'].includes(two)) {
      out.push({ t: two });
      i += 2;
      continue;
    }
    if ('()!~-+*/%<>&^|'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`${where}: \`#if\` 的表达式里认不出 \`${c}\``);
  }
  return out;
}

/** 按优先级从低到高的二元算子表（`&&` 最松、`*` 最紧）。 */
const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='],
  ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

function evalExpr(ts, macros, where) {
  let p = 0;
  const peek = () => (p < ts.length ? ts[p] : null);
  const apply = (op, a, b) => {
    if (op === '||') return (a !== 0 || b !== 0) ? 1 : 0;
    if (op === '&&') return (a !== 0 && b !== 0) ? 1 : 0;
    if (op === '|') return a | b;
    if (op === '^') return a ^ b;
    if (op === '&') return a & b;
    if (op === '==') return a === b ? 1 : 0;
    if (op === '!=') return a !== b ? 1 : 0;
    if (op === '<') return a < b ? 1 : 0;
    if (op === '<=') return a <= b ? 1 : 0;
    if (op === '>') return a > b ? 1 : 0;
    if (op === '>=') return a >= b ? 1 : 0;
    if (op === '<<') return a << b;
    if (op === '>>') return a >> b;
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    if (op === '/') return b === 0 ? 0 : Math.trunc(a / b);
    return b === 0 ? 0 : a % b;
  };
  const unary = () => {
    const t = peek();
    if (t === null) throw new Error(`${where}: \`#if\` 的表达式缺了一段`);
    if (t.t === '!') { p++; return unary() === 0 ? 1 : 0; }
    if (t.t === '-') { p++; return -unary(); }
    if (t.t === '+') { p++; return unary(); }
    if (t.t === '~') { p++; return ~unary(); }
    if (t.t === '(') {
      p++;
      const v = level(0);
      if (peek() === null || peek().t !== ')') throw new Error(`${where}: \`#if\` 里少一个 \`)\``);
      p++;
      return v;
    }
    if (t.t === 'num') { p++; return t.v; }
    if (t.t === 'name') {
      p++;
      /* `defined(X)` / `defined X` —— 宏展开之前就该算它，所以这一格在这儿判。 */
      if (t.v === 'defined') {
        let name = null;
        if (peek() !== null && peek().t === '(') {
          p++;
          if (peek() === null || peek().t !== 'name') throw new Error(`${where}: \`defined(\` 后面要一个名字`);
          name = ts[p].v;
          p++;
          if (peek() === null || peek().t !== ')') throw new Error(`${where}: \`defined(\` 少一个 \`)\``);
          p++;
        } else if (peek() !== null && peek().t === 'name') { name = ts[p].v; p++; }
        else throw new Error(`${where}: \`defined\` 后面要一个名字`);
        return macros.has(name) ? 1 : 0;
      }
      /* 展开之后还是名字 = 没定义 ⇒ 0（C 的预处理器就是这条）。 */
      return 0;
    }
    throw new Error(`${where}: \`#if\` 的表达式里认不出 \`${t.t}\``);
  };
  const level = (n) => {
    if (n >= LEVELS.length) return unary();
    let v = level(n + 1);
    for (;;) {
      const t = peek();
      if (t === null || !LEVELS[n].includes(t.t)) return v;
      p++;
      v = apply(t.t, v, level(n + 1));
    }
  };
  const v = level(0);
  if (p !== ts.length) throw new Error(`${where}: \`#if\` 的表达式后头还剩东西`);
  return v;
}

/**
 * 预处理一份源码。**行数不变**、第一个 `@` 之后原样不动（见头注那两条规矩）。
 *
 * `where` 只进错误消息（文件名）。回的是同样行数的文本。
 */
export function preprocess(text, where = 'eval') {
  const src = String(text ?? '');
  if (!/^[ \t]*#/m.test(src)) return src;        /* 一行指令都没有：原样回（常见情况） */
  const lines = src.split('\n');
  const macros = new Map();
  /* 条件栈：`{ live, taken }` —— `live` 是这一层现在收不收，`taken` 是这一层已经有分支中过。 */
  const stack = [];
  const live = () => stack.every((s) => s.live);
  const out = [];
  let inSections = false;
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    if (inSections || /^[ \t]*@/.test(raw)) { inSections = true; out.push(raw); continue; }
    const m = DIRECTIVE.exec(raw);
    if (m === null) { out.push(live() ? expand(raw, macros) : ''); continue; }
    const at = `${where}:${ln + 1}`;
    const op = m[1];
    /* 指令行后头的注释切掉（`#define X 1 //注`、`#if 0   ` 那种）。 */
    const arg = m[2].replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (op === 'define' || op === 'undef') {
      if (live()) {
        const nm = /^[A-Za-z_][A-Za-z_0-9]*/.exec(arg);
        if (nm === null) throw new Error(`${at}: \`#${op}\` 后面要一个名字`);
        if (op === 'undef') macros.delete(nm[0]);
        else macros.set(nm[0], arg.slice(nm[0].length).trim());
      }
      out.push('');
      continue;
    }
    if (op === 'if' || op === 'ifdef' || op === 'ifndef') {
      let v = 0;
      if (live()) {
        if (op === 'if') v = evalExpr(tokens(expand(arg, macros), at), macros, at) !== 0 ? 1 : 0;
        else {
          const has = macros.has(arg);
          v = (op === 'ifdef' ? has : !has) ? 1 : 0;
        }
      }
      stack.push({ live: v === 1, taken: v === 1 });
      out.push('');
      continue;
    }
    if (op === 'elif' || op === 'else') {
      const top = stack[stack.length - 1];
      if (top === undefined) throw new Error(`${at}: \`#${op}\` 没有对应的 \`#if\``);
      /* 外层关着的时候整层都不收；本层已经有分支中过也不收。 */
      const outerLive = stack.slice(0, -1).every((s) => s.live);
      if (!outerLive || top.taken) top.live = false;
      else if (op === 'else') { top.live = true; top.taken = true; }
      else {
        const v = evalExpr(tokens(expand(arg, macros), at), macros, at) !== 0;
        top.live = v;
        top.taken = v;
      }
      out.push('');
      continue;
    }
    if (op === 'endif') {
      if (stack.pop() === undefined) throw new Error(`${at}: \`#endif\` 没有对应的 \`#if\``);
      out.push('');
      continue;
    }
    if (op === 'include') {
      throw new Error(`${at}: \`#include\` 这一格没有（语料里也没有）——`
        + ' 要拼几份文件就在命令行上给（`--pkgs`）');
    }
    throw new Error(`${at}: 认不出的预处理指令 \`#${op}\``);
  }
  if (stack.length > 0) throw new Error(`${where}: 有 ${stack.length} 个 \`#if\` 没有 \`#endif\``);
  return out.join('\n');
}

