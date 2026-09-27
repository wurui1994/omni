/* `-std=` 那一格（tcc 的 `TCC_OPTION_std`，libtcc.c:1994）：**只有 `c11` 与 `gnu11` 算**，
 * 认了就把 `__STDC_VERSION__` 报成 201112L，别的写法（`c99`、`c17`、打错的）照默认走。
 *
 * 这一格的后果多半不在我们这儿而在**系统头**里：macOS 的 `_static_assert.h` 只在
 * `__STDC_VERSION__ >= 201112L` 时 `#define static_assert _Static_assert`，
 * CPython 的 `Include/object.h:145` 也只在那一支上才用 `_Alignas`。
 *
 * 判据的走法见 `tests/c/run.js` 的 `optCase`：`omni cpp -P -std=…` 与
 * `tcc -E -P -std=…` 的标准输出逐字节相同。 */
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
c11 __STDC_VERSION__
#else
c99 __STDC_VERSION__
#endif

/* C11 才有的那两个词在这一层只是记号，预处理看不见它们的语义 —— 这一格问的就是
 * 「__STDC_VERSION__ 报的是哪个数」，别的都不问。 */
#ifdef __STDC__
stdc __STDC__
#endif
