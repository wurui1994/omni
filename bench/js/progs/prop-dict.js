// bench/js/progs/prop-dict.js —— **对象字面量上的属性读**（J4b 那一格）
//
// 与 prop-mono/prop-poly 的分别：这一份的对象是**字面量**，在这条腿上是 `OMNI_DYN_DICT`
// （真对象 `OMNI_DYN_OBJ` 是 `new`/带属性位的那一族）。两种表示走的是两条查找路，
// 所以 IC 也得分两格 —— 这一份就是量那一格的。
//
// 形状照**我们自己这个编译器**来：一棵节点树、按 `e.kind` 派发、字段名落在不同的下标上。
// 那是 C 腿上 `omni check src/cli.js` 最热的一条（omni_js_obj.h 里那条注写着这件事）。
const N = 400000;

function mk(i) {
  if (i % 3 === 0) return { kind: 'Bin', op: '+', a: { kind: 'Num', v: i }, b: { kind: 'Num', v: 1 } };
  if (i % 3 === 1) return { pad1: 0, pad2: 0, kind: 'Num', v: i };
  return { kind: 'Neg', a: { kind: 'Num', v: i }, extra1: 0, extra2: 0, extra3: 0 };
}

function evalNode(e) {
  if (e.kind === 'Num') return e.v;
  if (e.kind === 'Neg') return -evalNode(e.a);
  if (e.kind === 'Bin') return evalNode(e.a) + evalNode(e.b);
  return 0;
}

function run(n) {
  const nodes = [mk(0), mk(4), mk(2)];
  let s = 0;
  for (let i = 0; i < n; i++) s += evalNode(nodes[0]) + evalNode(nodes[1]) + evalNode(nodes[2]);
  return s;
}

console.log(run(N));
