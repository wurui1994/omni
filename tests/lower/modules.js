#!/usr/bin/env node
// tests/lower/modules.js —— **旁边那几份同语言的文件真的读进来**（公共降级器这条路，ADR-0044）
//
// 规则只有一条，而且刻意不搜索（与 ADR-0009 那套模块路径同一条纪律）：
// `import x` 里那个 `x`（去掉 `./`）拼上这门语言的后缀，**就在导入方旁边**找；找着就读，
// 找不着照旧交给 adapter（标准库那一格是这么落的：nim 的 `import tables`）。
//
// 这一份判四件事：
//   一、**声明看得见**：`import util` 之后 util 里的 proc / fn 调得动（nim 与 V 各一格）；
//   二、**环不许挂死**：ring1 引 ring2、ring2 又引 ring1（两门语言里都合法）；
//   三、**类型的字段名也看得见**：`Point{3, 4}` 那种位置型字面量要"字段名与顺序"，
//       而 struct 只写在被导入的那份里；
//   四、**读进来了要说出来**：那一行去 stderr，stdout 只归被跑的程序。
//
// 账：这一轴在图那条路上**是红的**（`tests/graph/modules.js` 0/7，go 与 vlang 都报
// `unbound name: square`）—— 公共这条路把它修好了。`--pkgs`（好几个包各自一格模块 +
// 拓扑序）还没接，`drive.js` 明着报，那是 go 那一门的前置（ADR-0044 第四片）。
//
//   node tests/lower/modules.js

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

/** 一份源码跑出来的 stdout 要等于 `want`。 */
function run(what, file, want) {
  const r = omni(['run', join(MODS, file)]);
  const got = (r.stdout ?? '').trim();
  if (r.status !== 0) { bad(what, `rc=${r.status} ${(r.stderr ?? '').slice(0, 300)}`); return; }
  if (got !== want) { bad(what, `要 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`); return; }
  ok(`${what}（${JSON.stringify(want)}）`);
}

/* ---- 一：声明看得见 */
run('nim import util（proc 从旁边那份文件来）', 'main.nim', '49\n42');
run('vlang import util（fn 从旁边那份文件来）', 'vmain.v', '81');

/* ---- 二：环不许挂死（读过的不再读） */
run('nim 互相 import（A 引 B、B 引 A）不挂死', 'ring1.nim', '3');

/* ---- 三：类型的字段名也看得见（位置型字面量） */
run('vlang import 之后看得见对方的 struct', 'vshape.v', '12');

/* ---- 四：标准库那一格照旧交给 adapter（`import tables` 旁边没有那份文件） */
{
  const r = omni(['run', join(ROOT, 'ext', 'nim', 'examples', 'dict.nim')]);
  const s = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 0 && !s.includes('import 进来的同语言文件')) {
    ok('标准库那一格照旧：import tables 交给 adapter，不去找文件');
  } else bad('标准库那一格该照旧', `rc=${r.status} ${s.slice(0, 300)}`);
}

/* ---- 五：读进来了要**说出来**（那一行去 stderr，stdout 归被跑的程序） */
{
  const r = omni(['run', join(MODS, 'main.nim')]);
  if ((r.stderr ?? '').includes('util.nim') && (r.stdout ?? '').trim() === '49\n42') {
    ok('读进来的文件印在 stderr 上（stdout 只有程序自己的输出）');
  } else bad('该在 stderr 上说读了谁', `stderr=${(r.stderr ?? '').slice(0, 200)}`);
}

/* ---- 六：`--pkgs` 那一格**明着报**（不假装） */
{
  const r = omni(['run', join(MODS, 'main.nim'), '--pkgs', 'x']);
  if (r.status !== 0 && `${r.stderr ?? ''}`.includes('--pkgs')) {
    ok('--pkgs 还没接 —— 有名有姓地报，不假装');
  } else bad('--pkgs 该明着报', `rc=${r.status} ${(r.stderr ?? '').slice(0, 200)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed（旁边那几份同语言的文件）\n`);
process.exit(fail === 0 ? 0 : 1);
