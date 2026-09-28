// **给属性读的单态 IC 先把判据摆好**（ADR-0047 §14.5，判据先行）。
//
// 这一份现在就该过 —— 它压的是语义，不是速度。IC 落地之后它才真正值钱：
// 每一格都是"缓存必须失效"的一种理由，少任何一格都可能变成**答旧值**，
// 而那是最难查的一类错（答案错了但不报错，而且只在第二次之后错）。
//
// 六格，各压一件事：
//   1. 同一处代码先读 A 形状再读 B 形状（多态 ⇒ 每次都得重新找）；
//   2. `delete` 掉那个键（`live[slot]` 置假 ⇒ 缓存的 slot 不能再用）；
//   3. 给对象**加**一个键（`n` 变 ⇒ `keys[]` 的身份可能挪了）；
//   4. 把原型上那格方法**换掉**（holder 那格 dict 变了）；
//   5. 读的键在**原型链第二层**（holder 不是自己那格 dict）；
//   6. 同名键在自己身上把原型那格**遮住**（shadow）之后再 `delete`，露出原型那格。
// 后四格（7..10）是照落地之后那格 IC 的两种形态补的，见下面各自那条注。
function A() { this.k = 'A'; }
function B() { this.k = 'B'; this.extra = 1; }

const out = [];
const read = (o) => String(o.k);          // 就是这一处调用点：IC 会长在这儿

/* 1. 多态：同一处代码轮着读两种形状 */
const a = new A();
const b = new B();
for (let i = 0; i < 3; i++) out.push(read(a), read(b));

/* 2. delete */
const d = new A();
out.push(read(d));
delete d.k;
out.push(read(d));                         // undefined

/* 3. 加一个键（n 变） */
const g = new A();
out.push(read(g));
g.z1 = 1; g.z2 = 2; g.z3 = 3;
out.push(read(g), String(g.z3));

/* 4. 原型上那格方法被换掉 */
function P() { this.n = 1; }
P.prototype.get = function () { return 'v1'; };
const p = new P();
out.push(p.get());
P.prototype.get = function () { return 'v2'; };
out.push(p.get());                         // v2，不许还是 v1

/* 5. 原型链第二层 */
function Base() {}
Base.prototype.deep = 'deep1';
function Mid() {}
Mid.prototype = Object.create(Base.prototype);
const m = new Mid();
out.push(String(m.deep));
Base.prototype.deep = 'deep2';
out.push(String(m.deep));

/* 6. 自己身上遮住原型那格，再删掉 */
const s = new P();
out.push(String(s.own));
P.prototype.own = 'proto';
out.push(String(s.own));
s.own = 'self';
out.push(String(s.own));
delete s.own;
out.push(String(s.own));                   // 回到 proto

console.log(out.join('|'));

/* 下面四格是照**落地之后的 IC**（omni_js_obj.h 的 omni_js_ic_s）补的：那一格分两种形态，
   每种都有自己"会答旧值"的路子。 */
const out2 = [];

/* 7. 自有那一格**不认对象身份、只认下标**：同一处代码读一批同构的实例必须都对；
      而"名字相同但落在别的下标上"的实例（插入序不同）也必须对 —— 判据是缓存里那个
      下标上的**键**要重新验一遍，不是"下标合法就用"。 */
function Q(x) { this.x = x; }
for (let i = 0; i < 4; i++) out2.push(String(new Q(i).x));
const q2 = {};
q2.pad1 = 1; q2.pad2 = 2; q2.x = 'late';     // x 落在第 3 格，不是第 0 格
out2.push(String(q2.x));
out2.push(String(new Q(9).x));               // 换回去，还得是 9

/* 8. 同一个键**原地变成访问器**：缓存里记的是"数据槽"，defineProperty 之后必须去调 getter */
const acc = new Q(1);
out2.push(String(acc.x));
Object.defineProperty(acc, 'x', { get() { return 'got'; }, configurable: true });
out2.push(String(acc.x));

/* 9. 换原型（setPrototypeOf）：原型那一格的缓存认 pr 的身份，换过就不许再命中 */
function R() { this.n = 0; }
R.prototype.who = 'R';
const r = new R();
out2.push(String(r.who));
Object.setPrototypeOf(r, { who: 'other' });
out2.push(String(r.who));

/* 10. 同一处代码上先读真对象、再读**代理**：陷阱的口径只有慢路那一份 */
const site = (o) => String(o.who);
out2.push(site(new R()));
out2.push(site(new Proxy(new R(), { get: (t, k) => (k === 'who' ? 'trap' : t[k]) })));
out2.push(site(new R()));

console.log(out2.join('|'));

/* 11..14：**对象字面量**（这条腿上是 dict，键不带前缀、值就是值）那一支的 IC。
   同一处代码轮着读一批字面量：名字落在不同的下标上、删掉、加键、以及读到原型上去。 */
const out3 = [];
const kind = (e) => String(e.kind);
out3.push(kind({ kind: 'k0' }));
out3.push(kind({ pad: 1, kind: 'k1' }));
out3.push(kind({ a: 1, b: 2, c: 3, kind: 'k3' }));
out3.push(kind({ kind: 'k0again' }));
const e1 = { kind: 'x', v: 1 };
out3.push(kind(e1));
delete e1.kind;
out3.push(kind(e1));                        // undefined
e1.kind = 'back';
out3.push(kind(e1));
const e2 = { kind: 'y' };
e2.z1 = 1; e2.z2 = 2;                       // n 变
out3.push(kind(e2), String(e2.z2));
out3.push(String(typeof ({ kind: 1 }).hasOwnProperty));   // 原型那一支：function

console.log(out3.join('|'));
