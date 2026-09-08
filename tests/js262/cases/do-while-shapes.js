// do-while 的五种形状。以前 do-while 摊的是 while (true) { 体; if (!test) break; }，
// continue 会跳过尾巴上那句判断、成死循环，所以那时候 do-while 里的 continue 是当场拒掉；
// 现在摊成 For（条件在 step 里），continue 的语义正好是"去算条件"。
let i = 0;
do { i++; } while (i < 5);
console.log(i);
// 条件一上来就假：体也要跑一遍
let once = 0;
do { once++; } while (false);
console.log(once);
// continue：跳到条件那儿，不是跳过条件
let n = 0; const kept = [];
do { n++; if (n % 2 === 0) continue; kept.push(n); } while (n < 7);
console.log(n, kept.join(","));
// break：直接出去，条件不再算（条件里的副作用用函数记一笔 —— 逗号表达式在惰性位置
// 上是 loud 拒绝的，见 lazy()）
let b = 0; let evals = 0;
function tick(v) { evals++; return v < 10; }
do { b++; if (b === 3) break; } while (tick(b));
console.log(b, evals);
// 嵌套 + 里层 continue / 外层继续
const pairs = [];
let x = 0;
do {
  x++;
  let y = 0;
  do { y++; if (y === 2) continue; pairs.push(x + "" + y); } while (y < 3);
} while (x < 3);
console.log(pairs.join(" "));
// 体里 return
function firstOdd(a) {
  let k = -1;
  do { k++; if (a[k] % 2 === 1) return a[k]; } while (k < a.length - 1);
  return -1;
}
console.log(firstOdd([2, 4, 7, 8]), firstOdd([2, 4]));
// 条件里有副作用：每轮算一次，最后一轮也算
let c = 0; let cond = 0;
function again() { cond++; return c < 4; }
do { c++; } while (again());
console.log(c, cond);
