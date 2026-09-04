// Omni — GLSL 的预处理（ADR-0019 施工图 A11）
//
// 收的这一档照着 mesa/llvmpipe 的 `glcpp`：**对象宏 + `#if` 一族 + `#include`**，
// 加上收下并忽略的 `#pragma`/`#line`/`#extension`。**函数宏还不收**（明着骂）——
// 那一格是下一刀，理由见下面那条错误消息。
//
// 起点是 `grapheq.glsl` 那 772 行数出来的最窄一档（8 处对象宏、无 `#if`、无 `#include`）；
// 后来 vispy 那 73 份逼出了 `#include`（网状 include 图）与 `#if` 一族
// （`#ifdef GL_ES`、include guard、`#if defined(X) && X > 1`）。
//
// 位置：在词法之后、语法之前。`glsl.grammar` 里 `#` 开头到行尾是**一个 `VERSION` token**
// （那条 token 规则本来是为 `#version` 写的），所以指令行现在就已经是一个个
// token 摆在流里了 —— 这一片要做的就是把它们摘出来、把用到的地方换掉。
//
// 展开是**定义时**展开（`#define NO_GAP vec2(BIG, -BIG)` 里的 `BIG` 在读到这一行时就换掉），
// 不是使用时。对象宏且不许重定义的话，两种时机等价，而定义时展开天然没有递归问题。
// `#if` 里的展开是另一份（按**文本**再展开一次，见 `ceEval`）：那儿要的是整数常量表达式。
//
// 替换进来的 token 的 span 指向一个合成源文件（`… 的 #define BIG`）—— 报错时指的是宏体
// 里的那一段，而不是使用处。这比让它指向别处的字节要诚实。
//
// **替换是上下文无关的**，与 C 的预处理器同：`#define x 9.0` 之后 `v.x` 会变成 `v.9.0`
// 然后语法那一侧骂。那不是这一片的 bug —— 预处理器就是这么定义的（它不认识成员访问），
// 量过 C 与 GLSL 都是这个行为。所以宏名别取 `x`/`y`/`z`/`w`。
//
// 宏名**必须是标识符**：`#define float double` 这种在 GLSL 里是非法的，而在这一片里
// 「不报错但也不生效」会更坏（悄悄按别的意思编），所以拿同一个词法器验一遍再骂。

import { lexText } from '../glr/lex.js';
import { SourceFile } from '../source/diag.js';

/** `#define NAME BODY` —— 名字后面**紧跟** `(` 的是函数宏（这一片不收）。 */
const DEFINE = /^#\s*define\s+([A-Za-z_]\w*)([\s\S]*)$/;

/** `#include "路径"` 或 `#include <路径>`（`ARB_shading_language_include` 那两种写法）。 */
const INCLUDE = /^#\s*include\s*(?:"([^"]*)"|<([^>]*)>)\s*$/;

/** 套多深就当是环（真的环由 `stack` 认，这一条是兜底）。 */
const INCLUDE_MAX = 32;

/** 一条指令的名字：`#  ifdef` -> `ifdef`。 */
const DIRECTIVE = /^#\s*([A-Za-z_]\w*)?/;

/* ------------------------------------------------ `#if` 的条件表达式（ADR-0019 A11 第二档）
 * 照着 mesa/llvmpipe 的 `glcpp` 那一档来：**整数常量表达式**加 `defined`。
 * 浮点、字符串、逗号、赋值都不在里面（GLSL 规范 3.4 就是这么写的）。
 *
 * 三条与 C 一致的规矩：
 *   - `defined(X)` 与 `defined X` 两种写法都收。
 *   - **没定义过的标识符当 0**（glcpp 的行为；GLSL 规范说它是错，而 mesa 只警告）。
 *     悄悄当 0 是这一格唯一能与真实着色器对上的选择 —— vispy 那些 `#if GL_ES` 就靠它。
 *   - 非零为真。除零在**常量表达式**里是错，所以骂而不是给 0。
 */
const CE_TOK = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+|^(?:0[xX][0-9a-fA-F]+|\d+)[uU]?|^[A-Za-z_]\w*|^(?:<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!<>()])/;

/** 把条件表达式切成记号（空白与注释直接丢）。 */
function ceLex(text) {
  const out = [];
  let s = text;
  while (s.length > 0) {
    const m = CE_TOK.exec(s);
    if (m === null) return null;      // 不认识的字符 —— 让调用方骂
    const tk = m[0];
    s = s.slice(tk.length);
    if (/^\s|^\/\//.test(tk) || tk.startsWith('/*')) continue;
    out.push(tk);
  }
  return out;
}

/**
 * 条件表达式的求值。递归下降，优先级与 C 相同（从 `||` 到一元）。
 *
 * @param {string[]} tk 记号
 * @param {Map<string, string>} texts 宏名 -> 宏体**文本**（`#if` 里要按文本再展开一次，
 *   与 token 那份分开：token 那份是给源码用的，这儿要的是「整数常量表达式」的文本）
 * @returns {{v: number} | {err: string}}
 */
function ceEval(tk, texts) {
  let p = 0;
  let bad = null;
  const peek = () => (p < tk.length ? tk[p] : null);
  const take = () => tk[p++];
  const fail = (m) => { if (bad === null) bad = m; return 0; };

  /* 标识符：`defined` 先接手，其余按宏展开（展开后再整段求值一次，深度设上限防环）。 */
  const ident = (name, depth) => {
    if (depth > 32) return fail(`'${name}' 在 #if 里展开得太深，当成环了`);
    const body = texts.get(name);
    if (body === undefined) return 0;          // 没定义过 -> 0（glcpp 的行为）
    const sub = ceLex(body);
    if (sub === null) return fail(`宏 '${name}' 的宏体在 #if 里不是整数常量表达式：${body.trim()}`);
    if (sub.length === 0) return fail(`宏 '${name}' 的宏体是空的，不能用在 #if 里`);
    const r = ceEval(sub, texts);
    if (r.err !== undefined) return fail(r.err);
    return r.v;
  };

  /* `unary` 与 `expr` 是**互相递归**的，所以其中一个必须先占个名字再填。
   * 这不是风格，是自编译子集的要求：降级器按词法顺序解析名字，「后面那个 `const`」
   * 它看不见（真 JS 里靠 TDZ 只在运行期挡，编译期那个绑定是在的）。互相递归下
   * 换顺序也解决不了，所以先 `let … = null`、后面再赋上。 */
  let expr = null;

  const unary = () => {
    const t = peek();
    if (t === null) return fail('#if 的表达式在这儿断了');
    if (t === '!') { take(); return unary() === 0 ? 1 : 0; }
    if (t === '~') { take(); return ~unary(); }
    if (t === '-') { take(); return -unary(); }
    if (t === '+') { take(); return unary(); }
    if (t === '(') {
      take();
      const v = expr(0);
      if (peek() !== ')') return fail("#if 的表达式少一个 ')'");
      take();
      return v;
    }
    if (/^\d/.test(t)) {
      take();
      const n = t.replace(/[uU]$/, '');
      return n.startsWith('0x') || n.startsWith('0X') ? parseInt(n, 16) : parseInt(n, 10);
    }
    if (/^[A-Za-z_]/.test(t)) {
      take();
      if (t === 'defined') {
        /* `defined(X)` 与 `defined X`。 */
        const paren = peek() === '(';
        if (paren) take();
        const name = peek();
        if (name === null || !/^[A-Za-z_]/.test(name)) return fail("defined 后面要一个宏名");
        take();
        if (paren) {
          if (peek() !== ')') return fail("defined( 后面少一个 ')'");
          take();
        }
        return texts.has(name) ? 1 : 0;
      }
      return ident(t, 0);
    }
    return fail(`#if 的表达式里不认识 ${JSON.stringify(t)}`);
  };

  /* 优先级表。`||`/`&&` 要短路（`#if defined(X) && X > 2` 里 X 没定义时右边不能骂）。 */
  const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='],
    ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  expr = (lv) => {
    if (lv >= LEVELS.length) return unary();
    let v = expr(lv + 1);
    for (;;) {
      const t = peek();
      if (t === null || LEVELS[lv].indexOf(t) < 0) return v;
      take();
      const r = expr(lv + 1);
      if (t === '||') v = (v !== 0 || r !== 0) ? 1 : 0;
      else if (t === '&&') v = (v !== 0 && r !== 0) ? 1 : 0;
      else if (t === '|') v = v | r;
      else if (t === '^') v = v ^ r;
      else if (t === '&') v = v & r;
      else if (t === '==') v = v === r ? 1 : 0;
      else if (t === '!=') v = v !== r ? 1 : 0;
      else if (t === '<') v = v < r ? 1 : 0;
      else if (t === '>') v = v > r ? 1 : 0;
      else if (t === '<=') v = v <= r ? 1 : 0;
      else if (t === '>=') v = v >= r ? 1 : 0;
      else if (t === '<<') v = v << r;
      else if (t === '>>') v = v >> r;
      else if (t === '+') v = v + r;
      else if (t === '-') v = v - r;
      else if (t === '*') v = v * r;
      else if (t === '/') { if (r === 0) return fail('#if 的表达式里除以 0'); v = Math.trunc(v / r); }
      else if (t === '%') { if (r === 0) return fail('#if 的表达式里对 0 取余'); v = v % r; }
    }
  };

  const v = expr(0);
  if (bad !== null) return { err: bad };
  if (p !== tk.length) return { err: `#if 的表达式后面还剩 ${JSON.stringify(tk.slice(p).join(' '))}` };
  return { v };
}

/**
 * 对象宏的展开 + `#include`。
 *
 * @param {any} lexSpec `readGrammar(...).lex`
 * @param {{type: string, node: any, span: any}[]} toks 词法出来的 token 流
 * @param {import('../source/diag.js').Diagnostics} diags
 * @param {{open?: (name: string, fromPath: string) => ({path: string, text: string} | null)}} [opts]
 *   `open` 是**注入的文件查找**：给一个 `#include` 的名字与「谁 include 的」，
 *   回 `{path, text}` 或 null（找不到）。不给这一格就照旧骂「不收 #include」——
 *   这一片不碰文件系统（IO 在 CLI 那一层），与别处同一条规矩。
 * @returns {{type: string, node: any, span: any}[]} 展开后的 token 流
 */
export function glslPreprocess(lexSpec, toks, diags, opts) {
  if (toks === null || toks === undefined) return toks;
  const macros = new Map();
  /** 宏体的**文本**那一份：只给 `#if` 用（见 `ceEval`）。 */
  const texts = new Map();
  const open = opts === undefined || opts === null ? undefined : opts.open;

  /** 把一段宏体文本切成 token（用的是**同一个**词法规格，所以宏体里的写法与源码里一致）。 */
  const lexBody = (name, text, span) => {
    const file = new SourceFile(`${span.file.path} 的 #define ${name}`, text);
    const sub = lexText(lexSpec, file, diags);
    return sub === null ? [] : sub;
  };

  /**
   * 一份源码的 token 流走一遍。`stack` 是当前 include 链（认环用），
   * `macros` 是**共用的** —— `#include "math/constants.glsl"` 之后那些宏得能用，
   * 那正是 vispy 那 73 份的用法。
   */
  /* `run` 与 `include` 互相递归（include 进来的那一份还要再走一趟 run），
   * 所以先占名字再填 —— 与 `ceEval` 里 `expr` 那一处同一个理由。 */
  let include = null;

  const run = (input, stack) => {
    const out = [];
    /* 条件栈（`#if` 一族）。每一层三格：
     *   `on`   这一层现在收不收
     *   `took` 这一层已经有分支被收过了（`#elif` 靠它）
     *   `up`   外层收不收（外层不收，整层都不收，条件也不求值）
     * 不收的时候**只认条件指令**：里面的 `#define` 不生效、里面的错误不报 ——
     * 那正是 include guard 与 `#ifdef GL_ES` 的意义所在。 */
    const cond = [];
    const on = () => cond.length === 0 || cond[cond.length - 1].on;

    /** `#if`/`#elif` 的条件求值 + 报错。不收的层里不求值（也就不会骂）。 */
    const evalCond = (text, t) => {
      const tk = ceLex(text);
      if (tk === null || tk.length === 0) {
        diags.error(t.span, `#if 的条件读不成整数常量表达式：${text.trim()}`);
        return false;
      }
      const r = ceEval(tk, texts);
      if (r.err !== undefined) { diags.error(t.span, r.err); return false; }
      return r.v !== 0;
    };

    for (const t of input) {
      if (t.type !== 'VERSION') {
        if (!on()) continue;
        /* 只有 `ID` 会是宏名 —— 关键字与类型名在这个语法里都是**关键字 token**，
         * 所以 `#define float double` 这种改不动类型名，那是对的（GLSL 也不许）。 */
        const body = t.type === 'ID' ? macros.get(t.node.value) : undefined;
        if (body === undefined) out.push(t);
        else out.push(...body);
        continue;
      }
      const text = t.node.value;
      const dm = DIRECTIVE.exec(text);
      const dir = dm === null || dm[1] === undefined ? '' : dm[1];
      /* ---- 条件那五条：**不管这一层收不收都要认**，否则嵌套的层数就数错了。 */
      if (dir === 'ifdef' || dir === 'ifndef' || dir === 'if') {
        const up = on();
        let v = false;
        if (up) {
          if (dir === 'if') {
            v = evalCond(text.replace(/^#\s*if\b/, ''), t);
          } else {
            const m = /^#\s*ifn?def\s+([A-Za-z_]\w*)\s*$/.exec(text);
            if (m === null) {
              diags.error(t.span, `${dir} 后面要一个宏名：${text.trim()}`);
            } else {
              v = texts.has(m[1]) === (dir === 'ifdef');
            }
          }
        }
        cond.push({ on: up && v, took: v, up });
        continue;
      }
      if (dir === 'elif' || dir === 'else') {
        const top = cond.length > 0 ? cond[cond.length - 1] : null;
        if (top === null) { diags.error(t.span, `#${dir} 没有配对的 #if`); continue; }
        if (dir === 'else') {
          top.on = top.up && !top.took;
          top.took = true;
          continue;
        }
        /* `#elif`：前面已经有分支收过了就整条跳过（连条件都不求值 —— C 与 GLSL 同）。 */
        if (top.took) { top.on = false; continue; }
        const v = top.up && evalCond(text.replace(/^#\s*elif\b/, ''), t);
        top.on = v;
        top.took = v;
        continue;
      }
      if (dir === 'endif') {
        if (cond.length === 0) { diags.error(t.span, '#endif 没有配对的 #if'); continue; }
        cond.pop();
        continue;
      }
      if (!on()) continue;
      if (dir === 'version') { out.push(t); continue; }
      /* `#pragma` / `#line` / `#extension`：**照 mesa 的做法收下并忽略**。
       * 为什么不骂：`#extension GL_OES_standard_derivatives : enable` 在 vispy 那些
       * 着色器里到处都是，而它要的那几个内建（`dFdx`/`dFdy`）本来就在我们的表里；
       * 骂它等于把一堆本来能编的着色器挡在门外。真要 `: require` 一个我们没有的扩展，
       * 那才该骂 —— 那一格留在下面。 */
      if (dir === 'pragma' || dir === 'line') continue;
      if (dir === 'extension') {
        const m = /^#\s*extension\s+([A-Za-z_0-9]+)\s*:\s*([A-Za-z]+)/.exec(text);
        if (m !== null && m[2] === 'require' && m[1] !== 'all') {
          diags.error(t.span, `#extension ${m[1]} : require —— 这一档没有这个扩展`
            + '（enable/warn/disable 会被收下并忽略）');
        }
        continue;
      }
      if (dir === 'undef') {
        const m = /^#\s*undef\s+([A-Za-z_]\w*)\s*$/.exec(text);
        if (m === null) { diags.error(t.span, `#undef 后面要一个宏名：${text.trim()}`); continue; }
        macros.delete(m[1]);
        texts.delete(m[1]);
        continue;
      }
      const inc = INCLUDE.exec(text);
      if (inc !== null) {
        out.push(...include(inc[1] === undefined ? inc[2] : inc[1], t, stack));
        continue;
      }
      const m = DEFINE.exec(text);
      if (m === null) {
        /* 剩下的都是真不认识的指令。骂得具体一点：说清「收的是哪一档」。 */
        diags.error(t.span, `glsl 的预处理收 #version / #define / #undef / #if 一族 /`
          + ` #include / #pragma / #line / #extension，不收 ${JSON.stringify(dir === '' ? text.trim() : `#${dir}`)}`);
        continue;
      }
      const name = m[1];
      const rest = m[2];
      if (rest.startsWith('(')) {
        diags.error(t.span, `glsl 的预处理这一片不收函数宏（'${name}' 的名字后面紧跟着 '('）——`
          + '只收对象宏。名字与 ( 之间加一个空格才是「宏体以 ( 开头」的对象宏');
        continue;
      }
      /* 宏名必须真是个标识符：`#define float double` 在 GLSL 里非法，而这一片里它会
       * 「不报错也不生效」（`float` 是关键字 token，永远不参与替换）—— 那种沉默更坏。 */
      const nameToks = lexBody(name, name, t.span);
      if (nameToks.length !== 1 || nameToks[0].type !== 'ID') {
        diags.error(t.span, `'${name}' 是关键字，不能拿它当宏名`);
        continue;
      }
      if (macros.has(name)) {
        /* GLSL 要求先 `#undef` 再重定义 —— 现在 `#undef` 收了，所以这一条是真的「重定义」。
         *
         * **include 进来的那一份例外**：同一份被两条链 include 到（`math/functions.glsl`
         * 在 vispy 里就是），第二遍整份跳过（见 `include`），所以走不到这儿。 */
        diags.error(t.span, `宏 '${name}' 定义了两次（GLSL 要求先 #undef）`);
        continue;
      }
      /* 宏体里已经定义过的宏在这里就换掉（定义时展开）。 */
      const raw = lexBody(name, rest, t.span);
      const body = [];
      for (const b of raw) {
        const sub = b.type === 'ID' ? macros.get(b.node.value) : undefined;
        if (sub === undefined) body.push(b);
        else body.push(...sub);
      }
      macros.set(name, body);
      texts.set(name, rest);
    }
    if (cond.length > 0) {
      diags.error(input[input.length - 1].span, `#if 少了 ${cond.length} 个 #endif`);
    }
    return out;
  };

  /**
   * 一条 `#include`。
   *
   * 三条规矩写在明处：
   *   1. **文件只进来一次**（第二次整份跳过）。GLSL 那边没有 `#pragma once`
   *      这一说，而 include 图是网状的（vispy 的 `math/functions.glsl` 被好几份引），
   *      重复进来就会「宏定义了两次」「函数定义了两次」。C 那边靠 include guard，
   *      而 guard 要 `#ifndef` —— 这一片还不收它，所以规矩定在这一层。
   *   2. **认环**：链上出现过就骂，指的是那条 `#include` 的位置。
   *   3. 找不到就骂，把「谁 include 的」一起说出来。
   */
  const seen = new Set();
  include = (name, t, stack) => {
    if (open === undefined) {
      diags.error(t.span, 'glsl 的预处理这一片只收 #version 与对象宏 #define，不收 "#include"'
        + '（这一趟没给 include 的查找口子）');
      return [];
    }
    if (stack.length >= INCLUDE_MAX) {
      diags.error(t.span, `#include 套了 ${INCLUDE_MAX} 层，当成环了`);
      return [];
    }
    const from = t.span.file.path;
    const f = open(name, from);
    if (f === null || f === undefined) {
      diags.error(t.span, `#include 找不到 ${JSON.stringify(name)}（${from} 引的）`);
      return [];
    }
    if (stack.indexOf(f.path) >= 0) {
      diags.error(t.span, `#include 成环了：${[...stack, f.path].join(' -> ')}`);
      return [];
    }
    if (seen.has(f.path)) return [];
    seen.add(f.path);
    const sub = lexText(lexSpec, new SourceFile(f.path, f.text), diags);
    if (sub === null) return [];
    return run(sub, [...stack, f.path]);
  };

  const rootPath = toks.length > 0 ? toks[0].span.file.path : '<空>';
  seen.add(rootPath);
  return run(toks, [rootPath]);
}

/**
 * **词法反馈**：`struct IV { … };` 之后，所有值为 `IV` 的 `ID` token 重判成 `TYPENAME`
 * （ADR-0019 施工图 B13 第 1 步）。
 *
 * 为什么要有这一步：上一次给语法加 `type -> (ID)`，让**任何**标识符都可能是类型 ——
 * 构表零冲突，但 12 组只剩 1 组绿（`length(v)` 被当成构造）。教训是「LR 表没冲突
 * ≠ 语法没歧义」。这次让**这一层**决定谁是类型，语法里 `type -> TYPENAME` 与
 * `expr -> ID` 就不再打架。真 GLSL 编译器也是这么做的。
 *
 * `TYPENAME` **只由这一步产出，词法器里根本没有它** —— `grammar.js` 只单向检查
 * 「词法器产出的 token 必须是终结符」，所以不必编一条永不匹配的假词法规则。
 *
 * `struct` 后面紧跟的那个名字**不重判**：语法那条规则写的是 `("struct" ID "{" …)`。
 */
export function glslTypeNames(toks) {
  if (toks === null || toks === undefined) return toks;
  const names = new Set();
  const out = [];
  let afterStruct = false;
  for (const t of toks) {
    if (afterStruct) {
      afterStruct = false;
      if (t.type === 'ID') { names.add(t.node.value); out.push(t); continue; }
      /* `struct` 后面不是标识符 —— 交给语法去骂，这一层不抢着报错。 */
    }
    if (t.type === '"struct"') { afterStruct = true; out.push(t); continue; }
    if (t.type === 'ID' && names.has(t.node.value)) {
      out.push({ ...t, type: 'TYPENAME' });
      continue;
    }
    out.push(t);
  }
  return out;
}
