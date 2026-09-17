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
 * 这一份判四件事：
 *   一、三门语言（go / nim / vlang）各读进来一份本地文件，答案对；
 *   二、**两条腿一致**：interp 与 js 后端跑出来的字节相同（借用不该只在一条腿上成立）；
 *   三、**环不许挂死**：nim 的 A 引 B、B 引 A（两门语言里都合法）；
 *   四、**标准库那一格照旧**：`import tables` 仍旧被映射接住（不许被这一刀带坏）。
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

/* ---- 一 & 二：三门语言各读一份本地文件，两条腿都对 */
bothLegs('nim import util（proc 从旁边那份文件来）', join(MODS, 'main.nim'), '49\n42');
bothLegs('go import "./util"', join(MODS, 'gmain.go'), '64');
bothLegs('vlang import util', join(MODS, 'vmain.v'), '81');

/* ---- 三：环不许挂死（读过的不再读） */
bothLegs('nim 互相 import（A 引 B、B 引 A）不挂死', join(MODS, 'ring1.nim'), '3');

/* ---- 三之二：**声明也要看得见**（不只是名字能连上）。
   `Point{3, 4}` 那种位置型字面量要"字段名与顺序"，而 struct 只写在被导入的那份里。
   落地这一格时漏掉的正是这一半：读进来了，可每份文件的映射各扫各的声明，于是导入方
   照旧报"声明不在这一份文件里"。现在一起编的那几份互相看得见声明（`opts.also`）。 */
bothLegs('vlang import 之后**看得见对方的 struct**（位置型字面量的字段名）',
  join(MODS, 'vshape.v'), '12');

/* ---- 四：标准库那一格照旧被映射接住（`import tables` 不该被这一刀带坏） */{
  const p = join(ROOT, 'ext', 'nim', 'examples', 'dict.nim');
  const r = omni(['run', p, '--engine', 'graph']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  /* 它 `import tables`，而 `tables.nim` 不在旁边 —— 所以那一行照旧交给映射（Table 落成
     map 那四格节点）。**顺带判一句**：不许印出"import 进来的同语言文件"。 */
  if (r.status === 0 && !s.includes('import 进来的同语言文件')) {
    ok('标准库那一格照旧：import tables 交给映射，不去找文件');
  } else bad('标准库那一格该照旧', `rc=${r.status} ${s.slice(0, 300)}`);
}

/* ---- 五：读进来了要**说出来**（那一行去 stderr，stdout 归被跑的程序） */{
  const r = omni(['run', join(MODS, 'main.nim'), '--engine', 'graph']);
  if ((r.stderr || '').includes('util.nim') && (r.stdout || '').trim() === '49\n42') {
    ok('读进来的文件印在 stderr 上（stdout 只有程序自己的输出）');
  } else bad('该在 stderr 上说读了谁', `stderr=${(r.stderr || '').slice(0, 200)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed（同语言本地文件 import）\n`);
process.exit(fail === 0 ? 0 : 1);
