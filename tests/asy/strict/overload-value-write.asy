// asy 自己就不收：`write` 收不下一个没定案的重载集 —— 量过 asy 报
// "no matching function 'write(<overloaded>)'" 加 "use of variable 'both' is
// ambiguous"（3.6 与 3.7）。
//
// 这条守的是"记号不许漏出去"：第三十五刀让 nameOf 在多重载时回一个 code 为空的记号，
// 漏到没有目标类型的位置就会变成核心方言里一句"表达式要写成一个 (…) 形式"。
int both(int a, int b) {return a + b;}
real both(real a, real b) {return a * b;}
write(both);
