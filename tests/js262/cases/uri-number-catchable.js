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
