extern int lib_data;
extern int lib_add(int);

int main(void)
{
    return lib_add(3) + lib_data;
}
