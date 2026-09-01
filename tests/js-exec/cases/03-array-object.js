// 数组与对象：字面量、下标、方法、for-of、展开、解构
const xs = [3, 1, 2];
console.log(String(xs.length));
console.log(String(xs[0]));
console.log(String(xs[9]));
xs.push(4);
console.log(xs.join(","));
console.log(xs.slice(1, 3).join(","));
console.log(String(xs.indexOf(2)));
console.log(String(xs.includes(9)));
console.log(xs.concat([7, 8]).join(","));

let total = 0;
for (const x of xs) {
  total = total + x;
}
console.log(`for-of total=${total}`);

let acc = "";
for (const ch of "héllo") {
  acc = acc + ch + ".";
}
console.log(acc);

const more = [0, ...xs, 9];
console.log(more.join(","));

const o = { a: 1, b: "two", "c-d": 3 };
console.log(String(o.a));
console.log(String(o.b));
console.log(String(o["c-d"]));
console.log(String(o.missing));
o.a = 10;
o["e"] = 5;
console.log(String(o.a + o.e));
console.log(Object.keys(o).join(","));
console.log(Object.values(o).join(","));
console.log(String("a" in o));
console.log(String(delete o.a));
console.log(Object.keys(o).join(","));

const nested = { list: [1, 2], inner: { deep: "yes" } };
console.log(String(nested.list[1]));
console.log(nested.inner.deep);
nested.list[0] = 100;
console.log(nested.list.join(","));

const [first, second, ...rest] = [10, 20, 30, 40];
console.log(`${first} ${second} ${rest.join("|")}`);
const { a: renamed, b } = { a: 1, b: 2 };
console.log(`${renamed} ${b}`);
const [withDefault = 5] = [];
console.log(String(withDefault));

let counter = 0;
counter += 5;
counter -= 2;
counter *= 3;
console.log(String(counter));
const box = { n: 1 };
box.n += 41;
console.log(String(box.n));
const arr2 = [1];
arr2[0] += 9;
console.log(String(arr2[0]));

let i = 0;
const post = i++;
const pre = ++i;
console.log(`post=${post} pre=${pre} i=${i}`);

let maybe = null;
maybe ??= "filled";
console.log(maybe);
let flag = 1;
flag ||= 99;
console.log(String(flag));
console.log(String(nested.nope?.deep));
// ?. 的短路是整条链的：nope 是 undefined，后面的 .list / .find / [0] 都不该发生
console.log(String(nested.nope?.list.find((x) => x > 0)));
console.log(String(nested.nope?.list[0]));
console.log(String(nested.nope?.list.join(",")));
console.log(String(nested.list?.find((x) => x > 1)));
console.log(String(JSON.stringify({ k: [1, "s", true, null] })));

// 数组身上挂字段：JS 里数组也是对象。asy 前端的 do-while 就往那一格更新列表上挂一个 dw
// （stmts.js 的 `ctx.dw = []`），从前这个值域里一读就 "dynamic value is list, expected dict"。
// 元素与属性互不干扰：length 只数元素，for-of 只走元素。
const withProp = [1, 2];
console.log(String(withProp.tag));
withProp.tag = "loop";
withProp.extra = [7];
console.log(`${withProp.tag} ${withProp.extra[0]} ${withProp.length}`);
withProp.push(3);
let propAcc = 0;
for (const v of withProp) propAcc = propAcc + v;
console.log(`${propAcc} ${withProp.length} ${withProp.join(",")}`);
console.log(String("tag" in withProp));
console.log(String(delete withProp.tag));
console.log(String(withProp.tag));
// 两个数组各自一份，互不串味
const a1 = [];
const a2 = [];
a1.mark = "one";
console.log(`${String(a1.mark)} ${String(a2.mark)}`);
// JSON 只看元素（宿主也是这样）
console.log(JSON.stringify(withProp));

// unshift：往头上插一格，回新长度（第一百〇四刀补的那格 ABI —— 编译器自己
// 往 `(main …)` 头上补一句时要它，而从前动态接收者上取 "unshift" 取到的是 undefined）
const uns = [2, 3];
console.log(`${uns.unshift(1)} ${uns.join(",")}`);
const uns0 = [];
console.log(`${uns0.unshift("a")} ${uns0.join(",")}`);
