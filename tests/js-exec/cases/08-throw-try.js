// throw / try / catch（ADR-0011 落地第 6d 步）
// 只有一个 pending 槽，每条可能抛的语句后面查一下，一级一级地退（决策 14）
function boom(msg) {
  throw new Error(msg);
}

try {
  boom("first");
  console.log("not reached");
} catch (e) {
  console.log(`caught ${e.message}`);
}

// 抛字符串（被抛的不一定是 Error）
try {
  throw "plain";
} catch (e) {
  console.log(`caught ${e}`);
}

// catch 不绑名字
try {
  boom("ignored");
} catch {
  console.log("caught something");
}

// try 正常走完，catch 不跑
try {
  console.log("body ran");
} catch (e) {
  console.log("never");
}

// 深一层：抛的地方和接的地方隔着好几个函数
function level3() {
  throw new Error("deep");
}
function level2() {
  level3();
  return "not reached";
}
function level1() {
  return level2();
}
try {
  console.log(level1());
} catch (e) {
  console.log(`caught ${e.message}`);
}

// 抛之后，同一条语句之后的语句都不许再跑
let trace = [];
function collect() {
  trace.push("a");
  boom("stop");
  trace.push("b");
}
try {
  collect();
  trace.push("c");
} catch (e) {
  trace.push(`caught:${e.message}`);
}
console.log(trace.join(","));

// 循环里抛：要跳出所有层
function findFirstBad(rows) {
  let seen = 0;
  try {
    for (const row of rows) {
      for (const cell of row) {
        seen = seen + 1;
        if (cell < 0) throw new Error(`bad cell ${cell}`);
      }
    }
  } catch (e) {
    return `${e.message} after ${seen}`;
  }
  return `all good after ${seen}`;
}
console.log(findFirstBad([[1, 2], [3, 4]]));
console.log(findFirstBad([[1, 2], [3, -7], [9, 9]]));

// 嵌套的 try：内层接不住的（重新抛的）由外层接
try {
  try {
    boom("inner");
  } catch (e) {
    console.log(`inner saw ${e.message}`);
    throw new Error(`wrapped:${e.message}`);
  }
} catch (e) {
  console.log(`outer saw ${e.message}`);
}

// 回调里抛
try {
  [1, 2, 3].map((x) => {
    if (x === 2) throw new Error("in callback");
    return x;
  });
  console.log("never");
} catch (e) {
  console.log(`caught ${e.message}`);
}

// try 里 return
function pick(x) {
  try {
    if (x < 0) throw new Error("negative");
    return "ok";
  } catch (e) {
    return e.message;
  }
}
console.log(pick(1));
console.log(pick(-1));

// Error 的子类：instanceof 与自己的字段
class OmniError extends Error {}
class ResolveError extends Error {
  constructor(msg, path) {
    super(msg);
    this.path = path;
  }
}

try {
  throw new OmniError("typed");
} catch (e) {
  console.log(`${e.message} ${e instanceof OmniError} ${e instanceof Error} ${e instanceof ResolveError}`);
}

try {
  throw new ResolveError("no such module", "a/b.omni");
} catch (e) {
  console.log(`${e.message} ${e.path} ${e instanceof ResolveError} ${e instanceof Error}`);
}

// 按类型分流：不认的重新抛出去
function route(kind) {
  try {
    if (kind === "omni") throw new OmniError("mine");
    throw new Error("someone else's");
  } catch (e) {
    if (!(e instanceof OmniError)) return `rethrow ${e.message}`;
    return `handled ${e.message}`;
  }
}
console.log(route("omni"));
console.log(route("other"));

// 抛出来的不是对象时 instanceof 给 false，不炸
try {
  throw "just a string";
} catch (e) {
  console.log(String(e instanceof Error));
}

// 类的方法里抛
class Guard {
  constructor(limit) {
    this.limit = limit;
  }
  check(v) {
    if (v > this.limit) throw new Error(`${v} over ${this.limit}`);
    return v;
  }
}
const g = new Guard(10);
console.log(String(g.check(5)));
try {
  g.check(50);
} catch (e) {
  console.log(`caught ${e.message}`);
}
