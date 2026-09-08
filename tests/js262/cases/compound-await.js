// 复合赋值的右边是 await / yield：`s += await f()` 从前是当场拒（"split it into two
// statements"），现在摊成两句 —— 先把挂起的值接进临时量，再做那次复合赋值。
// 目标只收"读两次也没差别"的形状（名字，或者对象是名字的成员）。
async function one(v) { return v; }
(async () => {
  let s = 0;
  for (let i = 0; i < 4; i++) s += await one(i);
  console.log("sum", s);
  let t = "a";
  t += await one("b");
  t += await one("c");
  console.log("cat", t);
  const o = { n: 1, arr: [] };
  o.n += await one(41);
  o.n *= await one(2);
  console.log("mem", o.n);
  let m = 8;
  m -= await one(3);
  m /= await one(5);
  m **= await one(2);
  console.log("ops", m);
  let n = null;
  n ??= await one(5);
  n ||= await one(9);
  n &&= await one(7);
  console.log("logic", n);
  // 生成器那边同一条路
  function* g() {
    let acc = 0;
    acc += yield 1;
    acc += yield 2;
    return acc;
  }
  const it = g();
  it.next();
  it.next(10);
  console.log("gen", JSON.stringify(it.next(20)));
})();
