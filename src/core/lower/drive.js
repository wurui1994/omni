// src/core/lower/drive.js —— **借来的语言 → 核心方言那一趟**（ADR-0044 的默认路径）
//
//   源码 → GLR → CST → adapter(语言) → 标准 IR → lower(公共) → .sx text
//
// 与图那一条（`graph/run.js` 的 `graphOf` + `backend-core.js`）比，这条路少两层中间表示：
// 没有节点图、没有"把图翻回文本"那一道。每门语言剩下的只有一份 adapter，语义降级只有一份。
//
// 这一份**只管接线**：读语法、解析、叫 adapter、叫公共降级器。一格语义都不加 ——
// 语言的知识在 adapter 里，方言的形状在 `sx.js` 里。
//
// 登记处仍旧是 `graph/langs.js`（一门语言一格：语法 · adapter · 后缀）。那份表还长在
// `graph/` 底下是因为图那一层还有几门没迁完；十一门全迁完之后它跟着搬出来（ADR-0044 第五片）。

import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { Diagnostics, SourceFile, OmniError } from '../source/diag.js';
import { readText, stderr } from '../host/native.js';
import { pickLang, treeRoot } from '../graph/langs.js';
import { lower } from './lower.js';

/** 一门语言迁到公共降级器了没有（登记处那一格 `toIR` 就是答案）。 */
export function hasAdapter(lang) {
  return lang !== null && lang !== undefined && typeof lang.toIR === 'function';
}

/**
 * 一份源码 → 核心方言文本（`.sx`）。回 null = 语法说不通（诊断已经印过了）。
 * adapter 或降级器接不住的形状按 `OmniError` 抛（有名有姓，退出码 1）。
 *
 * @param {string} path 源文件
 * @param {string[]} argv `run` / `build` 后面那些参数（`--lang` 在里头）
 */
export function sxTextOf(path, argv = []) {
  const lang = pickLang(path, cliArg(argv, '--lang'));
  if (!hasAdapter(lang)) {
    throw new OmniError(`${lang.name} 还没有 adapter —— 这条路（ADR-0044）要登记处那一格 toIR`);
  }
  /* 多文件那几个开关（go 的包）还没接到这条路上：**明说，不假装**。 */
  for (const flag of ['--pkg', '--pkgs', '--pkgs-root']) {
    if (argv.includes(flag)) {
      throw new OmniError(`${flag} 还没接到公共降级器这条路上（${lang.name}）——`
        + ' 那一格是"多份文件一起编"，要等 adapter 那一侧也答得出"这份文件 import 了什么"');
    }
  }
  const { tb, g } = loadGrammarTable(`${treeRoot()}/${lang.grammar}`);
  const diags = new Diagnostics();
  const toks = lexText(g.lex, new SourceFile(path, readText(path)), diags);
  if (toks === null || diags.hasErrors()) { stderr(diags.format()); return null; }
  const tree = glrParse(tb, toks, diags);
  if (tree === null || diags.hasErrors()) { stderr(diags.format()); return null; }
  try {
    const ir = lang.toIR(tree);
    return lower(ir, lang.hooks ?? {});
  } catch (err) {
    throw new OmniError(`${path}：${lang.name} 这一格还没接住 —— ${err.message}`);
  }
}

/** 一格 `--flag VALUE`（与 `graph/run.js` 那份同一条规矩：不认 `--flag=VALUE`）。 */
function cliArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
