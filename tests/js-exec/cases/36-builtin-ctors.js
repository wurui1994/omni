// 内建构造器**当值用**在五条腿上（ADR-0020 P1-f 的第二半）。名字是编译期常量、每个 realm
// 一份，所以取两次是同一个值（=== 为真）；prototype 那一格预先坐好，于是 A.prototype 与
// x instanceof A 都对。C 那条腿上它是一格原生（sel 从 OMNI_JS_CTOR_SEL 起）。
const A = Array, S = String, N = Number, B = Boolean;
console.log(typeof A, A.name, A.length, A === Array);
console.log([].constructor === Array, "x".constructor === String, (5).constructor === Number);
console.log(({}).constructor === Object, true.constructor === Boolean, /a/.constructor === RegExp);
console.log(S(5), N("7"), B(0), A(1, 2).join(","), A(3).length);
console.log([] instanceof Array, ({}) instanceof Object, Array.prototype === A.prototype);
// 静态面（A.isArray）挂不上去：函数在这个值域里还不是真对象，那些名字只能从**成员写法**取
// （Array.isArray(x) 那条静态路）。那是画出来的边界，四条腿一致而与 node 不同，
// 所以不在这道门里量 —— 写在 ADR-0020 上。
