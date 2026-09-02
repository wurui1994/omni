/* 第八刀第四十六片：块里的 `extern int x = 3;` —— tcc 连那个 `=` 都不认。 */
int main(void)
{
    extern int x = 3;
    return x;
}
