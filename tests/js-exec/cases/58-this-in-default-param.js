// 形参的**默认值里**提到 `this`（箭头捕获它）。
//
// 从前这条路是坏的：`funcOf` 判"要不要在入口取一次接收者、要不要把它装进 cell"，问的是
// `bodyStmts`——而默认值不在体里。于是 `m(s, f = () => this.val(s))` 这一格既不发
// `js_this_take` 也不装 cell，箭头里的 `this` 是 undefined，当场
// `cannot read property 'val' of undefined`。
//
// 判据是这份编译器自己：`Lower.forOf(s, seqOf = () => op(…, [this.expr(s.right)]))` 正是
// 这个形状，于是原生腿上 `emit c src/cli.js`（fix:self 那一条）栽在它上面 —— 而 node 腿
// 看不出来，因为那一趟跑的是 node 自己的 this。判分的人是 node，以后不会再悄悄坏掉。
//
// 与 `capturedNames(params)` 是同一类漏（那一格治的是默认值里的**自由变量**），
// 这一条治的是默认值里的 **this**。

class K {
  constructor(v) { this.v = v; }
  val(x) { return this.v + x; }
  // 默认值用到 this：省略实参时走它，给了实参就不该求值
  go(s, f = () => this.val(s)) { return f(); }
  // 默认值里的箭头被**返回**出去：cell 必须真的活过这次调用
  later(s, f = () => this.val(s)) { return f; }
  // 体里一个 this 都没有，只有默认值里有 —— 正是漏掉的那一格
  onlyDefault(f = () => this.v) { return f(); }
}

const k = new K(7);
console.log(k.go(1));
console.log(k.go(2, () => 100));
console.log(k.later(3)());
console.log(k.onlyDefault());
console.log(k.onlyDefault(() => -1));

// 普通函数（不是方法）上的同一形状：this 是调用接收者
const obj = {
  n: 5,
  read: function (f = () => this.n) { return f(); },
};
console.log(obj.read());

// 默认值里的箭头同时用到**外层形参**与 this（两条捕获一起走）
class Pair {
  constructor(a) { this.a = a; }
  join(b, f = () => this.a + ':' + b) { return f(); }
}
console.log(new Pair('x').join('y'));

// 嵌套：默认值里的箭头里再套一层箭头
class Deep {
  constructor(v) { this.v = v; }
  run(f = () => (() => this.v * 2)()) { return f(); }
}
console.log(new Deep(6).run());
