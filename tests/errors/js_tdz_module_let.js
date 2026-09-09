// TDZ（规范 9.1.1.1 的 uninitialized binding）：模块级的 let / const 在**声明之前**读它。
//
// 这个值域里模块级的 let / const 是**全局槽**（后端各发一个真全局），所以声明之前读它
// 从前静静地给 undefined —— 规范那儿是 ReferenceError，qjs 也抛。函数体里的同一件事早就
// 是响的（名字还没进作用域，报 "unresolved identifier"），差的只有顶层这一格。
//
// 判据只看**词法**：同一格顶层语句表里，读它的那句在声明那句之前。闭包体不算 —— 它什么
// 时候跑是运行期的事，静态判不了（`function g() { return B; }` 写在 `const B` 前面是合法的，
// 只要 g 在 B 初始化之后才被调用）。
//
// 为什么是编译期而不是运行期：要在运行期抛，每一格模块级 let / const 的读都得带一句
// "初始化了吗"的检查 —— 与 null.x 那一格同一个理由（ADR-0020），太密。编译期拒是**更强**
// 的保证：这段源码在真 JS 里必然抛，编不过比跑起来才炸好。
try { readEarly; } catch (e) { console.log("never gets here", e); }
let readEarly = 1;

// 这两条是合法的，不该被上面那条规则误伤（它们在这份用例里编不到，因为上面已经报错了 ——
// 合法的那面由 tests/js262 与五腿用例里满地的 const 覆盖着）：
//   function g() { return later; }   // 闭包体，运行期才读
//   var v; console.log(v);           // var 声明前读到 undefined 是对的
