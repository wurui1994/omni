/* 宿主抛出来的错要**能 catch**（ADR-0020）。从前 JSON.parse 的语法错是硬错
   （omni: runtime error + 退出码 70），`try { JSON.parse(s) } catch {}` 这一格最常见的
   写法整个进程就没了；JSON.stringify 碰上环则是一路递归把宿主的栈撑爆 —— 那是崩，
   比错答案还糟。现在两样都翻成 pending 的 Error 值（js_json_parse / js_json_stringify
   在 ABI 表里本来就是 throws: true，调用点的检查早就发了）。
   报错**文本**不在这儿量：三个引擎各写各的（qjs 说 "expecting property name"、
   node 说 "Unexpected token b"），这一格我们照自己那套写，只有 name 与可 catch 性对齐。 */
const names = [];
for (const s of ["", "{bad", "[1,]", "1 2", "{", '{"a"', '{"a":}', "tru", "01", "-", "[1"]) {
  try { JSON.parse(s); names.push("ok"); } catch (e) { names.push(e.name); }
}
console.log(names.join(","));
console.log(names.every((n) => n === "SyntaxError"));

// e 是真正的 Error 值：instanceof / message 都在
try { JSON.parse("{"); } catch (e) {
  console.log(e instanceof SyntaxError, e instanceof Error, typeof e.message, e.message.length > 0);
}

// catch 之后还能接着跑（硬错那会儿这一段根本到不了）
let acc = 0;
for (const s of ["1", "x", "2", "[", "3"]) {
  try { acc += JSON.parse(s); } catch (e) { acc += 100; }
}
console.log(acc);

// 好输入照旧
console.log(JSON.stringify(JSON.parse('{"a":[1,2],"b":{"c":null}}')));
console.log(JSON.parse("5"), JSON.parse('"s"'), JSON.parse(" true "), JSON.parse("[1,2]").join(","));

/* 环：规范抛 TypeError。seen 是**当前路径上的**容器栈，所以同一格对象出现在兄弟位置上
   仍然合法（下面第二组），只有落在自己的祖先里才算环。 */
const cyc = { a: 1 };
cyc.self = cyc;
try { JSON.stringify(cyc); } catch (e) { console.log("cyc", e.name, e instanceof TypeError); }
const arrCyc = [1];
arrCyc.push(arrCyc);
try { JSON.stringify(arrCyc); } catch (e) { console.log("arr", e.name); }
const deep = { x: { y: {} } };
deep.x.y.back = deep.x;
try { JSON.stringify(deep); } catch (e) { console.log("deep", e.name); }

// 兄弟位置上的同一格对象不是环
const shared = { v: 1 };
console.log(JSON.stringify({ a: shared, b: shared, c: [shared, shared] }));

// 抛完之后 stringify 还能正常用
console.log(JSON.stringify({ ok: true }));
