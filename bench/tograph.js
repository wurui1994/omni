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
//   node bench/tograph.js --strict-calls  **把"取字段再调它"那条兜底也当成墙**
//
// **两个口径都要看**（2026-09-18 量出来的那笔账）：默认那一档里，`x.M(…)` 的 M 没登记成方法
// 时落的是"取字段再调它" —— 对**方法**调用那条兜底运行期跑不通。表里「取字段调」那一栏数的
// 就是它（V 423/1310 = 32.3%、nim 6/9、go 0 —— go 在同一处当场报）。加上 `--strict-calls`
// 之后 V 那一栏是 **916 / 42.3%**（掉了 394 份），剩下的 29 份是真的"字段里装着函数值"。
// 默认留松的那一档只为了与账上历史的数可比；**要与 go 比就用 `--strict-calls`**。
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
/**
 * `--strict-calls`：**把"取字段再调它"那条兜底也当成一堵墙**（见 `softCallsIn` 那一段）。
 * 默认不开 —— 开了 V 那一栏会掉下来，而"掉多少"本身就是那笔账的第二半。
 * 这一格经 `opts.strictCalls` 交给映射（今天只有 V 那一份认它）。
 */
const STRICT_CALLS = argv.includes('--strict-calls');

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
  // 这一族的名字 2026-09-18 改过：`&T{…}` 那一半已经落地了（图上的记录就是引用），
  // 留在墙上的是**真别名**那一半 —— `&x`（名字的地址）与光秃秃的 `*p` 当值用。
  // 新那两句话里没有 `addr` / `deref` 这两个词，所以"指针那一格"也要在名单里
  // （落地那一刻忘了加，"没归类"当场从 41 涨到 199 —— 那一栏又一次自己举了手）。
  ['指针（真别名：`&x` · 光秃秃的 `*p`）',
    /addr|deref|这个算子还没接：&(?!&)|（解引用）|指针那一格|还没接：ptr|p\[\] 图上没有指针/],
  // `体里的 err` 那一条也归这一族（Option 那一刀之后剩下的最大一块 —— 错误消息不在图上）
  ['option / result（or-block · 传播 · ?T · `or { … }` 体里的 err）',
    /or-block|propagate|option|Option \/ Result/],

  ['编译期求值（when / \$if / \$for / ctconst）', /编译期|ctime|ctconst|comptime|\$for|whenexpr/],
  ['函数值与闭包（fnlit）', /fnlit|闭包|函数值/],
  ['位运算（<< >> & | ^ shl）', /这个算子还没接：(<<|>>|\||\^|shl|shr|&\^|\+%|!\&|\.\.<?|\.\.\^)/],
  ['集合与字符（set-lit / char / rune / array / imag / 复数）',
    /set 字面量|char 是自己一格类型|还没接：char|还没接：rune|还没接：imag|还没接：array$|要复数那一格/],
  ['类型层的算子（typeof / sizeof / is / as / x.(T)）',
    /typeof|sizeof|isreftype|还没接：is$|还没接：not-is|还没接：as$|还没接：tswitch|还没接：assert$|登记过的类型|还没接：if-is|类型断言/],
  // **这一族是"没归类"那一栏第二回指出来的**（2026-09-18）：内嵌字段的名字要从被嵌的那格
  // 类型来、泛型实例化 `Foo[int]{…}` 也要类型、"两个类型都声明了同名方法"更是非类型不能分。
  // 三条都不是"哪一格还没接"，是**这一层看不见类型** —— 与"跨文件才知道的事"是邻居。
  // **`x.M(…)` 那 366 份当天拆开之后，绝大多数落进了这一族**（见 `ext/go/tograph.js`
  // 的 `selWall`）：它们缺的不是映射，是第 40 条那一层。
  ['类型才分得开的事（embed / tinst / 方法重名 / 变体重名 / 接收者的类型看不出来）',
    /是 embed|还没接：tinst|重名要类型才分得开|好几个类型都声明了方法|sum type 那一族要类型|有嵌入字段|两个枚举里都有|没有声明方法|接收者的类型这一层看不出来|包级变量上的方法|泛型实例化/],
  ['C 指令与外部声明（#flag / $c）', /cdirective/],
  ['语句头上的绑定（V 的 `if x := …`）', /还没接：if-bind/],
  ['命名实参 / 变参展开', /还没接：named|还没接：spread|命名实参|还没接：kv/],
  ['成员是不是在里头（数组的 `in`）', /只接 map（数组的 in|还没接：in$/],
  // 表达式位置上的 match 那两条也是**明说过的**（没有 else 就没有值 · 一支只准一格表达式）
  ['明说过的形状限制（主语要算好几遍 · 匿名接收者 · 格式动词 …）',
    /要算好几遍|匿名接收者|格式动词|不是字面量|要 N 是整数字面量|只接 map 与切片|混着|没有 else|正好是一格表达式|声明了 N 格字段|\]T 的零值|位置型字面量给了/],
  ['并发与异常（chan / spawn / try / yield / select · lock）',
    /chan|spawn|select|try|yield|raise|throw|还没接：r?lock|还没接：send|还没接：recv|还没接：go$/],
  /* **这一族排在"跨文件"前头**（`docs/design/cross-file-methods.md` §5）：
     `os.join_path(…)` 那种的声明在**标准库**里、`cmd/internal/src` 那种在**语料树外**，
     而尺子的分母是"那门编译器自己的源码" —— 两样都不在里头。所以它们不是这一层的欠账，
     是尺子的**下一层**（ADR-0037 §5.1a 的 ① 档）。混进"跨文件"那一族会让人以为
     接着写映射就能收（V 那 599 份里绝大多数是这一族）。
     **排在前头**是因为"包不在语料里"比"跨文件"更具体：两条正则都认得那句话，
     而 `classOf` 取先中的那一条。 */
  ['语料外的声明（标准库 · 语料树外的包）',
    /库函数 .* 声明在标准库里|不在语料里|语料树外的模块/],
  ['跨文件才知道的事（跨模块的类型 / 库函数）',
    /跨模块|声明不在这一份文件|这份文件里没见过|只接 fmt\.Print|零值还没接：tname|带包限定的类型/],
  ['要一格"按长度造"的节点', /按长度造|list-new 收的是元素表/],
  ['要一格"按键遍历"的节点（map 的 for-in）', /按键遍历/],
  /* 这两族是"没归类"那一栏第三回指出来的（2026-09-18）：都不是"缺一格内建"，
     是**这一层的降级形状接不住**（fallthrough 要带标签的块、标签本身要一格附属），
     以及**表示层的转换要类型**（`[]byte(s)` / `(*T)(p)`）。 */
  ['落成 branch 链接不住的那两格（fallthrough / 带标签的语句 / goto / switch-break）',
    /fallthrough|带标签的语句|跳出 switch|还没接：goto/],
  ['表示层的转换（`[]byte(s)` / `(*T)(p)` / range 表达式 / 具名类型 tname / cast）',
    /表示层的转换|还没接：range|还没接：tname|还没接：cast|还没接：undefined$/],
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

/**
 * **"落成图"不等于"落成能跑的图"** —— 这一格数的是图里有多少处 `call` 的被调者是一格
 * `field-get`（`x.M(…)` 里 M 没登记成方法时那条兜底："取字段再调它"）。
 *
 * 为什么要单独数它：**两门语言在这一处的口径不一样**。V 的映射走兜底（落得出图），
 * go 的映射当场报（"这一批只接 fmt.Print* 与声明过的方法"，475 份卡在墙上）。于是
 * 两栏的百分比**不是一件事** —— 量出来 V 有 423/1310 份（32.3%）靠这条兜底。
 * 对**方法**调用来说那条兜底跑不通（记录上没有那个字段），所以这一栏是"分子里的虚数"。
 *
 * 不改任何一门的映射：先把账印出来。要合口径是一次设计决定（要么给图一格"按名字派发"，
 * 要么两门一起当场报），而账印出来之后那个决定才有分母。
 */
function softCallsIn(x, seen) {
  if (x === null || x === undefined) return 0;
  if (Array.isArray(x)) return x.reduce((a, y) => a + softCallsIn(y, seen), 0);
  if (x.kind === 'graph') return softCallsIn(x.body, seen);
  if (x.op === undefined) return 0;
  if (seen.has(x)) return 0;       // 图是 DAG，一格共享的节点只算一次
  seen.add(x);
  let n = 0;
  if (x.op === 'call') {
    const f = x.ins.fn;
    if (f !== null && f !== undefined && f.op === 'field-get') n += 1;
  }
  for (const k of Object.values(x.ins ?? {})) n += softCallsIn(k, seen);
  return n;
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
    softFiles: 0, softSites: 0,
  };
  const walls = new Map();
  const classes = new Map();
  /**
   * **没归类的那几条按原话记**（键是归一之后那句，值是**第一次见到的原话 + 出处**）。
   *
   * 为什么不在印的时候现算：`classOf` 认的是**原话**，而印出来那一栏是**归一过**的
   * （名字抹成 `'…'`、数字抹成 `N`）—— 两者不是同一个串，于是"按归一的串再判一遍"会
   * 与账上的数**不一致**。2026-09-18 踩过：账上说"没归类 1 份"，`--nc` 一条都印不出来，
   * 真凶是 `[5]T 的零值` 归一成 `[N]T` 之后反倒**认得出来**了。
   */
  const nocls = new Map();
  const bump = (msg, path) => {
    const k = wallOf(msg);
    const w = walls.get(k) ?? { n: 0, first: path };
    w.n = w.n + 1;
    walls.set(k, w);
    const c = classOf(msg);
    if (c === null && !nocls.has(k)) nocls.set(k, { msg: String(msg), path: path });
    classes.set(c ?? '没归类（这一栏涨了就是上面那张表漏了一族）',
      (classes.get(c ?? '没归类（这一栏涨了就是上面那张表漏了一族）') ?? 0) + 1);
  };
  const t0 = Date.now();
  /**
   * **按目录分两趟**（2026-09-18）：go 的一个**包**、V 的一个**模块**就是一个目录，
   * 而"这个类型有哪几格字段"、"这名字登记成类型了吗"这两问的答案常常在**旁边那份文件**里
   * （账上"跨文件才知道的事"那一族 470 份 / 25.2%，是最大的一族）。
   *
   * 所以先把一个目录里的树全解析出来，再把**整目录的树**一起交给每一次映射（`opts.also`）：
   * 那几张声明表先按旁边那几份填一遍、再按自己这一份填。这不是"猜"——它就是真编译器的
   * 模块那一趟，而且**同一格机制驱动那一侧也用**（`src/core/graph/run.js` 里 import
   * 进来的那几份现在也这么传，那儿原来读进来了却看不见声明）。
   */
  const byDir = new Map();
  for (const p of files) {
    const d = dirname(p);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p);
  }
  /**
   * **先把整棵语料解析完，再逐份映射**（2026-09-18）。为什么要多这一趟：账上最大的一族是
   * "跨文件才知道的事"（go 435 份 / 68.3%），而它里头最大的一半**跨的是包**不是文件 ——
   * `syntax.Type` 的零值、`ir.NewNilExpr(…)` 那格调用都要**另一个包**的声明。所以除了
   * `opts.also`（同一个目录 = 同一个包）之外，再递一格 `opts.pkgs` = **语料里所有的树**；
   * 每棵树自己的 `package` 那一句说它属于哪个包，索引由那门语言自己建（尺子不认识 go 的树）。
   *
   * 代价是**整棵树都得留在内存里**：量过 go 的 751 棵是 1.3GB 堆（`--expose-gc` 之后）。
   * 换成"解析两趟、第一趟只留摘要"能省这一格，但要多花一趟解析（go 那门 +50s）——
   * 时间是每次都付的，内存这台机器付得起，所以留住树。
   */
  const all = [];
  for (const [, ps] of byDir) {
    const trees = [];
    for (const p of ps) {
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
      if (tree === null || diags.hasErrors()) continue;    // 第一层的账在 grammars.js 上
      row.parsed += 1;
      trees.push({ path: p, tree: tree });
    }
    all.push(trees);
  }
  const pkgs = all.flatMap((ts) => ts.map((t) => t.tree));
  for (const trees of all) {
    const also = trees.map((t) => t.tree);
    for (const t of trees) {
      try {
        const g = lang.toGraph(t.tree, { also: also, pkgs: pkgs, strictCalls: STRICT_CALLS });
        row.graphed += 1;
        /* 顺带数一格账：这份图里有多少处"取字段再调它"（见 `softCallsIn` 那一段）。 */
        const soft = softCallsIn(g, new Set());
        if (soft > 0) { row.softFiles += 1; row.softSites += soft; }
      } catch (err) {
        bump(err.message, t.path);
      }
    }
  }
  row.ms = Date.now() - t0;
  row.walls = [...walls.entries()].sort((a, b) => b[1].n - a[1].n);
  row.classes = [...classes.entries()].sort((a, b) => b[1] - a[1]);
  row.nocls = [...nocls.entries()].map(([k, v]) => [k, v.msg, v.path]);
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
  process.stdout.write('语言      文件    解析过        落成图      取字段调       字节    用时  子树\n');
  for (const [lang, r] of rows) {
    process.stdout.write(`${lang.name.padEnd(9)}${String(r.files).padStart(5)}`
      + `${String(r.parsed).padStart(7)} ${pct(r.parsed, r.files).padStart(6)}`
      + `${String(r.graphed).padStart(7)} ${pct(r.graphed, r.parsed).padStart(6)}`
      + `${String(r.softFiles).padStart(7)} ${pct(r.softFiles, r.graphed).padStart(6)}`
      + `${mb(r.bytes).padStart(9)}${`${(r.ms / 1000).toFixed(1)}s`.padStart(8)}`
      + `  ${relative(ROOT, r.root)}\n`);
  }
  /* **"取字段调"那一栏是分子里的虚数**（见 `softCallsIn` 那一段）—— 印在表里，不藏。 */
  {
    const sf = rows.reduce((a, [, r]) => a + r.softFiles, 0);
    const ss = rows.reduce((a, [, r]) => a + r.softSites, 0);
    if (sf > 0) {
      process.stdout.write(`  ——「取字段调」= 落成了图，可里头有 \`call\` 的被调者是一格 field-get`
        + `（\`x.M(…)\` 里 M 没登记成方法时那条兜底）：${sf} 份 / ${ss} 处。\n`
        + '     对**方法**调用那条兜底运行期跑不通（记录上没有那个字段）。'
        + '**两门的口径不一样**：V 走兜底、go 当场报 —— 所以两栏的百分比不是一件事。\n');
    }
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
    /* `--nc` 只印**没归类**的那几条 —— 那是"上面那张表漏了什么"的清单。
       **用原话判**（`r.nocls`）：归一过的串可能落成另一族（2026-09-18 踩过），
       而原话在 `bump` 那一步就记好了，这儿只管印。 */
    if (argv.includes('--nc')) {
      const nc = (r.nocls ?? []).slice(0, WALLS);
      if (nc.length > 0) {
        process.stdout.write(`  ——（没归类的前 ${nc.length} 条，按原话）\n`);
        for (const [, msg] of nc) {
          process.stdout.write(`        ${msg.slice(0, 120)}\n`);
        }
      }
    }
  }
  process.stdout.write('\n这一份量的是**映射写全了没有**（改的是 ext/<语言>/tograph.js）；'
    + '语法那一层的账在 bench/grammars.js 上。\n');
}

