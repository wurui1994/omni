// bench/go/run.js —— go 这条腿的**性能尺子**：我们的原生 vs `go build` 的原生。
//
// 为什么要它：正确性有 `tests/go`，但这条路的目标是**逼近 go 原生**，那只能量。
// 参考是官方 go 编出来的二进制（同一台机器、同一份源码），所以这把尺子不是我们自己的复述。
//
// **第三列是"同一份 C 交给 clang -O2"**（`--cc clang` + `OMNI_OPT=2`）。它把差分成两段：
//   go → clang 那一段是**我们发出来的 C 的形状**（前端 / 图 / 方言那一路）；
//   clang → self 那一段是**我们自己那个后端的发码**（公共优化管线，ADR-0039）。
// 没有这一列就只能猜该改哪头 —— 量过一次就知道：slice 那格 self 89ms、clang 30ms、
// go 39ms，也就是形状已经够好、欠的全在后端。
// 用法：node bench/go/run.js [次数]（交错跑、各取最小 —— 这台机器单次墙上时间抖 ±40%）
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, '.omni-cache', 'go-bench');
mkdirSync(out, { recursive: true });
const N = Number(process.argv[2] || 5);

const wall = (bin) => {
  const t0 = process.hrtime.bigint();
  execFileSync(bin, [], { stdio: 'ignore', timeout: 600000 });
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

for (const f of readdirSync(here).filter((x) => x.endsWith('.go')).sort()) {
  const src = join(here, f);
  const stem = f.slice(0, -3);
  const ref = join(out, `${stem}_go`);
  const ours = join(out, `${stem}_ours`);
  const cl = join(out, `${stem}_clang`);
  const omni = (args, env) => execFileSync('node', [join(root, 'src', 'cli.js'), ...args],
    { cwd: root, stdio: 'pipe', timeout: 300000, env: { ...process.env, ...env } });
  /* 编不过就报一行、接着量下一份 —— 尺子不该因为一处缺口整趟垮掉。 */
  try {
    execFileSync('go', ['build', '-o', ref, src], { timeout: 300000 });
    /* `.go` 直接喂 `build`（cli 自己译成核心方言再往下走）—— 从前这儿是手动两步：
       先 `--backend core -o x.sx`，再 `build x.sx`。那两步只存在于这个文件里，
       命令行上没有一条路能从 `.go` 走到二进制，等于尺子量的是别人量不到的东西。 */
    omni(['build', src, '-o', ours], { OMNI_MIR_OPT: '1' });
    omni(['build', src, '-o', cl, '--cc', 'clang'], { OMNI_OPT: '2' });
  } catch (e) {
    const all = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    const why = all.split('\n').filter((x) => x.trim()).pop();
    console.log(`${f.padEnd(16)} 编不出来：${String(why).slice(0, 96)}`);
    continue;
  }
  /* **先比答案再比时间**。为什么这一条不能省（量出来的，2026-09-20）：regalloc 的
     槽位合流第一版发出了错的码，smallpt 快了 9.25 倍 —— 因为它算的不是那件事。
     一把不验答案的性能尺子会把"算错了所以快"报成进步。
     go 的 `println` 写的是 **stderr**，所以两边都要合流取。 */
  const say = (bin) => execFileSync('sh', ['-c', `${JSON.stringify(bin)} 2>&1`],
    { encoding: 'utf8', timeout: 600000 });
  const want = say(ref);
  for (const [who, bin] of [['我们', ours], ['clang', cl]]) {
    const got = say(bin);
    if (got !== want) {
      console.log(`${f.padEnd(16)} 答案不对（${who}）：go 给 ${JSON.stringify(want.slice(0, 60))}`
        + `，它给 ${JSON.stringify(got.slice(0, 60))}`);
    }
  }
  let bg = Infinity, bo = Infinity, bc = Infinity;
  for (let i = 0; i < N; i++) {
    bg = Math.min(bg, wall(ref)); bo = Math.min(bo, wall(ours)); bc = Math.min(bc, wall(cl));
  }
  console.log(`${f.padEnd(16)} go ${bg.toFixed(0)}ms`
    + `   我们 ${bo.toFixed(0)}ms ×${(bo / bg).toFixed(2)}`
    + `   同一份 C 交给 clang ${bc.toFixed(0)}ms ×${(bc / bg).toFixed(2)}`);
}
