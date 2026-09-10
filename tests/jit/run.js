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
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
