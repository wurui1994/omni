// 端到端回归：不变式检查的观察者 + Proxy 校验 + WeakMap 私有态 + Symbol 协议。
// JSON.stringify 在"每个键都答一句"的校验代理上从前静静地给 undefined（内部标记被 get 陷阱
// 接住了），就是在这一段里露出来的 —— 见 tests/js262/cases/proxy-json.js。
// 第五段真程序：不变式检查的观察者 + Proxy 校验 + WeakMap 私有态 + Symbol 协议
const PRIV = new WeakMap();
const OBSERVERS = Symbol("observers");
class Store {
  constructor(init) {
    PRIV.set(this, { state: { ...init }, log: [] });
    this[OBSERVERS] = [];
  }
  get state() { return { ...PRIV.get(this).state }; }
  get log() { return [...PRIV.get(this).log]; }
  subscribe(fn) {
    this[OBSERVERS].push(fn);
    return () => {
      const i = this[OBSERVERS].indexOf(fn);
      if (i >= 0) this[OBSERVERS].splice(i, 1);
    };
  }
  dispatch(action) {
    const p = PRIV.get(this);
    const next = Store.reduce(p.state, action);
    p.log.push(`${action.type}:${JSON.stringify(action.payload ?? null)}`);
    const prev = p.state;
    p.state = next;
    for (const fn of [...this[OBSERVERS]]) fn(next, prev, action);
    return next;
  }
  static reduce(s, a) {
    switch (a.type) {
      case "inc": return { ...s, n: s.n + (a.payload ?? 1) };
      case "name": return { ...s, name: String(a.payload) };
      case "reset": return { n: 0, name: "" };
      default: throw new TypeError(`unknown action ${a.type}`);
    }
  }
}
const guard = (obj, rules) => new Proxy(obj, {
  get(t, k, r) { return k in t ? Reflect.get(t, k, r) : `<no ${String(k)}>`; },
  set(t, k, v, r) {
    const rule = rules[k];
    if (rule && !rule(v)) throw new RangeError(`bad ${String(k)}: ${v}`);
    return Reflect.set(t, k, v, r);
  },
  has(t, k) { return Reflect.has(t, k); },
  ownKeys(t) { return Reflect.ownKeys(t); },
});
const s = new Store({ n: 0, name: "" });
const seen = [];
const off = s.subscribe((next, prev, a) => seen.push(`${a.type} ${prev.n}->${next.n}`));
s.dispatch({ type: "inc" });
s.dispatch({ type: "inc", payload: 4 });
s.dispatch({ type: "name", payload: "zed" });
off();
s.dispatch({ type: "inc" });
console.log(JSON.stringify(s.state), seen.join(" | "));
console.log(s.log.join(" ; "));
try { s.dispatch({ type: "nope" }); } catch (e) { console.log(`${e.name}: ${e.message}`); }
const cfg = guard({ port: 80, host: "x" }, { port: (v) => Number.isInteger(v) && v > 0 });
console.log(cfg.port, cfg.host, cfg.missing, String("port" in cfg), Object.keys(cfg).join(","));
cfg.port = 8080;
console.log(cfg.port);
try { cfg.port = -1; } catch (e) { console.log(`${e.name}: ${e.message}`); }
console.log(JSON.stringify(cfg));
// Symbol 键不进 JSON / keys，但 in 与 getOwnPropertySymbols 看得见
console.log(String(OBSERVERS in s), Object.keys(s).length, Object.getOwnPropertySymbols(s).length);
console.log(String(OBSERVERS.description), String(OBSERVERS.toString()));
// WeakMap 的私有态：外面拿不到
console.log(String(Object.keys(s).includes("state")), String(s.state === s.state));
