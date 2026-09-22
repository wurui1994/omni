// tests/lib/mapping-check.js —— `.mapping` 的判据（docs/design/when-sexpr.md 第四问）
//
// 没有判据的 DSL 是装饰。这一份把 `ext/<lang>/<lang>.mapping` 与两份事实对账：
//
//   事实一：`<lang>.grammar` 里**造得出来的 CST 标签**（那些 `(-> (…) (tag …))` 的 tag）
//   事实二：`ext/<lang>/tograph.js` 里**真有的 case**
//
// 三条判据：
//   1. 覆盖：grammar 造得出的每一格标签，要么有 `(map …)`、要么有 `(native …)`。
//      漏掉的那些是**静默的墙** —— 跑到那儿才报"这一格还没接"。
//   2. 诚实：每一格 `(native X …)` 在 tograph.js 里真有 `case 'X':`。
//      写了 native 但代码里没有，等于账上挂了一笔假的。
//   3. 预算：native 的条目数不超过 `(budget native N)` 写的那个数。
//      **这个数只许降不许升** —— 升了就是 DSL 在漏（第五问）。
//
// 跑法：`node tests/lib/mapping-check.js`（要看细节加 --verbose）

import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname;
const VERBOSE = process.argv.includes('--verbose');

/* ---- 一格极简 s-expr 读入器（只为这份判据；不引 src/ 的那份，免得判据依赖被判的东西）---- */
function readForms(text) {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === ';' && text[i + 1] === ';') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      break;
    }
  };
  const one = () => {
    skip();
    if (i >= text.length) return undefined;
    if (text[i] === '(') {
      i++;
      const items = [];
      for (;;) {
        skip();
        if (i >= text.length) break;
        if (text[i] === ')') { i++; break; }
        const v = one();
        if (v === undefined) break;
        items.push(v);
      }
      return items;
    }
    if (text[i] === ')') { i++; return undefined; }
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        s += text[i++];
      }
      i++;
      return { str: s };
    }
    let a = '';
    while (i < text.length && !/[\s()]/.test(text[i])) a += text[i++];
    return a;
  };
  const out = [];
  for (;;) {
    skip();
    if (i >= text.length) break;
    const v = one();
    if (v === undefined) break;
    out.push(v);
  }
  return out;
}

const isList = (x) => Array.isArray(x);
const head = (x) => (isList(x) && typeof x[0] === 'string' ? x[0] : null);

/* ---- 事实一：grammar 造得出的 CST 标签 ---- */
function grammarTags(path) {
  const text = readFileSync(path, 'utf8');
  const tags = new Set();
  /* 产生式的动作部分：`(-> (rhs…) (tag …))` 或 `(-> (rhs…) (prefer N) (tag …))`。
     动作里第一格 atom 就是造出来的标签。`$1` / `$*1` 那种是透传，不造标签。 */
  for (const m of text.matchAll(/\(->\s/g)) {
    /* 从 `(->` 起，手工配对括号取出整条产生式 */
    let d = 0; let j = m.index;
    for (; j < text.length; j++) {
      if (text[j] === '(') d++;
      else if (text[j] === ')') { d--; if (d === 0) { j++; break; } }
    }
    const rule = text.slice(m.index, j);
    const forms = readForms(rule);
    if (forms.length === 0 || !isList(forms[0])) continue;
    /* forms[0] = ['->', [rhs…], action…]；动作是第 2 格起，跳过 (prefer N) */
    for (let k = 2; k < forms[0].length; k++) {
      const act = forms[0][k];
      if (!isList(act)) continue;
      const h = head(act);
      if (h === null || h === 'prefer') continue;
      if (h.startsWith('$')) continue;         // 透传，不造标签
      tags.add(h);
    }
  }
  return tags;
}

/* ---- 事实二：tograph.js 里真有的 case ---- */
function tographCases(path) {
  const text = readFileSync(path, 'utf8');
  const cases = new Set();
  for (const m of text.matchAll(/case\s+'([^']+)'/g)) cases.add(m[1]);
  return cases;
}

/* ---- 被判的那份：.mapping ---- */
function readMapping(path) {
  const forms = readForms(readFileSync(path, 'utf8'));
  const top = forms.find((f) => head(f) === 'mapping');
  if (top === undefined) throw new Error(`${path}: 顶层没有 (mapping <lang> …)`);
  const mapped = new Set();      // (map (tag …) …) 覆盖的标签
  const natives = new Map();     // (native tag "why") 的标签 -> 理由
  const builtins = new Set();
  let budget = null;
  for (const form of top.slice(2)) {
    if (!isList(form)) continue;
    const h = head(form);
    if (h === 'map') {
      const pat = form[1];
      if (!isList(pat)) continue;
      const ph = head(pat);
      if (ph === 'or' || (isList(pat[0]) && head(pat[0]) === 'or')) {
        /* `(map ((or a b c) …) …)`：一条规则覆盖几格标签 */
        const orList = isList(pat[0]) ? pat[0] : pat;
        for (const t of orList.slice(1)) if (typeof t === 'string') mapped.add(t);
        continue;
      }
      if (ph !== null) mapped.add(ph);
    } else if (h === 'native') {
      const tag = form[1];
      const why = form[2];
      if (typeof tag === 'string') {
        natives.set(tag, why !== undefined && why.str !== undefined ? why.str : '');
      }
    } else if (h === 'builtin') {
      if (typeof form[1] === 'string') builtins.add(form[1]);
    } else if (h === 'budget' && form[1] === 'native') {
      budget = Number(form[2]);
    }
  }
  return { mapped, natives, builtins, budget };
}

/* ---- 对账 ---- */
function checkLang(lang) {
  const gPath = `${ROOT}ext/${lang}/${lang}.grammar`;
  const mPath = `${ROOT}ext/${lang}/${lang}.mapping`;
  const tPath = `${ROOT}ext/${lang}/tograph.js`;
  if (!existsSync(mPath)) return null;          // 还没写 .mapping 的语言跳过

  const tags = grammarTags(gPath);
  const cases = tographCases(tPath);
  const { mapped, natives, builtins, budget } = readMapping(mPath);

  const covered = new Set([...mapped, ...natives.keys()]);
  const problems = [];

  /* 判据一·覆盖：grammar 造得出、tograph 也接了的标签，.mapping 里要有账。
     只查"两边都有"的那些 —— grammar 里的辅助标签（lhs / rhs / in / out 那种结构标签）
     不是 toNode 的入口，不该要求 .mapping 覆盖。 */
  const needed = [...cases].filter((c) => tags.has(c));
  const missing = needed.filter((c) => !covered.has(c));
  if (missing.length > 0) {
    problems.push(`覆盖：${missing.length} 格标签在 tograph.js 里接了、grammar 也造得出，但 .mapping 里没有账：\n    ${missing.sort().join(' ')}`);
  }

  /* 判据二·诚实：native 点名的 case 要真存在 */
  const fake = [...natives.keys()].filter((t) => !cases.has(t));
  if (fake.length > 0) {
    problems.push(`诚实：${fake.length} 格 (native …) 在 tograph.js 里没有对应的 case：\n    ${fake.sort().join(' ')}`);
  }

  /* 判据三·预算 */
  if (budget !== null && natives.size > budget) {
    problems.push(`预算：native ${natives.size} 格 > 上限 ${budget} 格（超 ${natives.size - budget}）`);
  }

  /* 理由：每一格 native 要有一句"为什么它不是模式" */
  const noWhy = [...natives.entries()].filter(([, w]) => w.trim() === '').map(([t]) => t);
  if (noWhy.length > 0) {
    problems.push(`理由：${noWhy.length} 格 (native …) 没写为什么：\n    ${noWhy.sort().join(' ')}`);
  }

  return {
    lang,
    tags: tags.size,
    cases: cases.size,
    mapped: mapped.size,
    natives: natives.size,
    builtins: builtins.size,
    budget,
    needed: needed.length,
    problems,
  };
}

/* ---- 跑 ---- */
/* **只量还在图那一层的那几门**（ADR-0044）：迁到公共降级器的语言没有 `tograph.js` 了，
   它们的 `.mapping`（声明式映射）跟着一起删 —— lua 那份就是这么走的。 */
const LANGS = ['go', 'vlang'];
let bad = 0;
let done = 0;
for (const lang of LANGS) {
  const r = checkLang(lang);
  if (r === null) continue;
  done++;
  const ok = r.problems.length === 0;
  if (!ok) bad++;
  const budgetStr = r.budget === null ? '—' : `${r.natives}/${r.budget}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.lang}：grammar ${r.tags} 标签 · tograph ${r.cases} case · `
    + `mapping ${r.mapped} 模式 + ${r.natives} native（预算 ${budgetStr}）+ ${r.builtins} builtin`);
  if (VERBOSE || !ok) for (const p of r.problems) console.log(`  - ${p}`);
}
if (done === 0) {
  console.log('mapping-check：一份 .mapping 都没有（跳过）');
  process.exit(0);
}
console.log(bad === 0
  ? `mapping-check ok（${done} 门语言：覆盖 / 诚实 / 预算 / 理由 四条都过）`
  : `mapping-check FAIL（${bad}/${done} 门有账没对上）`);
process.exit(bad === 0 ? 0 : 1);
