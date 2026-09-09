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
/* 协议里那两格错都是**能 catch** 的 TypeError（规范 7.4.2 的 GetIterator、7.4.4 的
   IteratorNext），从前是硬错、整个进程停在那儿。而且要**当场**响：报了不马上查就成了另一种
   静默 —— js_iter 因此带上 throws（量出来的：那一句照跑完，catch 到下一句才生效）。
   `e.constructor.name` 这一格还给 "Object"（运行期抛的错身上那格构造器没接上，记在
   ADR-0020 的"没做"里），所以这儿量 e.name 与 instanceof。 */
try { const bad = [...null]; console.log("no-throw", bad.length); }
catch (e) { console.log("iter", e.name, e instanceof TypeError); }
try { for (const x of 5) console.log("never", x); }
catch (e) { console.log("iter", e.name, e instanceof TypeError); }
try { const [p] = undefined; console.log("no-throw", p); }
catch (e) { console.log("iter", e.name, e instanceof TypeError); }
// next 交出来的不是对象（规范 7.4.4 第 3 步）
const badNext = { [Symbol.iterator]() { return { next() { return 1; } }; } };
try { console.log("no-throw", [...badNext].length); }
catch (e) { console.log("next", e.name, e instanceof TypeError); }
// 没有 Symbol.iterator 的真对象
try { console.log("no-throw", [...{ a: 1 }].length); }
catch (e) { console.log("noiter", e.name, e instanceof TypeError); }
// 报过之后照旧往下跑
console.log("after");
