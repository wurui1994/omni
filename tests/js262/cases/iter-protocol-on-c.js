class Bag {
  constructor() { this.items = [1, 2, 3]; }
  [Symbol.iterator]() {
    let i = 0;
    const xs = this.items;
    return { next() { return i < xs.length ? { value: xs[i++] * 10, done: false } : { value: undefined, done: true }; } };
  }
}
console.log([...new Bag()].join(","));
for (const v of new Bag()) console.log(v);
const [f, ...rest] = new Bag();
console.log(f, rest.join("|"));
console.log(Array.from(new Bag()).length, Math.max(...new Bag()));
try { [...{ a: 1 }]; } catch (e) { console.log(e.name, e.message); }
