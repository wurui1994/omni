/* 构造函数：`.init_array` 在 Mach-O 里叫 `__mod_init_func`，落在 `__DATA` 段里。
 * 那一节的每一格都是个函数指针 —— 于是每一格都要一条 rebase。 */

static int v;
static int w;

__attribute__((constructor)) static void setup(void) { v = 7; }
__attribute__((constructor)) static void setup2(void) { w = 35; }

int main(void) { return v + w; }
