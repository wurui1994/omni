/* src/jit/png.c —— 最窄的一档 PNG 写盘（ADR-0019 决策九）
 *
 * 8 位 RGBA、filter 0（每行前面一个 0 字节）、zlib **stored**（deflate 的未压缩块）。
 * **不引 zlib 依赖**：宿主已经链了 LLVM，再多一个外部库不值得，而 stored 的那点格式
 * （两字节头 + 每块五字节 + adler32）自己写比接一个库短。
 *
 * 代价写在明处：stored 的文件大（256² RGBA ≈ 260 KB）。它是**对照物**，不是要发布的图。
 *
 * 行序：调用者给的第 0 行是**画布最上面**那一行。片元那一侧 `gl_FragCoord.y = 0` 是
 * 最下面（见 ADR「量：gl_FragCoord.y 与缓冲行序」），所以扫画布的那一层要负责翻 ——
 * 这一层不猜，只按 PNG 的规矩写（第 0 行在上）。
 */

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* CRC-32（PNG 用的那个多项式 0xEDB88320，反射形）。表按需生成，省掉一张静态表。 */
static uint32_t png_crc_tab[256];
static int png_crc_ready = 0;

static void png_crc_init(void) {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
    png_crc_tab[n] = c;
  }
  png_crc_ready = 1;
}

static uint32_t png_crc(const uint8_t *p, size_t n) {
  if (!png_crc_ready) png_crc_init();
  uint32_t c = 0xFFFFFFFFu;
  for (size_t i = 0; i < n; i++) c = png_crc_tab[(c ^ p[i]) & 0xFF] ^ (c >> 8);
  return c ^ 0xFFFFFFFFu;
}

/* adler32（zlib 流尾巴那四个字节）。 */
static uint32_t png_adler(const uint8_t *p, size_t n) {
  uint32_t a = 1, b = 0;
  for (size_t i = 0; i < n; i++) {
    a = (a + p[i]) % 65521u;
    b = (b + a) % 65521u;
  }
  return (b << 16) | a;
}

static void png_be32(uint8_t *d, uint32_t v) {
  d[0] = (uint8_t)(v >> 24); d[1] = (uint8_t)(v >> 16);
  d[2] = (uint8_t)(v >> 8);  d[3] = (uint8_t)v;
}

/* 一个块：长度 + 类型 + 数据 + CRC（CRC 盖住类型和数据，不盖长度）。 */
static int png_chunk(FILE *f, const char *ty, const uint8_t *data, size_t n) {
  uint8_t hdr[8], crc[4];
  png_be32(hdr, (uint32_t)n);
  memcpy(hdr + 4, ty, 4);
  if (fwrite(hdr, 1, 8, f) != 8) return 0;
  if (n > 0 && fwrite(data, 1, n, f) != n) return 0;
  /* CRC 要连着算「类型 + 数据」，所以这儿拼一份临时的。 */
  uint8_t *tmp = (uint8_t *)malloc(n + 4);
  if (tmp == NULL) return 0;
  memcpy(tmp, ty, 4);
  if (n > 0) memcpy(tmp + 4, data, n);
  png_be32(crc, png_crc(tmp, n + 4));
  free(tmp);
  return fwrite(crc, 1, 4, f) == 4;
}

/**
 * 写一份 8 位 RGBA 的 PNG。
 *
 *   rgba  —— w*h*4 字节，第 0 行是**最上面**那一行
 *   回 0 表示成功，非 0 是出错的那一步（给调用者当退出码用）
 */
int png_write_rgba(const char *path, const uint8_t *rgba, int w, int h) {
  if (w <= 0 || h <= 0) return 1;
  FILE *f = fopen(path, "wb");
  if (f == NULL) return 2;

  static const uint8_t sig[8] = { 137, 'P', 'N', 'G', '\r', '\n', 26, '\n' };
  if (fwrite(sig, 1, 8, f) != 8) { fclose(f); return 3; }

  /* IHDR：宽、高、位深 8、颜色类型 6（RGBA）、压缩 0、过滤 0、无隔行。 */
  uint8_t ihdr[13];
  png_be32(ihdr, (uint32_t)w);
  png_be32(ihdr + 4, (uint32_t)h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  if (!png_chunk(f, "IHDR", ihdr, 13)) { fclose(f); return 4; }

  /* 原始数据 = 每行「一个 0（filter none）+ w*4 字节」。 */
  size_t stride = (size_t)w * 4 + 1;
  size_t raw_n = stride * (size_t)h;
  uint8_t *raw = (uint8_t *)malloc(raw_n);
  if (raw == NULL) { fclose(f); return 5; }
  for (int y = 0; y < h; y++) {
    raw[stride * (size_t)y] = 0;
    memcpy(raw + stride * (size_t)y + 1, rgba + (size_t)y * (size_t)w * 4, (size_t)w * 4);
  }

  /* zlib 流：两字节头（0x78 0x01 = deflate/32K 窗口/最低压缩）+ 若干 stored 块 + adler32。
     每个 stored 块：1 字节 BFINAL|BTYPE(00) + LEN(小端 2 字节) + ~LEN + 那么多字节。
     一块最多 65535 字节，所以大图要切好几块。 */
  size_t blocks = (raw_n + 65534) / 65535;
  if (blocks == 0) blocks = 1;
  size_t z_n = 2 + blocks * 5 + raw_n + 4;
  uint8_t *z = (uint8_t *)malloc(z_n);
  if (z == NULL) { free(raw); fclose(f); return 6; }
  size_t zi = 0;
  z[zi++] = 0x78; z[zi++] = 0x01;
  size_t left = raw_n, off = 0;
  for (size_t b = 0; b < blocks; b++) {
    size_t part = left > 65535 ? 65535 : left;
    z[zi++] = (b + 1 == blocks) ? 1 : 0;         /* 最后一块置 BFINAL */
    z[zi++] = (uint8_t)(part & 0xFF);
    z[zi++] = (uint8_t)(part >> 8);
    z[zi++] = (uint8_t)(~part & 0xFF);
    z[zi++] = (uint8_t)((~part >> 8) & 0xFF);
    memcpy(z + zi, raw + off, part);
    zi += part; off += part; left -= part;
  }
  png_be32(z + zi, png_adler(raw, raw_n));
  zi += 4;
  free(raw);

  int ok = png_chunk(f, "IDAT", z, zi);
  free(z);
  if (!ok) { fclose(f); return 7; }
  if (!png_chunk(f, "IEND", NULL, 0)) { fclose(f); return 8; }
  return fclose(f) == 0 ? 0 : 9;
}
