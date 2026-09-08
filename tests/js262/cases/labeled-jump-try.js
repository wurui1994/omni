/* 带标签的 break / continue 跨过 try：带 finally 的那层走 unwind 协议（清理跑完了再跳），
   只有 catch 的那层就是"多跳一层"（它循环后面那句 pending 检查只在真有异常时才进）。
   无标签的那两个也一起量：目标在 finally 里面时清理不能提前跑。 */

const log = [];
outer: for (let i = 0; i < 3; i++) {
  try {
    for (let j = 0; j < 3; j++) {
      if (j === 1) continue outer;
      if (i === 2) break outer;
      log.push(`${i}:${j}`);
    }
  } finally {
    log.push(`fin${i}`);
  }
}
console.log(log.join(","));

// 两层 finally：一层层都跑得到，最后才真的跳
function two() {
  const o = [];
  L: for (let i = 0; i < 2; i++) {
    try {
      try {
        o.push("in");
        break L;
      } finally { o.push("f1"); }
    } finally { o.push("f2"); }
    o.push("never");
  }
  o.push("done");
  return o.join(",");
}
console.log(two());

function twoCont() {
  const o = [];
  L: for (let i = 0; i < 3; i++) {
    try {
      try {
        if (i === 1) continue L;
        o.push(`v${i}`);
      } finally { o.push(`f1-${i}`); }
    } finally { o.push(`f2-${i}`); }
  }
  return o.join(",");
}
console.log(twoCont());

// switch 里跳出带 finally 的 try
function sw() {
  const o = [];
  L: for (let i = 0; i < 4; i++) {
    try {
      switch (i) {
        case 1: continue L;
        case 2: break L;
        default: o.push(`d${i}`);
      }
      o.push(`post${i}`);
    } finally { o.push(`f${i}`); }
  }
  return o.join(",");
}
console.log(sw());

// 标签块：break 出去也要先跑清理
function blk() {
  const o = [];
  B: {
    try {
      o.push("a");
      break B;
    } finally { o.push("f"); }
  }
  o.push("b");
  return o.join(",");
}
console.log(blk());

// 同一层 finally 上既有带标签的又有无标签的
function both() {
  const o = [];
  L: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      try {
        if (j === 1) break;
        if (i === 2) break L;
        o.push(`${i}${j}`);
      } finally { o.push(`f${i}${j}`); }
    }
  }
  return o.join(",");
}
console.log(both());

/* 无标签 break / continue 跨过只有 catch 的那层 try：多跳一层就是了。
   外面那层 finally 的清理不能提前跑 —— 目标循环在它里面。 */
function inner() {
  const o = [];
  try {
    for (let i = 0; i < 3; i++) {
      try {
        if (i === 1) break;
        o.push(`i${i}`);
      } catch (e) { o.push("c"); }
      o.push(`tail${i}`);
    }
    o.push("afterLoop");
    return o.join(",");
  } finally { o.push("fin"); }
}
console.log(inner());

function innerCont() {
  const o = [];
  try {
    for (let i = 0; i < 3; i++) {
      try {
        if (i === 1) continue;
        o.push(`i${i}`);
      } catch (e) { o.push("c"); }
      o.push(`tail${i}`);
    }
    return o.join(",");
  } finally { o.push("fin"); }
}
console.log(innerCont());

// 只有 catch 的内层 try 夹在中间：break 一路跳出去，外层 try 体的尾巴不该再跑
function skipTail() {
  const o = [];
  for (let i = 0; i < 2; i++) {
    try {
      try {
        if (i === 0) break;
        o.push(`body${i}`);
      } catch (e) { o.push("c"); }
      o.push(`after-inner${i}`);
    } finally {
      o.push(`fin${i}`);
    }
  }
  return o.join(",");
}
console.log(skipTail());

// switch 的 break 属于 switch 自己，虽然外面套着带 finally 的 try
function swInner() {
  const o = [];
  try {
    switch (1) {
      case 1: o.push("one"); break;
      default: o.push("d");
    }
    o.push("afterSwitch");
  } finally { o.push("fin"); }
  return o.join(",");
}
console.log(swInner());
