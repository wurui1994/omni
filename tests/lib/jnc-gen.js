#!/usr/bin/env node
// tests/lib/jnc-gen.js —— **生成出来的**那把尺子（位置 × 乘出来的要素）
//
// 与 `jnc-matrix.js` 的分工：
//   jnc-matrix  66 列**手命名**的要素，每一格都在 features/*.js 里声明过 —— 那是**可执行的规格**
//   jnc-gen     301 列**乘出来**的要素（`src/lang/jnc/elements.js` 从 `syntax.js` 那张
//               照 jancy .llk 抄的词汇表里乘），每一格只**量**，不要求先声明 —— 那是**发现器**
//
// 为什么要第二把：手命名那一把再宽也是我数出来的，而"我数出来的"永远漏。这一把的列数
// = 修饰符 27 × 声明符形状（按 on/kind 配对）+ 存储 10 × 形状 + 命名类型 11 + 特殊成员 9 + …
// —— 漏没漏由**乘法**说，不由我说。
//
// 用法：
//   node tests/lib/jnc-gen.js                  全量（301 × 9 = 2709 格，约 6 分钟）
//   node tests/lib/jnc-gen.js --sort fn-body   只量一个位置
//   node tests/lib/jnc-gen.js --group modifier 只量一族要素
//   node tests/lib/jnc-gen.js --top 40         理由榜只印前 40 条

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { elements } from '../../src/lang/jnc/elements.js';
import { SORT_CONTEXT } from '../../src/lang/jnc/syntax.js';
import { SORTS, runOne, prepare, cleanup, root } from './jnc-probe.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const onlySort = arg('--sort');
const onlyGroup = arg('--group');
const top = Number(arg('--top', '30'));
const keep = argv.includes('--keep');

const els = elements().filter((e) => onlyGroup === null || e.group === onlyGroup);
const sorts = SORTS.filter(([s]) => onlySort === null || s === onlySort);

prepare();
const cells = new Map();
const tally = { ok: 0, N: 0, E: 0, syn: 0, crash: 0 };
const t0 = Date.now();
let n = 0;
for (const [sort, wrap] of sorts) {
  for (const e of els) {
    const r = runOne(sort, `gen__${e.name.replace(/[^\w-]/g, '_')}`, wrap(e.src));
    cells.set(`${sort}|${e.name}`, r);
    tally[r.k] += 1;
    n += 1;
  }
  process.stdout.write(`  ${sort.padEnd(18)} ${els.length} 格\n`);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write(`\n位置 ${sorts.length} × 要素 ${els.length} = ${n} 格`
  + `　ok ${tally.ok}、N ${tally.N}、E ${tally.E}、syn ${tally.syn}、炸 ${tally.crash}　${secs}s\n`);

/* **炸**排第一：那是这一层自己的 bug（一条诊断都没有、栈爬出来了）。 */
const crashes = [...cells].filter(([, r]) => r.k === 'crash');
if (crashes.length > 0) {
  process.stdout.write(`\n**炸了 ${crashes.length} 格**（这一层自己的 bug，优先级最高）：\n`);
  for (const [k, r] of crashes.slice(0, 40)) process.stdout.write(`  ${k}　${r.why}\n`);
}

/* 理由榜：同一句话按格数排。E 那一栏最值钱（"我们认为你写错了"，而语料里写着的多半没错）。 */
const byWhy = new Map();
for (const [k, r] of cells) {
  if (r.why === '') continue;
  const key = `${r.k}|${r.why}`;
  const had = byWhy.get(key) ?? { k: r.k, why: r.why, cells: [] };
  had.cells.push(k);
  byWhy.set(key, had);
}
const rows = [...byWhy.values()].sort((a, b) => b.cells.length - a.cells.length);
process.stdout.write(`\n理由榜（${rows.length} 句话，印前 ${Math.min(top, rows.length)} 条）：\n`);
for (const r of rows.slice(0, top)) {
  process.stdout.write(`  ${String(r.cells.length).padStart(4)}  ${r.k}  ${r.why.slice(0, 100)}\n`);
}

/* 落一份表：行是要素、列是位置。这一份是**发现器的账**，不是规格 —— 规格在 features/*.js。 */
const mark = (r) => {
  if (r === undefined) return ' ';
  if (r.k === 'ok') return '✓';
  if (r.k === 'syn') return '·';
  if (r.k === 'crash') return '**炸**';
  return r.k;
};
const md = ['# jancy 的 位置 × **乘出来的**要素（发现器，ADR-0029）', '',
  '这一份是 `node tests/lib/jnc-gen.js` 跑出来的。要素不是手数的，是从 `src/lang/jnc/syntax.js`',
  '（照 jancy 的 .llk 抄的词汇表）**乘出来**的 —— 见 `src/lang/jnc/elements.js`。', '',
  `位置 ${sorts.length} × 要素 ${els.length} = ${n} 格：`
  + `✓ ${tally.ok}、N ${tally.N}、E ${tally.E}、· ${tally.syn}、炸 ${tally.crash}`, '',
  `| 要素 | 组 | 上下文 | ${sorts.map(([s]) => s).join(' | ')} |`,
  `|---|---|---|${sorts.map(() => '---').join('|')}|`];
for (const e of els) {
  const ctx = [...new Set(sorts.map(([s]) => SORT_CONTEXT[s]))].join('/');
  md.push(`| \`${e.name}\` | ${e.group} | ${ctx} | `
    + `${sorts.map(([s]) => mark(cells.get(`${s}|${e.name}`))).join(' | ')} |`);
}
md.push('', '## 理由榜', '');
for (const r of rows) md.push(`- **${r.cells.length}** \`${r.k}\` ${r.why}`);
const doc = join(root, 'docs', 'design', 'jnc-elements.md');
mkdirSync(dirname(doc), { recursive: true });
writeFileSync(doc, `${md.join('\n')}\n`);
process.stdout.write(`\n表：${doc}\n`);
process.stdout.write(`合成的源码：${cleanup(keep)}\n`);
