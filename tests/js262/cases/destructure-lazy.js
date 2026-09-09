/* 数组解构走**迭代器协议**（规范 8.6.2）：一格取一次就往前走一格，取完了（没有 rest）
   补一次 `return()`。从前是先把迭代器抽干再按下标取 —— 于是 `const [a, b] = 无穷生成器()`
   直接**挂住**（量出来的 30s 超时），而部分取用时带 finally 的生成器也漏掉清理。
   声明位置（const [a] = …）与赋值位置（[a] = …）两条路都要。 */
function* nat() { let n = 0; while (true) yield n++; }
const [a, b] = nat();
console.log(a, b);
let c, d;
[c, d] = nat();
console.log(c, d);

function* fin(tag) {
  try { yield 1; yield 2; yield 3; } finally { console.log("fin", tag); }
}
const [one] = fin("decl");
console.log(one);
let two;
[two] = fin("assign");
console.log(two);

// 取完了正好 done：不再多走一格，也不用 return()
function* justTwo() { try { yield 1; yield 2; } finally { console.log("fin2"); } }
const [j1, j2] = justTwo();
console.log(j1, j2);

// 空位也要走一格
const [, second] = nat();
console.log(second);
let s2;
[, s2] = nat();
console.log(s2);

// 有 rest 就抽到 done（规范也是抽干），所以只在有限的东西上用
const [h, ...rest] = [1, 2, 3];
console.log(h, rest.join(","));
const [g1, ...g2] = fin("rest");
console.log(g1, g2.join(","));

// 默认值只在 undefined 时用；嵌套模式再来一层
const [p = 9, [q] = [8]] = [undefined];
console.log(p, q);
/* 默认值那个表达式是**惰性位置**：那一格在的时候一次都不该跑。会抛的调用被 guard 提成
   "临时量 + 一次 pending 检查"，那两句从前摊在整条 If 前面 —— 于是副作用每次都发生。 */
const ev = [];
const gv = (t, v) => { ev.push(t); return v; };
const { d1 = gv("d1", 1) } = { d1: 0 };
const { p2: d2 = gv("d2", 2) } = { p2: 0 };
const [d3 = gv("d3", 3)] = [0];
const { p4: { d4 = gv("d4", 4) } = gv("obj4", {}) } = { p4: { d4: 0 } };
let d5;
({ d5 = gv("d5", 5) } = { d5: 0 });
console.log(d1, d2, d3, d4, d5, `[${ev.join(",")}]`);
// 缺席的那几格照旧要算，而且只算一次
const { e1 = gv("e1", 1) } = {};
const [e2 = gv("e2", 2)] = [];
let e3;
({ e3 = gv("e3", 3) } = {});
console.log(e1, e2, e3, `[${ev.join(",")}]`);
// 成员目标
const o = {};
[o.x, o.y] = nat();
console.log(o.x, o.y);
// 数组身上把手就是它自己（与从前等价）
const [z1, z2, z3] = [7, 8];
console.log(z1, z2, String(z3));
// 字符串按码点
const [c1, c2] = "ab";
console.log(c1, c2);
// Map / Set 照旧
const [mk] = new Map([["k", 1]]);
console.log(mk.join(":"));
