// 28-import 引到的模块之一（`mod_` 开头的不是用例，是被 import 的模块）。
// 这一份被 mod_one 引 —— 于是 28-import 里裸用 twice 就是在量 import 的**传递性**。
write("two body");
int two = 2;
int twice(int x) { return 2 * x; }
