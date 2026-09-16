/* `--skip-missing-includes`（tcc 没有这一格）：找不到的头当空文件跳过，
 * 于是**别人的源码**当语料读的时候，宏还是能展开 —— 前言用 `-D` 递。
 *
 * 判据在 tests/c/run.js 第 2.5 节：
 *   关着：报 `include file 'no-such-header.h' not found`，退出码非 0；
 *   开着：出正文，`TEST(A, Empty)` 展开成 `void A_Empty_Test()`，并且**警告里说得出跳了谁**。 */
#include "no-such-header.h"
#include <also-not-here.h>

TEST(A, Empty) { return 0; }
