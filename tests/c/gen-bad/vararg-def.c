/* 变参函数的**定义**还没到（调用早就通了：`printf` 那一族走 CCALL）。
 *
 * 定义它要 `va_list` / `va_start` / `va_arg`，而那三个在 C 里是宏 —— 展开成
 * 「按 ABI 从形参区往后走」的代码。也就是说这一格要的不是语法，是**调用约定**：
 * arm64 与 x86-64 的变参区布局不同，而我们这一片的形参还都在 MIR 的槽里。 */
int printf(const char *fmt, ...);

static int total(int n, ...) { return n; }

int main(void) {
  return total(1, 2, 3);
}
