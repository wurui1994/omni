extern int lib_call(int);

int host_hook(int a)
{
    return a * 3;
}

int main(void)
{
    return lib_call(2);
}
