/* 阶段边界：模板非空的 `__asm__` 要真的发指令 —— 等自带汇编器（ADR-0017 第九到十一步）。 */
int main(void)
{
	int x = 1;
	__asm__ __volatile__("nop" ::: "memory");
	return x;
}
