/* 自己起名的节 + `__attribute__((constructor))`：`__start_xxx`/`__stop_xxx` 与
 * `.init_array`（`.init_array` 是 RELRO 的一类，会牵出 PT_GNU_RELRO 那个段头）。 */

__attribute__((section("mysec"))) int marked[3] = { 11, 22, 33 };

extern int __start_mysec[], __stop_mysec[];

static int ran;

__attribute__((constructor)) static void setup(void)
{
    ran = 1;
}

int main(void)
{
    return (int)(__stop_mysec - __start_mysec) + marked[1] + ran;
}
