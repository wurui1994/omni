// ES2023 的 change-by-copy 与"从后往前找"（lib）：findLast / findLastIndex /
// toReversed / with —— 都拷一份再改，原数组不动。
// with 的越界（规范里是 RangeError）不在这儿量：这个值域里它是当场 rt_error，
// 不是能 catch 的 JS 错误，那是画出来的边界。
console.log([1, 2, 3, 4].findLast((x) => x % 2 === 1), [1, 2, 3].findLastIndex((x) => x === 1));
console.log([].findLast((x) => true), [].findLastIndex((x) => true));
const xs = [1, 2, 3];
console.log(JSON.stringify(xs.toReversed()), JSON.stringify(xs));
console.log(JSON.stringify(xs.with(1, 9)), JSON.stringify(xs.with(-1, "z")), JSON.stringify(xs));
// 谓词收的还是 (v, i, arr) 三个实参，只是走的方向反过来
const seen = [];
[10, 20, 30].findLast((v, i, a) => { seen.push(`${i}:${v}:${a.length}`); return v === 20; });
console.log(seen.join(","));
console.log(JSON.stringify([3, 1, 2].toSorted()), JSON.stringify([3, 1, 2].toSorted((p, q) => q - p)));
