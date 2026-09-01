/* 第六刀第十四片：浮点（`float` / `double`）。
 *
 * 三格：类型（MIR 的 `T_F32`/`T_F64`、`f32`/`f64` 的访问描述符）、转换
 * （`CVT_I2F`/`CVT_U2F`/`CVT_F2I`/`CVT_FCVT`，以及无符号源要先扩到 64 位那一条）、
 * printf 的 `%f/%e/%g`。
 *
 * 这一份是**能与 tcc 逐字节对账**的浮点：只用二进制里精确的值（0.5、1.25、2.25 那类）
 * 与「舍入不落在正中间」的商（1/3），所以「宿主的 toFixed 与 C 的向偶数舍入」
 * 那一格分歧碰不到（libc.js 的 `fText` 记着这件事）。
 *
 * printf 一定要有原型：arm64 的变参走栈，没原型时 **tcc 自己**会编错。 */

int printf(const char *fmt, ...);

struct P { double x; float y; int n; };

/* 静态初始化式在浮点上也是常量表达式：`1.5 * 2` 在编译期算完，
 * 而 `1 / 2` **在整数里**算（是 0，不是 0.5）—— 转换发生在最后。 */
static double g = 1.5 * 2;
static float sf = 0.25f;
static double half = 1 / 2;
static double tab[4] = { 0.5, 1.5, 2.5, 3.5 };
static float ftab[3] = { 0.25f, 0.5f, 1.0f };
static struct P gp = { 1.5, 2.5f, 3 };
static double hexf = 0x1.8p1;      /* 十六进制浮点字面量 = 3.0 */

static double area(struct P p) { return p.x * p.y + p.n; }
static struct P scale(struct P p, double k) { p.x *= k; p.y *= (float)k; return p; }
static double pick(int c, double a, double b) { return c ? a : b; }
static float halve(float x) { return x / 2.0f; }

static double sum(double *a, int n) {
  double s = 0.0;
  int i;
  for (i = 0; i < n; i++) s += a[i];
  return s;
}

/* 函数指针也认浮点的签名（第十三片那条路与这一片无关地正交） */
static double (*fp)(int, double, double) = pick;

int main(void) {
  double d = 2.25;
  float f = 0.5f;
  int i = 3;
  double *p = tab;

  /* 一、字面量与静态初始化式 */
  printf("%f %f %f %f\n", g, (double)sf, half, hexf);

  /* 二、算术与混合类型（`float + int` 是 float，`double + float` 是 double） */
  printf("%f %f %f\n", d + f, d * i, f * i);
  printf("%f %f %f\n", d - 0.25, d / 2.0, 1.0 / 3.0);

  /* 三、比较与逻辑（`gtst` 与 0.0 比） */
  printf("%d%d%d%d%d%d\n", d > f, d < f, d == 2.25, d != 2.25, !f, !0.0);
  printf("%d %d\n", (d && f) + (0.0 || f), (f > 0.0f) + (ftab[0] < 1.0f));

  /* 四、与整型互转。无符号源要先扩到 64 位，否则 `(double)4000000000u` 会变成一个
   *     天文数字（U2F 在 MIR 里是「把这 64 位当无符号读」）。 */
  unsigned int u = 4000000000u;
  unsigned char uc = 200;
  long long big = 1234567890123LL;
  printf("%f %f %f\n", (double)u, (double)uc, (double)big);
  printf("%d %d %d %d\n", (int)2.9, (int)-2.9, (int)(d * 4), (int)f);
  printf("%f %f\n", (double)(float)0.1, (double)(float)d);

  /* 五、赋值与自增（`+=` 走的是 `a = a + b`，`++` 走的是 `x += 1`） */
  double acc = 0.0;
  while (acc < 3.0) acc += 0.75;
  acc++;
  acc *= 2.0;
  acc -= 0.5;
  printf("%f\n", acc);

  /* 六、struct 里的浮点：传值、返回、整块拷贝 */
  printf("%f %f %d\n", gp.x, (double)gp.y, gp.n);
  printf("%f\n", area(gp));
  struct P q = scale(gp, 2.0);
  struct P r = q;
  printf("%f %f %f\n", q.x, (double)q.y, r.x);

  /* 七、数组与指针 */
  printf("%f %f %f\n", tab[1], p[2], *(p + 3));
  printf("%f %f\n", sum(tab, 4), sum(&d, 1));
  printf("%f %f\n", (double)ftab[2], tab[0] + ftab[0]);

  /* 八、`? :` 的两支有一支是浮点，公共类型就是浮点 */
  printf("%f %f %f\n", d > 1.0 ? d : (double)f, i ? (double)i : d, 0 ? 1 : 2.5);

  /* 九、函数与函数指针 */
  printf("%f %f %f\n", pick(1, 1.5, 2.5), fp(0, 1.5, 2.5), (double)halve(f));

  /* 十、printf 的三种形态与各种标志 */
  printf("%.2f|%.0f|%10.3f|%-10.3f|\n", d, d, d, d);
  printf("%e|%E|%.2e\n", 1234.5, 1234.5, 0.000125);
  printf("%g|%g|%g|%g\n", 100000.0, 1000000.0, 0.0001, 0.00001);
  printf("%+f|% f|%08.2f|%08.2f\n", d, d, d, -d);
  printf("%f|%g|%f\n", 0.0, 0.0, -0.0);

  /* 退出码：收在 0..255（`wait(2)` 的规矩） */
  return ((int)(acc * 10) + (int)q.x + (int)area(gp) + (int)sum(tab, 4)) & 255;
}
