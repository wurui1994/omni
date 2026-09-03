// tests/c/dm-order.js —— `-dD`/`-dM` × `-D`/`-U`：印的是**经过**，不是宏表
// （ADR-0017 第九刀第一百〇八片）
//
// tcc 把预定义 + 命令行上的 `-D`/`-U` 拼成一份源码，压在主文件上面当 `<command line>`
// 那一层读（`tccpp.c:3653-3666`）。`-dD`/`-dM` 的那几行是这些指示**经过时**印的，于是有两件
// 从「印宏表」那个做法里绝对得不到的事：
//
//   * 后来被 `-U` 掉的预定义，照印一遍 `#define` —— 它确实定义过。
//   * 从没定义过的名字，`-UNEVER` 也照印一行 `#undef NEVER` —— 那一条指示确实过去了。
//
// 顺带称两件同一层的事：
//
//   * `-E` 那一路每出一条诊断，stdout 上先落一个**空行**（`error1`，libtcc.c:683）。
//     诊断本身走 stderr，这个换行走 stdout —— 逐字节比 `-E` 输出时它是能看见的。
//   * 于是「该不该响」也进了这根轴：`X redefined` 是无条件响的（`tccpp.c:1262`），
//     而 `multi-character character constant` 只有 `-Wall` 才响（`tccpp.c:2197`）——
//     多响一句就多一个空行，当场抓住。
//
//   node tests/c/dm-order.js

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const OUT = join(tmpdir(), 'omni-dm-order');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (!existsSync(TCC)) {
  process.stdout.write(`  skip 整组：尺子不在（${TCC}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const plain = join(OUT, 'plain.c');
writeFileSync(plain, 'int x;\n');
/* 同一个名字定义两遍，宏体不同 -> 无条件警告；再来一对宏体相同的 -> 一句都不响
 * （`macro_is_equal`：宏名后头那几个空格不进宏体，所以 `T  2` 与 `T 2` 算一样）。 */
const redef = join(OUT, 'redef.c');
writeFileSync(redef, '#define B 1\n#define B 2\n#define T  2\n#define T 2\nint y = B + T;\n');
/* `'ab'` —— tcc 只在 `-Wall` 下才为它响一句。 */
const multi = join(OUT, 'multi.c');
writeFileSync(multi, '#if \'ab\' == 24930\nint z = 1;\n#endif\n');

const runTcc = (args, src) =>
  spawnSync(TCC, ['-B', TCC_DIR, '-E', ...args, src], { encoding: 'utf8', maxBuffer: 1 << 26 });
const runOurs = (args, src) =>
  spawnSync(process.execPath, [CLI, 'cpp', '-E', ...args, src],
    { encoding: 'utf8', maxBuffer: 1 << 26 });

const lines = (t) => t.trimEnd().split('\n').map((l) => `      ${l}`).join('\n');

/** 一组开关：stdout 必须逐字节相同。 */
function sameOut(name, args, src) {
  const r = runTcc(args, src);
  const m = runOurs(args, src);
  if (m.status !== 0) {
    bad(name, `    我们的 cpp 挂了：${(m.stderr ?? '').trim().split('\n')[0]}`);
    return;
  }
  if (m.stdout !== r.stdout) {
    /* 只把不一样的那一段摘出来，免得刷 130 行预定义。 */
    const a = r.stdout.split('\n');
    const b = m.stdout.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    bad(name,
      `    第 ${i + 1} 行起不一样\n`
      + `    tcc :\n${lines(a.slice(i, i + 6).join('\n'))}\n`
      + `    ours:\n${lines(b.slice(i, i + 6).join('\n'))}`);
    return;
  }
  ok(name);
}

/* 1) 被 `-U` 掉的预定义照印、没定义过的名字照印 `#undef`、`-D` 排在最后 —— 全按命令行次序。 */
sameOut('-dM：预定义（含随后被 -U 掉的）+ 按命令行次序的 -U/-D，与 tcc 逐字节相同',
  ['-P', '-dM', '-U__TINYC__', '-U__APPLE__', '-UNEVER', '-DFOO=2'], plain);

/* 2) 同一个名字先 `-D` 再 `-U`：两行都印，次序就是命令行次序（反过来结果也反过来）。 */
sameOut('-dD：-DA=1 -UA 两行都印且次序 = 命令行次序', ['-P', '-dD', '-DA=1', '-UA'], plain);

/* 3) 诊断前那个空行：源文件里重定义一次，`-E` 的 stdout 必须仍与 tcc 逐字节相同。 */
sameOut('-E：源文件里重定义，诊断前那个空行落在同一处', [], redef);
sameOut('-dD + 重定义：空行与 #define 行的先后与 tcc 相同', ['-P', '-dD'], redef);

/* 4) 警告本身（stderr）：该响的响一句、宏体相同的不响。 */
{
  const r = runTcc([], redef);
  const m = runOurs([], redef);
  const clean = (t) => (t ?? '').replace(new RegExp(redef, 'g'), 'redef.c').trim();
  if (clean(m.stderr) !== clean(r.stderr)) {
    bad('重定义警告与 tcc 一字不差（且宏体相同的那一对不响）',
      `    tcc :\n${lines(clean(r.stderr) || '(空)')}\n    ours:\n${lines(clean(m.stderr) || '(空)')}`);
  } else {
    ok(`重定义警告与 tcc 一字不差：${clean(r.stderr) || '(空)'}`);
  }
}

/* 5) `-Wall` 才响的那一类：默认两边都不响，于是 stdout 里也没有那个空行。 */
{
  const r = runTcc([], multi);
  const m = runOurs([], multi);
  const clean = (t) => (t ?? '').trim();
  if (clean(r.stderr) !== '' || clean(m.stderr) !== '') {
    bad('multi-character character constant 默认不响（tcc 那句挂在 warn_all 上）',
      `    tcc :\n${lines(clean(r.stderr) || '(空)')}\n    ours:\n${lines(clean(m.stderr) || '(空)')}`);
  } else {
    ok('multi-character character constant 默认两边都不响（-Wall 才响）');
  }
  sameOut("-E：'ab' 那一行不多出空行，输出与 tcc 逐字节相同", [], multi);
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
