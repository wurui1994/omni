// try / finally（ADR-0020 P4）。pending 槽只有一格，所以清理不能在"槽里还有东西"的
// 时候跑（那样清理自己的第一次 pending 检查就把异常接走了）。降级是三步：记下有没有、
// 把它挪进一格局部量（槽因此清空）、干净地跑清理、有的话再抛回去。
try {
  throw 1;
} catch (e) {
  console.log(`c ${e}`);
} finally {
  console.log("f");
}

// 没有 catch：清理照跑，异常继续往外传
function h() {
  try {
    throw new Error("boom");
  } finally {
    console.log("f-nocatch");
  }
}
try {
  h();
} catch (e) {
  console.log(`outer ${e.message}`);
}

// 不抛的那条路也要跑清理
let log = "";
try {
  log += "t";
} finally {
  log += "f";
}
console.log(`plain ${log}`);

// 嵌套：里层的 finally 先跑，外层的后跑
log = "";
try {
  try {
    throw 2;
  } catch (e) {
    log += `c${e}`;
  } finally {
    log += "i";
  }
} finally {
  log += "o";
}
console.log(`nest ${log}`);

// catch 里再抛：清理跑完之后那个新的异常继续往外传
function rethrow() {
  try {
    throw new Error("a");
  } catch (e) {
    throw new Error(`${e.message}b`);
  } finally {
    log += "R";
  }
}
try {
  rethrow();
} catch (e) {
  console.log(`rethrow ${e.message} ${log}`);
}

// 从 try / catch 里 return / break / continue 出去：**清理不能被跳过**。降级走一格
// unwind 协议（记下为什么出去、break 出合成循环、跑完清理再照着做），见 lower.js 的 finAbrupt。
function r1() {
  try {
    return "try";
  } finally {
    console.log("u-fin1");
  }
}
console.log(`u ${r1()}`);
function r2() {
  try {
    throw new Error("x");
  } catch (e) {
    return "caught";
  } finally {
    console.log("u-fin2");
  }
}
console.log(`u ${r2()}`);
// finally 里的 return 盖掉 try 里的那一格（规范如此）
function r3() {
  try {
    return "a";
  } finally {
    return "b";
  }
}
console.log(`u ${r3()}`);
// 循环里：continue / break 也要先跑清理
function loopy() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    try {
      if (i === 1) continue;
      if (i === 3) break;
      out.push(String(i));
    } finally {
      out.push(`f${i}`);
    }
  }
  return out.join(",");
}
console.log(`u ${loopy()}`);
// 两层 finally：里层记下、跑里层清理，外层再记下、跑外层清理，最后才 return
function two() {
  try {
    try {
      return "deep";
    } finally {
      console.log("u-inner");
    }
  } finally {
    console.log("u-outer");
  }
}
console.log(`u ${two()}`);
/* 错误对象上的"自有可枚举"口径：$cls 是内部标记、message 与 cause 是 own 但不可枚举、
   name 在原型上，所以 JSON.stringify(new Error("x")) 是 {}。这一条要五条腿一起验 ——
   C 那条腿的错误对象是 dict，JSON 那儿有一份对应的跳过（omni_js_json.h）。
   带数组 replacer 那一格**照样看得见** message：那条路走的是 [[Get]]，不问可枚举。 */
const e1 = new Error("boom");
console.log(`err ${JSON.stringify(e1)} ${e1.name} ${e1.message}`);
const e2 = new TypeError("bad");
console.log(`err ${JSON.stringify(e2)} ${e2.name} ${JSON.stringify(new Error("c", { cause: 7 }))}`);
e1.code = 5;
console.log(`err ${JSON.stringify(e1)} ${JSON.stringify(e2, ["message"])}`);
