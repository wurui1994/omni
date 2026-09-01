/* `long double` 还没到（浮点那一片只做了 float / double）。
 *
 * 它**不是** double：本机 arm64 上是 128 位的 IEEE quad，x86 上是 80 位扩展精度，
 * 两者都不是宿主的 double，得有自己的一套算术与自己的一份 printf。
 * tinycc 自己的源码里 `long double` 只在常量折叠那一格出现，所以它排在后面。 */
int main(void) {
  long double d = 1.5;
  return (int)d;
}
