/* 库这一侧：一个数据符号加一个函数。用它的那一份要一格跳板（函数）
 * 与一条 `R_*_COPY`（数据）。 */

int lib_data = 7;

int lib_add(int a)
{
    return a + lib_data;
}
