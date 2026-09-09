/* 自有属性那四个视图（ADR-0020）：hasOwnProperty / `in` / getOwnPropertyDescriptor /
   own_keys 那一族必须彼此一致，也必须与 node 一致。
   两处从前是静默分叉的：一，运行时自己的隐藏槽（$ms / $st / $gst / $src / $cls）
   在前三个视图里露了出来；二，hasOwnProperty 在 JS 那条腿上只认真对象当接收者
   （[1,2].hasOwnProperty("0") 是 false），而 C 那条腿上压根找不着那格函数。 */
function* g() { yield 1; }
const rows = [
  ["date", new Date(0), "$ms"],
  ["prom", Promise.resolve(1), "$st"],
  ["gen", g(), "$gst"],
  ["iter", [1, 2][Symbol.iterator](), "$src"],
];
for (const [nm, o, k] of rows) {
  console.log(nm, o.hasOwnProperty(k), k in o,
    Object.getOwnPropertyDescriptor(o, k) === undefined,
    Object.keys(o).length, Object.getOwnPropertyNames(o).length,
    Reflect.ownKeys(o).length, Object.keys({ ...o }).length);
}

// 异常对象：$cls 是内部的；name 住在原型上（不是自有），message 是自有的
const e = new TypeError("boom");
console.log(e.hasOwnProperty("$cls"), "$cls" in e,
  Object.getOwnPropertyDescriptor(e, "$cls") === undefined);
console.log(e.hasOwnProperty("message"), "message" in e, e.hasOwnProperty("name"), "name" in e);
console.log(Object.keys({ ...e }).join(","));

// 四种接收者都要认
console.log([1, 2].hasOwnProperty("0"), [1, 2].hasOwnProperty("2"),
  [1, 2].hasOwnProperty("length"), "0" in [1, 2]);
console.log(typeof [1, 2].hasOwnProperty, typeof (5).hasOwnProperty);
console.log(Object.prototype.hasOwnProperty.call([1, 2], "1"));
console.log("ab".hasOwnProperty("0"), "ab".hasOwnProperty("5"), "ab".hasOwnProperty("length"));
const d = { a: 1 };
console.log(d.hasOwnProperty("a"), d.hasOwnProperty("b"), "a" in d);
const p = Object.create({ z: 9 });
p.y = 1;
console.log(p.hasOwnProperty("z"), "z" in p, p.hasOwnProperty("y"));

// 展开一格真对象：隐藏槽不可枚举，所以什么都不抄
console.log(Object.keys({ ...new Date(0) }).length, Object.keys({ ...g() }).length);
const merged = Object.assign({ keep: 1 }, new Date(0), { add: 2 });
console.log(Object.keys(merged).sort().join(","));
