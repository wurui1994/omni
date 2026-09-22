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
import {
  readText, stderr, exists,
} from '../host/native.js';
import { pickLang, treeRoot } from '../graph/langs.js';
import { lower } from './lower.js';

/** 一份路径的目录（宿主那侧不供这一格 —— 与 `graph/run.js` 里那一行同一条办法）。 */
const dirOf = (p) => (p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '.');

/** 一门语言迁到公共降级器了没有（登记处那一格 `toIR` 就是答案）。 */
export function hasAdapter(lang) {
  return lang !== null && lang !== undefined && typeof lang.toIR === 'function';
}

/**
 * 一份源码 → 核心方言文本（`.sx`）。回 null = 语法说不通（诊断已经印过了）。
 * adapter 或降级器接不住的形状按 `OmniError` 抛（有名有姓，退出码 1）。
 *
 * **旁边那几份同语言的文件也读进来**（`lang.imports` 答"这份文件 import 了什么"）：
 * `import util` 里的 `util` 拼上这门语言的后缀，**就在导入方旁边**找；找着就读、找不着照旧
 * 交给 adapter（标准库那一族是这么落的）。刻意不搜索（与 ADR-0009 那套模块路径同一条纪律）。
 * 依赖在前、读过的不再读（环不挂死），全部交给 `toIR(主树, { also })`。
 *
 * @param {string} path 源文件
 * @param {string[]} argv `run` / `build` 后面那些参数（`--lang` 在里头）
 */
export function sxTextOf(path, argv = []) {
  const lang = pickLang(path, cliArg(argv, '--lang'));
  if (!hasAdapter(lang)) {
    throw new OmniError(`${lang.name} 还没有 adapter —— 这条路（ADR-0044）要登记处那一格 toIR`);
  }
  /* **跨包那几个开关还没接到这条路上**（`--pkgs` 是"好几个包各自一格模块、按拓扑序拼"，
     比"旁边那几份"多一层）：明说，不假装。 */
  for (const flag of ['--pkg', '--pkgs', '--pkgs-root']) {
    if (argv.includes(flag)) {
      throw new OmniError(`${flag} 还没接到公共降级器这条路上（${lang.name}）——`
        + ' 那一格是"好几个包一起编"，比"同目录旁边那几份"多一层（各自一格模块 + 拓扑序）');
    }
  }
  const { tb, g } = loadGrammarTable(`${treeRoot()}/${lang.grammar}`);
  const diags = new Diagnostics();
  const treeOf = (p) => {
    const toks = lexText(g.lex, new SourceFile(p, readText(p)), diags);
    if (toks === null || diags.hasErrors()) return null;
    const t = glrParse(tb, toks, diags);
    return t === null || diags.hasErrors() ? null : t;
  };
  const tree = treeOf(path);
  if (tree === null) { stderr(diags.format()); return null; }

  const also = [];
  const seen = new Set([path]);
  const load = (p, t) => {
    if (lang.imports === undefined) return true;
    for (const spec of lang.imports(t)) {
      const rel = spec.startsWith('./') ? spec.slice(2) : spec;
      let hit = null;
      for (const e of lang.exts) {
        const cand = `${dirOf(p)}/${rel}.${e}`;
        if (exists(cand)) { hit = cand; break; }
      }
      if (hit === null || seen.has(hit)) continue;      // 标准库那一格 / 已经读过
      seen.add(hit);
      const sub = treeOf(hit);
      if (sub === null) return false;
      if (!load(hit, sub)) return false;               // 它自己的 import 先读（依赖在前）
      also.push(sub);
      stderr(`omni: import 进来的同语言文件 ${hit}\n`);
    }
    return true;
  };
  if (!load(path, tree)) { stderr(diags.format()); return null; }

  try {
    const ir = lang.toIR(tree, { also });
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
