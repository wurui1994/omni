#!/usr/bin/env node
// bench/tograph.js —— **自举尺子的第二层**：那门语言自己的编译器，我们能把多少份**落成图**
//
// ADR-0037 §5.1a 那把尺子问的是"用我们的腿能不能编 go / nim / v 自己的编译器"。那条路是
//
//     源码 --解析--> 树 --映射--> 节点图 --后端--> js / c / 核心方言
//
// 第一层（解析）已经有量了：`bench/grammars.js`（go 8114/8218、nim、vlang 各自一行）。
// 这一份量**第二层**：解析过的那些里，有多少份 `xxxToGraph(tree)` 走得通，走不通的
// **卡在哪句话上**（按错误消息归类，印前几条）。
//
// 为什么单独一份而不是塞进 grammars.js：那一份量的是"语法收不收得下"（吞吐、冷热建表），
// 这一份量的是"映射写全了没有"。两件事的分母都是文件，但**结论落在不同的清单上** ——
// 前者改 `.grammar`，后者改 `tograph.js`。混在一行里，看的人分不清该改哪一处。
//
// 语料由每门语言自己说：`ext/<语言>/bench.json` 的 **`selfhost`** 那一格（"它自己的编译器
// 在哪棵子树下"）。没有那一格就跳过并说清 —— 与 grammars.js 同一条纪律。
//
//   node bench/tograph.js              三门都跑
//   node bench/tograph.js nim          只跑一门
//   node bench/tograph.js --limit 200  每门最多跑这么多份（改映射的时候快看一眼）
//   node bench/tograph.js --walls 20   墙那一栏印前几条
//   node bench/tograph.js --nc         逐条那一栏里只印**没归类**的（"上面那张表漏了什么"）
//
// 印出来的第一栏是**按族的账**（`CLASSES`）。那一栏才是"下一刀该做什么"看的 ——
// "还差多少"这句话的答案不是"一百条不同的话"，是**十几族决定**。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGrammarTable } from '../src/core/glr/load.js';
import { lexText } from '../src/core/glr/lex.js';
import { glrParse } from '../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../src/core/source/diag.js';
import { LANGS } from '../src/core/graph/langs.js';
import { refDirIf } from '../tests/lib/refsrc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const numArg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i < 0 ? dflt : Number(argv[i + 1]);
};
/* **带值的开关后面那一格不是语言名**：`--walls 8` 里的 `8` 原来被当成语言过滤器，
   于是 `node bench/tograph.js --walls 8` 报"一门都没量到"。 */
const VALUED = new Set(['--limit', '--walls']);
const only = argv.filter((a, i) => !a.startsWith('-') && !VALUED.has(argv[i - 1]));
const LIMIT = numArg('--limit', 0);
const WALLS = numArg('--walls', 8);

/** 递归收一棵目录树里的某个后缀（与 grammars.js 那一份同形）。 */
function filesUnder(dir, ext, out) {
  let names = null;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of names) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * **一堵墙属于哪一族**。这一栏是这份尺子最要紧的一栏 —— 因为"还差多少"这句话的答案
 * 不是"一百条不同的话"，是**五六族决定**：
 *
 *   指针 · option/result · 编译期求值 · 函数值 · 位运算 · 集合与字符 · 映射还没写全
 *
 * 前五族每一族都是一次**设计决定**（要不要给图加那一格 / 加在哪一层），最后一族才是
 * "接着写就行"。分开印出来，"下一刀该做什么"就不用靠人去数一百行。
 *
 * **判据是这张表自己**：认不出来的落进"没归类"，那一栏印在最后 —— 所以这张表**盖不住**
 * 任何东西（漏一族就会看见"没归类"涨），这也是它敢用正则的理由。
 */
const CLASSES = [
  ['指针（addr / deref / &）', /addr|deref|这个算子还没接：&(?!&)|（解引用）/],
  ['option / result（or-block · 传播 · ?T）', /or-block|propagate|option/],
  ['编译期求值（when / \$if / ctconst）', /编译期|ctime|ctconst|comptime/],
  ['函数值与闭包（fnlit）', /fnlit|闭包|函数值/],
  ['位运算（<< >> & | ^ shl）', /这个算子还没接：(<<|>>|\||\^|shl|shr|&\^|\+%)/],
  ['集合与字符（set-lit / char / rune）', /set 字面量|char 是自己一格类型|还没接：char|还没接：rune/],
  ['类型层的算子（typeof / sizeof / is / as / x.(T)）',
    /typeof|sizeof|isreftype|还没接：is$|还没接：as$|还没接：tswitch|还没接：assert$|登记过的类型/],
  // **这一族是"没归类"那一栏第二回指出来的**（2026-09-18）：内嵌字段的名字要从被嵌的那格
  // 类型来、泛型实例化 `Foo[int]{…}` 也要类型、"两个类型都声明了同名方法"更是非类型不能分。
  // 三条都不是"哪一格还没接"，是**这一层看不见类型** —— 与"跨文件才知道的事"是邻居。
  ['类型才分得开的事（embed / tinst / 方法重名）',
    /是 embed|还没接：tinst|重名要类型才分得开|sum type 那一族要类型/],
  ['C 指令与外部声明（#flag / $c）', /cdirective/],
  ['语句头上的绑定（V 的 `if x := …`）', /还没接：if-bind/],
  ['命名实参 / 变参展开', /还没接：named|还没接：spread|命名实参/],
  ['成员是不是在里头（数组的 `in`）', /只接 map（数组的 in|还没接：in$/],
  // 表达式位置上的 match 那两条也是**明说过的**（没有 else 就没有值 · 一支只准一格表达式）
  ['明说过的形状限制（主语要算好几遍 · 匿名接收者 · 格式动词 …）',
    /要算好几遍|匿名接收者|格式动词|不是字面量|要 N 是整数字面量|只接 map 与切片|混着|没有 else|正好是一格表达式/],
  ['并发与异常（chan / spawn / try / yield / select · lock）',
    /chan|spawn|select|try|yield|raise|throw|还没接：r?lock/],
  ['跨文件才知道的事（跨模块的类型 / 库函数）',
    /跨模块|声明不在这一份文件里|这份文件里没见过|只接 fmt\.Print|零值还没接：tname/],
  ['要一格"按长度造"的节点', /按长度造|list-new 收的是元素表/],
  ['要一格"按键遍历"的节点（map 的 for-in）', /按键遍历/],
];

/** 一堵墙归到哪一族（认不出来回 null —— 那时它进"没归类"，印出来）。 */
function classOf(msg) {
  for (const [name, re] of CLASSES) if (re.test(msg)) return name;
  return null;
}

/** 一句错误消息**归一**成一格墙：把里面的名字与数字抹掉，不然每份文件都是一条新墙。 */
function wallOf(msg) {
  return String(msg)
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/[0-9]+/g, 'N')
    .slice(0, 110);
}

/** 这门语言的 `selfhost` 语料（`ext/<语言>/bench.json`）。没那一格或树不在就回 null。 */
function corpusOf(lang) {
  let conf = null;
  try {
    conf = JSON.parse(readFileSync(join(ROOT, 'ext', lang.name, 'bench.json'), 'utf8'));
  } catch {
    return null;
  }
  const sh = conf.selfhost;
  if (sh === undefined) return null;
  const tree = refDirIf(sh.tree, sh.env ?? null);
  if (tree === null) return { root: null, files: [] };
  const root = sh.sub === undefined ? tree : join(tree, sh.sub);
  return { root: root, files: filesUnder(root, sh.ext, []) };
}

/** 一门语言跑一遍：解析 -> 落图，两层各自的过与没过，加一张墙的清单。 */
function measure(lang) {
  const got = corpusOf(lang);
  if (got === null) return { skip: `ext/${lang.name}/bench.json 里没有 selfhost 那一格` };
  if (got.root === null) return { skip: '参考树不在（那门语言的源码没在本机上）' };
  let files = got.files;
  if (LIMIT > 0) files = files.slice(0, LIMIT);
  if (files.length === 0) return { skip: `${got.root} 底下一份都没有` };
  const { tb } = loadGrammarTable(join(ROOT, lang.grammar));
  const row = {
    root: got.root, files: files.length, parsed: 0, graphed: 0, bytes: 0, ms: 0,
  };
  const walls = new Map();
  const classes = new Map();
  const bump = (msg, path) => {
    const k = wallOf(msg);
    const w = walls.get(k) ?? { n: 0, first: path };
    w.n = w.n + 1;
    walls.set(k, w);
    const c = classOf(msg) ?? '没归类（这一栏涨了就是上面那张表漏了一族）';
    classes.set(c, (classes.get(c) ?? 0) + 1);
  };
  const t0 = Date.now();
  for (const p of files) {
    const text = readFileSync(p, 'utf8');
    row.bytes += text.length;
    const diags = new Diagnostics();
    let tree = null;
    try {
      const toks = lexText(tb.grammar.lex, new SourceFile(p, text), diags);
      if (toks !== null && !diags.hasErrors()) tree = glrParse(tb, toks, diags);
    } catch {
      tree = null;
    }
    if (tree === null || diags.hasErrors()) continue;      // 第一层的账在 grammars.js 上
    row.parsed += 1;
    try {
      lang.toGraph(tree);
      row.graphed += 1;
    } catch (err) {
      bump(err.message, p);
    }
  }
  row.ms = Date.now() - t0;
  row.walls = [...walls.entries()].sort((a, b) => b[1].n - a[1].n);
  row.classes = [...classes.entries()].sort((a, b) => b[1] - a[1]);
  return row;
}

const pct = (a, b) => (b === 0 ? '  —  ' : `${((a / b) * 100).toFixed(1)}%`);
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

/* `LANGS` 是一格 Map（名字 -> 那门语言那一栏），所以这儿把名字与那一栏配成一对。 */
const names = [...LANGS.entries()]
  .map(([name, l]) => ({ name: name, grammar: l.grammar, toGraph: l.toGraph }))
  .filter((l) => (only.length === 0 ? true : only.includes(l.name)))
  .filter((l) => typeof l.toGraph === 'function');
const rows = [];
for (const lang of names) {
  const r = measure(lang);
  if (r.skip !== undefined) {
    if (only.length > 0) process.stdout.write(`${lang.name}：跳过 —— ${r.skip}\n`);
    continue;
  }
  rows.push([lang, r]);
}

if (rows.length === 0) {
  process.stdout.write('一门都没量到（`selfhost` 那一格只有 go / nim / vlang 三门有）。\n');
} else {
  process.stdout.write('语言      文件    解析过        落成图         字节    用时  子树\n');
  for (const [lang, r] of rows) {
    process.stdout.write(`${lang.name.padEnd(9)}${String(r.files).padStart(5)}`
      + `${String(r.parsed).padStart(7)} ${pct(r.parsed, r.files).padStart(6)}`
      + `${String(r.graphed).padStart(7)} ${pct(r.graphed, r.parsed).padStart(6)}`
      + `${mb(r.bytes).padStart(9)}${`${(r.ms / 1000).toFixed(1)}s`.padStart(8)}`
      + `  ${relative(ROOT, r.root)}\n`);
  }
  /* **按族的那一栏印在前面** —— 那是"下一刀该做什么"看的那一栏（逐条的话在它下面）。 */
  const tot = new Map();
  for (const [, r] of rows) for (const [c, n] of r.classes) tot.set(c, (tot.get(c) ?? 0) + n);
  if (tot.size > 0) {
    const all = [...tot.entries()].sort((a, b) => b[1] - a[1]);
    const sum = all.reduce((a, [, n]) => a + n, 0);
    process.stdout.write(`\n三门合起来，没落成图的那 ${sum} 份卡在哪几族上：\n`);
    for (const [c, n] of all) {
      process.stdout.write(`  ${String(n).padStart(5)} ${pct(n, sum).padStart(7)}  ${c}\n`);
    }
    process.stdout.write('  —— 前几族每一族都是一次**设计决定**（要不要给图加那一格 / 加在哪一层）；'
      + '"没归类"那一栏涨了就是 CLASSES 那张表漏了一族。\n');
  }
  for (const [lang, r] of rows) {
    if (r.walls.length === 0) continue;
    const shown = r.walls.slice(0, WALLS);
    const rest = r.walls.length - shown.length;
    process.stdout.write(`\n${lang.name} 的墙（${r.parsed - r.graphed} 份没落成图，`
      + `${r.walls.length} 条不同的话${rest > 0 ? `，印前 ${shown.length} 条` : ''}）：\n`);
    for (const [msg, w] of shown) {
      process.stdout.write(`  ${String(w.n).padStart(5)}  ${msg}\n`);
    }
    /* `--nc` 只印**没归类**的那几条 —— 那是"上面那张表漏了什么"的清单。 */
    if (argv.includes('--nc')) {
      const nc = r.walls.filter(([m]) => classOf(m) === null).slice(0, WALLS);
      if (nc.length > 0) {
        process.stdout.write(`  ——（没归类的前 ${nc.length} 条）\n`);
        for (const [msg, w] of nc) {
          process.stdout.write(`  ${String(w.n).padStart(5)}  ${msg}\n`);
        }
      }
    }
  }
  process.stdout.write('\n这一份量的是**映射写全了没有**（改的是 ext/<语言>/tograph.js）；'
    + '语法那一层的账在 bench/grammars.js 上。\n');
}

