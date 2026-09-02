/* DLL 的导出表：几个 `__declspec(dllexport)`，名字故意不按字母序写 ——
 * `pe_build_exports` 是按 `strcmp` 排的，不是按符号表的次序。 */

__declspec(dllexport) int counter = 7;
__declspec(dllexport) int Zeta(int a) { return a + counter; }
__declspec(dllexport) int alpha(int a) { return Zeta(a) * 2; }
__declspec(dllexport) int _under(void) { return 3; }
__declspec(dllexport) int Mid = 11;

static int hidden(int a) { return a - 1; }

__declspec(dllexport) int beta(int a) { return hidden(a) + Mid; }

int _dllstart(void) { return 1; }
