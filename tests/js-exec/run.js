#!/usr/bin/env node
// Omni — JS 程序的端到端对照测试（第五条测试轴）
//
// 前四条轴测的是"op 的语义对不对"（tests/oir 手搭 OIR）与"Omni 侧的语义"。这一条测
// 的是**降级器**：一段真的 JS 源码，node 跑一遍当参照，再经 frontend-js/parser.js ->
// lower.js -> 两个后端各跑一遍，三方的 stdout 必须逐字节相同。
//
//   node tests/js-exec/run.js
//   node tests/js-exec/run.js loop     只跑名字含 loop 的用例
//
// 用例是 cases/*.js，每个都是能直接被 node 执行的普通脚本（只用 lower.js 支持的那部分
// JS，见 ADR-0011）。输出一律用 console.log(单个字符串)。

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mixedRunner } from '../lib/incr.js';
import { Diagnostics } from '../../src/core/source/diag.js';
import { linkJs } from '../../src/core/frontend-js/link.js';
import { lowerJs } from '../../src/core/frontend-js/lower.js';
import { emitJs } from '../../src/core/backend-js/emit.js';
import { emitC } from '../../src/core/backend-c/emit.js';
import { runtimeSources, RUNTIME_DIR } from '../../src/core/runtime/c_runtime.js';
import { FULL_LEGS } from '../lib/legs.js';

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
/* node 那几次走 RunCache（只记依赖、不缓存，ADR-0023 的 S7）：轴级指纹要"这一趟装了哪些
   模块"这一份 —— 不然改 jnc / asy 的前端会把这条 184s 的轴带着重跑。clang 与编出来的
   可执行文件照旧原样跑。 */
const { cache, run } = mixedRunner('js-exec');

const dir = workDir('jsexec');
const cc = ['clang', 'cc', 'gcc'].find((x) => run('which', [x]).code === 0);
const cases = readdirSync(join(here, 'cases')).filter((f) => f.endsWith('.js')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

let pass = 0;
let fail = 0;
const failures = [];
// C 那条腿整条走不了的那些（ADR-0020 P1-c 之前）。不算失败，但末尾要报出来。
const skipC = [];

for (const file of cases) {
  const name = basename(file, '.js');
  const path = join(here, 'cases', file);

  const ref = run(process.execPath, [path]);
  if (ref.code !== 0) {
    fail++;
    failures.push(`${name}\n    node itself failed:\n${ref.err}`);
    process.stdout.write(`  FAIL ${name} (node)\n`);
    continue;
  }

  // 单文件的用例也走链接器：没有 import 的话结果就是它自己（ADR-0011 落地 6e）
  const diags = new Diagnostics();
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  const ast = linkJs(path, read, diags);
  const mod = diags.hasErrors() ? null : lowerJs(ast, diags);
  if (diags.hasErrors()) {
    fail++;
    failures.push(`${name}\n    lowering failed:\n${diags.format()}`);
    process.stdout.write(`  FAIL ${name} (lower)\n`);
    continue;
  }

  const jsPath = join(dir, `${name}.mjs`);
  writeFileSync(jsPath, emitJs(mod));
  const viaJs = run(process.execPath, [jsPath]);

  const cPath = join(dir, `${name}.c`);
  /* C 那条腿可能**整条走不了**：ADR-0020 P1 的真对象/Symbol 那一族现在只有 JS 侧的实现
   * （`hir/js_abi.js` 的 P1_JS_ONLY），发射器在那时候当场抛。这不是"这个用例坏了"，
   * 是"这条腿还没修完"—— 所以标成 skip-c 并在末尾报一行，而不是记成 FAIL。
   * P1-c 落地之后这一段就该删掉（那时任何抛出都又是真失败了）。 */
  let cText = null;
  let cSkip = null;
  try {
    cText = emitC(mod);
  } catch (e) {
    if (!String(e.message).includes('ADR-0020 P1-c')) throw e;
    cSkip = e.message;
  }
  let viaC = { out: ref.out, err: '', code: 0 };
  if (cText !== null) {
    writeFileSync(cPath, cText);
    const exe = join(dir, `${name}.out`);
    const build = run(cc, ['-std=c99', '-O1', '-pthread', `-I${RUNTIME_DIR}`, cPath, ...runtimeSources(), '-o', exe, '-lm']);
    viaC = build.code === 0 ? run(exe, []) : { out: '', err: build.err, code: build.code };
  } else {
    skipC.push(name);
  }

  /* 后两条腿平时不跑（tests/lib/legs.js 那条规矩，`OMNI_LEGS=all` 跑齐）：这条轴的判分人是
     **node 自己**，`omni-js` 与 `omni-c` 那两条已经把"我们跑出来的字节等于 node 的"钉住了；
     解释器那两条盯的是"腿与腿分叉"，留给提交前那一遍。
     第三条腿：自己的执行器（ADR-0013）。同一段 JS，同一棵 OIR，解释一遍 —— 参照还是 node。
     走 CLI 而不是在进程内 new Interp：解释器的输出缓冲、退出码、uncaught 都在那条路上。
     第四条腿：MIR 上的闭包编译解释器（ADR-0014 决策 7）。同一棵 OIR 再往下降一层。
     它与上一条的差别不是"换个写法"：求值顺序、短路的落法、循环层数都在 MIR 里被钉死了，
     而槽位取代了作用域链 —— 两条给出同一串字节，才说明那一层降级没有偷偷改语义。 */
  const viaI = FULL_LEGS
    ? run(process.execPath, [join(here, '../../src/core/cli.js'), 'interp', path]) : null;
  const viaM = FULL_LEGS
    ? run(process.execPath, [join(here, '../../src/core/cli.js'), 'interp', path, '--mir']) : null;

  const okJs = viaJs.code === 0 && viaJs.out === ref.out;
  const okC = viaC.code === 0 && viaC.out === ref.out;
  const okI = viaI === null || (viaI.code === 0 && viaI.out === ref.out);
  const okM = viaM === null || (viaM.code === 0 && viaM.out === ref.out);
  if (okJs && okC && okI && okM) {
    pass++;
    const n = ref.out === '' ? 0 : ref.out.replace(/\n$/, '').split('\n').length;
    const legs = FULL_LEGS ? 'node == omni-js == omni-c == interp == interp-mir'
      : 'node == omni-js == omni-c';
    process.stdout.write(`  ok   ${name} [${legs}] ${n} lines\n`);
    continue;
  }
  fail++;
  const show = (label, r) => (r === null ? '' : `    ${label} exit=${r.code}\n${r.out}${r.err ? `    stderr: ${r.err}` : ''}`);
  failures.push(`${name}\n    node    exit=${ref.code}\n${ref.out}${show('omni-js', viaJs)}${show('omni-c ', viaC)}${show('interp ', viaI)}${show('interp-mir', viaM)}`);
  process.stdout.write(`  FAIL ${name}\n`);
}

const rep = cache.report();
process.stdout.write(`\n${pass} passed, ${fail} failed${rep === '' ? '' : `  （${rep}）`}\n`);

if (skipC.length) {
  process.stdout.write(`（C 那条腿跳过 ${skipC.length} 个：${skipC.join(' ')}`
    + ' —— 真对象/Symbol 那一族还没有 C 实现，见 ADR-0020 P1-c）\n');
}
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
