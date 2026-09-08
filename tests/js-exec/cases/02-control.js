// 控制流：if / while / for / do-while / switch / break / continue
let out = "";
const n = 5;
if (n > 3) {
  out = out + "gt3 ";
} else if (n > 1) {
  out = out + "gt1 ";
} else {
  out = out + "small ";
}
console.log(out);

let i = 0;
let sum = 0;
while (i < 10) {
  i = i + 1;
  if (i % 2 === 0) continue;
  if (i > 7) break;
  sum = sum + i;
}
console.log(`while sum=${sum} i=${i}`);

let acc = "";
for (let k = 0; k < 5; k++) {
  if (k === 2) continue;
  acc = acc + k;
}
console.log(`for acc=${acc}`);

let d = 0;
do {
  d = d + 3;
} while (d < 10);
console.log(`do d=${d}`);

for (let a = 0, b = 10; a < b; a++, b--) {
  if (a > 100) break;
}
console.log("two-var for done");

function classify(x) {
  switch (x) {
    case 0:
      return "zero";
    case 1:
    case 2:
      return "small";
    case "s":
      return "string";
    default:
      return "other";
  }
}
console.log(classify(0));
console.log(classify(1));
console.log(classify(2));
console.log(classify("s"));
console.log(classify(9));

function withBreak(x) {
  let r = "?";
  switch (x) {
    case 1:
      r = "one";
      break;
    default:
      r = "many";
  }
  return r;
}
console.log(withBreak(1));
console.log(withBreak(3));

// switch 在循环里：case 体里的 break 只跳出 switch
let seen = "";
for (let v = 0; v < 4; v++) {
  switch (v) {
    case 1:
      seen = seen + "a";
      break;
    case 2:
      seen = seen + "b";
      break;
    default:
      seen = seen + ".";
  }
}
console.log(seen);

// 带标签的循环：`break L` / `continue L` 降级成 OIR 的多层 Break/Continue（level）。
// 生成出来的 JS 自己就是这个形状（backend-js/emit.js 的 pushLoop 会发 `$L0:`），
// 所以这一块也是"JS 后端的产物能落回 JS 前端"这条路上的第一格。
const rows = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
let picked = "";
outer: for (let ri = 0; ri < rows.length; ri++) {
  for (let ci = 0; ci < rows[ri].length; ci++) {
    if (rows[ri][ci] === 5) continue outer;   // 跳的是外层那一轮
    if (rows[ri][ci] === 8) break outer;      // 一句话跳出两层
    picked = picked + rows[ri][ci];
  }
  picked = picked + "|";
}
console.log(picked);

// 标签跨过一层 switch：switch 摊成的合成循环在 OIR 里也是一层，level 得数进去
let tally = "";
let m = 0;
scan: while (m < 10) {
  m = m + 1;
  switch (m % 3) {
    case 0:
      continue scan;
    case 1:
      break;
    default: {
      if (m > 6) break scan;
      break;
    }
  }
  tally = tally + m;
}
console.log(tally + " " + m);

/* 没有声明的 for-of / for-in（`for (x of xs)`、`for (k in o)`）：每轮往一个**已经存在的**
   名字上写，循环之后那个名字留着最后一轮的值。`for (k in o)` 从前连解析都过不去 ——
   this.expression() 会把 `k in o` 当成二元 in 表达式吃掉，所以"名字 + in/of"这一种形状
   现在在 for 头部先接住。 */
let fx;
const fxs = [];
for (fx of [1, 2, 3]) fxs.push(fx);
console.log(`fx ${fxs.join(",")} ${fx}`);
let fk;
const fks = [];
for (fk in { a: 1, b: 2 }) fks.push(fk);
console.log(`fk ${fks.join(",")} ${fk}`);
let fs2 = "";
for (fx of "ab") fs2 = fs2 + fx + "|";
console.log(`fs ${fs2} ${fx}`);
