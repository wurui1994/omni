const pairs = [["x", 1], ["y", 2], ["x", 3]];
console.log(JSON.stringify(Object.fromEntries(pairs)));
console.log(JSON.stringify(Object.fromEntries(new Map([["a", 1], ["b", [2]]]))));
console.log(JSON.stringify(Object.fromEntries([[1, "n"], [true, "b"]])));
console.log(Object.keys(Object.fromEntries(pairs)).join(","));

const items = ["ada", "bo", "cy", "dee"];
const g = Object.groupBy(items, (s) => (s.length > 2 ? "long" : "short"));
console.log(JSON.stringify(g));
console.log(Object.keys(g).join(","), g.long.join("+"));
const gi = Object.groupBy([10, 11, 12], (v, i) => i % 2);
console.log(JSON.stringify(gi));
console.log(JSON.stringify(Object.groupBy([], (v) => v)));
