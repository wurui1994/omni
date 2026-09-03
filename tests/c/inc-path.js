// tests/c/inc-path.js —— 驱动层的头目录开关要走到**编译**那条路上
// （ADR-0017 第九刀第一百三十九片）
//
// 从前 `-isystem` 只有 `-E` 那条路认：`c-obj`/`c-mir`/`c-run` 只收 `-I`
// （`cli.js` 里它们的 `sysIncludeDirs` 是写死的 `cSysInclude()`）。于是
// `omni c tcc -c x.c -B DIR` 把 `-B` **整个丢了** —— 而 `-B` 是十几处门给尺子指
// tinycc 源码树用的那一格。`tests/c/run.js` 那一组只称 `-E`，所以一直没红。
//
// 这一门称三件事，两边喂**同一串 argv**（ADR-0018 决策三）：
//
//   1. `-isystem D` 在 `-run`（编译并跑）那条路上生效
//   2. `-B D` 在 `-run` 上生效（tcc 拿它当 `{B}/include`）
//   3. `-B D` 在 `-c`（出目标文件）那条路上生效
//
// 字节层面的比对不在这儿（那是 `tcc-obj.js` 的事）—— 这一门只问「那个目录到没到」。
//
//   node tests/c/inc-path.js

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const OUT = join(tmpdir(), 'omni-inc-path');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (!existsSync(TCC)) {
  process.stdout.write(`  skip 整组：尺子不在（${TCC}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
/* `-B DIR` 找的是 `DIR/include` —— 这一格是 tcc 的形状（`{B}/include`），
 * 所以探针头放在 `libdir/include/` 里，而不是随便一个目录。 */
const LIB = join(OUT, 'libdir');
mkdirSync(join(LIB, 'include'), { recursive: true });
writeFileSync(join(LIB, 'include', 'probe.h'), '#define PROBE_VALUE 37\n');

/* `-run` 那一路要 libtcc1.a 与 runmain.o，它们在构建目录里 —— 于是 `-B` 那一格
 * 在「跑」的用例上不能拿去指别处。所以：`-isystem` 用 `-run`（`-B` 仍指构建目录），
 * 而 `-B` 指探针树的那两条走 `-c`（不跑，不需要运行期那两份）。 */
const src = join(OUT, 'm.c');
writeFileSync(src, '#include <probe.h>\n#include <stdio.h>\n'
  + 'int main(void) { printf("%d\\n", PROBE_VALUE); return PROBE_VALUE; }\n');

const runTcc = (args) => spawnSync(TCC, args, { encoding: 'utf8', maxBuffer: 1 << 24 });
const runOurs = (args) => spawnSync(process.execPath, [CLI, 'c', 'tcc', ...args],
  { encoding: 'utf8', maxBuffer: 1 << 24 });

/** 同一串 argv 喂两边：退出码与 stdout 都要一样。 */
function same(name, args) {
  const w = runTcc(args);
  const g = runOurs(args);
  if (w.status !== 0 && (w.stderr ?? '').includes('error')) {
    bad(name, `    尺子自己就拒了：${(w.stderr ?? '').trim().split('\n')[0]}`);
    return;
  }
  if (g.status !== w.status) {
    bad(name, `    退出码不同：tcc=${w.status} ours=${g.status}\n`
      + `    ours stderr: ${(g.stderr ?? '').trim().split('\n')[0]}`);
    return;
  }
  if (g.stdout !== w.stdout) {
    bad(name, `    stdout 不同：\n    tcc : ${JSON.stringify(w.stdout)}\n`
      + `    ours: ${JSON.stringify(g.stdout)}`);
    return;
  }
  ok(`${name}（退出码 ${w.status}、stdout ${JSON.stringify(w.stdout)}）`);
}

/* 1) `-isystem` 走到「编译并跑」那条路上。这一条从前是红的 —— `c-run` 只收 `-I`。 */
same('-isystem 在 -run（编译并跑）那条路上生效',
  ['-B', TCC_DIR, '-isystem', join(LIB, 'include'), '-run', src]);

/* 2) 同一份源码换成 `-I`：`-I` 那一路一直是通的，这一条是**对照** ——
 *    它绿而上面那条红，就说明问题在「系统头目录」这一格，不在「头目录」整件事。 */
same('-I 在 -run 上生效（与上面那条互为对照）',
  ['-B', TCC_DIR, '-I', join(LIB, 'include'), '-run', src]);

/* 3) `-B DIR` 在 `-c` 那条路上生效 —— tcc 拿 `{B}/include` 当自带的系统头目录。
 *    我们这边它落成 `--tcc-lib-dir DIR`（**换掉** `src/include`，不是多一条 `-isystem`）。 */
{
  const name = '-B DIR 在 -c 那条路上生效（{B}/include 里的头找得到）';
  const mine = join(OUT, 'ours.o');
  const theirs = join(OUT, 'tcc.o');
  const w = runTcc(['-B', LIB, '-c', src, '-o', theirs]);
  const g = runOurs(['-B', LIB, '-c', src, '-o', mine]);
  /* 尺子那边 `-B` 指到探针树上，于是它找不到 `stdio.h` 之外的自带头也无所谓 ——
   * 它照样得编得出来（`stdio.h` 在 SDK 那一段，`-B` 不影响它）。 */
  if (w.status !== 0) {
    bad(name, `    尺子自己就拒了：${(w.stderr ?? '').trim().split('\n').slice(0, 2).join(' / ')}`);
  } else if (g.status !== 0) {
    bad(name, `    我们拒了，尺子没拒：${(g.stderr ?? '').trim().split('\n').slice(0, 2).join(' / ')}`);
  } else if (!existsSync(mine)) {
    bad(name, '    没写出目标文件');
  } else {
    ok(name);
  }
}

/* 4) 反面：不给任何头目录，两边都得找不到 `probe.h`。
 *    没有这一条，上面那几条可能是「我们随便到处找」而不是「那个目录到了」。 */
{
  const name = '一个头目录都不给：两边都找不到 probe.h（上面几条不是「到处乱找」）';
  const w = runTcc(['-B', TCC_DIR, '-c', src, '-o', join(OUT, 'x1.o')]);
  const g = runOurs(['-B', TCC_DIR, '-c', src, '-o', join(OUT, 'x2.o')]);
  if (w.status === 0) bad(name, '    尺子居然编出来了 —— 探针头名字撞上了真头文件？');
  else if (g.status === 0) bad(name, '    我们居然编出来了（说明搜索路比 tcc 宽）');
  else ok(name);
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
