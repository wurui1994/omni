// 28-import 里用 `access mod_three as m3;` 引这一份 —— 只给限定名（量过：
// access 之后裸用那些名字，asy 报 "no matching variable"）。
write("three body");
real third = 3.5;
real thrice(real x) { return 3 * x; }
