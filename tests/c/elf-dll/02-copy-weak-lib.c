/* 拷过来的那块不止四个字节：`R_*_COPY` 的长度取库里那条符号的 `st_size`，
 * 而 `.bss` 里那块的起点按 16 对齐（tcc 里那句 `XXX: which alignment ?`）。
 * 再加一个弱符号：库里有定义，用它的那一份于是不该留下未定义的引用。 */

char lib_buf[40] = "from the library";
int lib_tail = 5;

__attribute__((weak)) int lib_weak(int a)
{
    return a * 2;
}
