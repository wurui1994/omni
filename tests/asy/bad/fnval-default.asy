// 通过**函数值**调的时候省一个实参：asy 收（量过 `var g=f; g(3)` 印 5），我们还不收。
// 差别在默认值是谁填的：asy 的 `push_default`（application.h:76）是调用处发一个记号、
// **被调方**（runtime.in:276 的 pushDefault）把它换成真值，所以那份默认值跟着函数值走；
// 我们的默认值是**调用处**用一个包装填的（asyDefWrapper），通过一个值调的时候拿不到
// 那份包装。要做成 asy 那样，得让被调方自己填 —— 那是另一刀。
real f(real x, real y = 2) { return x + y; }
var g = f;
write(g(3));
