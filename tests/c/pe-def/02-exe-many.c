/* 导出得多一些，名字排序要跨过 `_`（0x5f）与小写字母（0x61）那条线。 */

#define F(n) __declspec(dllexport) int f##n(int a) { return a + n; }
F(0) F(1) F(2) F(3) F(4) F(5) F(6) F(7) F(8) F(9)
F(10) F(11) F(12) F(13) F(14) F(15) F(16) F(17) F(18) F(19)

typedef int (*fp)(int);
__declspec(dllexport) fp table[] = { f0, f9, f19 };
__declspec(dllexport) int _pick(int i) { return table[i % 3](i); }
__declspec(dllexport) int Pick(int i) { return _pick(i) + 1; }

int main(void) { return Pick(2); }
