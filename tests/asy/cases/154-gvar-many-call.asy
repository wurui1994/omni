// 同名的文件级变量可以有**好几格**（asy 按签名分得开），调用时按签名挑那一格。
// 原型是 plain_arrows.asy 的 EndArrow：:335 是一格 `arrowbar(arrowhead,real,real,
// filltype,position)`（带默认值的函数类型变量），:444 的声明表里又有一格光是 `arrowbar` 的。
// feynman.asy:579 的 `currentmomarrow = EndArrow(momarrowsize());` 走的是前者，
// 少给的几格由**类型上**记着的默认值填。
typedef bool ab(int);
ab mk(real size=0) { return new bool(int k) { return size > k; }; }

ab EA(real size=0)=mk;    // 一格：ab(real)
ab EA=mk(3.0);            // 又一格：ab 本身

write(EA(2.0)(1));        // ab(real) 那一格：2>1
write(EA()(1));           // 默认值 size=0：0>1 是假
write(EA(5));             // ab 那一格：3>5 是假
write(EA(1));             // 同上：3>1
