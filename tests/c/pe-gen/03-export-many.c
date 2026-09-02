/* 导出得多一些：4K 那条线两边都有，`.reloc` 里也就不只一个块。 */

#define F(n) __declspec(dllexport) int f##n(int a) { return a + n; }
F(0) F(1) F(2) F(3) F(4) F(5) F(6) F(7) F(8) F(9)
F(10) F(11) F(12) F(13) F(14) F(15) F(16) F(17) F(18) F(19)
F(20) F(21) F(22) F(23) F(24) F(25) F(26) F(27) F(28) F(29)

typedef int (*fp)(int);
__declspec(dllexport) fp table[] = { f0, f9, f19, f29 };

__declspec(dllexport) int pick(int i) { return table[i & 3](i); }

int _dllstart(void) { return 1; }
