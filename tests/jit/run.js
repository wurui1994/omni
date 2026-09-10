#!/usr/bin/env node
// Omni — ORC JIT（第十四条测试轴，ADR-0014 决策 3 第二阶段）
//
// AOT 那条轴（tests/llvm）钉的是「降得对」。这条钉的是另一件事：**同一份 IR 换一个
// 装载方式，答案不许变**。所以它不重新列支持面，而是直接复用 tests/llvm 那张 SUPPORTED
// 清单 —— 两条轴共用一张表，支持面扩大时只改一处。
//
// 三件事：
//   1. **run-jit == run-llvm == interp == run-c**，stdout / stderr / 退出码都比。
//      错误路径在里面（04_div_zero 走 IR 里的 @omni_ll_div -> omni_error -> 70）。
//      这一条同时是「JIT 出来的代码直接 call 到 C 运行时」的验收：omni_print_int 这些
//      是靠 ORC 的进程符号搜索找到的，一层胶水都没有（ADR-0013 的 C-FFI 主张）。
//   2. **磁盘上不留目标文件**：--work 指一个空目录，跑完里面只该有那份 .ll。
//      这是「运行期不需要 cc」的可观测形式 —— 光看输出对不对区分不了 AOT 和 JIT。
//   3. **降不了的照样拒绝**，理由仍是阶段边界。JIT 与 AOT 共用发射器，
//      所以这条边界必须一模一样，不许某条路悄悄多支持一点。
//
//   node tests/jit/run.js

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED } from '../llvm/supported.js';
/* 4g（会话那一节）直接用编译器的模块降一批 delta —— CLI 上还没有"编一批"这个动词 */
import { CoreSession } from '../../src/core/sexpr/lower.js';
import { Diagnostics } from '../../src/core/source/diag.js';
import { lowerToMir } from '../../src/core/mir/from_oir.js';
import { emitLlvm } from '../../src/core/backend-llvm/emit.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'src', 'core', 'cli.js');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const bad = (label, detail) => {
  fail++;
  failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

function run(args) {
  const r = spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status };
}

// 宿主要先编一次（约 1s，之后是内容寻址缓存命中）。先单独跑一发，
// 这样"环境里没有 libLLVM"和"某份 case 答案不对"不会混成同一条失败。
const probe = run(['run-jit', join(root, 'tests', 'cases', '02_numeric.omni')]);
if (probe.code !== 0 && /llvm-config|libLLVM|jit host/.test(probe.err)) {
  process.stdout.write(`  skip jit axis: ${probe.err.trim().split('\n')[0]}\n`);
  process.stdout.write('\n0 passed, 0 failed (skipped)\n');
  process.exit(0);
}

// ------------------------------------------------- 1. 四方一致

for (const rel of SUPPORTED) {
  const src = join(root, rel);
  const name = basename(rel);
  const jit = run(['run-jit', src]);
  const aot = run(['run-llvm', src]);
  const ip = run(['interp', src]);
  const c = run(['run-c', src]);
  const detail = [];
  if (jit.out !== aot.out) detail.push(`    stdout 与 run-llvm 不同\n      aot ${JSON.stringify(aot.out)}\n      jit ${JSON.stringify(jit.out)}`);
  if (jit.out !== ip.out) detail.push(`    stdout 与 interp 不同\n      interp ${JSON.stringify(ip.out)}\n      jit    ${JSON.stringify(jit.out)}`);
  if (jit.out !== c.out) detail.push(`    stdout 与 omni-c 不同\n      omni-c ${JSON.stringify(c.out)}\n      jit    ${JSON.stringify(jit.out)}`);
  if (jit.code !== aot.code || jit.code !== ip.code || jit.code !== c.code) {
    detail.push(`    退出码不同：jit ${jit.code}, aot ${aot.code}, interp ${ip.code}, omni-c ${c.code}`);
  }
  if (jit.err !== aot.err) detail.push(`    stderr 与 run-llvm 不同\n      aot ${JSON.stringify(aot.err)}\n      jit ${JSON.stringify(jit.err)}`);
  if (detail.length > 0) bad(`four-way/${name}`, detail.join('\n'));
  else ok(`four-way/${name} [jit == aot == interp == omni-c] exit=${jit.code}, ${jit.out.length} bytes`);
}

// ------------------------------------------------- 2. 不落目标文件

const work = workDir('jit-axis');
const r = run(['run-jit', join(root, 'tests', 'cases', '02_numeric.omni'), '--work', work]);
const left = readdirSync(work).sort();
if (r.code !== 0) bad('no-objects', `    run-jit --work exit=${r.code}\n${r.err}`);
else if (left.length !== 1 || left[0] !== 'jit.ll') {
  bad('no-objects', `    工作目录里除了 jit.ll 还有别的：${JSON.stringify(left)} —— 这条路不该产出目标文件`);
} else ok('no-objects [工作目录里只有 jit.ll：运行期没有 cc、没有 .o、没有链接]');

// ------------------------------------------------- 3. 边界与 AOT 完全一致

const others = [];
for (const f of readdirSync(join(root, 'tests', 'cases')).sort()) {
  if (!/\.(omni|omnid|omnis)$/.test(f)) continue;
  const rel = join('tests', 'cases', f);
  if (!SUPPORTED.includes(rel)) others.push(rel);
}
const wrong = [];
let declined = 0;
for (const rel of others) {
  const j = run(['run-jit', join(root, rel)]);
  if (j.code === 0) { wrong.push(`    ${rel} 在 JIT 上居然跑通了 —— 两条路的边界必须一样`); continue; }
  if (!j.err.includes('llvm 后端目前不支持')) wrong.push(`    ${rel} 报错的理由不对：${JSON.stringify(j.err.slice(0, 120))}`);
  else declined++;
}
if (wrong.length > 0) bad('boundary/same-as-aot', wrong.join('\n'));
else ok(`boundary/same-as-aot [${declined} 份 case 被拒，理由与 AOT 同一条]`);

// ------------------------------------------------- 4. 宿主直调那一组（缺符号 / 多入口）
//
// 这两条直接调宿主二进制（`omni-jit FILE.ll`）：走 `run-jit` 进不来，那条路的输入是源码。
// 宿主的位置从缓存里捞 —— 上面那些用例已经把它编好了。J3 会给它一扇正门。
{
  const hosts = [];
  const jitRoot = join(root, '.omni-cache', 'jit');
  try {
    for (const d of readdirSync(jitRoot)) {
      const p = join(jitRoot, d, 'omni-jit');
      if (existsSync(p)) hosts.push(p);
    }
  } catch { /* 没这个目录就是没编过，下面按 skip 处理 */ }
  if (hosts.length === 0) {
    process.stdout.write('  skip 宿主直调那一组：缓存里找不到 omni-jit 宿主\n');
  } else {
    const host = hosts.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    const tmp = mkdtempSync(join(tmpdir(), 'omni-jit-'));

    /* 4a 缺符号：ADR-0022 决策 2 的可观测形式。宿主的符号可见性默认关（进程符号搜索
       故意没装），所以"IR 里要一个表上没有的名字"必须在物化之前就拒 —— 而不是让 ORC
       在跑到一半时报它那句带平台前缀的 `Symbols not found: [ _foo ]`。 */
    const miss = join(tmp, 'miss.ll');
    writeFileSync(miss, 'declare i64 @no_such_thing(i64)\n'
      + 'define i32 @main(i32 %argc, ptr %argv) {\n'
      + '  %r = call i64 @no_such_thing(i64 1)\n'
      + '  ret i32 0\n}\n');
    const r2 = spawnSync(host, [miss], { encoding: 'utf8' });
    const err = r2.stderr ?? '';
    if (r2.status === 0) bad('unresolved-symbol', '    缺符号居然跑通了 —— 那说明还有别的解析路径');
    else if (!err.includes('unresolved: no_such_thing')) {
      bad('unresolved-symbol', `    报错的理由不对：${JSON.stringify(err.slice(0, 160))}`);
    } else ok('unresolved-symbol [装载前按名字报：unresolved: no_such_thing]');

    /* 4b 多入口 + 反复调（J3）：一份 IR 里两个 `void(void)` 各调一次、再让一个调三次。
       形状是从 IR 上读的（0 格参数 / 2 格参数），没有另发明签名语法。
       顺带这一条也钉住了"运行时是靠宿主符号表解析的"：手写的 IR 里除了
       `omni_print_int` 什么都没有，它只能从表里来。 */
    const two = join(tmp, 'two.ll');
    writeFileSync(two, 'declare void @omni_print_int(i64)\n'
      + 'define void @first() {\n  call void @omni_print_int(i64 11)\n  ret void\n}\n'
      + 'define void @second() {\n  call void @omni_print_int(i64 22)\n  ret void\n}\n');
    const m1 = spawnSync(host, [two, '--call', 'first', '--call', 'second'], { encoding: 'utf8' });
    const m2 = spawnSync(host, [two, '--call', 'first', '--repeat', '3'], { encoding: 'utf8' });
    const d2 = [];
    if (m1.status !== 0) d2.push(`    两个入口那次 exit=${m1.status}\n${m1.stderr}`);
    else if (m1.stdout !== '11\n22\n') d2.push(`    两个入口的顺序/输出不对：${JSON.stringify(m1.stdout)}`);
    if (m2.status !== 0) d2.push(`    --repeat 那次 exit=${m2.status}\n${m2.stderr}`);
    else if (m2.stdout !== '11\n11\n11\n') d2.push(`    --repeat 3 的输出不对：${JSON.stringify(m2.stdout)}`);
    if (d2.length > 0) bad('multi-entry', d2.join('\n'));
    else ok('multi-entry [--call 两个入口按序各一次；--repeat 3 反复调同一个]');

    /* 4c C 那条腿在 JIT 上（ADR-0022 的 J4 后半 + J5）：`emit llvm x.c` 出来的 IR
       喂给宿主，答案要与 `omni c run` 逐字节相同 —— stdout、stderr、退出码三样。
       这一组的符号全在**进程的动态符号表**里（`printf`、`__stdoutp`、`write`…），
       所以要 `--dl`；不给的那一条在 4d 上钉着。 */
    const sysDir = join(root, 'tests', 'c', 'sys');
    if (existsSync(sysDir)) {
      for (const f of readdirSync(sysDir).sort()) {
        if (!f.endsWith('.c')) continue;
        const src = join(sysDir, f);
        const em = spawnSync('node', [cli, 'emit', 'llvm', src], { encoding: 'utf8' });
        if (em.status !== 0) { bad(`c-jit/${f}`, `    emit llvm 没过：${(em.stderr ?? '').trim().split('\n')[0]}`); continue; }
        const irPath = join(tmp, `${f}.ll`);
        writeFileSync(irPath, em.stdout);
        /* 带时限与输出上限：一份跑飞的用例不该把测试机的磁盘写满。 */
        const jr = spawnSync(host, [irPath, '--dl'], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 });
        const cr = spawnSync('node', [cli, 'c', 'run', src], { encoding: 'utf8' });
        const d3 = [];
        if (jr.error !== undefined && jr.error !== null) d3.push(`    没能正常跑完：${jr.error.code ?? jr.error.message}`);
        if ((jr.stdout ?? '') !== cr.stdout) d3.push(`    stdout 与 omni-c 不同\n      omni-c ${JSON.stringify(cr.stdout.slice(0, 200))}\n      jit    ${JSON.stringify((jr.stdout ?? '').slice(0, 200))}`);
        if ((jr.stderr ?? '') !== cr.stderr) d3.push(`    stderr 与 omni-c 不同\n      omni-c ${JSON.stringify(cr.stderr.slice(0, 200))}\n      jit    ${JSON.stringify((jr.stderr ?? '').slice(0, 200))}`);
        if (jr.status !== cr.status) d3.push(`    退出码不同：jit ${jr.status}, omni-c ${cr.status}`);
        if (d3.length > 0) bad(`c-jit/${f}`, d3.join('\n'));
        else ok(`c-jit/${f} [jit --dl == omni-c] exit=${jr.status}, ${(jr.stdout ?? '').length}+${(jr.stderr ?? '').length} bytes`);
      }

      /* 4d 默认还是**关**的（ADR-0022 决策 2 没有被 J5 推翻）：同一份 IR 不给 `--dl`
         必须在物化之前停下，而且那句话里要指出 `--dl` 这条路 —— 一个开关的价值全在
         「默认那一边是哪一边」上，所以它要有一条自己的用例。 */
      const irOne = join(tmp, '02-streams.c.ll');
      if (existsSync(irOne)) {
        const closed = spawnSync(host, [irOne], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 });
        const e4 = closed.stderr ?? '';
        if (closed.status === 0) bad('dl-closed', '    不给 --dl 居然也跑通了 —— 那 J2 那个决定就没了');
        else if (!e4.includes('unresolved: __stdoutp') || !e4.includes('--dl')) {
          bad('dl-closed', `    报错的理由/指路不对：${JSON.stringify(e4.slice(0, 240))}`);
        } else ok('dl-closed [不给 --dl 就在物化前停，并指出 --dl 这条路]');
      }

      /* 4e `--lib`（J5 的验收面）：`sin`/`cos` 在 libm 里，不在宿主表里。装上那个库之后
         同一份 IR 就跑得通，而对账的对象是 **AOT**（`clang -x ir`）而不是解释器 ——
         解释器那条腿压根没有 libm（它会明着说 `C ABI call 'sin' is not supported`）。
         库的路径按平台挑：macOS 上 libm 在 libSystem 里，Linux 上是 libm.so.6。
         macOS 那一格**不能用 existsSync 判**：libSystem 早就不在磁盘上了（在 dyld 的
         共享缓存里），`existsSync` 回 false 而 `dlopen` 照样成 —— 按文件在不在挑会把
         这条用例静默跳过。所以那一格直接给名字，装不上时按 skip 处理。 */
      const LIBM_PATH = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib'
        : ['/lib/x86_64-linux-gnu/libm.so.6', '/lib/aarch64-linux-gnu/libm.so.6',
          '/usr/lib/libm.so.6'].find((p) => existsSync(p));
      const mSrc = join(tmp, 'libm.c');
      writeFileSync(mSrc, '#include <stdio.h>\ndouble sin(double);\ndouble cos(double);\n'
        + 'int main(void) { printf("%.6f %.6f\\n", sin(1.0), cos(1.0)); return 0; }\n');
      const em = spawnSync('node', [cli, 'emit', 'llvm', mSrc], { encoding: 'utf8' });
      if (LIBM_PATH === undefined) process.stdout.write('  skip lib-libm：这台机器上找不到 libm\n');
      else if (em.status !== 0) bad('lib-libm', `    emit llvm 没过：${(em.stderr ?? '').trim().split('\n')[0]}`);
      else {
        const irPath = join(tmp, 'libm.ll');
        writeFileSync(irPath, em.stdout);
        const binPath = join(tmp, 'libm.bin');
        const cc = spawnSync('clang', ['-x', 'ir', irPath, '-o', binPath], { encoding: 'utf8' });
        const jr = spawnSync(host, [irPath, '--lib', LIBM_PATH], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 });
        const d5 = [];
        if (cc.status !== 0) d5.push(`    clang -x ir 没过：${(cc.stderr ?? '').trim().split('\n')[0]}`);
        else {
          const ar = spawnSync(binPath, [], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 });
          if ((jr.stdout ?? '') !== (ar.stdout ?? '')) d5.push(`    与 AOT 不同\n      aot ${JSON.stringify(ar.stdout)}\n      jit ${JSON.stringify(jr.stdout)}\n      jit-err ${JSON.stringify((jr.stderr ?? '').slice(0, 200))}`);
          if (jr.status !== ar.status) d5.push(`    退出码不同：jit ${jr.status}, aot ${ar.status}`);
        }
        if (d5.length > 0) bad('lib-libm', d5.join('\n'));
        else ok(`lib-libm [--lib 装上库，sin/cos 与 AOT 相同] ${JSON.stringify((jr.stdout ?? '').trim())}`);
      }
    }

    /* 4f **对象码缓存**（J7）：`--objcache PATH` —— 第一次跑生成对象码并落盘，第二次直接
       摆那份对象码进去，一次代码生成都不做。这一条钉三件事：miss/hit 的先后、缓存文件真的
       出来了、**两次的输出逐字节相同**（缓存不许改变可观测行为）。
       走宿主直调而不是 `run-jit`：那条路的缓存目录是共享的，第一次跑是不是 miss 取决于
       别人跑过没有 —— 判据不该有那种依赖。 */
    {
      const src = join(tmp, 'oc.c');
      writeFileSync(src, '#include <stdio.h>\nint main(void) { printf("oc ok\\n"); return 7; }\n');
      const em2 = spawnSync('node', [cli, 'emit', 'llvm', src], { encoding: 'utf8' });
      if (em2.status !== 0) bad('objcache', `    emit llvm 没过：${(em2.stderr ?? '').trim().split('\n')[0]}`);
      else {
        const irPath = join(tmp, 'oc.ll');
        writeFileSync(irPath, em2.stdout);
        const ocPath = join(tmp, 'oc.o');
        const env2 = { ...process.env, OMNI_JIT_TRACE: '1' };
        const opts2 = { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20, env: env2 };
        /* `--dl`：这份 IR 要 `printf` 那一族（libc）—— 默认那扇门是关着的（决策 2）。 */
        const r1 = spawnSync(host, [irPath, '--dl', '--objcache', ocPath], opts2);
        const r2 = spawnSync(host, [irPath, '--dl', '--objcache', ocPath], opts2);
        const d6 = [];
        if (!(r1.stderr ?? '').includes('objcache miss')) {
          d6.push(`    第一次不是 miss：${JSON.stringify((r1.stderr ?? '').slice(0, 200))}`);
        }
        if (!existsSync(ocPath)) d6.push('    第一次跑完没有落下那份对象码');
        if (!(r2.stderr ?? '').includes('objcache hit')) {
          d6.push(`    第二次不是 hit：${JSON.stringify((r2.stderr ?? '').slice(0, 200))}`);
        }
        if ((r1.stdout ?? '') !== 'oc ok\n' || (r2.stdout ?? '') !== 'oc ok\n') {
          d6.push(`    输出不对：${JSON.stringify(r1.stdout)} / ${JSON.stringify(r2.stdout)}`);
        }
        if (r1.status !== 7 || r2.status !== 7) {
          d6.push(`    退出码不对：${r1.status} / ${r2.status}（要 7）`);
        }
        if (d6.length > 0) bad('objcache', d6.join('\n'));
        else {
          ok('objcache [--objcache：第一次 miss 并落盘，第二次 hit，两次输出与退出码相同]'
            + ` ${statSync(ocPath).size} bytes`);
        }
      }
    }
    /* 4g **一次会话摆好几份 IR 进同一个 JITDylib**（`--add`，J6）。REPL 一批一份产物：
       第二份里的 `@g_base` 是一句 `external global`、`@s_f1` 是一句 `declare`，落点在第一份
       里 —— 这一条要证的就是 ORC 自己把它们接上了，而且**与 AOT 那条腿的答案逐字节相同**
       （tests/llvm 第 10 节 session-aot 把同样这四份链成一个可执行文件，也是这四行）。
       顺带钉一条边界：`--objcache` 的键是**一份** IR 的内容，与 `--add` 一起用要明着报错。 */
    {
      const texts = [
        '(fn f1 ((n int)) int (ret (bin "+" (var n) (int 1))))\n(let base int (int 100))\n(print (var base))\n',
        '(set base (bin "+" (var base) (int 1)))\n(print (var base))\n',
        '(print (bin "*" (var base) (int 2)))\n',
        '(print (call f1 (var base)))\n',
      ];
      const cs = new CoreSession();
      const lls = [];
      const calls = [];
      let k = 0;
      for (const t of texts) {
        k++;
        const diags = new Diagnostics();
        const delta = cs.add(t, diags);
        diags.throwIfErrors();
        const p = join(tmp, `chunk${k}.ll`);
        writeFileSync(p, emitLlvm(lowerToMir(delta), { repl: true }));
        lls.push(p);
        calls.push('--call', `omni_chunk_${k}`);
      }
      const args = [lls[0]];
      for (const p of lls.slice(1)) args.push('--add', p);
      const sr = spawnSync(host, [...args, ...calls], { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 20 });
      const d7 = [];
      if (sr.status !== 0) {
        d7.push(`    exit=${sr.status}：${(sr.stderr ?? '').trim().split('\n').slice(0, 3).join('\n      ')}`);
      } else if ((sr.stdout ?? '') !== '100\n101\n202\n102\n') {
        d7.push(`    输出不对：${JSON.stringify(sr.stdout)}（要 "100\\n101\\n202\\n102\\n"）`);
      }
      const oc = spawnSync(host, [...args, ...calls, '--objcache', join(tmp, 'sess.o')],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 20 });
      if (oc.status !== 64 || !(oc.stderr ?? '').includes('--objcache 与 --add 不能一起用')) {
        d7.push(`    --objcache 与 --add 一起用该报错：exit=${oc.status} ${JSON.stringify((oc.stderr ?? '').slice(0, 120))}`);
      }
      if (d7.length > 0) bad('session', d7.join('\n'));
      else ok('session [--add：四批 IR 进同一个 JITDylib，跨批改变量、跨批调函数，答案与 AOT 相同]');
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
