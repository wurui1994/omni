// tests/cli/tree.js —— 命令树（ADR-0018 决策四）
//
// 这一份只查**机制**：走树、分开关、别名铺平、每一级的 --help。真正跑起来的行为由各语言
// 那几组门管（tests/c/*、tests/run.js）。
//
//   node tests/cli/tree.js

import { findCmd, splitArgv, canonicalize, ownsVerbose, renderHelp } from '../../stage0/src/cli/tree.js';
import { ROOT, LEGACY } from '../../stage0/src/cli/cmds.js';

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

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
