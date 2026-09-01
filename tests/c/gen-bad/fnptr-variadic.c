/* 边界：通过函数指针调**变参**函数。
 *
 * 变参调用在这条路上不发 `CALL` 而发 `CCALL`（第五片：每个调用点的实参个数都不同，
 * 一个转发桩装不下），而 `CCALL` 的 a 是 C ABI 的入口号 —— 一个编译期常量。
 * 间接的变参调用要 MIR 再多一条「间接的 CCALL」，或者让 `CALLI` 认宿主符号，
 * 两条都要先想清楚 wasm 那一侧的形状。 */
int printf(const char *fmt, ...);

int main(void) {
  int (*p)(const char *, ...) = printf;
  return p("hi\n") == 3 ? 0 : 1;
}
