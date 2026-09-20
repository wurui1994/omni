// ext/go/go-rt.js — Go 语义运行时（js 后端）
//
// 这一份实现 Go 特有的运行时语义：struct（带类型标签）、方法分派、
// channel、goroutine、append、copy、delete、Sprintf。
// tograph.js 生成对这些函数的调用，不再内联展开 Go 语义。
//
// 注入方式：GRAPH_JS_RT 文本末尾追加这一份的文本（go 专用部分）。
// 钩子接口不变（十五格），这些是**额外的全局函数**。

/** Go 运行时的 JS 文本（追加在 GRAPH_JS_RT 后面）。 */
export const GO_RT = String.raw`

// ============================================================
// Go struct：带 __type 标签的普通对象
// ============================================================
function __goStruct(typeName, fields, values) {
  const obj = { __type: typeName };
  for (let i = 0; i < fields.length; i++) obj[fields[i]] = values[i] ?? null;
  return obj;
}

// ============================================================
// Go 方法注册与分派
// ============================================================
const __goMethods = {};
function __goRegMethod(typeDotMethod, fn) { __goMethods[typeDotMethod] = fn; }
function __goDispatch(obj, method, args) {
  const tn = (obj !== null && obj !== undefined && typeof obj === 'object') ? obj.__type : null;
  if (tn !== null) {
    const fn = __goMethods[tn + '.' + method];
    if (fn) return fn.apply(null, [obj].concat(args));
  }
  // 兜底：field-get
  if (obj !== null && obj !== undefined && typeof obj[method] === 'function') {
    return obj[method].apply(obj, args);
  }
  return null;
}

// ============================================================
// Go append（返回 slice 本身，不是 null）
// ============================================================
function __goAppend(slice, elem) {
  if (slice === null || slice === undefined) slice = [];
  if (Array.isArray(elem) && arguments.length === 3 && arguments[2] === true) {
    // append(s, other...) — spread
    for (let i = 0; i < elem.length; i++) slice.push(elem[i]);
  } else {
    slice.push(elem);
  }
  return slice;
}

// ============================================================
// Go copy
// ============================================================
function __goCopy(dst, src) {
  if (!Array.isArray(dst) || !Array.isArray(src)) return 0;
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = src[i];
  return n;
}

// ============================================================
// Go delete（真正从 map 删键）
// ============================================================
function __goDelete(m, k) {
  if (m instanceof Map) m.delete(k);
  return null;
}

// ============================================================
// Go channel / goroutine
//
// **这几格在非原生腿上是一句有名有姓的墙，不是一份近似**（2026-09-20 改）。
//
// 从前这儿是一个"同步队列"：send 往数组里推、recv 空了就回 null、__goSpawn 当场
// 同步调用那个函数。那不是 goroutine —— 一个 "for i { go w(i) }" 再 "for i { <-ch }"
// 的程序在它上头**跑得通而且给错答案**（收到的全是 null），而在 go 上那是真并发。
// 静默的错答案是最坏的一种，所以现在一律当场报。
//
// 真货在原生那三条腿上：图落 "call __goChanSend(…)" -> backend-core 的 C_RT 认出
// 名字 -> "(ccall omni_go_chan_send …)" -> libomnigo（照 go 的 proc.go/chan.go 写的
// G/M/P 调度器）。js / 解释器这两条腿要接得先有协程（CPS 或 generator），那是另一刀。
// 口径与 tests/cabi 那一条轴一样：**非原生腿明着拒**，而不是给一份看起来能跑的近似。
//
// 注：这一份是 String.raw 模板（见文件头），所以注里**不能有反引号、也不能有 $ 加花括号**
// —— 前者提前收了模板、后者会在装载这个模块时就求值。这一格踩过三次了。
// ============================================================
function __goNoConc(what) {
  throw new Error(what + ' is only available in a native build'
    + '（channel 与 goroutine 在 js / 解释器这两条腿上还没有协程可用）');
}
function __goChanMake() { return __goNoConc('make(chan T)'); }
function __goChanSend() { return __goNoConc('ch <- v'); }
function __goChanRecv() { return __goNoConc('<-ch'); }
function __goChanRecv2() { return __goNoConc('v, ok := <-ch'); }
function __goChanOK() { return __goNoConc('v, ok := <-ch'); }
function __goChanClose() { return __goNoConc('close(ch)'); }
function __goChanLen() { return __goNoConc('len(ch)'); }
function __goSpawn() { return __goNoConc('go f(x)'); }
function __goSpawn0() { return __goNoConc('go f()'); }
function __goRun() { return __goNoConc('并发那一档的主 goroutine'); }

// ============================================================
// Go select —— 与上面那几格同一条：非原生腿明着拒。
// 原生腿上它还没接（omni_selectgo 在 omni_chan.c 里，前端那一侧的门面还没发）。
// ============================================================
function __goSelect() { return __goNoConc('select'); }
function __goSelBegin() { return __goNoConc('select'); }
function __goSelRecv() { return __goNoConc('select'); }
function __goSelSend() { return __goNoConc('select'); }
function __goSelDefault() { return __goNoConc('select'); }
function __goSelGo() { return __goNoConc('select'); }
function __goSelVal() { return __goNoConc('select'); }
function __goSelOK() { return __goNoConc('select'); }

// ============================================================
// Go type switch + type checking
// ============================================================
function __goTypeOf(obj) {
  if (obj === null || obj === undefined) return 'nil';
  if (typeof obj === 'object' && obj.__type !== undefined) return obj.__type;
  if (Array.isArray(obj)) return 'slice';
  if (obj instanceof Map) return 'map';
  return typeof obj;
}
function __goTypeIs(obj, typeName) { return __goTypeOf(obj) === typeName; }
function __goTypeSwitch(obj, cases) {
  const tn = (obj !== null && obj !== undefined && typeof obj === 'object') ? obj.__type : null;
  for (const [typeName, handler] of cases) {
    if (typeName === 'default' || typeName === tn) return handler(obj);
  }
  return null;
}

// ============================================================
// Go interface check（判断 obj 是否实现了某接口的方法集）
// ============================================================
function __goImplements(obj, methods) {
  const tn = (obj !== null && obj !== undefined && typeof obj === 'object') ? obj.__type : null;
  if (tn === null) return false;
  for (const m of methods) {
    if (!__goMethods[tn + '.' + m]) return false;
  }
  return true;
}

// ============================================================
// Go Sprintf（常见 verb 子集）
// ============================================================
function __goSprintf(format) {
  const args = Array.prototype.slice.call(arguments, 1);
  let i = 0;
  return format.replace(/%([#0\- +]*)(\*|\d+)?(\.\*|\.\d+)?([dvsxqfgetTpwbo%])/g,
    function(match, flags, width, prec, verb) {
      if (verb === '%') return '%';
      if (i >= args.length) return match;
      const a = args[i++];
      switch (verb) {
        case 'd': return String(Math.trunc(Number(a)));
        case 's': return String(a);
        case 'v': return __show(a);
        case 'x': return Math.trunc(Number(a)).toString(16);
        case 'o': return Math.trunc(Number(a)).toString(8);
        case 'b': return Math.trunc(Number(a)).toString(2);
        case 'f': case 'g': case 'e': {
          const n = Number(a);
          if (prec) {
            const p = parseInt(prec.slice(1));
            return verb === 'f' ? n.toFixed(p) : verb === 'e' ? n.toExponential(p) : n.toPrecision(p);
          }
          return String(n);
        }
        case 'q': return '"' + String(a).replace(/"/g, '\\"') + '"';
        case 'p': return '<ptr>';
        case 'T': return (a !== null && a !== undefined && typeof a === 'object' && a.__type) ? a.__type : typeof a;
        case 'w': return (a !== null && typeof a === 'object' && typeof a.Error === 'function') ? a.Error() : String(a);
        default: return __show(a);
      }
    });
}
`;
