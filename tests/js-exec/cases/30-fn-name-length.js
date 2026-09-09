// fn.name / fn.length 在五条腿上（ADR-0020 P1-c）。函数在这个值域里还不是真对象，
// 这两格是 Function.prototype 上的两个访问器：JS 与两条解释器腿把值存在闭包记录里
// （$nm / $ln），C 那条腿按闭包**模板**查一张按 fp 索引的静态表（omni_js_fn_meta）。
function foo(a, b) { return a + b; }
console.log(foo.name, foo.length);

// 具名函数表达式：name 是它自己的名字，不是变量名
const bar = function baz(a) { return a; };
console.log(bar.name, bar.length);

// 匿名的那两种：名字来自赋值目标
const arrow = (x, y) => x;
const anon = function () { return 1; };
console.log(arrow.name, arrow.length, anon.name, anon.length);

// 方法（对象上与类上各一个，静态的也算）
const obj = { m(a, b, c) { return a; } };
console.log(obj.m.name, obj.m.length);
class C { hi(a) { return a; } static there(a, b) { return a; } }
console.log(new C().hi.name, new C().hi.length, C.there.name, C.there.length);

// length 数到第一个带默认值的形参之前；rest 不算
function withDefault(a, b = 2, c) { return a; }
function withRest(a, ...rest) { return a; }
console.log(withDefault.length, withRest.length);
