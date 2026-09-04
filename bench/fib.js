// 与 bench/fib.omni **同一个算法**，**手写**的那一份（ADR-0013 的执行路径对照）。
//
// 它的身份是**上限**：同一台 V8、同一个算法，人写出来的 JS 能跑多快 ——
// 「编成 JS」那条路的天花板就在这儿，解释器要追的也是这条线。
//
// 用 Number（不是 BigInt）：`i * i` 最大 4e12、`acc` 最大 ~1e12，都在 2^53 以内，
// 所以这一份与 i64 语义**逐位相同**。这也正是「i32/i64 什么时候可以用 Number」
// 那个问题的一个样本。

function fib(n) {
  if (n < 2) { return n; }
  return fib(n - 1) + fib(n - 2);
}

function sumTo(n) {
  let acc = 0;
  for (let i = 1; i <= n; i++) { acc += i * i % 1000003; }
  return acc;
}

process.stdout.write(`${fib(27)}\n`);
process.stdout.write(`${sumTo(2000000)}\n`);
