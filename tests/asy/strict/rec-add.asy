// asy 自己就不收：struct 上没有内建的 `+`（量过 asy 报
// "no matching function 'operator +(A, A)'"，5.9）—— 自己定义一个 `operator +` 才有。
// 这条是量 `a + null` 时撞出来的一个洞：原先 `a + a` 一路落到核心方言的 `(bin "+" …)`，
// 在 JS 后端上崩成 `js.bin: + on class` —— 一处内部错，不是诊断。
struct A { int x; }
A a = new A;
A b = new A;
A c = a + b;
write(c.x);
