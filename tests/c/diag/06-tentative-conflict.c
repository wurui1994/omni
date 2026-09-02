/* 第八刀第三十九片：两条同名声明都写了长度、而且不一样 —— 合不了。
 * tcc 的原话是 `incompatible types for redefinition of 'a'`。 */
int a[3];
int a[4];

int main(void)
{
    return a[0];
}
