// 排序那一族：默认比较器按串比、undefined 一律垫底且不进比较器、稳定、sort 交出同一格
// 数组、toSorted 不动原数组。比较器交出来的东西照规范先 ToNumber（23.1.3.30.2 第 3 步）——
// 交串的那种写法（"1" / "-1"）从前一律当 0，于是一格都不动、静静地把原次序交回去。
// 不量"只交布尔"那种比较器：它不是一致的比较函数，规范说次序由实现定，两把尺子确实不一样。
console.log([10, 9, 1, 100].sort().join(","));
console.log(["b", "a", "C"].sort().join(","), [1, "10", 2].sort().join(","));
const log = [];
console.log([3, undefined, 1].sort((a, b) => { log.push(`${a}/${b}`); return a - b; }).join(","), log.length);
console.log(JSON.stringify([undefined, 1].sort()), [undefined, undefined, 2].sort().length);
const a = [2, 1];
console.log(a.sort() === a, a.join(","));
// 稳定性：同键的相对次序不变
const items = [{ k: 1, i: 0 }, { k: 0, i: 1 }, { k: 1, i: 2 }, { k: 0, i: 3 }, { k: 1, i: 4 }];
console.log(items.sort((x, y) => x.k - y.k).map((o) => `${o.k}${o.i}`).join(","));
// 比较器交串 / 交 0 / 交 NaN / 交 undefined
console.log([3, 1, 2].sort((x, y) => x < y ? "-1" : (x > y ? "1" : "0")).join(","));
console.log([3, 1, 2].sort(() => NaN).join(","), [3, 1, 2].sort(() => undefined).join(","), [2, 1].sort(() => null).join(","));
// toSorted 拷一份
const b = [3, 1, 2];
console.log(b.toSorted().join(","), b.join(","), b.toSorted((x, y) => y - x).join(","));
// 当值用：原型上那一格函数（[].sort 从前是 undefined）
console.log([].sort.length, [].sort.name, [].toSorted.length, typeof [].sort);
const xs = [3, 1, 2];
console.log(Array.prototype.sort.call(xs, (x, y) => x - y).join(","), xs.join(","));
console.log(Array.prototype.toSorted.call([3, 1, 2]).join(","));
// 串的关系比较按码元（sort 的默认比较器踩的就是这一格）
console.log("Z" < "a", "\u{1F600}" > "\uFFFF", "ab" < "b", "" < "a");
