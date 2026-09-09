// Object.freeze / seal / preventExtensions 落在**容器**上（数组 / Map），现在**四条腿都有**：
// C 侧那三档锁在 omni_js_obj.h（表与 xprops 同一招 —— 键就是 omni_js_key 给引用值发的地址）。
// 这条腿上真对象还不存在，所以那一支本来就到不了。
//
// 这儿只量**两把尺子都同意**的那几格：三个判据、照抛的那几个方法、读、以及 Map 的内部槽。
// 赋值那一族（a[0] = x / a.length = 0 / delete a[0] / a.x = 1）两把尺子是**分开的** ——
// node 按模块（严格模式）抛，qjs 按脚本（非严格）静静地忽略。我们跟 qjs，所以那几格只在
// js262 的 freeze-array.js 里量，并且记在 ADR-0020 里当成一条待定的口径。
const a = Object.freeze([1, 2]);
console.log(String(Object.isFrozen(a)), String(Object.isSealed(a)), String(Object.isExtensible(a)));
const r = [];
const t = (l, f) => { try { f(); r.push(l + " ok"); } catch (e) { r.push(l + " " + e.name); } };
t("push", () => a.push(3));
t("pop", () => a.pop());
t("shift", () => a.shift());
t("unshift", () => a.unshift(0));
t("reverse", () => a.reverse());
t("fill", () => a.fill(0));
t("copyWithin", () => a.copyWithin(0, 1));
t("splice", () => a.splice(0, 1));
t("sort-desc", () => a.sort((x, y) => y - x));
console.log(r.join(" | "));
// 读的那一边一格不变
console.log(a[0] + "," + a.length + "," + a.map((x) => x * 2).join("/"));
// 封住：还能写现有那几格，但删不了、长不了
const s = Object.seal([1, 2]);
const r2 = [];
const t2 = (l, f) => { try { f(); r2.push(l + " ok"); } catch (e) { r2.push(l + " " + e.name); } };
console.log(String(Object.isSealed(s)), String(Object.isFrozen(s)), String(Object.isExtensible(s)));
t2("s.push", () => s.push(3));
t2("s.pop", () => s.pop());
t2("s.reverse", () => s.reverse());
t2("s.fill", () => s.fill(0));
console.log(r2.join(" | "), s.join(","));
// 只是不可扩展：删得掉
const n = Object.preventExtensions([1, 2]);
const r3 = [];
const t3 = (l, f) => { try { f(); r3.push(l + " ok"); } catch (e) { r3.push(l + " " + e.name); } };
console.log(String(Object.isExtensible(n)), String(Object.isSealed(n)));
t3("n.push", () => n.push(3));
t3("n.pop", () => n.pop());
console.log(r3.join(" | "), n.join(","));
// Map 冻住之后 set 照旧成立：内部槽不是属性
const m = Object.freeze(new Map([["k", 1]]));
console.log(String(Object.isFrozen(m)), String(m.set("j", 2).size));
// 原始值照规范：冻住、封住都算，不可扩展
console.log(String(Object.isFrozen(1)), String(Object.isSealed("s")), String(Object.isExtensible(true)));
