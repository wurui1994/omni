/* 阶段边界：`ASM_KNOWN` 是一张**白名单**，不是模板匹配 —— 模板对上了，形状也得对上。
 * 这一格给「读栈指针」那条塞两个输出：等价物只顶得住「一个输出、没有输入」那一种。 */
int main(void)
{
	unsigned long a, b;
	__asm__ ("mov %0, sp" : "=r" (a), "=r" (b));
	return (int)(a + b);
}
