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
// Go channel（简单同步队列）
// ============================================================
class __GoChan {
  constructor(cap) { this.buf = []; this.cap = cap || 0; this.closed = false; }
  send(v) { if (this.closed) throw new Error('send on closed channel'); this.buf.push(v); }
  recv() { return this.buf.length > 0 ? { value: this.buf.shift(), ok: true } : { value: null, ok: !this.closed }; }
  close() { this.closed = true; }
  get length() { return this.buf.length; }
}

function __goChanMake(cap) { return new __GoChan(cap || 0); }
function __goChanSend(ch, v) { if (ch instanceof __GoChan) ch.send(v); return null; }
function __goChanRecv(ch) {
  if (ch instanceof __GoChan) { const r = ch.recv(); return r.value; }
  return null;
}
function __goChanRecv2(ch) {
  if (ch instanceof __GoChan) { const r = ch.recv(); return { __vals: [r.value, r.ok] }; }
  return { __vals: [null, false] };
}
function __goChanClose(ch) { if (ch instanceof __GoChan) ch.close(); return null; }

// range over channel：收集所有已缓冲的值
function __goChanRange(ch) {
  if (!(ch instanceof __GoChan)) return [];
  const result = [];
  while (ch.buf.length > 0) result.push(ch.buf.shift());
  return result;
}

// ============================================================
// Go goroutine（phase 1: 同步调用）
// ============================================================
function __goSpawn(fn) { if (typeof fn === 'function') fn(); return null; }

// ============================================================
// Go select（phase 1: 取第一个非空 case）
// ============================================================
function __goSelect(cases) {
  // cases = [[ch, 'recv'], [ch, 'send', val], ['default']]
  for (const c of cases) {
    if (c[0] === 'default') return { idx: cases.indexOf(c), value: null };
    const ch = c[0];
    if (c[1] === 'recv' && ch instanceof __GoChan && ch.buf.length > 0) {
      return { idx: cases.indexOf(c), value: ch.recv().value };
    }
    if (c[1] === 'send' && ch instanceof __GoChan && (ch.cap === 0 || ch.buf.length < ch.cap)) {
      ch.send(c[2]);
      return { idx: cases.indexOf(c), value: null };
    }
  }
  // 没有 default 且全部阻塞 → 死锁（简化处理：返回 -1）
  return { idx: -1, value: null };
}

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
