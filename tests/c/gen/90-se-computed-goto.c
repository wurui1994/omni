/* 第一百五十二片：**语句表达式里头的计算跳转**（ADR-0047 第十七格）。
 *
 * R 的字节码解释器（`src/main/eval.c`）跳一步的形状就是这个：
 *
 *     #define NEXT() (__extension__ ({currentpc = pc; goto *(*pc++).v;}))
 *     #define BEGIN_MACHINE  NEXT(); init: { int which = 0; loop: switch(which++)
 *
 * 标签（`op_##name`）在**函数**那一层上，`goto *` 却写在一个语句表达式里。
 * 从前 `stmtExpr` 一律把状态槽清成 -1，于是那儿报"计算跳转却没摆状态机"，
 * 整份 `eval.c` 编不过。现在：自己没有标签的语句表达式接着用**外面那台**状态机。
 *
 * 判据照这一组的规矩：与 cc 编出来的退出码逐字节相同。 */

int main(void) {
  static void *tab[4];
  void **pc;
  int s = 0;

  tab[0] = &&op_add;
  tab[1] = &&op_mul;
  tab[2] = &&op_add;
  tab[3] = &&op_done;
  pc = tab;

  /* NEXT() 一模一样的形状：语句表达式里 `goto *`，标签在函数那一层 */
#define NEXT() (__extension__ ({ goto *(*pc++); }))

  NEXT();

 op_add:
  s += 7;
  NEXT();

 op_mul:
  s *= 3;
  NEXT();

 op_done:
  /* 7 -> 21 -> 28 */

  /* 再来一趟：语句表达式**自己有标签**时，还得摆自己的状态机（别被上面那条捎带坏了） */
  s += __extension__ ({
    int t = 0;
    goto here;
  here:
    t = 2;
    if (t == 2) goto there;
    t = 99;
  there:
    t;
  });                                            /* 28 + 2 = 30 */

  /* 外圈的 goto 与里圈各摆一台：里圈跳完不许把外圈的槽写花 */
  int k = 0;
 again:
  k += __extension__ ({
    int u = 1;
    goto in;
  in:
    u + 1;
  });                                            /* 每趟 +2 */
  if (k < 6) goto again;                          /* k: 2,4,6 */
  s += k;                                         /* 30 + 6 = 36 */

  return s;
}
