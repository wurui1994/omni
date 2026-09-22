#!/usr/bin/env node
/* **同目录下的同语言文件真的读进来**（第一百五十一片第二格）：借用第一档要的第一步。
 *
 * 从前 `import` 那一行在三门语言的映射里都是 `return []` —— **静默丢掉**。标准库那几格
 * （`import tables` / `import "fmt"`）本来就该丢（节点与内建接住了它们），可**本地文件**
 * 也一起丢了，于是"用它们的库"这句话在多文件上根本不成立。
 *
 * 现在的规则只有一条，而且刻意不搜索（与 ADR-0009 那套模块路径同一条纪律）：
 * `import x` 里那个 `x`（去掉 `./`）拼上这门语言的后缀，**就在导入方旁边**找；找着就读，
 * 找不着照旧交给映射。所以这一格不改变任何现有例子（判据在 `tests/graph/run.js`）。
 *
 * 这一份判三件事（**nim 那几格退场了**：那门语言 2026-09-22 迁到公共降级器，图这一层
 * 不再有它，ADR-0044。它的三格判据里"环不许挂死"的夹具是 nim 独有的，跟着一起走 ——
 * 多文件这件事在新那条路上还没接（`drive.js` 明着报），账记在 ADR-0044 里）：
 *   一、两门语言（go / vlang）各读进来一份本地文件，答案对；
 *   二、**两条腿一致**：interp 与 js 后端跑出来的字节相同（借用不该只在一条腿上成立）；
 *   三、**标准库那一格照旧**：`import "fmt"` 仍旧被映射接住（不许被这一刀带坏）。
 *
 *   node tests/graph/modules.js
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const MODS = join(HERE, 'mods');

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };

const omni = (args) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 120000, maxBuffer: 8 << 20,
});

/** 一份源码在**两条腿**上跑，都要等于 `want`（interp 与 js）。 */
function bothLegs(what, path, want) {
  for (const back of ['interp', 'js']) {
    const r = omni(['run', path, '--engine', 'graph', '--backend', back]);
    const got = (r.stdout || '').trim();
    if (r.status !== 0) {
      bad(`${what}（${back}）`, `rc=${r.status} ${(r.stderr || '').slice(0, 300)}`);
      return;
    }
    if (got !== want) {
      bad(`${what}（${back}）`, `要 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`);
      return;
    }
  }
  ok(`${what}（interp 与 js 两条腿都对：${JSON.stringify(want)}）`);
}

/* ---- 一 & 二：还在图上的那一门（go）读一份本地文件，两条腿都对。
   vlang 那三格跟着它迁到公共降级器一起走了（ADR-0044，2026-09-22）——
   夹具（vmain.v / util.v / vshape.v / shape.v）也删了。 */
bothLegs('go import "./util"', join(MODS, 'gmain.go'), '64');

/* ---- 三：**环不许挂死**那一格**退场了**：夹具（ring1.nim / ring2.nim）是 nim 独有的，
   而 nim 迁到公共降级器之后图这一层没有它了（ADR-0044）。go 与 vlang 那边没有对应的夹具，
   不现编一份 —— 这一族判据跟着图那一层一起走。 */

/* ---- 三之二：**声明也要看得见**那一格也跟着 vlang 走了（夹具是 vshape.v / shape.v）。
   go 那边位置型字面量的字段名来自 `type` 声明，判据在 `tests/graph/run.js` 的 posinit 那一族。 */

/* ---- 四：标准库那一格照旧被映射接住（`import "fmt"` 不该被这一刀带坏）。
   从前这一格点的是 `ext/nim/examples/dict.nim`（`import tables`）—— nim 迁走了，
   换成还在图上的 go，判的是同一件事：**旁边没有那份文件时，import 交给映射**。 */{
  const p = join(ROOT, 'ext', 'go', 'examples', 'basics.go');
  const r = omni(['run', p, '--engine', 'graph']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && !s.includes('import 进来的同语言文件')) {
    ok('标准库那一格照旧：import "fmt" 交给映射，不去找文件');
  } else bad('标准库那一格该照旧', `rc=${r.status} ${s.slice(0, 300)}`);
}

/* ---- 五：读进来了要**说出来**（那一行去 stderr，stdout 归被跑的程序） */{
  const r = omni(['run', join(MODS, 'gmain.go'), '--engine', 'graph']);
  if ((r.stderr || '').includes('util.go') && (r.stdout || '').trim() === '64') {
    ok('读进来的文件印在 stderr 上（stdout 只有程序自己的输出）');
  } else bad('该在 stderr 上说读了谁', `stderr=${(r.stderr || '').slice(0, 200)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed（同语言本地文件 import）\n`);
process.exit(fail === 0 ? 0 : 1);
