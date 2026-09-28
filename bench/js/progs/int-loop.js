// bench/js/progs/int-loop.js —— **对照组：纯整数算术**（属性一次都不碰）
//
// 这一份的用处是**把账分开**：prop-mono 慢，到底是"属性查找"慢还是"我们发的码整体都慢"？
// 这一格只有加减乘与比较、一个局部变量都不装箱得下来（如果发射层做对了），
// 所以它量的是**算术与循环这条底线**。两份的 ratio 一比，属性那一层的账就单独出来了。
const N = 20000000;

function run(n) {
  let s = 0;
  for (let i = 1; i <= n; i++) {
    s = (s + i * 3 - (i >> 2)) | 0;
  }
  return s;
}

console.log(run(N));
