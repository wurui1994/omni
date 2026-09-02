/* 导出表与导入表挨在一块：两张都在 thunk 节里，导入表在前、导出表在后（对到 16）。 */

#include <stdio.h>
#include <string.h>

__declspec(dllexport) int say(const char *s)
{
  printf("%s %d\n", s, (int)strlen(s));
  return (int)strlen(s);
}

__declspec(dllexport) const char *tag = "omni";

__declspec(dllexport) int all(void)
{
  return say(tag);
}

int _dllstart(void) { return 1; }
