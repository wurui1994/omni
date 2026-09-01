/* goto 还没做到。第 9 片把 switch 做成了「层层嵌套的 block」，那一招吃得下 switch
 * 是因为它的目标都在**同一个方向**（往外跳）；goto 可以往回跳、可以跳进别人的作用域，
 * 结构化控制流下要一套「循环 + 状态机」的改写（relooper 那一路）。 */
int main(void) {
  int i = 0;
  if (i == 0) goto done;
  i = 99;
done:
  return i;
}
