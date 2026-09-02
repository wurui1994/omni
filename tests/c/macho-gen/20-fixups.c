/* 数据里的指针（rebase）、弱未定义的符号（bind）、被调用的弱未定义函数（`__stubs`）。
 *
 * 这三样正好是 Mach-O 链式修正的三条路：初始化成某个地址的全局指针要 rebase，
 * 弱未定义的符号要 bind，被**调用**的弱未定义函数还要多一条 `__stubs` 桩子。
 *
 * 一个符号不能同时「被取地址放进 GOT」又「被调用走桩子」—— tcc 自己会喊
 * `Overlap bind/bind .got:_xxx`（同一格 GOT 上两条 bind）。所以这里分成两个符号。 */

int table[4] = { 1, 2, 3, 4 };
int *pt = table;
int *pt2 = &table[2];
const char *msg = "hi";
static int local_data[2] = { 5, 6 };
int *plocal = local_data;

__attribute__((weak)) int called_only(int);
__attribute__((weak)) int taken_only(int);
__attribute__((weak)) extern int missing_data;

int (*fp)(int) = taken_only;

int main(void) {
  int s = 0;
  for (int i = 0; i < 4; i++) s += table[i];
  s += pt[0] + pt2[0] + plocal[1];
  s += msg[0] + msg[1];
  if (&missing_data != 0) s += 1;
  if (fp != 0) s += 1;
  if (called_only != 0) s += called_only(3);
  return s;
}
