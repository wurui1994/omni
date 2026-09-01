/* 位域没有地址（C11 6.5.3.2 第 1 段）—— 它连整字节都不占。
 * 这一条是**真的诊断**，不是「还没到」的钉子：位域第 7 片就做完了。 */
struct Flags {
  unsigned int a : 3;
  unsigned int b : 5;
};

int main(void) {
  struct Flags f;
  f.a = 5;
  unsigned int *p = &f.a;
  return *p;
}
