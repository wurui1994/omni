/* 不带 libc 的用例：`.bss`、tentative definition、以及 `_etext`/`_edata`/`_end`
 * 这几个链接器给的符号（ADR-0017 第九刀第五十三片的尺子之一）。 */

int uninit_int;
char uninit_buf[4096];
int inited = 7;
static int table[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };

extern char _etext[], _edata[], _end[];

static int sum_table(void)
{
    int i, s = 0;
    for (i = 0; i < 8; i++)
        s += table[i];
    return s;
}

int main(void)
{
    uninit_int = 3;
    uninit_buf[10] = 'x';
    return sum_table() + inited + uninit_int + uninit_buf[10]
        + (int)(_end - _etext) + (int)(_edata - _etext);
}
