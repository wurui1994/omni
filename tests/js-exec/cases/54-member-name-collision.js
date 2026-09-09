/* 用户自己的方法与内建成员**同名**（ADR-0011 决策 12）。
   splice / toSpliced / push 这三条收可变实参，所以降级器不走定长的成员派发器、直接发
   js_arr_splice / js_arr_to_spliced / js_arr_push_all —— 静态分不出接收者，只能在运行期
   看标签。push 早就有那一句，splice / toSpliced 从前没有：于是 C 前端里的
   Cpp.splice()（"跳过行拼接"）在**两条编出来的腿上都炸** ——
   C 是 "dynamic value is object, expected list"、emit-js 是 "object is not an array"，
   而 node 直接跑源码时它是一次普通的方法调用，所以那条路一直是绿的。 */
class Cpp {
  constructor() { this.n = 0; this.log = []; }
  splice() { this.n++; return "spliced-" + this.n; }
  toSpliced(a, b) { return "ts:" + a + "," + b; }
  push(x) { this.log.push(x); return this.log.length; }
}
const c = new Cpp();
console.log(c.splice());
console.log(c.splice());
console.log(c.toSpliced(1, 2));
console.log(c.push("a"), c.push("b"), c.log.join(","));

// 真数组那一侧照旧：实参个数是语义的一部分（splice(1) 删到底，splice(1, 2) 只删两格）
const a = [1, 2, 3, 4];
console.log(a.splice(1).join(","), a.join(","));
const b = [1, 2, 3, 4];
console.log(b.splice(1, 2).join(","), b.join(","));
console.log([1, 2, 3].toSpliced(1, 1, 9).join(","));

// 普通对象上挂的同名函数值也一样
const o = { splice: (x) => "obj:" + x, toSpliced: () => "obj-ts" };
console.log(o.splice(7), o.toSpliced());
