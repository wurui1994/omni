// Omni — GLSL 的预处理：**只有对象宏**（ADR-0019 施工图 A11 的最窄那一档）
//
// 为什么只做对象宏：拿 `grapheq.glsl` 那 772 行数出来的 —— 8 处 `#define` 全是对象宏，
// 一个函数宏都没有，也没有 `#if`/`#ifdef`/`#include`。所以这一片收的正好是「那一份要什么」，
// 别的一律**明着骂**（宁可少收，不能悄悄按别的意思编）。
//
// 位置：在词法之后、语法之前。`glsl.grammar` 里 `#` 开头到行尾是**一个 `VERSION` token**
// （那条 token 规则本来是为 `#version` 写的），所以 `#define` 那些行现在就已经是一个个
// token 摆在流里了 —— 这一片要做的就是把它们摘出来、把用到的地方换掉。
//
// 展开是**定义时**展开（`#define NO_GAP vec2(BIG, -BIG)` 里的 `BIG` 在读到这一行时就换掉），
// 不是使用时。对象宏且不许重定义的话，两种时机等价，而定义时展开天然没有递归问题。
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
  const run = (input, stack) => {
    const out = [];
    for (const t of input) {
      if (t.type !== 'VERSION') {
        /* 只有 `ID` 会是宏名 —— 关键字与类型名在这个语法里都是**关键字 token**，
         * 所以 `#define float double` 这种改不动类型名，那是对的（GLSL 也不许）。 */
        const body = t.type === 'ID' ? macros.get(t.node.value) : undefined;
        if (body === undefined) out.push(t);
        else out.push(...body);
        continue;
      }
      const text = t.node.value;
      if (/^#\s*version\b/.test(text)) { out.push(t); continue; }
      const inc = INCLUDE.exec(text);
      if (inc !== null) {
        out.push(...include(inc[1] === undefined ? inc[2] : inc[1], t, stack));
        continue;
      }
      const m = DEFINE.exec(text);
      if (m === null) {
        /* `#undef`/`#if`/`#ifdef`/`#else`/`#endif`/`#pragma`/`#extension`/`#line`
         * 都落在这儿。骂得具体一点：说清「收的是哪一档」，而不是「语法错误」。 */
        diags.error(t.span, `glsl 的预处理这一片只收 #version、对象宏 #define 与 #include，`
          + `不收 ${JSON.stringify(text.trim().split(/\s+/)[0])}`);
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
        /* GLSL 要求先 `#undef` 再重定义，而 `#undef` 这一片不收 —— 所以重定义一定是错的。
         *
         * **include 进来的那一份例外**：同一份被两条链 include 到（`math/functions.glsl`
         * 在 vispy 里就是），第二遍整份跳过（见 `include`），所以走不到这儿。 */
        diags.error(t.span, `宏 '${name}' 定义了两次（GLSL 要求先 #undef，而这一片不收 #undef）`);
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
  const include = (name, t, stack) => {
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
