// 宿主抛出来的错要**能 catch**（ADR-0020）：JSON.parse 的语法错是 SyntaxError、
// JSON.stringify 碰上环是 TypeError。从前两样都是硬错（进程直接没了），环那一格更是
// 一路递归把栈撑爆。五条腿都走同一套（C 那侧用 setjmp 剥栈，JS 那侧用宿主的 throw）。
// 报错**文本**不量：三个引擎各写各的，这儿只量 name 与可 catch 性。
const names = [];
for (const s of ["", "{bad", "[1,]", "1 2", "{", "tru", "[1"]) {
  try { JSON.parse(s); names.push("ok"); } catch (e) { names.push(e.name); }
}
console.log(names.join(","));

try { JSON.parse("{"); } catch (e) {
  console.log(`${String(e instanceof SyntaxError)} ${String(e instanceof Error)} ${String(e.message.length > 0)}`);
}

// catch 之后还能接着跑
let acc = 0;
for (const s of ["1", "x", "2", "[", "3"]) {
  try { acc = acc + JSON.parse(s); } catch (e) { acc = acc + 100; }
}
console.log(String(acc));

// 好输入照旧
console.log(JSON.stringify(JSON.parse('{"a":[1,2],"b":{"c":null}}')));
console.log(`${String(JSON.parse("5"))} ${JSON.parse('"s"')} ${JSON.parse("[1,2]").join(",")}`);

// 环：当前路径上的祖先才算环
const cyc = { a: 1 };
cyc.self = cyc;
try { JSON.stringify(cyc); } catch (e) { console.log(`cyc ${e.name} ${String(e instanceof TypeError)}`); }
const arrCyc = [1];
arrCyc.push(arrCyc);
try { JSON.stringify(arrCyc); } catch (e) { console.log(`arr ${e.name}`); }

// 兄弟位置上的同一格对象不是环
const shared = { v: 1 };
console.log(JSON.stringify({ a: shared, b: shared, c: [shared, shared] }));
console.log(JSON.stringify({ ok: true }));
