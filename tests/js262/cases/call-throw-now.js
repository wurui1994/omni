// 调用会抛的两格，从前都不对：
//  1. 被调的那一段自己 throw：js_call_this / js_call_fn 不带 throws，于是"报了不马上查" ——
//     量出来的是 try { o.m(); log.push("after") } catch … 里 after 先印了、错到下一句才被接住。
//  2. 取到的那一格不是函数（o.foo() 里 foo 不存在）：规范里是**能 catch** 的 TypeError，
//     从前是硬错，整个程序当场没了，try/catch 拦不住。消息跟 qjs：not a function。
const o = { m() { throw new Error("x"); }, n() { return 1; } };
const log = [];
try { o.m(); log.push("after"); } catch (e) { log.push("caught " + e.message); }
console.log(log.join("|"));
const log2 = [];
try { o.m(); log2.push("after1"); o.n(); log2.push("after2"); } catch (e) { log2.push("caught"); }
console.log(log2.join("|"));

const r = [];
const t = (l, f) => { try { r.push(l + "=" + String(f())); } catch (e) { r.push(l + "!" + e.name + ": " + e.message); } };
t("obj", () => o.foo());
t("str", () => "s".zork());
t("arr", () => [1].zork());
t("num", () => (5).zork());
t("dyn", () => { const f = o.foo; return f(); });
t("still-works", () => o.n());
console.log(r.join("\n"));
