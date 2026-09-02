/* 一份真的 `.dll`：函数与数据各导出几个。数据那几个用的时候要
 * `__declspec(dllimport)`，函数不用。 */

__declspec(dllexport) int gvar = 7;
__declspec(dllexport) int add(int a) { return a + gvar; }
__declspec(dllexport) int mul(int a, int b) { return a * b; }

int _dllstart(void) { return 1; }
