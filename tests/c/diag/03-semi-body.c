/* 函数体里的语法错误。这一格钉的是**行号**：函数体是先收成记号串、再放一遍解析的
 * （`Cpp.captureBraced` / `finishFunc`，MIR 换来的代价），放的时候文件已经读到末尾了。
 * 记号串里带 `TOK_LINENUM`、放的时候把行号拨回去 —— 少了那一条，这儿会报到最后一行。 */
int f(int n)
{
	int i;
	int s = 0;
	for (i = 0; i < n; i++) {
		s += i;
	}
	int t = s
	return t;
}

int main(void) { return f(3); }
