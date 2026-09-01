/* printf 的十六进制浮点 `%a` 还没到（`%f/%e/%g` 已经与 tcc 逐字节对上了）。
 *
 * 它要的是「把 double 的位模式印成 0x1.8p+1」，与那三种十进制的路完全不同一条：
 * 宿主没有现成的函数，得自己拆尾数与指数。tinycc 自己的源码里用不到它。 */
int printf(const char *fmt, ...);

int main(void) {
  printf("%a\n", 1.5);
  return 0;
}
