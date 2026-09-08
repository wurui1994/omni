/* 类表达式（`const C = class {}`）。与类声明共用同一段降级，差别只在类对象与原型
   住哪儿：声明住模块级全局（方法只能建一次），表达式住一对临时量 —— 所以**每次求值
   都是一格新的类**。这一点是可观察的，下面第一行量的就是它。
   `typeof C` 不在这儿量：这个值域里类不是函数（给 "object"，qjs 给 "function"），
   那是画出来的边界，写在 ADR-0020 里。 */
function mk(n) {
  return class {
    static kind = "k" + n;
    #p = n * 10;
    v = n;
    get twice() { return this.v * 2; }
    set twice(x) { this.v = x / 2; }
    peek() { return this.#p; }
    static make() { return "s" + n; }
  };
}
const A = mk(1);
const B = mk(2);
console.log(A === B, A.kind, B.kind, A.make(), B.make());

const a = new A();
console.log(a.v, a.twice, a.peek());
a.twice = 10;
console.log(a.v);

// 两次求值造出来的类互不 instanceof
console.log(new A() instanceof A, new A() instanceof B);
console.log(Object.getPrototypeOf(new A()) === A.prototype, A.prototype.constructor === A);
// 匿名类的 name 是空串，length 是构造器的形参个数
console.log(JSON.stringify(A.name), A.length, Object.keys(a).join(","));

// 计算键、构造器、立刻 new、数组里的两格类
const key = "dyn";
const K = class { [key]() { return "d"; } static [key + "S"]() { return "ds"; } };
console.log(new K().dyn(), K.dynS());
const withCtor = class { constructor(x, y) { this.s = x + y; } };
console.log(new withCtor(2, 3).s, withCtor.length);
console.log((new (class { m() { return "imm"; } })()).m());
const pair = [class { m() { return 1; } }, class { m() { return 2; } }];
console.log(new pair[0]().m(), new pair[1]().m());

// 有名字的类表达式：名字落到 name 上
const D = class Named { static who() { return "w"; } };
console.log(D.name, D.who());

// 循环里每一圈一格新类，方法捕获那一圈的 i
let cnt = 0;
for (let i = 0; i < 3; i++) { const C = class { m() { return i; } }; cnt += new C().m(); }
console.log(cnt);
