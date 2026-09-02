#include <stdio.h>

extern int zeta(int);
extern int alpha(int);
extern int mid(int);
extern int beta(int);
__declspec(dllimport) extern int table[4];
__declspec(dllimport) extern const char *tag;

int main(void)
{
  printf("%s %d\n", tag, table[2]);
  return zeta(1) + beta(2) + alpha(3) + mid(4);
}
