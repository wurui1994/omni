/* 线程局部（local-exec）：`__thread` 的变量落在 `.tdata`/`.tbss`，摆放时多一个
 * PT_TLS 段，取地址那几条重定位是相对**那一段**算的。
 *
 *  - x86_64：`R_X86_64_TPOFF32` = `val - tls_end` —— fs 基址在整块的**末尾**，
 *    所以偏移是负数。
 *  - arm64：`TLSLE_ADD_TPREL_HI12`/`LO12` 是 `val - tls_start + 16` —— tpidr_el0
 *    指着 `tcbhead_t`，数据跟在它后面，那 16 个字节要算进去。
 *
 * 初始化过的、没初始化过的、静态的各一份：三节（`.tdata`/`.tbss`）与三种可见性
 * 都在这一条上。 */

__thread int counter = 5;
__thread int other;
static __thread int hidden = 3;

int bump(int a)
{
    counter += a;
    hidden += a;
    other = counter + hidden;
    return other;
}

int main(void)
{
    return bump(2);
}
