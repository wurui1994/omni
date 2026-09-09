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

// 解构的默认值也是**惰性位置**：属性/元素在的时候那个表达式一次都不该跑。会抛的调用会被
// guard 提成"临时量 + 一次 pending 检查"，那两句从前摊在整条 If 前面 —— 于是每次都算。
const ev = [];
const gv = (t, v) => { ev.push(t); return v; };
const { d1 = gv("d1", 1) } = { d1: 0 };
const { p2: d2 = gv("d2", 2) } = { p2: 0 };
const [d3 = gv("d3", 3)] = [0];
const { p4: { d4 = gv("d4", 4) } = gv("obj4", {}) } = { p4: { d4: 0 } };
let d5;
({ d5 = gv("d5", 5) } = { d5: 0 });
console.log(`dflt ${d1}${d2}${d3}${d4}${d5} [${ev.join(",")}]`);
// 缺席的那几格照旧要算，而且只算一次
const { e1 = gv("e1", 1) } = {};
const [e2 = gv("e2", 2)] = [];
console.log(`dflt ${e1}${e2} [${ev.join(",")}]`);
