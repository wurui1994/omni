/* 两个目标文件一起链：跨文件的调用与共享变量（`14-multi-b.c` 是另一半）。 */

extern int shared_counter;
int bump(int n);

static int local_seed = 5;

int main(void)
{
    shared_counter = local_seed;
    return bump(2) + shared_counter;
}
