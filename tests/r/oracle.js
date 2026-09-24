#!/usr/bin/env node
// tests/r/oracle.js —— **R 这条腿的两把尺子**
//
// 一、`omni run x.R` 的 stdout 与本机 `Rscript x.R` **逐字节相同**。
//     这一格与 `tests/lower/run.js` 的 `r+*` 不是同一件事：那边判的是"与别的十一门那几个
//     家族输出一致"（期望值是我们定的一张表），这边判的是"与 R 自己一致"（期望值是 R 给的）。
//     两把尺子都要在 —— 家族表说的是"这一族在各语言之间是同一件事"，Rscript 说的是
//     "我们对 R 的理解没走样"。`Rscript` 不在就整轴跳过（不是失败）。
//
// 二、**那份 `.y` 的漂移守卫**。`ext/r/r.grammar` 的正本是参考树里的
//     `r-source/src/main/gram.y`，而"正本"这句话只有在**它一直读得动**的时候才成立：
//       * `omni glr y gram.y` 转得出来（ADR-0034 的导入器）；
//       * 转出来的那段文本建得出表；
//       * 转出来的**终结符与产生式条数**与我们那一份对得上（差多少、差在哪，明写在
//         `ext/r/r.grammar` 文件头那四处差别里）。
//     参考树不在就跳过这一节。
//
//   node tests/r/oracle.js
//   node tests/r/oracle.js basics      只跑名字里带 basics 的

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REF_ROOT } from '../lib/refsrc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/core/cli.js');
const EXAMPLES = join(ROOT, 'ext/r/examples');
const GRAM_Y = join(REF_ROOT, 'r-source/src/main/gram.y');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };
const skip = (s) => process.stdout.write(`  skip ${s}\n`);

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 << 20 });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const have = (cmd) => spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;

/* ─── 一、逐字节对 Rscript ─────────────────────────────────────────────── */

const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.R')).sort();
if (!have('Rscript')) {
  skip(`oracle：本机没有 Rscript（${files.length} 份例子这一节整格跳过）`);
} else {
  for (const f of files) {
    const label = `oracle/${f.replace(/\.R$/, '')}`;
    if (only.length > 0 && !only.some((x) => label.includes(x))) continue;
    const path = join(EXAMPLES, f);
    const want = run('Rscript', ['--vanilla', path]);
    if (want.code !== 0) {
      no(label, `Rscript 自己就没跑过（退出码 ${want.code}）：${want.err.split('\n')[0]}`);
      continue;
    }
    const got = run(process.execPath, [CLI, 'run', path]);
    if (got.code !== 0) {
      no(label, `omni run 退出码 ${got.code}：${got.err.split('\n').slice(-2).join(' ')}`);
      continue;
    }
    if (got.out !== want.out) {
      no(label, `stdout 不一样\n       Rscript: ${JSON.stringify(want.out)}\n       omni   : ${JSON.stringify(got.out)}`);
      continue;
    }
    ok(`${label} [与 Rscript 逐字节相同，${want.out.length} 字节]`);
  }
}

/* ─── 二、`gram.y` 的漂移守卫 ─────────────────────────────────────────── */

if (only.length > 0 && !only.some((x) => 'gram.y'.includes(x) || x === 'y')) {
  /* 过滤掉了，不印 */
} else if (!existsSync(GRAM_Y)) {
  skip(`gram.y：参考树不在（${GRAM_Y}）`);
} else {
  const conv = run(process.execPath, [CLI, 'glr', 'y', GRAM_Y]);
  if (conv.code !== 0 || !conv.out.includes('(grammar')) {
    no('gram.y 转得出来', `退出码 ${conv.code}：${conv.err.split('\n')[0]}`);
  } else {
    ok(`gram.y 转得出来 [${conv.out.length} 字节 (grammar …)]`);

    const tbl = run(process.execPath, [CLI, 'glr', 'table', GRAM_Y, '--brief']);
    const head = tbl.out.split('\n')[0] ?? '';
    const m = /(\d+) terminals, (\d+) nonterminals, (\d+) rules, (\d+) states/.exec(head);
    if (tbl.code !== 0 || m === null) {
      no('gram.y 建得出表', `退出码 ${tbl.code}：${(tbl.err || head).split('\n')[0]}`);
    } else {
      ok(`gram.y 建得出表 [${m[1]} 终结符 / ${m[3]} 条产生式 / ${m[4]} 状态]`);

      /* 与我们那一份对一遍。**不要求相等** —— 差的那几条正是文件头写着的四处差别：
         `prog` 那 5 条换成 1 条 `program`、多一条 `**`、`cr` 挪了两处位置。
         判据是"差得不多"：产生式条数差 ≤ 6。真的差大了，说明那份 `.y` 改了大动作，
         而这一格就是让人去看它的那句话。 */
      const ours = run(process.execPath, [CLI, 'glr', 'table', 'ext/r/r.grammar', '--brief']);
      const m2 = /(\d+) terminals, (\d+) nonterminals, (\d+) rules, (\d+) states/.exec(ours.out.split('\n')[0] ?? '');
      if (m2 === null) {
        no('r.grammar 建得出表', (ours.err || ours.out).split('\n')[0]);
      } else {
        const d = Math.abs(Number(m[3]) - Number(m2[3]));
        if (d > 6) {
          no('r.grammar 没跟 gram.y 走散', `产生式条数差了 ${d} 条（那份 .y ${m[3]} 条、我们 ${m2[3]} 条）——`
            + '去看 ext/r/r.grammar 文件头那四处差别还对不对');
        } else {
          ok(`r.grammar 没跟 gram.y 走散 [那份 .y ${m[3]} 条、我们 ${m2[3]} 条，差 ${d}]`);
        }
      }
    }
  }
}

/* ─── 三、`NA` 的载荷能存在哪儿 —— **量 V8，不猜** ─────────────────────────────
 *
 * R 的 `NA_real_` 是"带 1954 载荷的 NaN"，所以"这个载荷在哪种存法里活得下来"直接决定
 * R 的向量能用什么表示。这一节不测我们的代码，测的是**这台 V8 的行为** ——
 * 因为它是一条设计约束，而约束不该靠记忆传下去。
 *
 * 量出来的两条（`node tests/r/oracle.js` 会守着它们）：
 *   * `Float64Array` / 普通对象字段 / 局部量：载荷**留得住**；
 *   * **只装 double 的 JS 数组：载荷被抹掉**（V8 的 PACKED_DOUBLE_ELEMENTS 会把 NaN
 *     规范化 —— 那种数组里"洞"本身就是一个特殊 NaN，所以它必须规范化）。
 *
 * 第二条是 R 这一门的硬约束：后端把 `(arr real)` 落成 JS 数组（`$anew` 出 `[]`），
 * 于是**R 的数值向量不能用 `(arr real)`**，得走线性内存（`(ptr real)`，`$pload_r` /
 * `$pstore_r` 是 DataView 的 getFloat64/setFloat64，按位进出）。
 *
 * 这一条是一路量出来的：C 里对 → 按值过 N-API 丢 → 按指针不丢 → 存进 `(arr real)` 又丢。
 * 前三格已经落成 `ext/r/adapter.js` 的 `PTR_REAL` 那段账，这一格落在这儿。
 */
if (only.length === 0 || only.some((x) => 'nanpayload'.includes(x))) {
  const buf = new Float64Array(1);
  const words = new Uint32Array(buf.buffer);
  words[0] = 1954;
  words[1] = 0x7ff80000;
  const NA = buf[0];
  const low = (x) => { const t = new Float64Array(1); t[0] = x; return new Uint32Array(t.buffer)[0]; };

  const keeps = [
    ['Float64Array', () => { const f = new Float64Array(2); f[1] = NA; return f[1]; }],
    ['对象字段', () => { const o = { v: 0.0 }; o.v = NA; return o.v; }],
    ['局部量', () => NA],
    ['混着别的东西的 JS 数组', () => { const g = [1.0, 'x', 3.0]; g[1] = NA; return g[1]; }],
  ];
  for (const [what, f] of keeps) {
    const got = low(f());
    if (got === 1954) ok(`nanpayload/${what} 留得住载荷`);
    else no(`nanpayload/${what}`, `载荷没了（low=${got}）—— 这台 V8 与量的时候不一样了，`
      + 'R 的值该换成这种存法了，去看 ext/r/adapter.js 的 PTR_REAL 那段');
  }
  /* 反过来那一条：**抹掉**才是对的（它是 `(arr real)` 不能用的理由）。
     哪天 V8 不抹了，这一格会红 —— 那时该去掉那条约束，而不是删掉这个判据。 */
  const dbl = [1.0, 0.0, 3.0];
  dbl[1] = NA;
  if (low(dbl[1]) === 1954) {
    no('nanpayload/只装 double 的 JS 数组', '这台 V8 **不再**抹载荷了 ——'
      + ' 那么 R 的向量可以直接用 `(arr real)`，去改 ext/r/adapter.js 那段约束');
  } else {
    ok('nanpayload/只装 double 的 JS 数组 会抹掉载荷（所以 R 的向量不能用 (arr real)）');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（R：对 Rscript + gram.y 漂移守卫 + NaN 载荷）\n`);
process.exit(fail === 0 ? 0 : 1);
