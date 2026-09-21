// tests/sexpr/modules.js —— 模块（ADR-0042 第一步）**报错那一面**的判据
//
// 正面（几个模块拼起来能跑）在 `cases/52-modules.sx`，走五条腿比 stdout。
// 这一份判的是**拒绝**：边界的价值全在"说不通的时候说人话"，所以每条都核那句话本身。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'omni-mods-'));
let pass = 0;
let fail = 0;

/** 写一份 `.sx`、跑一趟、要它**非零退出**且那句话里有 `want`。 */
function refuses(name, text, want) {
  const p = join(dir, `${name}.sx`);
  writeFileSync(p, text);
  const r = spawnSync('node', [cli, 'run', p], { encoding: 'utf8', timeout: 60000 });
  const say = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && say.includes(want)) { pass++; console.log(`  ok   ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}\n       退出码 ${r.status}\n       说的是：${say.trim().split('\n')[0]}\n       要它提到：${want}`);
}

console.log('sexpr/modules（模块的边界）');

refuses('未导出', `(module util
  (fn twice ((x int)) int (ret (bin "*" (var x) (int 2)))))
(module app
  (import util (twice))
  (main (print (call twice (int 21)))))
`, "模块 'util' 没有导出 'twice'");

refuses('没有那个模块', `(module app
  (import nope (f))
  (main (print (int 1))))
(module other (export g) (fn g () int (ret (int 0))))
`, "没有模块 'nope'");

refuses('导出了但没有这条声明', `(module util (export ghost))
(module app
  (import util (ghost))
  (main (print (int 1))))
`, "但里头没有这条声明");

refuses('一个声明两个家', `(module util
  (export twice)
  (fn twice ((x int)) int (ret (bin "*" (var x) (int 2)))))
(module app
  (import util (twice))
  (fn twice ((x int)) int (ret (var x)))
  (main (print (call twice (int 1)))))
`, '一个声明只能有一个家');

refuses('模块成环', `(module a
  (export f)
  (import b (g))
  (fn f ((x int)) int (ret (call g (var x)))))
(module b
  (export g)
  (import a (f))
  (fn g ((x int)) int (ret (call f (var x))))
  (main (print (int 0))))
`, '模块成环');

refuses('两个 main', `(module a (main (print (int 1))))
(module b (main (print (int 2))))
`, '一份程序只有一个入口');

refuses('几个模块但没名字', `(module (fn f () int (ret (int 1))))
(module (main (print (int 2))))
`, '每个都要名字');

/* C 那条腿**按模块编译**（docs/design/build-system.md §12 末节）。
 * 判的是三件机制，不是图也不是字节数：
 *   1. 模块数对（归属这一格真落到了每条声明上）
 *   2. include 图 = 依赖图：`P` 按值嵌了 `V`，所以 shape.h 引 geom.h；
 *      app 只引它真叫到的那两家；一份公用头都没有
 *   3. 每一份 `.c` **单独**过我们自己的 C 前端都编得过（头是自洽的）
 * 链起来答案不变那一格验过（同一堆 `.o` + 运行时那 21 份，见文档），这儿不做：
 * 它要 rt 暖存目录在，那是构建的事、不是这条轴的事。 */
function ok(name, cond, why = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}${why ? `\n       ${why}` : ''}`);
}

console.log('\nsexpr/modules（C 那条腿：头按依赖切）');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, 'cases', '53-modtypes.sx');
  const work = join(dir, 'split');
  const r = spawnSync('node', [cli, 'emit', 'c', src, '--modules', '--work', work],
    { encoding: 'utf8', timeout: 120000 });
  const got = (nm) => { try { return readFileSync(join(work, nm), 'utf8'); } catch { return null; } };
  ok('四个模块各一份 .c/.h', r.status === 0
    && ['app', 'shape', 'geom', 'tally'].every((n) => got(`${n}.c`) !== null && got(`${n}.h`) !== null),
    `退出码 ${r.status}：${(r.stderr ?? '').trim().split('\n').slice(-1)[0]}`);
  ok('没有公用头', got('_decl.h') === null && got('_shared.c') === null && got('omni_types.h') === null);
  const sh = got('shape.h') ?? '';
  const ap = got('app.h') ?? '';
  const apc = got('app.c') ?? '';
  ok('按值嵌套 -> shape.h 引 geom.h', sh.includes('#include "geom.h"'));
  ok('app 只引它叫到的那两家', !ap.includes('geom.h') && apc.includes('shape.h') && apc.includes('tally.h'));
  ok('模块级变量只定义一份', (got('tally.h') ?? '').includes('extern int64_t g_hits;')
    && (got('tally.c') ?? '').includes('\nint64_t g_hits;'));
  ok('main 归入口那一家', apc.includes('int main(int argc, char **argv)'));
  for (const n of ['omni_gen', 'geom', 'shape', 'tally', 'app']) {
    const o = spawnSync('node', [cli, 'c', 'obj', join(work, `${n}.c`), '-o', join(work, `${n}.o`),
      '--arch', 'arm64', '--os', 'osx', '-f', 'elf', '-I', 'src/runtime'],
      { encoding: 'utf8', timeout: 120000, cwd: join(here, '..', '..') });
    ok(`${n}.c 单独编得过`, o.status === 0, (o.stderr ?? '').trim().split('\n').slice(-1)[0]);
  }
}

/* `(unit "…")`：归属标记，**不改可见性**（asy 那样名字全局平铺的前端要的就是它）。
 * 判两件事：跨"单元"直接叫得到（没有 import 也能用），而 C 那条腿按它切成两份。 */
{
  const p = join(dir, 'unitmark.sx');
  writeFileSync(p, `(module
  (unit "src/one.sx")
  (fn twice ((x int)) int (ret (bin "*" (var x) (int 2))))
  (unit "src/two.sx")
  (main (print (call twice (int 21)))))
`);
  const r = spawnSync('node', [cli, 'run', p], { encoding: 'utf8', timeout: 60000 });
  ok('(unit …) 不改可见性', r.status === 0 && (r.stdout ?? '').trim() === '42',
    `退出码 ${r.status}：${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0]}`);
  const work2 = join(dir, 'unitsplit');
  const e = spawnSync('node', [cli, 'emit', 'c', p, '--modules', '--work', work2],
    { encoding: 'utf8', timeout: 120000 });
  const has = (nm) => { try { return readFileSync(join(work2, nm), 'utf8'); } catch { return null; } };
  ok('两份源文件各出一份 .c', e.status === 0 && has('src_one.c') !== null && has('src_two.c') !== null,
    (e.stderr ?? '').trim().split('\n').slice(-1)[0]);
  ok('main 归第二家', (has('src_two.c') ?? '').includes('int main('));
  ok('叫到第一家 -> src_two.c 引 src_one.h',
    (has('src_two.c') ?? '').includes('#include "src_one.h"'));
}

/* 两种模式**输出必须一样**（单体那条路是对照腿，不许废）：`--modules` 与 `--one-file`
 * 出来的是两份不同的 C、两个不同的二进制，答案得一个字节都不差。 */
{
  const src = join(dirname(fileURLToPath(import.meta.url)), 'cases', '53-modtypes.sx');
  const one = spawnSync('node', [cli, 'run', src, '--backend', 'c', '--one-file'],
    { encoding: 'utf8', timeout: 120000 });
  const mod = spawnSync('node', [cli, 'run', src, '--backend', 'c', '--modules'],
    { encoding: 'utf8', timeout: 120000 });
  ok('单体与按模块同一个答案', one.status === 0 && mod.status === 0
    && one.stdout === mod.stdout && (one.stdout ?? '').trim() === '14\n2',
    `单体 ${one.status}：${JSON.stringify(one.stdout)}；按模块 ${mod.status}：${JSON.stringify(mod.stdout)}`);
}

/* **自足的一份模块**（跨文件模块化那条路的发射单位）：`.h` 只有接口、`.c` 装实现。
 * 这一格先在"整份当一个模块"上验形状 —— 编得过、答案不变，那 iface/impl 这条线就切对了。 */
{
  const src = join(dirname(fileURLToPath(import.meta.url)), 'cases', '01-core.sx');
  const work = join(dir, 'modfile');
  const e = spawnSync('node', [cli, 'emit', 'c', src, '--module-files', '--work', work],
    { encoding: 'utf8', timeout: 120000 });
  const rd = (nm) => { try { return readFileSync(join(work, nm), 'utf8'); } catch { return null; } };
  const h = rd('01-core.h');
  const c = rd('01-core.c');
  ok('自足模块出 .h + .c', e.status === 0 && h !== null && c !== null,
    (e.stderr ?? '').trim().split('\n').slice(-1)[0]);
  ok('.h 只有接口（没有模板与函数体）', (h ?? '').includes('#ifndef OMNI_U_')
    && !(h ?? '').includes('static const uint16_t') && !(h ?? '').includes('omni_new_S_')
    && !(h ?? '').includes('omni_str_new('));
  ok('.c 先 include 自己的 .h', (c ?? '').startsWith('#include "01-core.h"'));
  const o = spawnSync('node', [cli, 'c', 'obj', join(work, '01-core.c'), '-o', join(work, 'm.o'),
    '--arch', 'arm64', '--os', 'osx', '-f', 'elf', '-I', 'src/runtime', '-I', work],
    { encoding: 'utf8', timeout: 120000,
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..') });
  ok('自足模块过我们自己的 C 前端', o.status === 0, (o.stderr ?? '').trim().split('\n').slice(-1)[0]);
}

/* **改一个字符不许有大量浪费**：asy 的方言本来就是按文件的模块 —— 改自己那一份只该重降
 * **自己**，不该把库重新词法一遍、也不该再发一整棵树（量到过：改一个字符照旧
 * `asy front end … 1657174 bytes`）。
 *
 * 判据就用 `-v` 那几行（它本来是给人看的账，拿它当判据不必另造插桩）：
 *   - `核心方言 N bytes`：N 是**自己那一份**的量级（几 KB），不是整棵树（1.6 MB）
 *   - `asy c 模块 新编 1 份`：只有自己那一份重发
 *   - `c obj 这一趟编了 1 格`：只有自己那一份重编
 *   - 库的 `.asy` 一份都不再词法
 * 这几条里破一条，就是"每趟重做一遍整棵树"回来了。 */
{
  const p = join(dir, 'waste.asy');
  const run = (v) => spawnSync('node', [cli, 'run', p, '--backend', 'c', ...(v ? ['-v'] : [])],
    { encoding: 'utf8', timeout: 180000 });
  writeFileSync(p, 'int a = 17, b = 5;\nwrite(a + b);\n');
  const warm = run(false);              // 暖机：库那几份落进缓存
  writeFileSync(p, 'int a = 19, b = 5;\nwrite(a + b);\n');
  const r = run(true);
  const log = `${r.stderr ?? ''}${r.stdout ?? ''}`;
  const line = (re) => (re.exec(log) ?? ['<没有这一行>'])[0];
  ok('改一个字符：答案还对', r.status === 0 && (r.stdout ?? '').trim() === '24',
    `暖机 ${warm.status}；这趟 ${r.status}：${JSON.stringify((r.stdout ?? '').slice(0, 60))}`);
  const fe = /核心方言 (\d+) bytes/.exec(log);
  ok('改一个字符：只降自己那一份的方言', fe !== null && Number(fe[1]) < 100000,
    `发了 ${fe === null ? '?' : fe[1]} bytes（要几 KB 的量级）`);
  ok('改一个字符：只重发一份模块', /asy c 模块\s+新编 1 份/.test(log), line(/asy c 模块.*/));
  ok('改一个字符：只重编一格 .o', /这一趟编了 1 格/.test(log), line(/c obj.*/));
  ok('改一个字符：库不再词法一遍', !/asy lexer.*src\/lib\/asy/.test(log),
    line(/asy lexer.*src\/lib\/asy.*/));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
