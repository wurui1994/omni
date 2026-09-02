extern int add(int);
extern int mul(int, int);
__declspec(dllimport) extern int gvar;

int main(void)
{
  return add(1) + mul(2, 3) + gvar;
}
