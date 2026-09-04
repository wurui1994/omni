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

/**
 * 对象宏的展开。
 *
 * @param {any} lexSpec `readGrammar(...).lex`
 * @param {{type: string, node: any, span: any}[]} toks 词法出来的 token 流
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {{type: string, node: any, span: any}[]} 展开后的 token 流
 */
export function glslPreprocess(lexSpec, toks, diags) {
  if (toks === null || toks === undefined) return toks;
  const macros = new Map();
  const out = [];

  /** 把一段宏体文本切成 token（用的是**同一个**词法规格，所以宏体里的写法与源码里一致）。 */
  const lexBody = (name, text, span) => {
    const file = new SourceFile(`${span.file.path} 的 #define ${name}`, text);
    const sub = lexText(lexSpec, file, diags);
    return sub === null ? [] : sub;
  };

  for (const t of toks) {
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
    const m = DEFINE.exec(text);
    if (m === null) {
      /* `#undef`/`#if`/`#ifdef`/`#else`/`#endif`/`#include`/`#pragma`/`#extension`/`#line`
       * 都落在这儿。骂得具体一点：说清「收的是哪一档」，而不是「语法错误」。 */
      diags.error(t.span, `glsl 的预处理这一片只收 #version 与对象宏 #define，不收 ${JSON.stringify(text.trim().split(/\s+/)[0])}`);
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
      /* GLSL 要求先 `#undef` 再重定义，而 `#undef` 这一片不收 —— 所以重定义一定是错的。 */
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
