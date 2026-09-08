// fn.name / fn.length（ADR-0020）。
//
// 函数在这个值域里还不是**真对象**，所以这两格不是自有属性，而是 Function.prototype 上的
// 两个访问器；值存在闭包记录里（`$nm` / `$ln`），由降级器（closureOf / topFnValue）与
// 发射器（closureMake）一起填。这一族只有 JS 那条腿 —— C 侧的闭包记录里还没有这两格，
// 那儿读 `f.name` 会当场报错（不是悄悄给 undefined），所以这条用例走 js262 这道门。

function foo(a, b) {}
console.log(foo.name, foo.length);

// 具名函数表达式：name 是**它自己的**名字，不是变量名
const bar = function baz(a) {};
console.log(bar.name, bar.length);

// length 数到第一个带默认值的形参之前（rest 不算）
function withDefault(a, b = 2, c) {}
console.log(withDefault.length);
function withRest(a, ...rest) {}
console.log(withRest.length);

// 方法（对象与类上各一个）
const obj = { m(a, b, c) {}, ["computed"]() {} };
console.log(obj.m.name, obj.m.length);
class C {
  hi(a) {}
  static there(a, b) {}
}
console.log(new C().hi.name, new C().hi.length);
console.log(C.there.name, C.there.length);

// 内建的静态面（Object.keys / Math.max 那一族）在这个值域里**只能调用**，取不出函数值来
// （封闭 ABI，ADR-0011 决策 2），所以它们的 name / length 不在这条用例里。

// bind 出来的那一格照规范是 "bound f"，这儿只给 "bound"（记在 prelude 的 funP.bind 上）
const bound = foo.bind(null);
console.log(typeof bound.name);
