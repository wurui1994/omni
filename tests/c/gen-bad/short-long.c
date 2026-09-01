/* 真类型错误（不是进度边界）：`short` 与 `long` 不能一起写。
 * 这一条钉的是新长出来的说明符循环真的在核对，而不是见到什么都按位或上去。 */
int main(void) {
  short long x = 1;
  return x;
}
