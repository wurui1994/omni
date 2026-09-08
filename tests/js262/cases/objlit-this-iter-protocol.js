// 这一批量出来的四格（前三格是**静默分叉**，最后一格是 loud）：
// 1. 对象字面量里的方法拿错了 this —— 外层函数以为"我体里提到了 this"（mentionsThis 钻进了
//    方法体），开一格 this 装进 cell，方法于是捕获外层那一个而不是自己的接收者；
// 2. 类方法里造的对象字面量，它的方法也一样错（funcOf 那条"外层已经有 this 就不取"的遗留）；
// 3. 原始值那一族没有 Symbol.iterator：手写协议 a[Symbol.iterator]() 当场报错；
// 4. `const x = yield* g()` 从前是 loud 拒绝，现在摊成手写协议、拿 done 那次的 value。
function mk() { return { i: 0, next() { this.i = this.i + 1; return this.i; } }; }
const m = mk();
console.log(m.next(), m.next(), m.i);
class Box {
  constructor() { this.v = 1; }
  make() { return { v: 9, get2() { return this.v; }, outer: () => this.v }; }
}
const o = new Box().make();
console.log(o.get2(), o.outer(), o.v);
function outerFn() { return { v: 7, inner() { return { v: 8, deep() { return this.v; } }; } }; }
console.log(outerFn().inner().deep(), outerFn().v);
const withArrow = { v: 3, m() { const a = () => this.v; return a(); } };
console.log(withArrow.m());
// 手写迭代器协议：数组 / 串 / Map / Set 上的 Symbol.iterator 交出一格真的迭代器
const ai = [1, 2][Symbol.iterator]();
console.log(JSON.stringify(ai.next()), JSON.stringify(ai.next()), JSON.stringify(ai.next()));
console.log(JSON.stringify("ab"[Symbol.iterator]().next()));
console.log(JSON.stringify(new Map([["k", 1]])[Symbol.iterator]().next()));
console.log(JSON.stringify(new Set([5])[Symbol.iterator]().next()));
// yield* 的返回值（规范 27.5.3.7：done 那次的 value 就是整个 yield* 的值）
function* inner() { yield 1; yield 2; return "r"; }
function* outer() { const got = yield* inner(); yield got; }
console.log([...outer()].join(","));
function* over() { const got = yield* [7, 8]; yield String(got); }
console.log([...over()].join(","));
// new <运行期的值>()：类对象不是函数值，构造走它身上的 prototype 与 $init
class A {
  constructor(v) { this.v = v === undefined ? 1 : v; }
  static make(v) { return new this(v); }
}
class B extends A {}
console.log(A.make().v, A.make(7).v, A.make() instanceof A);
console.log(B.make(2).v, B.make(2) instanceof B, B.make(2) instanceof A);
const ctor = A;
console.log(new ctor(6).v, new ({ A: A }).A(5).v);
