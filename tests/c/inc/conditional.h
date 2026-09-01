#if defined(WANT_EXTRA) && WANT_EXTRA
#define COND_VALUE 5
int cond_extra_decl;
#else
#define COND_VALUE 0
int cond_plain_decl;
#endif
