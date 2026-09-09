// unshift 的多实参：op 是定长的（一次插一格），所以降级时倒着摊成一串调用。
// 三件要对上的事：插进去的**次序**、返回的**新长度**、实参的**求值次序**（从左到右）。
const a = [3, 4];
console.log(a.unshift(1, 2));
console.log(a.join(","));

const seen = [];
const f = (v) => { seen.push(v); return v; };
const b = [];
console.log(b.unshift(f("x"), f("y"), f("z")));
console.log(b.join(","), seen.join(","));

// 一个实参那条老路不能被带歪
const c = [9];
console.log(c.unshift(0), c.join(","));

// 空数组 + 多实参
const d = [];
console.log(d.unshift(1, 2, 3), d.join(","));
