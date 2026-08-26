// 重载：asy 按实参类型选签名，那要一份真的符号表 + 转换代价排序。
// 这一层没有符号表（类型都是写在源码里的那份），所以同名两次就报错。
int f(int x) { return x; }
int f(int x, int y) { return x + y; }
write(f(1), f(1, 2));
