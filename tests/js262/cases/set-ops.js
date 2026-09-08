// Set 的集合运算（ES2025）。量的重点是**次序**：
//   union 先接收者的次序，再把实参里新的接在后面
//   intersection / isDisjointFrom 走**小的那个**，所以 a∩b 与 b∩a 次序一致
//   difference 以接收者的次序为主，symmetricDifference 再把实参独有的接在后面
// 实参必须是真 Set（qjs 那边非 set-like 是 TypeError，这儿是当场报错，不在这条里量）。
const a = new Set([5, 1, 9]), b = new Set([9, 1, 7, 3, 5]);
console.log([...a.union(b)].join(","), [...b.union(a)].join(","));
console.log([...a.intersection(b)].join(","), [...b.intersection(a)].join(","));
console.log([...a.difference(b)].join(","), [...b.difference(a)].join(","));
console.log([...a.symmetricDifference(b)].join(","), [...b.symmetricDifference(a)].join(","));
console.log(a.isSubsetOf(b), new Set([1, 5]).isSubsetOf(a), a.isSupersetOf(new Set([5])));
console.log(a.isDisjointFrom(new Set([2])), a.isDisjointFrom(b), new Set().isDisjointFrom(a));
// 原来那两个集合一格没动
console.log([...new Set().union(a)].join(","), [...a.intersection(new Set())].join(","), a.size, b.size);
// 键按 SameValueZero 比：串与数不撞
const mix = new Set([1, "1"]);
console.log(mix.size, [...mix.union(new Set(["1", 2]))].join("|"));
