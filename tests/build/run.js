// tests/build/run.js —— 构建引擎的判据：**不起一个进程**
//
// 磁盘与执行器都是注入的（`plan.js` 的 `FakeDisk`、`build()` 的 `exec`），所以每一条
// 判的都是确定的数据：**跑了哪些命令、什么次序、第二趟跑几条**。拿墙上时间比构建系统
// 是自欺 —— 这份文件里一个计时都没有。
//
// 外面那把尺子在另一处：`omni ninja --emit-ninja` 出来的 manifest 喂给真 ninja，
// 两边跑同一批命令（手动验过，见提交说明）。

import { State } from '../../src/core/build/graph.js';
import { parseManifest } from '../../src/core/build/manifest.js';
import { FakeDisk } from '../../src/core/build/plan.js';
import { build, BuildLog } from '../../src/core/build/run.js';
import { Builder, toNinja } from '../../src/core/build/script.js';

let pass = 0;
let fail = 0;

const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass++; console.log(`  ok   ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}\n       得到：${a}\n       要的：${b}`);
};

const throws = (name, fn, re) => {
  try {
    fn();
    fail++;
    console.log(`  FAIL ${name}（本该报错，却没报）`);
  } catch (e) {
    if (re.test(String(e.message))) { pass++; console.log(`  ok   ${name}`); return; }
    fail++;
    console.log(`  FAIL ${name}\n       报的是：${e.message}`);
  }
};

/** 造一趟：manifest 文本 + 磁盘上已有的文件 → 跑一趟，回跑过的命令。 */
function run(text, files, opts) {
  const st = new State();
  parseManifest(st, text, 'build.ninja');
  const disk = new FakeDisk(files);
  const o = opts ?? {};
  const log = o.log ?? new BuildLog();
  const r = build(st, {
    disk,
    log,
    targets: o.targets,
    toolFingerprint: o.fp ?? 'T',
    now: () => 0,
    exec: (cmd, edge) => {
      /* 假执行器：命令"成功"，产物按需要更新 mtime（不更新 = 内容没变，restat 那条） */
      if (o.noWrite !== true) for (const out of edge.outputs) disk.touch(out.path);
      return { code: o.codeOf === undefined ? 0 : o.codeOf(cmd) };
    },
  });
  return { ran: r.ran, disk, log, state: st, failed: r.failed };
}

const CC = [
  'rule cc',
  '  command = cc -c $in -o $out',
  'rule link',
  '  command = cc $in -o $out',
].join('\n');

const APP = [CC,
  'build a.o: cc a.c',
  'build b.o: cc b.c',
  'build app: link a.o b.o',
  'default app',
  ''].join('\n');

console.log('build（构建引擎）');

/* 一、从零开始：三条命令，**依赖在前** */
eq('从零：次序是拓扑序', run(APP, { 'a.c': 1, 'b.c': 1 }).ran,
  ['cc -c a.c -o a.o', 'cc -c b.c -o b.o', 'cc a.o b.o -o app']);

/* 二、都是新的：一条都不跑（第二趟的账 —— 构建系统的命门） */
{
  const first = run(APP, { 'a.c': 1, 'b.c': 1 });
  const again = run(APP, Object.fromEntries(first.disk.files), { log: first.log });
  eq('第二趟：零条命令', again.ran, []);
}

/* 三、只改一个源文件：只重做它那一支 */
{
  const first = run(APP, { 'a.c': 1, 'b.c': 1 });
  const files = Object.fromEntries(first.disk.files);
  files['a.c'] = 9999;
  eq('改 a.c：只重做 a.o 与 app', run(APP, files, { log: first.log }).ran,
    ['cc -c a.c -o a.o', 'cc a.o b.o -o app']);
}

/* 四、命令没变但**工具变了**：全部重做（学 Go 的 action ID，设计 §5） */
{
  const first = run(APP, { 'a.c': 1, 'b.c': 1 });
  const files = Object.fromEntries(first.disk.files);
  eq('换了编译器指纹：全部重做', run(APP, files, { log: first.log, fp: 'T2' }).ran.length, 3);
}

/* 五、**仅次序**的输入变了：不重做（`||` 与 `|` 的唯一区别） */
{
  const text = [CC, 'build a.o: cc a.c || mkdir.stamp', 'default a.o', ''].join('\n');
  const first = run(text, { 'a.c': 1, 'mkdir.stamp': 1 });
  const files = Object.fromEntries(first.disk.files);
  files['mkdir.stamp'] = 9999;
  eq('仅次序的输入变了：不重做', run(text, files, { log: first.log }).ran, []);
  /* 而隐式输入（`|`）变了要重做 */
  const text2 = [CC, 'build a.o: cc a.c | common.h', 'default a.o', ''].join('\n');
  const f2 = run(text2, { 'a.c': 1, 'common.h': 1 });
  const files2 = Object.fromEntries(f2.disk.files);
  files2['common.h'] = 9999;
  eq('隐式输入变了：要重做', run(text2, files2, { log: f2.log }).ran, ['cc -c a.c -o a.o']);
}

/* 六、**restat**：产物内容没变（mtime 没前进）→ 下游摘掉 */
{
  const text = [CC.replace('rule cc', 'rule cc'),
    'rule gen',
    '  command = gen $out',
    '  restat = 1',
    'build h.stamp: gen a.c',
    'build a.o: cc a.c | h.stamp',
    'default a.o',
    ''].join('\n');
  const st = new State();
  parseManifest(st, text, 'b.ninja');
  const disk = new FakeDisk({ 'a.c': 5, 'h.stamp': 1, 'a.o': 1 });
  const log = new BuildLog();
  const r = build(st, {
    disk,
    log,
    toolFingerprint: 'T',
    now: () => 0,
    /* gen 跑了但**不动** h.stamp（内容没变）；cc 正常写 a.o */
    exec: (cmd, edge) => {
      if (!cmd.startsWith('gen')) for (const o of edge.outputs) disk.touch(o.path);
      return { code: 0 };
    },
  });
  /* a.o 本来因为 a.c 更新也脏，所以它还是要做；判的是 gen 跑了、且没因为 h.stamp 多做别的 */
  eq('restat：产物没变时不额外传播', r.ran, ['gen h.stamp', 'cc -c a.c -o a.o']);
}

/* 七、环：报**整条路径** */
throws('环：报整条路径', () => run([CC,
  'build a.o: cc b.o',
  'build b.o: cc a.o',
  'default a.o',
  ''].join('\n'), {}), /依赖成环[\s\S]*a\.o[\s\S]*b\.o/);

/* 八、缺输入：报"谁要它"（不许 weak 兜底） */
throws('缺输入：报谁要它', () => run(APP, { 'b.c': 1 }), /缺了输入 'a\.c'[\s\S]*要它的是/);

/* 九、一格工件两条边造：当场报，且把两条边都印出来 */
throws('两条边造同一格：当场报', () => run([CC,
  'build a.o: cc a.c',
  'build a.o: cc b.c',
  ''].join('\n'), { 'a.c': 1, 'b.c': 1 }), /两条边都要造 'a\.o'/);

/* 十、命令失败：停下，并报它要造什么 */
{
  const r = run(APP, { 'a.c': 1, 'b.c': 1 }, { codeOf: (c) => (c.includes('a.c') ? 2 : 0) });
  eq('失败即停：只跑到那一条', r.ran, ['cc -c a.c -o a.o']);
  eq('失败记下来了', r.failed.length, 1);
}

/* 十一、`build.js` → manifest → 再解析：**同一张图**（单向桥的往返判据） */
{
  const b = new Builder();
  b.set('cflags', '-O2');
  b.rule('cc', { command: 'cc $cflags -c $in -o $out' });
  b.rule('link', { command: 'cc $in -o $out' });
  b.build('a.o', 'cc', 'a.c', { implicit: ['h.h'], vars: { cflags: '-O0' } });
  b.build('b.o', 'cc', 'b.c');
  b.build('app', 'link', ['a.o', 'b.o']);
  b.default('app');
  const text = toNinja(b.state);
  const st2 = new State();
  parseManifest(st2, text, 'gen.ninja');
  const cmds = (s) => s.edges.map((e) => e.command());
  eq('build.js 与它印出的 manifest 是同一批命令', cmds(st2), cmds(b.state));
  eq('边级绑定过了这座桥还在', cmds(st2)[0], 'cc -O0 -c a.c -o a.o');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
