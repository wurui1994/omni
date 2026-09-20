// tests/sched/run.js —— 调度器那一格的判据（编 + 跑）。
//
// 为什么是 C 判据而不是走前端：这一层（G/M/P）是**公共的线程与并发模型**，go 只是
// 第一个用它的前端。所以判据直接盯着 `src/runtime/omni_sched.c` 的行为，
// 与哪门语言无关。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, '.omni-cache', 'sched');
mkdirSync(out, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, detail) => { pass++; console.log(`  ok   ${name} [${detail}]`); };
const bad = (name, why) => { fail++; console.log(`  FAIL ${name}\n       ${why}`); };

const cc = (src, exe, opt, extra) => {
  execFileSync('clang', [opt || '-O1', '-Wall', '-Wextra', '-Werror',
    '-I', join(root, 'src', 'runtime-sched'), '-o', exe,
    join(here, src), ...(extra || []).map((f) => join(root, 'src', 'runtime-sched', f)),
    join(root, 'src', 'runtime-sched', 'omni_sched.c'), '-lpthread'],
    { stdio: 'pipe' });
};
const run = (exe, args, env) => execFileSync(exe, args || [], {
  encoding: 'utf8', timeout: 120000, env: { ...process.env, ...(env || {}) },
}).trim();

/* 一、编得过（-Werror：这一层不许留警告） */
const exe = join(out, 'smoke');
try { cc('smoke.c', exe); ok('编译', '-Werror 无警告'); }
catch (e) { bad('编译', String(e.stderr || e.message)); }

/* 二、N 条 g 的和对得上（跨 P 偷工作 + 让出都在这一格里） */
for (const n of [200, 5000]) {
  try {
    const s = run(exe, [String(n)]);
    if (/ ok$/.test(s)) ok(`${n} 条 goroutine`, s.split('\n').pop());
    else bad(`${n} 条 goroutine`, s);
  } catch (e) { bad(`${n} 条 goroutine`, String(e.stderr || e.message)); }
}

/* 三、GOMAXPROCS 真的是 M:N —— P 从 1 加到 4，墙上时间要明显下来。
 *    判据定得松（>1.5x），这台机器是 4 性能核 + 4 能效核，别把机器特性写进判据。 */
try {
  const par = join(out, 'par');
  cc('par.c', par, '-O2');
  const t = (p) => {
    const s = run(par, [], { P: String(p) });
    const m = /：(\d+) ms/.exec(s);
    if (m === null) throw new Error(`看不懂输出：${s}`);
    return Number(m[1]);
  };
  const t1 = t(1), t4 = t(4);
  if (t1 / t4 > 1.5) ok('M:N 并行', `P=1 ${t1}ms、P=4 ${t4}ms（×${(t1 / t4).toFixed(2)}）`);
  else bad('M:N 并行', `P=1 ${t1}ms、P=4 ${t4}ms —— 没看出并行`);
} catch (e) { bad('M:N 并行', String(e.stderr || e.message)); }

/* 四、channel 与 select（照 chan.go / select.go）。跑 20 趟 —— 这一层全是竞态，
 *    一趟过了说明不了什么。 */
try {
  const ce = join(out, 'chan');
  cc('chan.c', ce, '-O1', ['omni_chan.c']);
  let good = 0, last = '';
  for (let i = 0; i < 20; i++) {
    try { last = run(ce); good++; } catch (e) { last = String(e.stdout || e.message); break; }
  }
  if (good === 20) ok('channel / select', `20 趟全过（${last.split('\n').length - 1} 格判据）`);
  else bad('channel / select', `第 ${good + 1} 趟就挂了：\n${last}`);
} catch (e) { bad('channel / select', String(e.stderr || e.message)); }

/* 五、前端那一侧的门面（`omni_go.*`）：go 前端递进来的是**方言的函数值**
 *    （首字段是代码地址的闭包对象），这一格验的正是那条接缝 + 主 g 的起法。
 *    三档缓冲各跑 5 趟 —— 无缓冲那一档走的是 sendq/recvq 直接交接那条路。 */
try {
  const ge = join(out, 'go');
  cc('go.c', ge, '-O1', ['omni_go.c', 'omni_chan.c']);
  let good = 0, last = '';
  const runs = [];
  for (const cap of [0, 1, 8]) for (let i = 0; i < 5; i++) runs.push(cap);
  for (const cap of runs) {
    try { last = run(ge, ['300', String(cap)]); good++; } catch (e) { last = String(e.stdout || e.message); break; }
  }
  if (good === runs.length) ok('go f(x) / channel 的门面', `${runs.length} 趟全过（${last}）`);
  else bad('go f(x) / channel 的门面', `第 ${good + 1} 趟就挂了：\n${last}`);
} catch (e) { bad('go f(x) / channel 的门面', String(e.stderr || e.message)); }

/* 六、**方言那一侧**（`go.sx`）：`(lib "libomnigo")` + `(cabi …)` + `(ccall …)` +
 *    `(fnref …)` 一路走到两条原生腿。这一格钉的是"把一格方言的函数值交给 C 去跑"
 *    那条接缝在真编译链上也成立 —— 上面那一格是手写 C 造的闭包对象，这一格是编译器造的。
 *    答案（0..299 的平方和）与并发次序无关，所以可以逐字节比。 */
try {
  const cli = join(root, 'src', 'cli.js');
  const sx = join(here, 'go.sx');
  const want = '8955050\n0\n';
  const legs = [['self', []], ['clang', ['--cc', 'clang']]];
  const bad2 = [];
  for (const [leg, extra] of legs) {
    const exe = join(out, `gosx-${leg}`);
    execFileSync('node', [cli, 'build', sx, '-o', exe, ...extra],
      { cwd: root, stdio: 'pipe', timeout: 300000 });
    for (let i = 0; i < 3; i++) {
      const got = execFileSync(exe, [], { encoding: 'utf8', timeout: 120000 });
      if (got !== want) bad2.push(`${leg} 第 ${i + 1} 趟给的是 ${JSON.stringify(got)}`);
    }
  }
  if (bad2.length === 0) ok('go.sx 走两条原生腿', `self / clang × 3 趟，都是 ${JSON.stringify(want)}`);
  else bad('go.sx 走两条原生腿', bad2.join('\n       '));
} catch (e) { bad('go.sx 走两条原生腿', String(e.stderr || e.message)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
