// tests/cli/tree.js —— 命令树与管线表（ADR-0018 决策四、五）
//
// 这一份只查**机制**：走树、分开关、别名铺平、每一级的 --help，以及管线表那两个渲染
// （`--explain` 与 `-v` 是同一份数据的两种印法）。真正跑起来的行为由各语言那几组门管
// （tests/c/*、tests/run.js）。
//
//   node tests/cli/tree.js

import { findCmd, splitArgv, canonicalize, ownsVerbose, renderHelp } from '../../src/core/cli/tree.js';
import { ROOT, LEGACY } from '../../src/core/cli/cmds.js';
import { newPlan, addStage, renderPlan, renderStage } from '../../src/core/cli/stages.js';
import { planForC } from '../../src/core/cli/plan-c.js';
import { planForOmni } from '../../src/core/cli/plan-omni.js';
import { tccTranslate } from '../../src/core/cli/cmd-tcc.js';

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, got, want) => {
  fail++;
  process.stdout.write(`  FAIL ${name}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}\n`);
};
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(name);
  else bad(name, got, want);
};
const err = (m) => new Error(m);

/* ---- 走树。 */
{
  const r = findCmd(ROOT, ['c', 'obj', 't.c', '-o', 'a.o']);
  eq('走到 c obj', [r.path, r.node.key, r.rest], [['c', 'obj'], 'c-obj', ['t.c', '-o', 'a.o']]);
}
{
  /* 走到**第一个不是子命令名**的记号就停 —— 多级 --help 就是这么来的，不必特判。 */
  const r = findCmd(ROOT, ['c', '--help']);
  eq('omni c --help 落在 c 上', [r.path, r.node.name, r.node.key], [['c'], 'c', undefined]);
}
{
  const r = findCmd(ROOT, ['c', 'link', '--help']);
  eq('omni c link --help 落在 link 上', [r.path, r.node.key], [['c', 'link'], 'c-link']);
}
{
  const r = findCmd(ROOT, ['c-obj', 't.c']);
  eq('旧名 c-obj 还认（静默别名）', [r.path, r.node.key, r.node.hidden], [['c-obj'], 'c-obj', true]);
}
{
  const r = findCmd(ROOT, ['nosuch', 'x']);
  eq('不认识的命令：path 是空的', [r.path.length, r.node.name], [0, 'omni']);
}

/* ---- 带值的开关不能被当成源文件。这是从前顶层那一坨 26 个 || 干的活。 */
{
  const { node } = findCmd(ROOT, ['c', 'obj']);
  const { args, opts } = splitArgv(node, ['--arch', 'x86_64', '--os', 'linux', '-o', 'a.o', 't.c'], err);
  eq('开关写在前面也认得出源文件', args, ['t.c']);
  eq('-o 的值进 opts', opts.get('-o'), ['a.o']);
  eq('--arch 的值进 opts', opts.get('--arch'), ['x86_64']);
}
{
  /* `--arch`/`--os`/`--format` 从前**不在**顶层那张表里，所以
   * `c-obj --arch x86_64 x.c` 会把 `x86_64` 当成源文件 —— 现有的门都是 `x.c` 写在前面，
   * 所以一直没露。这一条就是钉住那个修好的地方。 */
  const { node } = findCmd(ROOT, ['c-obj']);
  const { args } = splitArgv(node, ['--arch', 'x86_64', 't.c'], err);
  eq('旧名上同样修好了', args, ['t.c']);
}
{
  const { node } = findCmd(ROOT, ['c', 'cpp']);
  const { opts } = splitArgv(node, ['-I', 'a', '-I', 'b', '-D', 'M=1', 'x.c'], err);
  eq('-I 可重复，按顺序攒', opts.get('-I'), ['a', 'b']);
  eq('-D 也进 opts', opts.get('-D'), ['M=1']);
}
{
  const { node } = findCmd(ROOT, ['c', 'run']);
  const { args } = splitArgv(node, ['t.c', '--', '-I', 'not-a-flag'], err);
  eq('-- 之后一律是位置参数', args, ['t.c', '--', '-I', 'not-a-flag']);
}
{
  const { node } = findCmd(ROOT, ['c', 'obj']);
  let msg = null;
  try { splitArgv(node, ['t.c', '-o'], err); } catch (e) { msg = e.message; }
  eq('带值的开关缺值要骂', msg, '-o 后面缺一个值');
}
/* ---- 不认识的开关**直接骂**（分片 4）。从前是「先放过、当 arity 0」，两层代价：
 *      打错名字会悄悄按默认走；带值的不认识时那个**值会被当成一个源文件**。 */
{
  const { node } = findCmd(ROOT, ['c', 'obj']);
  let msg = null;
  try { splitArgv(node, ['t.c', '--bogus'], err); } catch (e) { msg = e.message; }
  eq('不认识的开关要骂，且把认识的列出来',
    msg !== null && msg.startsWith("不认识的开关 '--bogus'；'obj' 认识的是：") && msg.includes('--arch'),
    true);
}
{
  /* 从前这一串会把 `/t` 当成第二个源文件。 */
  const { node } = findCmd(ROOT, ['c', 'obj']);
  let threw = false;
  try { splitArgv(node, ['t.c', '--unknown-with-value', '/t'], err); } catch { threw = true; }
  eq('不认识的带值开关不会把值悄悄变成源文件（骂了）', threw, true);
}
{
  /* 值粘在名字后头 —— tcc 两种写法都收（`-Ifoo`、`-DM=1`、`-UX`），所以我们也收。 */
  const { node } = findCmd(ROOT, ['c', 'cpp']);
  const { args, opts } = splitArgv(node, ['-Ia', '-DM=1', '-UX', 'x.c'], err);
  eq('-I 粘着写', opts.get('-I'), ['a']);
  eq('-D 粘着写', opts.get('-D'), ['M=1']);
  eq('-U 粘着写', opts.get('-U'), ['X']);
  eq('粘着写的值不会变成源文件', args, ['x.c']);
}
{
  /* tcc 的 `-v` 是**数出来**的（`-vvv` 也合法），而表里只列到 `-vv`。 */
  const { node } = findCmd(ROOT, ['c', 'cpp']);
  const { args } = splitArgv(node, ['-vvv', 'x.c'], err);
  eq('-vvv 在 cpp 上认得（tcc 的 -v 是数出来的）', args, ['x.c']);
}

/* ---- 别名铺平。 */
{
  const { node } = findCmd(ROOT, ['c', 'obj']);
  eq('-f 铺成 --format', canonicalize(node, ['-f', 'elf', 't.c']), ['--format', 'elf', 't.c']);
}
{
  /* 要紧的一格：`omni c cpp -v` 是 **tcc 的** -v（印搜索路径），不是 omni 的 --verbose。
   * 铺平成 --verbose 之后 `tests/c/run.js` 的 `inc/01-include -v` 那一条会红。 */
  const { node } = findCmd(ROOT, ['c', 'cpp']);
  eq('cpp 的 -v 不动', canonicalize(node, ['-v', 'x.c']), ['-v', 'x.c']);
  eq('cpp 自己认领了 -v', ownsVerbose(node), true);
}
{
  const { node } = findCmd(ROOT, ['run']);
  eq('别的命令上 -v 还是 --verbose', canonicalize(node, ['-v']), ['--verbose']);
  eq('run 没认领 -v', ownsVerbose(node), false);
}
{
  const { node } = findCmd(ROOT, ['c', 'run']);
  eq('-- 之后不铺平', canonicalize(node, ['t.c', '--', '-f']), ['t.c', '--', '-f']);
}

/* ---- --help 每一级都有，而且组与叶子印出来的形状不同。 */
{
  const top = renderHelp(ROOT, []);
  const has = (s) => top.includes(s);
  eq('顶层清单里有那几个动词', [has('  run '), has('  emit '), has('  c ')], [true, true, true]);
  eq('顶层清单里**没有**旧的扁平名', [has('run-c'), has('c-obj'), has('pe-link')], [false, false, false]);
  eq('顶层不该出现 C 特有的开关', [has('-isystem'), has('--image-base')], [false, false]);
}
{
  const { node, path } = findCmd(ROOT, ['c', 'link']);
  const h = renderHelp(node, path);
  eq('c link 的 help 里有 -f 与只对某格式有效的标注',
    [h.includes('--format'), h.includes('（-f macho）'), h.includes('（-f pe）')],
    [true, true, true]);
}
{
  const { node, path } = findCmd(ROOT, ['c']);
  const h = renderHelp(node, path);
  eq('组节点印子命令清单', [h.includes('commands:'), h.includes('  cpp ')], [true, true]);
}

/* ---- 每个叶子都得有 key，每条 LEGACY 都得真的走得通。 */
{
  const bads = [];
  const walk = (n, path) => {
    const kids = n.children ?? [];
    if (kids.length === 0) {
      if (n.key === undefined) bads.push([...path, n.name].join(' '));
      return;
    }
    for (const k of kids) walk(k, [...path, n.name]);
  };
  walk(ROOT, []);
  eq('每个叶子都有 key', bads, []);
}
{
  const bads = [];
  for (const [old] of LEGACY) {
    const r = findCmd(ROOT, old.split(' '));
    if (r.node.key === undefined) bads.push(old);
  }
  eq('LEGACY 里每个旧名都还走得通', bads, []);
}

/* ---- 管线表（决策五）：`--explain` 与 `-v` 是同一份数据的两个渲染。 */
{
  const p = newPlan('c obj', 'c → cpp → MIR → x86_64 → ELF(.o)');
  addStage(p, { phase: 'front', verb: 'cpp', in: 't.c', out: 'tokens' });
  addStage(p, { phase: 'exec', verb: 'exec', in: 'MIR', note: '解释器' });
  eq('摘要行在最前', renderPlan(p).split('\n')[0], 'pipeline  c → cpp → MIR → x86_64 → ELF(.o)');
  eq('有 out 才印箭头（exec 那一格没有产物形态）',
    [renderStage(p, 0).includes('->'), renderStage(p, 1).includes('->')], [true, false]);
  eq('-v 那一路就是同一行加耗时', renderStage(p, 0, 12), `${renderStage(p, 0)}  +12ms`);
}
{
  /* 汉字占两列 —— 不算这一格，带中文的注释会把后面的列顶歪。
   * 注意**不能**拿 `indexOf` 比：那是 UTF-16 码元的位置，汉字算一个 —— 正确的两行在
   * `indexOf` 上本来就差 4（那四个汉字）。要比的是「印出来在第几列」。 */
  const colsOf = (s) => {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      n += (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1;
    }
    return n;
  };
  const p = newPlan('x', 's');
  addStage(p, { phase: 'back', verb: 'write', in: 'x86_64 + 数据三段', out: 'ELF' });
  addStage(p, { phase: 'back', verb: 'read', in: 'abc', out: 'ELF' });
  const at = (i) => { const l = renderStage(p, i); return colsOf(l.slice(0, l.indexOf('->'))); };
  eq('两行的 -> 落在同一个显示列上', at(0), at(1));
}
{
  const p = planForC('c-obj', 't.c', ['t.c'], ['--arch', 'x86_64', '--os', 'win32', '--format', 'elf']);
  eq('win32 目标 + ELF 容器（tcc 的 -c 在所有目标上都写 ELF）',
    [p.summary, renderPlan(p).includes('.rdata')],
    ['c → cpp → MIR → x86_64 → ELF(.o)', true]);
}
{
  const p = planForC('c-obj', 't.c', ['t.c'], ['--arch', 'arm64', '--os', 'osx']);
  eq('osx 上没给 -f 就是 Mach-O', p.summary, 'c → cpp → MIR → arm64 → MACHO(.o)');
}
{
  const p = planForC('c-run', 't.c', ['t.c'], []);
  const last = p.stages[p.stages.length - 1];
  eq('c run 的最后一格是 exec、没有 out', [last.phase, last.out], ['exec', undefined]);
}
{
  const p = planForC('pe-link', 'a.o', ['a.o', 'b.o'], ['--shared']);
  eq('pe-link --shared 是 .dll，且要解导入表', [p.summary, renderPlan(p).includes('idata')],
    ['2×.o → merge → PE（.dll）', true]);
}
eq('C 那张表不认与语言无关的那几条（回 null，由 planForOmni 接）',
  planForC('emit-js', 'a.omni', ['a.omni'], []), null);

/* ---- 与语言无关那几条动词的管线表（分片 4，`plan-omni.js`）。 */
{
  const p = planForOmni('emit-js', 'a.omni', ['a.omni'], []);
  eq('omni → JS', p.summary, 'omni（mixed） → JS');
  const verbs = p.stages.map((s) => s.verb);
  eq('前端 + 检查器 + 摇树都在表上', verbs, ['read', 'parse', 'check', 'prune', 'emit']);
}
{
  /* `--mode` 覆盖扩展名（`.omnid` 本来是 dynamic）。 */
  const p = planForOmni('oir', 'a.omnid', ['a.omnid'], ['--mode', 'static']);
  eq('--mode 压过扩展名', p.summary, 'omni（static） → OIR');
}
{
  /* asy/jnc 多两格：`AST -> 核心方言文本 -> s-expr`。 */
  const p = planForOmni('emit-c', 'a.asy', ['a.asy'], ['--amalgamate']);
  eq('asy 那一路先落到核心方言文本',
    [p.summary, p.stages.map((s) => s.out)],
    ['asy → C', [undefined, 'AST', '核心方言文本', 's-expr', 'OIR', 'OIR', 'C']]);
  eq('--amalgamate 印在那一格上', renderPlan(p).includes('--amalgamate'), true);
}
{
  const p = planForOmni('interp', 'a.omni', ['a.omni'], ['--mir']);
  const last = p.stages[p.stages.length - 1];
  eq('interp --mir 多一格 lower，最后一格是 exec',
    [p.summary, last.phase, last.in], ['omni（mixed） → OIR → MIR → interp', 'exec', 'MIR']);
}
{
  /* `.c` 上的 `check` 走的是 C 那一路（cpp -> MIR + 自检），**没有 OIR 这一层** ——
   * 拿 omni 那一套形态串描述它就是编的。 */
  const p = planForOmni('check', 't.c', ['t.c'], []);
  eq('check 在 .c 上是 C 那一路', [p.summary, p.stages.map((s) => s.verb)],
    ['c → cpp → MIR（自检，不出产物）', ['read', 'cpp', 'lower', 'verify', 'print']]);
}
/* 说不通的那几格宁可回 null 让调用方明说，也不编一条看起来合理的管线出来。 */
eq('emit sx 在 .omni 上说不通（没有「前端 -> 核心方言」那一步）',
  planForOmni('sx', 'a.omni', ['a.omni'], []), null);
eq('emit ast 在 .sx 上说不通（那一路没有 AST）',
  planForOmni('ast', 'a.sx', ['a.sx'], []), null);
eq('run/build 还没覆盖（边走边决定）', planForOmni('run', 'a.omni', ['a.omni'], []), null);

{
  const bads = [];
  for (const [, now] of LEGACY) {
    const toks = now.split(' ').filter((t) => !t.startsWith('-'));
    /* 新名那一栏里的第一段（`run`/`emit`/`c` …）必须真的在树上。 */
    const r = findCmd(ROOT, toks);
    if (r.path.length === 0) bads.push(now);
  }
  eq('LEGACY 里每个新名的头一段都在树上', bads, []);
}

/* ---- tcc 那一层翻译（ADR-0018 决策三）。门拿**同一串 argv** 喂两边，靠的就是它，
 *      所以它自己也得有人称。 */
{
  const r = tccTranslate(['-B', '/t', '-c', 'x.c', '-o', 'x.o'], err);
  /* `-B DIR` 递的是 `--tcc-lib-dir DIR`，**不是** `-isystem DIR/include`：
   * tcc 那边 `{B}/include` 就是自带那一份的位置，给了 `-B` 就没有别的自带头了，
   * 所以它是「换掉」而不是「多一条」。从前翻成 `-isystem` 还有第二个毛病 ——
   * `c-obj` 那条路根本不读 `-isystem`，于是 `-B` 在 `-c` 上整个丢了
   * （ADR-0017 第一百三十九片量的就是这一格）。 */
  eq('-c 翻成 c-obj，-B 递成 --tcc-lib-dir（换掉自带的系统头，不是多一条 -isystem）',
    [r.key, r.argv],
    ['c-obj', ['x.c', '-o', 'x.o', '--tcc-lib-dir', '/t',
      '--arch', 'arm64', '--os', 'osx', '--format', 'elf']]);
}
{
  /* `-D` 与 `-U` 按**命令行次序**走 —— 攒成「先所有 -D 再所有 -U」就把
   * `-DA=1 -UA` 与 `-UA -DA=1` 弄成一回事了（`tests/c/dm-order.js` 称的那一格）。 */
  const head = (a) => {
    const v = tccTranslate([...a, '-E', 'x.c'], err).argv;
    const i = v.findIndex((t) => t.startsWith('--'));
    return i < 0 ? v : v.slice(0, i);
  };
  eq('-D/-U 保住命令行次序（正）', head(['-DA=1', '-UA']), ['x.c', '-D', 'A=1', '-U', 'A']);
  eq('-D/-U 保住命令行次序（反）', head(['-UA', '-DA=1']), ['x.c', '-U', 'A', '-D', 'A=1']);
}
{
  let msg = '';
  try { tccTranslate(['-c', 'x.c', '-zzz'], err); } catch (e) { msg = e.message; }
  eq('不认识的开关直接骂（不像别处那样放过）', msg.includes("不认识的开关 '-zzz'"), true);
}
{
  /* `-v` 是数出来的（tcc 的 `do ++verbose; while (*optarg++ == 'v')`），不是查表。 */
  const r = tccTranslate(['-E', 'x.c', '-vv'], err);
  eq('-vv 数成两个 -v', r.argv.filter((t) => t === '-v').length, 2);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
