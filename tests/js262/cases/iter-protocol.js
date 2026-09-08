// 迭代器协议：自定义 [Symbol.iterator]、for-of、展开、解构
const range = {
  from: 1,
  to: 4,
  [Symbol.iterator]() {
    let cur = this.from;
    const last = this.to;
    return { next() { return cur <= last ? { value: cur++, done: false } : { value: undefined, done: true }; } };
  },
};
const out = [];
for (const v of range) out.push(v);
console.log(out.join(","));
console.log([...range].join("-"));
const [a, b, ...rest] = range;
console.log(a, b, rest.join(","));
console.log(Array.from(range).length);
