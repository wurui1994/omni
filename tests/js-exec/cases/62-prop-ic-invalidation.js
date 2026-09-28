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
