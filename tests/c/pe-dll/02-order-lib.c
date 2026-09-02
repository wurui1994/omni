/* 导出多一些，名字的 `strcmp` 次序与用到的次序故意不一样 —— 导入表里那一串是按
 * **符号表里出现的次序**排的，不是按导出表的次序。 */

__declspec(dllexport) int zeta(int a) { return a + 1; }
__declspec(dllexport) int alpha(int a) { return a + 2; }
__declspec(dllexport) int mid(int a) { return a + 3; }
__declspec(dllexport) int beta(int a) { return a + 4; }
__declspec(dllexport) int table[4] = { 1, 2, 3, 4 };
__declspec(dllexport) const char *tag = "omni";

int _dllstart(void) { return 1; }
