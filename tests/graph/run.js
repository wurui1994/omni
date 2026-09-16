// tests/graph/run.js —— 节点的判据：**语言 × 后端的矩阵，输出逐行相同**
//
// 一门语言一份 `examples/<家族>.*`（形状随它自己的写法），期望输出**一个家族一份**，
// 家族里所有语言、所有后端共用。现在七个家族：
//
//     basics 15/120/7/ok · multi 3/7/1 2 · defer in/b/a/out · record 1/5/6
//     index 10/30/45 · loopexit 12/6/8 · intmath 15/120
//
// 三条轴各自的意思：
//   * 横着看（语言）：`docs/design/node-graph-contract.md` §1 —— 同一张节点清单承载不同语言。
//   * 竖着看（后端）：§6 —— 后端只回答五问，**同一张图在每个后端上的可观察行为必须一致**。
//   * 第三档 **skip**：后端接不住的形状要**有名有姓**地跳过（§6 第 2 条）——
//     跳过不是失败，它是算出来的待办。`wat` 那条腿现在就有 10 格缺口。
// 加一门语言或加一个后端，矩阵自动多一行/一列 —— 这就是"自动覆盖全部后端"的确切含义。
//
//   node tests/graph/run.js            全跑（末尾按后端印一行覆盖率）
//   node tests/graph/run.js --sx chez  顺带把那门语言的图印成 sx（人看的）
//   node tests/graph/run.js --gaps     印每个后端接不住的节点清单
//   node tests/graph/run.js --machines 印每格节点的**提供者名单**（G5 那条判据）
//
// **第十门 cpp 后来进来了，而它当初进不来的理由与后来进得来的理由都是量出来的**：
// 头一版拿 7 行的 `int sumto(int n) { … }` 去过 `ext/cpp/cpp.grammar`，报
// "too many concurrent parses" —— 连这么短的程序都过不去。把三类歧义一类一类量下来，
// 两类根本不是机制欠账，是**语法自己写松了**（`specs` 允许两格 type-spec；`stmt` 收了
// 函数定义，而 C++ 没有嵌套函数），改在语法里；第三类（`T * x;`）才是真要驱动器回问
// 一句"这个名字登记成类型了吗"（附录 A.5 第 3 笔账）—— 那一格**后来也补上了**
// （`declares-type` / `needs-type`，见 driver.js），于是 cpp 那个 `(prefer 1)` 删掉了。
// `ext/cpp/examples/basics.cpp` 里那行 `typedef int myint;` 就是这条机制的判据：
// 把语法里 `needs-type` 那一格删掉，这份例子当场过不去。期望输出与另外九门同一份
// `15 / 120 / 7 / ok`。

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { toSx, node, lit } from '../../src/core/graph/graph.js';
import { backends, gaps, shapeGaps, Gap } from '../../src/core/graph/contract.js';
// 五栏声明那张表 —— 下面"五栏指纹"那一节要拿它自己量自己（ADR-0033 §3.2）
import { NODES } from '../../src/core/graph/nodes.js';
// 内建那张表 —— "出处"那一节要它（arity 与 effects 两栏必须都在）
import { PRIMS } from '../../src/core/graph/prims.js';
// 登记处（这儿只用它一栏：谁是方言 —— 方言不算独立的一家，见下面 `baseOf`）
import { LANGS } from '../../src/core/graph/langs.js';
// 例子表两条判据共用一份（`delete.js` 也 import 它）—— 抄两份就会有一份忘了改
import { CASES, HAND } from './cases.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;

const argv = process.argv.slice(2);
const showSx = argv.includes('--sx');
const showGaps = argv.includes('--gaps');
const showMachines = argv.includes('--machines');
/** 每格节点用了它的语言名单 —— **数出来的**，不是手写的（ADR-0033 §3.7 的 G5）。 */
const providers = new Map();
/**
 * **方言不算独立的一家**：gsl-shell 的映射就是 lua 那份（`ext/gsl-shell/tograph.js` 是转手），
 * 所以它给同一格节点作证等于同一家作证两遍 —— 那会把"≥4 家 = 机器"这条判据灌水
 * （落地那天先看到的就是 `11 机器 bind … gsl-shell lua …`）。
 * 于是按**基准那门**记名：`LANGS` 里有 `extends` 的，票投给它继承的那门。
 */
const baseOf = (lang) => LANGS.get(lang)?.extends ?? lang;
function countOps(x, lang) {
  if (x === null || x === undefined) return;
  if (Array.isArray(x)) { x.forEach((y) => countOps(y, lang)); return; }
  if (x.kind === 'graph') { countOps(x.body, lang); return; }
  if (x.op === undefined) return;
  if (!providers.has(x.op)) providers.set(x.op, new Set());
  providers.get(x.op).add(baseOf(lang));
  Object.values(x.ins).forEach((y) => countOps(y, lang));
}
const only = argv.filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;
let skipped = 0;
/** 每个后端的覆盖（**比覆盖，不比优劣** —— 契约那一节的原话）。 */
const cov = new Map();
const tally = (name, kind) => {
  if (!cov.has(name)) cov.set(name, { ok: 0, skip: 0, fail: 0 });
  cov.get(name)[kind] += 1;
};

if (showGaps) {
  for (const b of backends()) {
    const g = gaps(b.name);
    const sh = shapeGaps(b.name);
    process.stdout.write(`${b.name}: ${g.length === 0 ? '节点级没有缺口' : `${g.length} 格节点接不住`}`
      + `${sh.length === 0 ? '' : ` · ${sh.length} 条形状上的账`}\n`);
    for (const x of g) process.stdout.write(`    ${x.op} —— ${x.why}\n`);
    // 形状上的账要一起印 —— 不然"节点级没有缺口"会盖住矩阵里还在跳的格子
    for (const x of sh) process.stdout.write(`    〔形状〕${x.what} —— ${x.why}\n`);
  }
  process.stdout.write('\n');
}

/**
 * **"没有出处的节点不许存在"也是一条判据**（§3 那句话）。
 * 每格节点的 `doc` 里写的是"哪几门语言的规格要求它" —— 空着就等于这一格是我想出来的。
 * 内建那张表（`PRIMS`）比着来：arity 与 effects 两栏必须都在（arity 是 -1 表示变参）。
 */
{
  let bad = 0;
  for (const [op, d] of NODES) {
    if (typeof d.doc === 'string' && d.doc.trim() !== '') continue;
    process.stdout.write(`  FAIL 出处〔${op}〕: 这格节点没写出处（哪几门语言的规格要求它）\n`);
    bad++;
  }
  for (const [nm, d] of PRIMS) {
    if (typeof d.arity === 'number' && Array.isArray(d.effects)) continue;
    process.stdout.write(`  FAIL 出处〔内建 ${nm}〕: arity 或 effects 没声明\n`);
    bad++;
  }
  if (bad === 0) {
    process.stdout.write(`  ok   出处 [节点 ${NODES.size} 格各有出处 · 内建 ${PRIMS.size} 格各有 arity 与 effects]\n`);
    pass++;
  } else fail += bad;
}

/**
 * **G1 与 G2 也各要一条会红的判据**（ADR-0033 §5 那五条里的头两条）。
 *
 * 两条都已经在 `node()` 里落地了 —— 可"落地了"与"有判据"是两件事：这几句检查哪天被谁
 * 顺手放宽（少一格端口也放过去、`seq` 悄悄进了 NODES），除了这一节没有别的地方会红。
 *   G1 边完整：多一格端口、少一格端口、多一格附属，三种都得当场炸；
 *   G2 调度器专属算子（`seq` / `let-temp` / `drop` / `split`）**不许出现在图上** ——
 *     它们不在 NODES 里，所以 `node()` 报的就是 `no such node`。次序是**算出来的边**，
 *     不是一格能手写的算子（§3.3）。
 * 顺带把第十九批那条也钉住：附属的值是 `undefined` 要在**建图这一步**炸，
 * 而不是等序列化那条腿去红。
 */
{
  const cases = [
    ['G2〔手写 seq〕', () => node('seq', {}), 'no such node: seq'],
    ['G2〔手写 let-temp〕', () => node('let-temp', {}), 'no such node: let-temp'],
    ['G2〔手写 drop〕', () => node('drop', {}), 'no such node: drop'],
    ['G2〔手写 split〕', () => node('split', {}), 'no such node: split'],
    ['G1〔多一格端口〕', () => node('bind', { init: lit(1), nope: lit(2) }, { name: 'x' }), 'has no in-port "nope"'],
    ['G1〔少一格端口〕', () => node('bind', {}, { name: 'x' }), 'misses in-port "init"'],
    ['G1〔多一格附属〕', () => node('const', {}, { valu: 1 }), 'has no attr "valu"'],
    ['G1〔附属是 undefined〕', () => node('func', { body: [] }, { params: [], name: undefined }), 'is undefined'],
  ];
  for (const [label, mk, want] of cases) {
    let msg = null;
    try {
      mk();
    } catch (err) {
      msg = err.message;
    }
    if (msg === null) {
      process.stdout.write(`  FAIL ${label}: 没报错 —— 这一格检查已经不管事了\n`); fail++;
    } else if (!msg.includes(want)) {
      process.stdout.write(`  FAIL ${label}: 报错了，但理由不对\n       期望里有 ${want}\n       得到 ${msg}\n`); fail++;
    } else {
      process.stdout.write(`  ok   ${label} [${msg}]\n`); pass++;
    }
  }
}

/**
 * **五栏这条公理自己也要被量一遍**（ADR-0033 §3.2："五栏里任何一格不同就是两个节点"）。
 *
 * 反过来读那句话：五栏**一格不差**的两格节点，就该是同一格（差别该落进附属，像
 * `loop-exit` 的 `break`/`continue`）。所以这一节给每格节点算一个**指纹** ——
 * sort + 入端口（求值语义 + rest/multi/optional，**名字抹掉**：改名不是语义差别）
 * + 出端口 + 效应 + 寿命 —— 撞了就得说清为什么。
 *
 * 说得清的写进 `SAME_FIVE`（一条一句人话），说不清的当场失败。
 * 这一节抓出来的两组都留在清单里，而且两组的性质**不一样**（见那两句话）——
 * 那正是"公理也会有说不清的地方，把它写下来比装作没有好"。
 */
const fiveFp = (d) => JSON.stringify([
  d.sort,
  d.ins.map((p) => `${p.sem}${p.rest ? '*' : ''}${p.multi ? '+' : ''}${p.optional ? '?' : ''}`),
  [...d.outs].sort(),
  [...d.effects].sort(),
  d.lifetime,
]);
/** 五栏撞车而**说得清**的那几组：一组一句话，说的是"差别在哪儿" */
const SAME_FIVE = new Map([
  ['list-new / record-new', '差别只在附属（`names` 有没有）—— 按公理该是一格节点两个 kind，'
    + '现在分两格是**这一批的记账**：记录的字段名是编译期的、列表的下标是运行期的，'
    + '而"编译期还是运行期"这件事五栏里没有一栏说得出来。要合就得先有那一栏。'],
  ['index-get / map-get / map-has', '**五栏与附属都一模一样，差别只在 op 名字上** ——'
    + ' 这是这条公理目前最露的一处。三格的真差别是"缺了怎么办"（越界 / 缺键 / 只问在不在），'
    + '那是一格**语义**，不在五栏里。合成一格要多一栏（缺项语义），拆成三格是现在的样子；'
    + '两条路都比"装作五栏说清了"好。'],
]);
{
  const groups = new Map();
  for (const [op, d] of NODES) {
    const k = fiveFp(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(op);
  }
  for (const ops of groups.values()) {
    if (ops.length < 2) continue;
    const key = [...ops].sort().join(' / ');
    const why = SAME_FIVE.get(key);
    if (why === undefined) {
      process.stdout.write(`  FAIL 五栏指纹〔${key}〕: 五栏一格不差却是两格节点 —— 要么合成一格，`
        + `要么把差别写进 SAME_FIVE（一句人话）\n`);
      fail++;
    } else {
      process.stdout.write(`  ok   五栏指纹〔${key}〕[撞车，理由记着]\n`);
      pass++;
    }
  }
  for (const key of SAME_FIVE.keys()) {
    const still = [...groups.values()].some((ops) => [...ops].sort().join(' / ') === key);
    if (!still) {
      process.stdout.write(`  FAIL 五栏指纹〔${key}〕: 这一组**已经不撞了** —— 从 SAME_FIVE 里删掉它\n`);
      fail++;
    }
  }
}

/**
 * **形状上的账要有证物**（每条都跑一遍）。
 *
 * 一条"接不住"写在清单里不花钱，**过期也不花钱** —— 哪天有人把实数转串接上了，账还留着，
 * 清单就开始说假话。所以每条账带一份手搭的小图：那份图必须**当场**抛出 Gap。
 * 不抛就报"这条账已经不欠了" —— 那是好消息，但它得改清单，不许留着。
 */
for (const b of backends()) {
  for (const sh of shapeGaps(b.name)) {
    const label = `${b.name} 形状账〔${sh.what}〕`;
    if (typeof sh.witness !== 'function') {
      process.stdout.write(`  FAIL ${label}: 这条账没有证物（一份当场触发它的小图）\n`);
      fail++;
      continue;
    }
    let threw = null;
    try {
      b.lower(sh.witness());
    } catch (err) {
      threw = err;
    }
    if (threw === null) {
      process.stdout.write(`  FAIL ${label}: 证物**没**报缺口 —— 这条账已经不欠了，删掉它\n`);
      fail++;
    } else if (!(threw instanceof Gap)) {
      process.stdout.write(`  FAIL ${label}: 证物报的不是缺口而是异常：${threw.message}\n`);
      fail++;
    } else {
      process.stdout.write(`  ok   ${label} [证物当场报缺口]\n`);
      pass++;
    }
  }
}

/**
 * 一张图 × 每个后端。语言那一侧与"手搭图"那一侧共用它 ——
 * 判据只有一条：**同一张图，每个后端的可观察行为必须一致**。
 */
function check(name, g, expect) {
  for (const b of backends()) {
    const label = `${name} × ${b.name}`;
    let art = null;
    try {
      art = b.lower(g);
    } catch (err) {
      // **缺口不是失败**：后端说不出口的形状要有名有姓地跳过（§6 第 2 条纪律）
      if (err instanceof Gap) {
        process.stdout.write(`  skip ${label}：${err.message}\n`); skipped++; tally(b.name, 'skip');
      } else { process.stdout.write(`  FAIL ${label}: ${err.message}\n`); fail++; tally(b.name, 'fail'); }
      continue;
    }
    if (b.runnable === false) {
      // sx 那一格：**三条一起验** —— 出得来、读回来逐字节相同、读回来那张图跑出同一份输出。
      // 第二三条是后加的：原来只验"出得来、且不空"，那连"这份文本能不能读回来"都没管，
      // 而"图的一种写法"这句话不成立的话 sx 就没有存在的理由（见 contract.js 那一段）。
      if (typeof art.text !== 'string' || art.text.length === 0) {
        process.stdout.write(`  FAIL ${label}: 序列化出来是空的\n`); fail++; tally(b.name, 'fail');
        continue;
      }
      const lines = art.text.split('\n').length;
      try {
        const again = art.reread();
        if (again !== art.text) {
          const at = firstLineDiff(art.text, again);
          process.stdout.write(`  FAIL ${label}: 读回来再序列化**不一样**\n${at}\n`);
          fail++; tally(b.name, 'fail');
          continue;
        }
        const { out } = art.run();
        const got = out.join(' / ');
        const want = expect.join(' / ');
        if (got !== want) {
          process.stdout.write(`  FAIL ${label}: 读回来那张图跑出别的结果\n       期望 ${want}\n       得到 ${got}\n`);
          fail++; tally(b.name, 'fail');
          continue;
        }
      } catch (err) {
        process.stdout.write(`  FAIL ${label}: ${err.message}\n`); fail++; tally(b.name, 'fail');
        continue;
      }
      process.stdout.write(`  ok   ${label} [序列化 ${lines} 行 · 读回来逐字节相同 · 跑出同一份输出]\n`);
      pass++; tally(b.name, 'ok');
      continue;
    }
    try {
      const { out } = art.run();
      const got = out.join(' / ');
      const want = expect.join(' / ');
      if (got === want) { process.stdout.write(`  ok   ${label} [${got}]\n`); pass++; tally(b.name, 'ok'); } else {
        process.stdout.write(`  FAIL ${label}\n       期望 ${want}\n       得到 ${got}\n`);
        fail++; tally(b.name, 'fail');
      }
    } catch (err) {
      process.stdout.write(`  FAIL ${label}: ${err.message}\n`);
      fail++; tally(b.name, 'fail');
    }
  }
}

/** 两份文本第一处不同的那一行 —— 整份 sx 贴出来没人读 */
function firstLineDiff(want, got) {
  const a = want.split('\n');
  const b = got.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return `       第 ${i + 1} 行\n       原文 ${JSON.stringify(a[i] ?? '<结束>')}\n       读回 ${JSON.stringify(b[i] ?? '<结束>')}`;
  }
  return '       （只差在末尾的空白）';
}

for (const c of CASES) {
  if (only.length > 0 && !only.includes(c.name)) continue;
  let g = null;
  try {
    const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
    const text = readText(`${ROOT}${c.file}`);
    const diags = new Diagnostics();
    const toks = lexText(tb.grammar.lex, new SourceFile(c.file, text), diags);
    if (toks === null || diags.hasErrors()) throw new Error(`词法炸了：${diags.items[0]?.msg}`);
    const tree = glrParse(tb, toks, diags);
    if (tree === null || diags.hasErrors()) throw new Error(`语法炸了：${diags.items[0]?.msg}`);
    g = c.toGraph(tree);
    countOps(g, c.name.split('+')[0]);
    if (showSx) process.stdout.write(`\n---- ${c.name} ----\n${toSx(g)}\n`);
  } catch (err) {
    process.stdout.write(`  FAIL graph/${c.name}（树 -> 图）: ${err.message}\n`);
    fail++;
    continue;
  }

  check(c.name, g, c.expect);
}

// ---- 手搭的图：**没有哪门语言的语法能直说的那几条调度器语义** --------------------
//
// 为什么不写成某门语言的例子：go / V 的 `defer` 是**函数**作用域、nim 的是块作用域，
// 而图上 `scope-exit` 挂的是"最近的一格 region"—— 拿它们的语法当例子会把语义写歪
// （那笔账记在 `docs/design/node-graph-contract.md` A.6.1）。这几条是**节点自己的**
// 语义，所以直接搭图，两个能跑的后端必须给同一个答案。
for (const c of HAND) {
  if (only.length > 0 && !only.includes(c.name)) continue;
  check(c.name, c.graph(), c.expect);
}

if (showMachines) {
  // G5：一格节点的提供者名单。**只有一家的不算机器**（ADR-0033 §3.7 / §5 同一条纪律）。
  process.stdout.write('\n每格节点的提供者名单（数出来的）：\n');
  const rows = [...providers.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [op, langs] of rows) {
    const mark = langs.size >= 4 ? '机器' : (langs.size >= 2 ? '能力' : '一家');
    process.stdout.write(`  ${String(langs.size).padStart(2)} ${mark}  ${op.padEnd(11)}${[...langs].sort().join(' ')}\n`);
  }
}

// 每个后端一行覆盖率。**后端之间不比优劣，比覆盖**（契约那一节的原话）——
// 这一行就是那句话的可执行版本：跑通几格、因为什么跳过几格、缺口几格。
process.stdout.write('\n每条腿的覆盖（比覆盖，不比优劣）：\n');
for (const b of backends()) {
  const c = cov.get(b.name) ?? { ok: 0, skip: 0, fail: 0 };
  const total = c.ok + c.skip + c.fail;
  const tail = b.runnable === false ? '（序列化 + 读回来逐字节相同 + 跑出同一份输出）'
    : (c.skip === 0 ? '' : `，${c.skip} 格跳过（节点级缺口 ${gaps(b.name).length} 格`
      + ` · 形状上的账 ${shapeGaps(b.name).length} 条）`);
  process.stdout.write(`  ${b.name.padEnd(7)}${c.ok}/${total} 跑通${tail}\n`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed, ${skipped} skipped（缺口，有名有姓）`
  + `（语言例子 ${CASES.length} + 手搭图 ${HAND.length}，× 后端 ${backends().length}）\n`);
if (fail > 0) process.exit(1);
