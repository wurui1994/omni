/* URI 那一族与位数/进制那一族的错也是**能 catch 的**（ADR-0020，与 json-catchable.js
   同一条路：出错点抛信号，入口翻成 pending 的 Error 值）。从前它们都是硬错
   （omni: runtime error + 退出码 70），一段带 try 的正常代码会把整个进程带走。
   报错**文本**不在这儿量：三个引擎各写各的，只有 name 与可 catch 性对齐。 */
const uris = [];
for (const s of ["%", "%A", "%zz", "%E0%A4%A", "%C0%80", "%F5%80%80%80"]) {
  try { decodeURIComponent(s); uris.push("ok"); } catch (e) { uris.push(e.name); }
}
console.log(uris.join(","));
console.log(uris.every((n) => n === "URIError"));
// 编码那一侧：落单的代理项就是畸形
try { encodeURIComponent("\uD800"); } catch (e) { console.log("enc", e.name, e instanceof URIError); }
// 好输入照旧
console.log(decodeURIComponent("%E4%BD%A0"), encodeURIComponent("a b"), encodeURI("a/b?c=1"));

// 位数与进制越界是 RangeError
try { (0).toFixed(200); } catch (e) { console.log("fix", e.name, e instanceof RangeError); }
try { (0).toExponential(-1); } catch (e) { console.log("exp", e.name); }
try { (5).toString(1); } catch (e) { console.log("rad", e.name); }
try { (5).toPrecision(0); } catch (e) { console.log("prec", e.name); }
console.log((1.5).toFixed(2), (255).toString(16), (1.5).toPrecision(3), (1234).toExponential(2));

// catch 之后还能接着跑（硬错那会儿这一段根本到不了）
let acc = 0;
for (const r of [2, 1, 16, 40]) {
  try { acc += (255).toString(r).length; } catch (e) { acc += 100; }
}
console.log(acc);

/* 又几格从前是硬错、现在能 catch 的：数组长度越界（规范 23.1.1.1 / 10.4.2.4）、
   BigInt(串) 的语法错与 BigInt(非整数)（7.1.14 / 7.1.13）、还有串长上限 ——
   最后那一格从前是**宿主**的 RangeError 一路冒到顶把进程崩掉（印出一整片 node 栈）。 */
function kind(f) {
  try { f(); return "no-throw"; } catch (e) { return `${e.name}:${e instanceof RangeError}`; }
}
console.log(kind(() => new Array(-1)), kind(() => new Array(2 ** 33)), kind(() => { [].length = -1; }));
console.log(kind(() => "x".padStart(2 ** 31)), kind(() => "x".repeat(2 ** 30)), kind(() => "x".repeat(-1)));
console.log(kind(() => BigInt(1.5)), kind(() => BigInt(Infinity)));
function bigkind(f) {
  try { return `${f()}`; } catch (e) { return `${e.name}:${e instanceof SyntaxError}`; }
}
console.log(bigkind(() => BigInt("x")), bigkind(() => BigInt("12")), bigkind(() => BigInt("")), bigkind(() => BigInt(" 0x10 ")));
console.log(bigkind(() => BigInt("+7")), bigkind(() => BigInt("-8")), bigkind(() => BigInt("1.5")), bigkind(() => BigInt("0b")));
console.log(new Array(2).length, new Array(0).length, "x".repeat(3), "y".padStart(3, "0"));
