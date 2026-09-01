/* 位域还没做到（第 6 片只做了成员与布局）。位域要在 CType 的
 * `VT_BITFIELD` 那两个 6 位段里记「偏移与宽度」（tcc.h:1077-1104），
 * 而读写要多一层移位与掩码 —— 那是下一片。 */
struct Flags {
  unsigned int a : 3;
  unsigned int b : 5;
};

int main(void) {
  struct Flags f;
  f.a = 5;
  return f.a;
}
