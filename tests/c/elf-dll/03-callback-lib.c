/* 反过来的那一路：库里引用一个名字，可执行文件里有定义 —— `bind_libs_dynsyms`
 * 要把我们这份定义导出到 `.dynsym`，装载器才会先在可执行文件里找到它。 */

extern int host_hook(int);

int lib_call(int a)
{
    return host_hook(a) + 1;
}
