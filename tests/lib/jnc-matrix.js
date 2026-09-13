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

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cli = join(root, 'src', 'core', 'cli.js');
const OUT_DIR = join(process.env.OMNI_CACHE_DIR || join(root, '.omni-cache'), 'test', 'matrix');
const DOC = join(root, 'docs', 'design', 'jnc-positions.md');

const argv = process.argv.slice(2);
const only = argv.includes('--sort') ? argv[argv.indexOf('--sort') + 1] : null;
const keep = argv.includes('--keep');

/* ---------------------------------------------------------------- 要素表
 * 每种要素给一段**最小**源码。`use` 是"用一下它"的那一句（免得被当成死代码而绕过检查）；
 * `needsField` 说的是"这一格要素自己不是字段"，那种位置（struct / union）要另配一格字段
 * 才满足方言"至少一个字段"那条界 —— 那是方言的账，不该混进这张表。 */
const KINDS = [
  ['field-int', 'int m_i;', 'x'],
  ['field-string', 'string_t m_s;', 'x'],
  ['field-array', 'int m_a[4];', 'x'],
  ['field-static', 'static int m_st;', 'x'],
  ['field-const', 'int const m_c;', 'x'],
  ['field-bitfield', 'int m_b : 3;', 'x'],
  ['field-bigendian', 'bigendian uint16_t m_be;', 'x'],
  ['field-class-value', 'Helper m_h;', 'x'],
  ['field-class-ptr', 'Helper* m_hp;', 'x'],
  ['struct', 'struct Nested { int m_n; }', 'x'],
  ['union-named', 'union Uni { int m_a; bool m_b; }', 'x'],
  ['union-anon', 'union { int m_ua; bool m_ub; }', 'x'],
  ['class', 'class Inner { int m_v; }', 'x'],
  ['enum', 'enum Color { Red, Green }', 'x'],
  ['enum-anon', 'enum { KB = 1024, MB = 2048 }', 'x'],
  ['enum-bitflag', 'bitflag enum Flags { A, B }', 'x'],
  ['typedef', 'typedef int Num;', 'x'],
  ['typedef-fn', 'typedef function VoidFn(int);', 'x'],
  ['typedef-fnptr', 'typedef int IntFn(int);', 'x'],
  ['alias-method', 'alias twice = probeFn;', 'x'],
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
  ['property-simple', 'int autoget property m_p;', 'x'],
  ['property-full', 'int property m_fp { get { return 1; } set { } }', 'x'],
  ['property-bindable', 'int bindable autoget property m_bp;', 'x'],
  ['event', 'event m_onDone();', 'x'],
  ['reactor', 'reactor m_r { }', 'x'],
  ['local-var', 'int v = 1;', 'v'],
  ['import', 'import "imports/lib60.jnc"', 'x'],
  ['pragma', 'pragma(ExposedEnums, true);', 'x'],
  ['using-namespace', 'using namespace probeNs;', 'x'],
  ['extension', 'extension ExtProbe: Helper { int extra() { return 3; } }', 'x'],
];

/* ---------------------------------------------------------------- 位置表
 * 每个位置给一个 `wrap(elem)`：把那一格要素塞进这个位置，凑成一份**能编的**源码。
 * 公共前奏（`PRE`）给要素里引到的名字（Helper / probeFn / probeNs）一个落脚处 ——
 * 那几个名字本身不是被量的东西，缺了它们每一格都会多一条"没有这个类型"的噪音。 */
const PRE = `class Helper {
	int m_hv;
}

int probeFn(int a) {
	return a;
}

namespace probeNs {
	int probeNsFn() {
		return 0;
	}
}

`;

const MAIN = `
int main() {
	printf("probe\\n");
	return 0;
}
`;

const SORTS = [
  ['module', (e) => `${PRE}${e}\n${MAIN}`],
  ['namespace', (e) => `${PRE}namespace probeOuter {\n${e}\n}\n${MAIN}`],
  ['class-body', (e) => `${PRE}class ProbeC {\n\tint m_pad;\n${e}\n}\n${MAIN}`],
  ['struct-body', (e) => `${PRE}struct ProbeS {\n\tint m_pad;\n${e}\n}\n${MAIN}`],
  ['union-body', (e) => `${PRE}union ProbeU {\n\tint m_ua;\n\tbool m_ub;\n${e}\n}\n${MAIN}`],
  ['opaque-class-body', (e) => `${PRE}opaque class ProbeO {\n\tint m_pad;\n${e}\n}\n${MAIN}`],
  ['fn-body', (e) => `${PRE}int probeHost() {\n${e}\n\treturn 0;\n}\n${MAIN}`],
  ['property-body', (e) => `${PRE}int property g_pp {\n\tget {\n\t\treturn 1;\n\t}\n${e}\n}\n${MAIN}`],
  ['extension-body', (e) => `${PRE}extension ProbeExt: Helper {\n${e}\n}\n${MAIN}`],
];

/* ---------------------------------------------------------------- 跑一格
 * 归一：`'…'` 那些名字换掉（与 jnc-sweep 的 reasonOf 同一条口径），好让同一件事在
 * 不同格里显示成同一句话。 */
function classify(err, code) {
  const lines = err.split('\n');
  let syn = false;
  let nope = null;
  let plain = null;
  for (const l of lines) {
    const m = /^.*?:\d+:\d+: (error|warning): (.*)$/.exec(l);
    if (m === null) continue;
    if (m[1] === 'warning') continue;
    const why = m[2].replace(/'[^']*'/g, "'…'");
    if (/^(unexpected|语法|认不出的)/.test(why) || /unexpected/.test(why)) { syn = true; continue; }
    if (why.startsWith('jancy 前端第一刀还不收：')) {
      if (nope === null) nope = why.slice('jancy 前端第一刀还不收：'.length);
      continue;
    }
    if (plain === null) plain = why;
  }
  if (syn && nope === null && plain === null) return { k: 'syn', why: '语法不认' };
  if (nope !== null) return { k: 'N', why: nope };
  if (plain !== null) return { k: 'E', why: plain };
  /* **炸**（一条诊断都没有、栈爬出来了）：那是这一层自己的 bug，不是语言的边界。
     这一类语料榜量不到（榜只看诊断行），而它恰恰是最该先修的一类 —— 见 ADR-0029。 */
  const st = /^\s*(TypeError|RangeError|ReferenceError|AssertionError|Error): (.*)$/m.exec(err);
  if (st !== null) return { k: 'crash', why: `${st[1]}: ${st[2]}`.slice(0, 90) };
  return code === 0 ? { k: 'ok', why: '' } : { k: 'E', why: `退出码 ${code}，没有诊断` };
}

function runOne(sort, kind, src) {
  const p = join(OUT_DIR, `${sort}__${kind}.jnc`);
  writeFileSync(p, src);
  try {
    execFileSync(process.execPath, [cli, 'sx', p], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
    });
    return classify('', 0);
  } catch (e) {
    return classify(e.stderr ?? '', e.status ?? 1);
  }
}

/* ---------------------------------------------------------------- 主流程 */
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const sorts = SORTS.filter(([s]) => only === null || s === only);
const cells = new Map();          // `${sort}|${kind}` -> {k, why}
const tally = { ok: 0, N: 0, E: 0, syn: 0, crash: 0 };
const t0 = Date.now();
for (const [sort, wrap] of sorts) {
  for (const [kind, elem] of KINDS) {
    const r = runOne(sort, kind, wrap(elem));
    cells.set(`${sort}|${kind}`, r);
    tally[r.k] += 1;
  }
  process.stdout.write(`  ${sort.padEnd(18)} ${KINDS.length} 格\n`);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write(`\n位置 ${sorts.length} × 要素 ${KINDS.length} = ${cells.size} 格`
  + `　ok ${tally.ok}、N ${tally.N}、E ${tally.E}、syn ${tally.syn}、炸 ${tally.crash}　${secs}s\n`);

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
if (!keep) rmSync(OUT_DIR, { recursive: true, force: true });
else process.stdout.write(`合成的源码留在：${OUT_DIR}\n`);


