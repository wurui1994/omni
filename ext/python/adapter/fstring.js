// ext/python/adapter/fstring.js —— **f-string 的内部结构**（PEP 498 / PEP 701）
//
// 这一份只做一件事：把 f-string 的**正文**切成若干段 —— 字面的一段、或者"一段要再解析的
// 表达式 + 转换 + 格式说明"。**不解析表达式**（那一步走 `C.exprTreeOf`，用的是同一张
// LR 表，jnc 的 `jncParseExpr` 是同一条先例）。
//
// 为什么不走 PEP 701 那条（词法层发 FSTRING_START / MIDDLE / END 三族记号）：
// 这套 GLR 的词法器是**一张 DFA** —— 没有起始条件、也没有栈（`src/core/glr/lex.js:56-61`、
// `:27-29`；`(indent …)` 是它唯一一格有栈的东西，而且是显式声明的）。要发那三族记号就得
// 给它加第二个栈与起始条件，还要同步改语法里的终结符与 `atom` 那几条规则，并与
// `(indent …)` 的括号计数纠缠。jnc 那一门撞上同一件事，选的是"整块当一格记号、
// 要用时再解析一遍"（`src/core/lang/jnc.js:87-119` 的注把理由写全了）—— 这儿照抄。
//
// ## 切的规矩（`Parser/string_parser.c` 与 PEP 498 的"替换字段"那一节）
//
//   * `{{` 是一个字面的 `{`，`}}` 是一个字面的 `}`；
//   * `{` 开一格替换字段，到**配平的** `}` 为止。配平要数 `(` `[` `{`，还要跳过里头的
//     引号串（`f"{d['k']}"` 里那两个引号不算括号，也不结束这一格字段）；
//   * 字段里**顶层**的 `!` 后面一个字母是转换（`!r` / `!s` / `!a`）—— 但 `!=` 不是；
//   * 字段里**顶层**的 `:` 后面是格式说明（`{x:.2f}`）。切片的 `:` 在 `[]` 里，
//     所以只认"圆/方括号都平了"那一层的 `:`；
//   * `{x=}` 是调试用的自文档形式（印 `x=<值>`）—— 这一版**不接**，当场说清。

/**
 * 一格 f-string 的正文 → 若干段。
 *
 * 交回来的每一段是 `{ lit }`（字面文本）或
 * `{ src, conv, spec }`（`src` 是那段表达式的**原文**，`conv` 是 `r`/`s`/`a`/null，
 * `spec` 是格式说明的原文或 null）。
 */
export function splitFString(body) {
  const parts = [];
  let lit = '';
  const flush = () => { if (lit !== '') { parts.push({ lit }); lit = ''; } };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '{' && body[i + 1] === '{') { lit += '{'; i += 1; continue; }
    if (c === '}' && body[i + 1] === '}') { lit += '}'; i += 1; continue; }
    if (c === '}') {
      throw new Error('python->IR: f-string 里有一个落单的 `}`（要写成 `}}`）');
    }
    if (c !== '{') { lit += c; continue; }
    flush();
    const f = readField(body, i);
    parts.push(f.part);
    i = f.end - 1;
  }
  flush();
  return parts;
}

/** 一格替换字段：从 `body[open]` 的 `{` 读到配平的 `}`。 */
function readField(body, open) {
  let depth = 0;          // 圆括号与方括号
  let braces = 0;         // 花括号（字典字面量、集合）
  let bang = -1;
  let colon = -1;
  for (let i = open; i < body.length; i += 1) {
    const c = body[i];
    /* 引号串整段跳过 —— 里头的括号与 `:` 都不算（`f"{d['a:b']}"`）。 */
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < body.length && body[j] !== q) j += (body[j] === '\\' ? 2 : 1);
      if (j >= body.length) throw new Error('python->IR: f-string 的替换字段里有一个没收尾的引号');
      i = j;
      continue;
    }
    if (c === '(' || c === '[') { depth += 1; continue; }
    if (c === ')' || c === ']') { depth -= 1; continue; }
    if (c === '{') { braces += 1; continue; }
    if (c === '}') {
      braces -= 1;
      if (braces > 0) continue;
      const head = colon < 0 ? i : colon;
      const body0 = body.slice(open + 1, bang < 0 ? head : Math.min(bang, head));
      const src = body0.trim();
      if (src === '') throw new Error('python->IR: f-string 里有一格空的 `{}`');
      if (src.endsWith('=')) {
        throw new Error(`python->IR: f-string 的自文档写法（\`{${src}}\`）还没接`
          + ' —— 它要把表达式原文也印出来');
      }
      const conv = bang >= 0 && bang < head ? body.slice(bang + 1, head).trim() : null;
      if (conv !== null && !['r', 's', 'a'].includes(conv)) {
        throw new Error(`python->IR: f-string 的转换 \`!${conv}\` 不认（只有 !r / !s / !a）`);
      }
      const spec = colon < 0 ? null : body.slice(colon + 1, i);
      return { part: { src, conv, spec }, end: i + 1 };
    }
    /* 顶层的 `!`（不是 `!=`）是转换的起点；顶层的 `:` 是格式说明的起点。 */
    if (depth === 0 && braces === 1) {
      if (c === '!' && body[i + 1] !== '=' && bang < 0) { bang = i; continue; }
      if (c === ':' && colon < 0) { colon = i; continue; }
    }
  }
  throw new Error('python->IR: f-string 里有一格 `{` 没有配平的 `}`');
}
