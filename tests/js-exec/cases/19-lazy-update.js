// 后缀自增/自减在**惰性位置**（三元的分支、`&&`/`||` 的右边）里的降级（ADR-0020 P2 的
// 前置障碍）。那儿开不了语句，所以名字这一支把两次写折进一个表达式：
//   (t = i) 先存旧值 -> i = t + 1 写回 -> 值是 t
// 三元的两条分支都是"读同一格临时量"，复制的只是一个变量引用，没有重复求值。
let i = 0;
const step = () => (i < 3 ? { v: i++, done: false } : { v: -1, done: true });
console.log(JSON.stringify(step()), JSON.stringify(step()));
console.log(JSON.stringify(step()), JSON.stringify(step()), i);

let j = 5;
const dec = (b) => b && j--;
console.log(dec(true), j);
console.log(dec(false), j);
console.log(dec(true), j);

// || 的右边同样是惰性位置
let k = 0;
const orSide = (b) => b || k++;
console.log(orSide(true), k);
console.log(orSide(false), k);

// 前缀不需要临时量（值就是新的），两种写法都要能在三元里
let n = 0;
console.log(true ? ++n : 0, n);
console.log(false ? 0 : ++n, n);

// 循环里混着用：惰性位置那一支与语句位置那一支必须给同一个答案
let a = 0;
let out = "";
for (let x = 0; x < 4; x++) {
  out += x % 2 === 0 ? `${a++}` : `${a}`;
}
console.log(out, a);
