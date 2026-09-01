// Omni — 测试轴的工作目录（第一百〇五刀）
//
// 一句话：**不用系统临时目录**。从前每条轴都是 `mkdtempSync(join(tmpdir(), 'omni-X-'))`，
// 于是中间产物落在 `/var/folders/x6/dw0kzl…/omni-wat-AbCdEf/` 这种地方：
//   - 系统会清它。一趟跑完想翻"上一趟到底生成了什么 C / 什么 .ll"，常常已经没了。
//   - 名字随机，连"是哪一趟"都对不上。
// 现在一条轴一格，落在仓库的 `.omni-cache/test/<轴名>` 底下（`.gitignore` 已经挡了
// `/.omni-cache/`）。**进来先清空**：名字是确定的，所以不会像 mkdtemp 那样每跑一趟多一个
// 目录；跑完那一格就是这一趟留下的东西，直接翻。
//
// 代价写在明处：同一条轴**并发跑两遍**会互相盖（从前 mkdtemp 不会）。轴自己是串行的，
// 而两个人在同一个 checkout 里同时跑同一条轴本来就会争同一批缓存。

import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 这条轴的工作目录（`.omni-cache/test/<name>`），已经清空并建好。
 * `OMNI_CACHE_DIR` 与编译器那边同一个含义：整棵搬走（CI 上想放到 workspace 之外时用）。
 */
export function workDir(name) {
  const base = process.env.OMNI_CACHE_DIR || join(ROOT, '.omni-cache');
  const dir = join(base, 'test', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
