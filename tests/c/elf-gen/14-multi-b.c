/* `14-multi-a.c` 的另一半。 */

int shared_counter;

static const char tag[] = "bump";

int bump(int n)
{
    shared_counter += n + tag[0];
    return shared_counter * 2;
}
