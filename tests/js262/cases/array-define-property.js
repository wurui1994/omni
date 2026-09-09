/* 数组上的 Object.defineProperty（ADR-0020）。list 是一排稠密的 dyn + 一张旁表，**没有
   描述符这一层**，所以只收"能原样表达出来"的那一种形状；别的当场报，不写一半进去。
   要留神**新键的默认是 false**：`defineProperty(a, "tag", { value: v })` 在 JS 里建的是一格
   **不可枚举**的属性，而旁表没有这一层 —— 所以新键必须把 enumerable 明写成 true。 */
const b = [1, 2, 3];
Object.defineProperty(b, "1", { value: 9 });
console.log(JSON.stringify(b), b.length);
// 键是数也认（规范先 ToPropertyKey）
Object.defineProperty(b, 2, { value: 7 });
console.log(JSON.stringify(b));

// 非下标的新键：三个位明写成 true 才收，那一格等于 b.tag = "t"
Object.defineProperty(b, "tag", { value: "t", enumerable: true, writable: true, configurable: true });
console.log(b.tag, Object.keys(b).join(","));
// 已有的键：缺的字段保持原样，所以 { value } 一种就够
Object.defineProperty(b, "tag", { value: "t2" });
console.log(b.tag, Object.keys(b).join(","));

// 已有下标上的 { value } 与直接赋值同一格：三个位都留在 true 上
const c = [1, 2];
Object.defineProperty(c, 0, { value: 5 });
c[0] = 6;
console.log(c.join(","), Object.keys(c).join(","), JSON.stringify(Object.getOwnPropertyDescriptor(c, "0")));

// 真对象上照旧是完整的描述符语义（这一格没变）
const o = {};
Object.defineProperty(o, "hidden", { value: 1 });
console.log(Object.keys(o).length, o.hidden, JSON.stringify(Object.getOwnPropertyDescriptor(o, "hidden")));
