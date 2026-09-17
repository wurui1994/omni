#!/usr/bin/env node
// tests/graph/deadcase.js —— **映射里的死代码**：`case '…'` 接的标签，语法出得来吗
//
// 这一格判据是**账上算出来的**，不是想出来的。2026-09-18 那三刀里，最高的两条墙都不是
// "还没写"，是**写在了不存在的标签上**：
//   * `ext/go/tograph.js` 写 `case 'const-decl': case 'var-decl'`，
//     而 `go.grammar` 的那两条产生式出的是 `(const …)` / `(var …)` —— 285 份文件卡在这儿；
//   * `ext/vlang/tograph.js` 写 `case 'type-decl'`，而语法出的是 `(typedecl …)` —— 283 份。
//
// 两次都是同一个错，而且**两次都是靠外部尺子（`bench/tograph.js`）才发现的** ——
// 例子全绿、判据全绿，因为例子里正好没有那一格。所以这件事该有一格自己的判据：
//
//     映射里每一格 `case '标签'`，那门语言的语法都得**出得来**这个标签。
//
// 出不来就是死代码：要么标签写错了（那背后一定有一批文件在墙上），要么那条产生式没了。
// 反方向（语法出得来但映射没接）**不在这儿** —— 那正是墙，`bench/tograph.js` 在量。
//
//   node tests/graph/deadcase.js

import { readFileSync } from 'node:fs';
import { loadGrammarTable } from '../../src/core/glr/load.js';
import { LANGS } from '../../src/core/graph/langs.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
let pass = 0;
let fail = 0;
let skip = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };
const gap = (s, why) => { skip++; process.stdout.write(`  skip ${s}：${why}\n`); };

/**
 * 一条产生式的动作里，**能出现在标签位置上**的那些名字。
 *
 * 动作是一棵 datum：`(const (n $2) (init $4))` 这样。标签就是每一格表的**头**，
 * 而头是 `$1` / `$*3` 那种占位符时**不算**（那时头是别处传上来的，不是新标签）。
 */
function tagsIn(action, out) {
  if (action === null || action === undefined) return out;
  if (Array.isArray(action)) {
    for (const a of action) tagsIn(a, out);
    return out;
  }
  if (action.kind !== 'list') return out;
  const head = action.items[0];
  if (head !== undefined && head.kind === 'atom' && typeof head.value === 'string'
      && !head.value.startsWith('$')) {
    out.add(head.value);
  }
  for (const it of action.items) tagsIn(it, out);
  return out;
}

/**
 * 那份映射里 `switch (tag(x))` 这一格收的标签表。
 *
 * 只扫**那一个** switch（到 `default:` 为止）：同一份文件里别的 switch 分的可能是算符名
 * （chez / sbcl 的 `switch (op)`），拿语法标签去比它是不对的。
 */
function labelsOf(src) {
  const at = src.indexOf('switch (tag(x))');
  if (at < 0) return null;
  const end = src.indexOf('default:', at);
  const region = src.slice(at, end < 0 ? src.length : end);
  // **注释要先去掉**：这几份文件里的注释会写"原来那一格 `case 'un'` 是死代码" ——
  // 不去掉的话，判据自己修好的那一格会被它自己的注释再报一遍（第一版就是这么错的）。
  // 判"这个 `//` 是注释还是串里的"用的是它前面单引号的个数：偶数就在串外面。
  const code = region.split('\n').map((line) => {
    for (let i = 0; i + 1 < line.length; i += 1) {
      if (line[i] === '/' && line[i + 1] === '/') {
        const quotes = line.slice(0, i).split("'").length - 1;
        if (quotes % 2 === 0) return line.slice(0, i);
      }
    }
    return line;
  }).join('\n');
  return [...code.matchAll(/case '([^']+)'/g)].map((m) => m[1]);
}

for (const [name, lang] of LANGS.entries()) {
  const src = readFileSync(`${ROOT}ext/${name}/tograph.js`, 'utf8');
  const labels = labelsOf(src);
  if (labels === null) {
    // 两门 Lisp 的映射分的是 datum 的头（`head(x)`），那不是语法出的标签 ——
    // 它们的"标签"来自被读进来的**程序**，语法只出 datum。所以这一格量不到它们。
    gap(`${name}`, '这一门分的是 datum 的头（`head(x)`），标签不由语法出');
    continue;
  }
  const { tb } = loadGrammarTable(`${ROOT}${lang.grammar}`);
  const emitted = new Set();
  for (const r of tb.grammar.rules) tagsIn(r.action, emitted);
  const dead = labels.filter((t) => !emitted.has(t));
  if (dead.length === 0) {
    ok(`${name} [${labels.length} 格 case · 语法出得来 ${emitted.size} 种标签]`);
  } else {
    no(`${name}`, `这几格是死代码（语法出不来这个标签）：${dead.join('、')}`
      + `\n       —— 标签写错的话，背后一定有一批文件卡在"这一格还没接"上（bench/tograph.js 会看见）`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + `${skip === 0 ? '' : `, ${skip} skipped（有名有姓）`}`
  + '（映射里的 case 标签 × 语法出得来的标签）\n');
process.exit(fail === 0 ? 0 : 1);
