/* 可执行文件里的 `__declspec(dllexport)`：`pe_build_exports` 不问是不是 DLL，
 * 所以这份 `.exe` 里一样有一张导出目录，旁边一样有一份 `<输出>.def`。 */

__declspec(dllexport) int counter = 7;
__declspec(dllexport) int Zeta(int a) { return a + counter; }
__declspec(dllexport) int alpha(int a) { return Zeta(a) * 2; }
__declspec(dllexport) int _under(void) { return 3; }

static int hidden(int a) { return a - 1; }

int main(void) { return alpha(hidden(counter)) + _under(); }
