// tests/lib/jnc-matrix.js —— 位置 × 要素矩阵的**机械枚举**（ADR-0029 的 Phase 0）
//
// 为什么有这一份：ADR-0016 那 260 刀里有一整族是"同一个洞撞了三次"
// （第 219 体里的 typedef、第 250 体里的 enum、第 260 体里的 struct）。祸根不是那三种要素，
// 是我们从来没有把**"哪种要素能出现在哪种位置"**写成一张能查、能枚举、能报缺的表 ——
// 于是只能靠语料撞。
//
// 这一份不改前端、不动那张榜。它做一件事：把 `位置 × 要素` 的每一格**合成一小段源码**、
// 跑一遍 `sx`、把结果归成四类，最后写出 `docs/design/jnc-positions.md`。
// 那张表出来之后，"还差什么"是**读表**，不是撞。
//
//   node tests/lib/jnc-matrix.js            # 全量，写文档
//   node tests/lib/jnc-matrix.js --sort fn-body   # 只跑一行
//   node tests/lib/jnc-matrix.js --keep     # 留下合成的源码（.omni-cache/test/matrix/）
//
// 四类结果：
//   ok    降得下来（退出码 0、一条诊断都没有）
//   N     "还不收"（前端自己说的边界；括号里是账的头一句）
//   E     普通错（认错人的话大多在这一类里 —— 这一栏是下一刀的料）
//   syn   语法就不认（那一格在这门语言里压根写不出来 —— 这是**规格**，不是洞）

import { compose, diff, gaps, lookup } from '../../src/core/frontend-engine/positions.js';
import { JNC_FEATURES, JNC_SORTS } from '../../src/lang/jnc/features/index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
/* 位置的垫、分类器、跑一格：与那把**生成出来的**尺子（jnc-gen.js）共用一份 —— 见 jnc-probe.js。 */
import { SORTS, classify, runOne, sxOf, prepare, cleanup, root } from './jnc-probe.js';

const DOC = join(root, 'docs', 'design', 'jnc-positions.md');

const argv = process.argv.slice(2);
const only = argv.includes('--sort') ? argv[argv.indexOf('--sort') + 1] : null;
const keep = argv.includes('--keep');
/* `--check`：把量出来的每一格与**声明的规格**（src/lang/jnc/features/）对账。
   这一格是 ADR-0029 那条"表要是可执行的规格"的落点：漂了就是一条测试失败。 */
const check = argv.includes('--check');

/* ---------------------------------------------------------------- 要素表
 * 每种要素给一段**最小**源码。`use` 是"用一下它"的那一句（免得被当成死代码而绕过检查）；
 * `needsField` 说的是"这一格要素自己不是字段"，那种位置（struct / union）要另配一格字段
 * 才满足方言"至少一个字段"那条界 —— 那是方言的账，不该混进这张表。 */
/* 第四格（可选）是**"名字漏没漏出来"的探针**：一句"用一下那个声明出来的名字"的话，
   探针把它塞进**后面一个函数体**里再编一遍。编得过 = 这一格的名字在写它的那层作用域**外面**
   也认得。第 219/250/260 刀那笔代价（T-005："体里声明的类型，名字提到外面那层"）先前只是
   一句话，这一格把它量出来。
   为什么是"后面一个函数"而不是模块顶层：登记发生在**降那个体的时候**，模块级那些声明的类型
   在那之前就解完了 —— 拿模块顶层去问，量到的是**遍的次序**，不是作用域。 */
const KINDS = [
  ['field-int', 'int m_i;', 'x'],
  ['field-string', 'string_t m_s;', 'x'],
  ['field-array', 'int m_a[4];', 'x'],
  ['field-static', 'static int m_st;', 'x', undefined, 'int m_st;'],
  ['field-const', 'int const m_c;', 'x', undefined, 'int m_c;'],
  ['field-bitfield', 'int m_b : 3;', 'x'],
  ['field-bigendian', 'bigendian uint16_t m_be;', 'x', undefined, 'uint16_t m_be;'],
  ['field-class-value', 'Helper m_h;', 'x'],
  ['field-class-ptr', 'Helper* m_hp;', 'x'],
  ['struct', 'struct Nested { int m_n; }', 'x', 'Nested v;'],
  ['union-named', 'union Uni { int m_a; bool m_b; }', 'x', 'Uni v;'],
  ['union-anon', 'union { int m_ua; bool m_ub; }', 'x'],
  ['struct-anon', 'struct { int m_sa; bool m_sb; }', 'x'],
  ['class', 'class Inner { int m_v; }', 'x', 'Inner* v;'],
  ['enum', 'enum Color { Red, Green }', 'x', 'Color v = Color.Red;'],
  ['enum-anon', 'enum { KB = 1024, MB = 2048 }', 'x', 'int v = KB;'],
  ['enum-bitflag', 'bitflag enum Flags { A, B }', 'x', 'Flags v = Flags.A;'],
  ['typedef', 'typedef int Num;', 'x', 'Num v = 1;'],
  ['typedef-fn', 'typedef function VoidFn(int);', 'x', 'VoidFn* v;'],
  ['typedef-fnptr', 'typedef int IntFn(int);', 'x', 'IntFn* v;'],
  ['alias-method', 'alias twice = probeSelf;', 'x', 'twice();'],
  ['method-body', 'int probeM() { return 1; }', 'x'],
  ['method-proto', 'int probeP();', 'x'],
  ['method-static', 'static int probeS() { return 2; }', 'x'],
  ['method-errorcode', 'bool errorcode probeE(int v);', 'x'],
  ['construct', 'construct() { }', 'x'],
  ['construct-args', 'construct(int v) { }', 'x'],
  ['static-construct', 'static construct() { }', 'x'],
  ['destruct', 'destruct() { }', 'x'],
  ['operator-add', 'int operator + (int v) { return v; }', 'x'],
  ['operator-assign', 'int operator := (int v) { return v; }', 'x'],
  ['property-simple', 'int autoget property m_p;', 'x', undefined, 'int m_p;'],
  ['property-full', 'int property m_fp { get { return 1; } set(int v) { } }', 'x'],
  ['property-bindable', 'int bindable autoget property m_bp;', 'x', undefined, 'int m_bp;'],
  ['event', 'event m_onDone();', 'x'],
  ['reactor', 'reactor m_r { }', 'x'],
  ['local-var', 'int v = 1;', 'v'],
  ['import', 'import "imports/probeimp.jnc"', 'x'],
  ['pragma', 'pragma(ExposedEnums, true);', 'x'],
  ['using-namespace', 'using namespace probeNs;', 'x'],
  ['extension', 'extension ExtProbe: Helper { int extra() { return 3; } }', 'x'],
  /* 后来补的几种要素（矩阵是**机械枚举**，所以"表里少一种"本身就是一笔账）： */
  ['namespace', 'namespace probeInner { int probeInnerFn() { return 0; } }', 'x'],
  ['class-opaque', 'opaque class ProbeOpq { int m_ov; }', 'x'],
  ['method-virtual', 'virtual int probeV() { return 1; }', 'x'],
  ['method-abstract', 'abstract int probeA();', 'x'],
  ['field-fnptr', 'int function* m_fnp(int);', 'x'],
  ['field-multicast', 'multicast m_mc();', 'x'],
  ['method-override', 'override int probeOvr() { return 4; }', 'x'],
  ['enum-typed', 'enum Small: uint16_t { S1, S2 }', 'x'],
  ['property-indexed', 'int property m_ip(int i);', 'x'],
  ['dylib', 'dylib ProbeLib { int probeDl(int); }', 'x'],
  ['field-thin-ptr', 'int thin* m_tp;', 'x', undefined, 'int* m_tp;'],
  ['field-array-dyn', 'int m_ad[];', 'x'],
  /* 泛型实例当**表达式**用（`Boxy<int>(4)`）：语料里 unit_stdt_BoxList.jnc:42 那一句
     （`BoxIterator<int>(list.m_head)`）就是它，而且是那份文件**唯一**的拦路项。
     声明位置上的 `Boxy<int> b;` 早就收了 —— 差的只是表达式那一处。 */
  ['template-ctor-expr', 'Boxy<int> m_bx = Boxy<int>(4);', 'x'],
  /* 又一轮（尺子越宽，"我们不知道什么"就越少）： */
  ['friend', 'friend class Helper;', 'x'],
  ['field-static-init', 'static int m_si = 3;', 'x'],
  ['event-args', 'event m_onArg(int v);', 'x'],
  ['alias-field-path', 'alias m_pa = m_pad;', 'x'],
  ['class-multi-base', 'class MultiC: Helper, Helper2 { int m_mv; }', 'x'],
  ['disposable-class', 'disposable class DispC { int m_dv; }', 'x'],
  /* 第四轮： */
  ['method-const', 'int probeCn() const { return 8; }', 'x', undefined, 'int probeCn() { return 8; }'],
  ['property-static', 'static int autoget property m_sp;', 'x'],
  ['field-weak-ptr', 'Helper weak* m_wp;', 'x'],
  ['fn-async', 'async int probeAs() { return 1; }', 'x'],
  ['fn-unsafe', 'unsafe int probeUs() { return 2; }', 'x', undefined, 'int probeUs() { return 2; }'],
  ['attribute-decl', '[probeAttr = 1] int m_at;', 'x'],
];

/* ---------------------------------------------------------------- 主流程 */
prepare();

const sorts = SORTS.filter(([s]) => only === null || s === only);
const cells = new Map();          // `${sort}|${kind}` -> {k, why, esc?}
const escOf = new Map(KINDS.filter((r) => r[3] !== undefined).map((r) => [r[0], r[3]]));
/* 第五格（可选）是**"把修饰词去掉"的那一句**：降出来的 sx 与原样一模一样，就说明那几个词
   在这一层被悄悄丢掉了（第二百六十六刀就是这么冒出来的：union 里的 `static` / `property`）。
   有些词丢了是**对的**（比如 `const` 只在编译期管事），所以这一列的期望写在规格里（`trace`）。 */
const bareOf = new Map(KINDS.filter((r) => r[4] !== undefined).map((r) => [r[0], r[4]]));
const tally = { ok: 0, N: 0, E: 0, syn: 0, crash: 0 };
const t0 = Date.now();
for (const [sort, wrap] of sorts) {
  for (const [kind, elem] of KINDS) {
    const r = runOne(sort, kind, wrap(elem));
    /* 这一格收得下，再问一句**名字落在哪**：把"在模块顶层用一下它"那句接在后面再编一遍。
       编得过 = 漏到了模块顶层。这是 Phase 3 要的那一列（谁登记、登记到哪层）的第一半，
       而且是**量出来的**，不是我说的。 */
    /* 第三问：修饰词留下痕迹了吗（见 bareOf 那段注）。 */
    const bare = bareOf.get(kind);
    if (r.k === 'ok' && bare !== undefined) {
      const a = sxOf(sort, `${kind}__with`, wrap(elem));
      const b = sxOf(sort, `${kind}__bare`, wrap(bare));
      if (a !== null && b !== null) r.trace = a !== b;
    }
    const out = escOf.get(kind);
    if (r.k === 'ok' && out !== undefined) {
      const useFn = `int probeEscUse() {\n\t${out}\n\treturn 0;\n}\n`;
      r.esc = runOne(sort, `${kind}__esc`, `${wrap(elem)}\n${useFn}`).k === 'ok';
    }
    cells.set(`${sort}|${kind}`, r);
    tally[r.k] += 1;
  }
  process.stdout.write(`  ${sort.padEnd(18)} ${KINDS.length} 格\n`);
}
/* 漏出去的那些格单独报一行 —— 它是 T-005 那笔代价的**清单**。 */
const escaped = [...cells].filter(([, r]) => r.esc === true).map(([k]) => k);
const kept = [...cells].filter(([, r]) => r.esc === false).map(([k]) => k);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write(`\n位置 ${sorts.length} × 要素 ${KINDS.length} = ${cells.size} 格`
  + `　ok ${tally.ok}、N ${tally.N}、E ${tally.E}、syn ${tally.syn}、炸 ${tally.crash}　${secs}s\n`);
const noTrace = [...cells].filter(([, r]) => r.trace === false).map(([k]) => k);
process.stdout.write(`修饰词**没留下痕迹**的：${noTrace.length} 格`
  + `${noTrace.length > 0 ? `　→ ${noTrace.join('、')}` : ''}\n`);
process.stdout.write(`名字漏到写它那层**外面**的：${escaped.length} 格（留在原处的 ${kept.length} 格）`
  + `${escaped.length > 0 ? `　→ ${escaped.join('、')}` : ''}\n`);

/* 理由编号：同一句话在整张表里只写一遍，格子里放号。这一格就是 ADR-0029 说的"账号"的雏形
   —— 先按出现顺序编，等 Phase 1 把 accounts.md 立起来之后换成稳定号。 */
const whyIds = new Map();
const whyList = [];
for (const [, r] of cells) {
  if (r.why === '' || whyIds.has(r.why)) continue;
  whyIds.set(r.why, whyList.length + 1);
  whyList.push(r.why);
}

const mark = (r) => {
  if (r.k === 'ok') return '✓';
  if (r.k === 'syn') return '·';
  if (r.k === 'crash') return `**炸${whyIds.get(r.why)}**`;
  return `${r.k}${whyIds.get(r.why)}`;
};

const head = ['要素', ...sorts.map(([s]) => s)];
const rows = KINDS.map(([kind]) => [kind, ...sorts.map(([s]) => mark(cells.get(`${s}|${kind}`)))]);
const md = [];
md.push('# jancy 的 位置 × 要素 矩阵（机械枚举，ADR-0029 的 Phase 0）', '');
md.push('这一份是 `node tests/lib/jnc-matrix.js` **跑出来**的，不是手写的。每一格是"把那种要素',
  '塞进那个位置、合成一小段源码、跑一遍 `sx`"的结果：', '');
md.push('- `✓` 降得下来（一条诊断都没有）', '- `·` 语法就不认 —— 那是**规格**（这门语言里写不出来），不是洞',
  '- `N…` 前端自己说的边界（"还不收"）', '- `E…` 普通错 —— **这一栏是下一刀的料**：话对不对、认不认错人，都在这儿看', '');
md.push(`位置 ${sorts.length} × 要素 ${KINDS.length} = ${cells.size} 格：`
  + `✓ ${tally.ok}、N ${tally.N}、E ${tally.E}、· ${tally.syn}、炸 ${tally.crash}`, '');
md.push(`| ${head.join(' | ')} |`);
md.push(`|${head.map(() => '---').join('|')}|`);
for (const r of rows) md.push(`| ${r.join(' | ')} |`);
md.push('', '## 修饰词留痕了吗（`trace`）', '',
  '带修饰词的那几种要素还有第三问：**把那几个词去掉再降一遍，两份 sx 一样吗**。一样就说明',
  '这一层把它们丢了。丢了不一定是错（`const` / `unsafe` 只在编译期管事），所以期望写在规格里 ——',
  '这一问是"`ok` 只说明没诊断、不说明降对了"那条界的补救（ADR-0029 第 10.21 节）。', '');
md.push(`没留下痕迹的：${noTrace.length} 格。`, '');
for (const k of noTrace) md.push(`- \`${k}\` —— 那几个词降出来没留痕`);
md.push('', '## 名字落在哪（`escapes`）', '',
  '带体的那几种要素还有第二问：**声明出来的名字，在写它的那层作用域外面认不认得**。',
  '量法是把"用一下那个名字"塞进后面一个函数体里再编一遍 —— 编得过就是漏出去了。',
  '这一列就是 ADR-0016 第 219/250/260 刀那笔代价（T-005）的清单。', '');
md.push(`漏到外面那层：${escaped.length} 格；留在原处：${kept.length} 格。`, '');
for (const k of escaped) md.push(`- \`${k}\` —— 漏到外面那层`);
md.push('', '## 理由表', '');
whyList.forEach((w, i) => md.push(`${i + 1}. ${w}`));
md.push('', '## 怎么读它', '',
  '- **E 那一栏**是优先级最高的：普通错意味着"这一层认为你写错了"，而语料里写着的东西',
  '  多半没错 —— 第 248/251/253 刀那三条"认错人"就长这样。',
  '- **同一行里 ✓ 与 N 混着**说明这件事与位置有关，那正是位置代数该管的；',
  '  同一列里大片 N 说明那个位置本身还欠一套机器。',
  '- 这张表**不替代**语料榜（`tests/lib/jnc-sweep.js`）：榜量"语料里真写了什么"，',
  '  这张表量"规格里可能写什么"。两张一起才知道"下一刀值不值"。', '');
mkdirSync(dirname(DOC), { recursive: true });
writeFileSync(DOC, `${md.join('\n')}\n`);
process.stdout.write(`表：${DOC}\n`);

if (check) {
  const spec = compose(JNC_FEATURES);
  const sortList = sorts.map(([s]) => s);
  const kindList = KINDS.map(([k]) => k);
  const bad = diff(spec, cells);
  const { todo, undeclared } = gaps(spec, sortList, kindList);
  process.stdout.write(`\n规格：${spec.features.length} 个特性、`
    + `${spec.accounts.size} 个账号、声明了 ${spec.cells.size} 格\n`);
  if (todo.length > 0) {
    process.stdout.write(`还没定（todo）${todo.length} 格：\n`);
    for (const [s, k, note] of todo) process.stdout.write(`  ${s} × ${k}　${note}\n`);
  }
  if (undeclared.length > 0) {
    process.stdout.write(`**表里压根没有** ${undeclared.length} 格：\n`);
    for (const [s, k] of undeclared) process.stdout.write(`  ${s} × ${k}\n`);
  }
  if (bad.length > 0) {
    process.stdout.write(`\n**分歧** ${bad.length} 格（规格说的 vs 量出来的）：\n`);
    for (const d of bad) {
      process.stdout.write(`  ${d.sort} × ${d.kind}　规格 ${d.want}、量出来 ${d.got}`
        + `${d.why ? `　（${d.why.slice(0, 60)}）` : ''}\n`);
    }
  }
  const okCells = cells.size - bad.length - todo.length - undeclared.length;
  process.stdout.write(`\n对上了 ${okCells} / ${cells.size} 格`
    + `　分歧 ${bad.length}、todo ${todo.length}、缺声明 ${undeclared.length}\n`);
  if (bad.length > 0 || undeclared.length > 0) process.exitCode = 1;
}
const left = cleanup(keep);
if (keep) process.stdout.write(`合成的源码留在：${left}\n`);


