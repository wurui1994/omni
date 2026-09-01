/* 第八刀第二十七片：K&R 的形参声明串里出现一个不是形参的名字。
 * 与 tcc 逐字节同一句话（`tccgen.c:8902`）。 */
int f(a, b) int a; int c; { return a + b; }

int main(void) { return f(1, 2); }
