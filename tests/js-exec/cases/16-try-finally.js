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
