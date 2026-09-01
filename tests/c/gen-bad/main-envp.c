/* 第八刀第十一片的边界：`main` 的第三个形参（`envp`）还没到。
 * 它是 POSIX 上的一条扩展（tcc 认），而线性内存里没有「环境」这一段 ——
 * 那要先决定 `environ` 住哪儿、`getenv` 从哪儿读。 */
int main(int argc, char **argv, char **envp) {
  return argc + (argv != 0) + (envp != 0);
}
