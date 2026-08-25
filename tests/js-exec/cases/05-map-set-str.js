// Map / Set / 模块级状态 / 字符串与正则 / JSON
const m = new Map();
m.set("k", 1);
m.set(2, "two");
console.log(String(m.size));
console.log(String(m.get("k")));
console.log(String(m.get(2)));
console.log(String(m.get("nope")));
console.log(String(m.has(2)));
console.log(String(m.has("2")));
console.log([...m.keys()].join(","));
console.log([...m.values()].join(","));
for (const [k, v] of m) {
  console.log(`entry ${k}=${v}`);
}
console.log(String(m.delete("k")));
console.log(String(m.size));

const s = new Set();
s.add("x");
s.add(1);
s.add("x");
console.log(String(s.size));
console.log(String(s.has(1)));
let items = "";
for (const v of s) {
  items = items + v + ";";
}
console.log(items);

// 模块级状态：顶层函数读写同一个槽
let hits = 0;
const seen = new Map();
function record(key) {
  hits = hits + 1;
  if (seen.has(key)) {
    seen.set(key, seen.get(key) + 1);
    return false;
  }
  seen.set(key, 1);
  return true;
}
console.log(String(record("a")));
console.log(String(record("a")));
console.log(String(record("b")));
console.log(`hits=${hits} distinct=${seen.size}`);

// 字符串
const text = "Hello, Omni";
console.log(String(text.length));
console.log(text.toUpperCase());
console.log(text.slice(7));
console.log(text.slice(-4));
console.log(String(text.indexOf("Omni")));
console.log(String(text.includes("mni")));
console.log(String(text.startsWith("Hello")));
console.log(text.split(", ").join("|"));
console.log(String(text.charCodeAt(0)));
console.log("  pad  ".trim() + "!");
console.log("ab".repeat(3));
console.log(String("7".padStart(3, "0")));
console.log(String(text.at(-1)));

// 正则：字面量直接用在使用点上
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
console.log(String(IDENT.test("ok_1")));
console.log(String(IDENT.test("1no")));
console.log(String(/\d+/.test("x42")));
console.log("a1b22c".replace(/\d+/g, "#"));
console.log("a1b22c".split(/\d+/).join("|"));
console.log(String("a1b22c".match(/\d+/g).join(",")));
console.log(JSON.stringify({ n: 1, s: "x", arr: [true, null] }));
console.log(JSON.stringify([1, 2], undefined, 2));
