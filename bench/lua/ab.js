// bench/lua/ab.js —— **性能判据**：两份产物（或同一份 + 环境开关）的交错 A/B
//
// 为什么非得有这个：这台机器单次墙上时间抖 ±5%，比一刀优化的收益还大；
// 而用 `bash 循环 + python 取时间戳` 量更糟 —— 那套 harness 每个样本白加 ~34ms，
// 把 31ms 的例子量成 65ms、ratio 全失真（踩过，连着误判了三刀）。
//
// 判据：**交错**跑（抗 CPU 频率随时间漂）+ **各取最小值**（抗被别的进程抢）。min 的重复性约 ±1%。
// 工作量低于 ~50ms 的别单跑（进程启动占比太大）——加大规模，或用程序内的 ITERS（见 bench/ir/extreme.js）。
//
// 用法：
//   node bench/lua/ab.js <A 二进制> <B 二进制> <prog.olbc> [N=8] [B 的环境，如 OMNI_JIT_IC=1]
//   node bench/lua/ab.js --bc <二进制> <A.olbc> <B.olbc> [N=8]      # 同一个二进制、两份字节码

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const t = (bin, prog, env) => {
  const s = process.hrtime.bigint();
  execFileSync(bin, [prog], { env: { ...process.env, ...env }, stdio: 'ignore' });
  return Number(process.hrtime.bigint() - s) / 1e6;
};
const f = (x) => x.toFixed(1);

let runA, runB, labelA, labelB, N;
if (argv[0] === '--bc') {
  const [, bin, pa, pb, n] = argv;
  N = Number(n || 8);
  labelA = pa.split('/').pop(); labelB = pb.split('/').pop();
  runA = () => t(bin, pa, {}); runB = () => t(bin, pb, {});
} else {
  const [a, b, prog, n, envStr] = argv;
  N = Number(n || 8);
  const envB = {};
  if (envStr) for (const kv of envStr.split(',')) { const [k, v] = kv.split('='); envB[k] = v; }
  labelA = a.split('/').pop(); labelB = b.split('/').pop() + (envStr ? ` +${envStr}` : '');
  runA = () => t(a, prog, {}); runB = () => t(b, prog, envB);
}

let ba = Infinity, bb = Infinity, sa = 0, sb = 0;
for (let i = 0; i < N; i++) {
  const x = runA(); if (x < ba) ba = x; sa += x;
  const y = runB(); if (y < bb) bb = y; sb += y;
}
console.log(`A ${labelA}: min ${f(ba)}ms  avg ${f(sa / N)}ms`);
console.log(`B ${labelB}: min ${f(bb)}ms  avg ${f(sb / N)}ms`);
console.log(`B/A = ${(bb / ba).toFixed(3)}（按最小值；<1 = B 更快）`);
