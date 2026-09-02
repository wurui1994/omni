/* 只读数据：字符串、浮点常量表、长长整数 —— 这些落在 `.data.ro` 那一类里。 */

static const char msg[] = "omni";
static const double table[4] = { 0.5, 1.5, 2.5, 3.5 };
static long long big = 1234567890123LL;

int main(void)
{
    double s = 0;
    int i;
    for (i = 0; i < 4; i++)
        s += table[i];
    return (int)s + msg[2] + (int)(big % 7);
}
