// 抛的设值器：错要**当场**被接住，不能等到下一句
const o = {};
Object.defineProperty(o, "x", { set(v) { throw new TypeError("no set"); }, get() { return 1; } });
const log = [];
try { o.x = 5; log.push("after-write"); } catch (e) { log.push("caught " + e.message); }
console.log(log.join("|"));

// a.length = -1 是 RangeError（10.4.2.4），同样当场
const a = [1, 2, 3];
const log2 = [];
try { a.length = -1; log2.push("after"); } catch (e) { log2.push("caught " + e.name); }
console.log(log2.join("|"), a.length);

// 下标写法同一格
const o2 = {};
Object.defineProperty(o2, "k", { set(v) { throw new TypeError("no k"); } });
const log3 = [];
try { o2["k"] = 1; log3.push("after"); } catch (e) { log3.push("caught " + e.message); }
console.log(log3.join("|"));

// 不抛的时候一格不变
const p = { v: 0 };
p.v = 7; p["v"] += 1;
const arr = [0];
arr[0] = 9; arr.length = 3;
console.log(p.v, arr.length, String(arr[0]));
