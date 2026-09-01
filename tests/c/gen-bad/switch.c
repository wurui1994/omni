/* switch 还没做到（第 4 片）。MIR 的 BRTABLE 在第三刀就加好了，
 * 缺的是前端这一侧的密集化判断。 */
int main(void) {
  int x = 2;
  switch (x) {
  case 1: return 10;
  case 2: return 20;
  default: return 30;
  }
}
