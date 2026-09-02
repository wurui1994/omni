extern char lib_buf[40];
extern int lib_tail;
__attribute__((weak)) int lib_weak(int);

static int len(const char *s)
{
    int n = 0;
    while (s[n] != 0)
        n++;
    return n;
}

int main(void)
{
    int n = len(lib_buf) + lib_tail;
    if (lib_weak)
        n += lib_weak(1);
    return n;
}
