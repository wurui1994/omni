/*
 * omni_vk —— 把一份 SPIR-V 计算模块在真设备上跑一遍，然后把缓冲的内容印出来。
 * ADR-0014 门槛 7 的前半句要的那个"设备侧答案"就是它印的东西。
 *
 * 为什么是一份独立的宿主程序而不是编译器的一个子命令：`dispatch` 的语义在 CPU 那五条腿
 * 上是「降级期展开成 while + 普通调用」（决策 6 的门槛 7 小节），main 本来就在 CPU 上跑。
 * 要在设备上跑的只有 kernel 那一段，而"把缓冲绑上去、灌 push constant、dispatch、
 * 把结果读回来"是 Vulkan 的活，跟编译器没有关系。所以它是测试轴的工具，不是后端的一部分。
 *
 * 用法：
 *   omni_vk MODULE.spv ENTRY --grid N [--buf i64:v,v,...]... [--push i64:v|f64:v]...
 *
 * 缓冲按给出的顺序绑到 set 0 的 binding 0..N-1 —— 和发射器给缓冲形参编号的顺序一致
 * （backend-spirv/emit.js 的 bufVar）。标量按顺序进 push constant 块，每个 8 字节。
 * 印出来的是 dispatch 之后每个缓冲的内容，一行一个缓冲，值之间一个空格。
 *
 * **工作组大小与 LocalSize 都是从模块里读出来的，不是约定的**：头部那几条
 * OpCapability / OpExecutionMode 就说了这份模块要什么特性、工作组多大。于是
 *   - 设备缺 shaderFloat64（Apple 的 Metal 就没有双精度）时**退出码 3**，
 *     让测试轴把它记成 skip 而不是 fail —— 那是平台的事实，不是降级出了错；
 *   - 组数 = ceil(grid / LocalSize.x)，所以实际起的调用数会被向上取整到工作组的整数倍。
 *     多出来的那些道靠 kernel 自己用 blen 守门（门槛 7 的约定），CPU 那边跑的是恰好
 *     grid 次 —— 两边能对上正是因为守门条件是 blen，而不是 grid。
 *
 * 退出码：0 = 跑完；2 = 用法/Vulkan 出错；3 = 这台设备缺这份模块要的特性。
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <vulkan/vulkan.h>

#define MAX_BUF 8
#define MAX_PUSH 16

typedef struct {
  int isF;              /* 元素是 f64 还是 i64 —— 只影响解析与打印，字节数都是 8 */
  uint32_t n;
  uint64_t *cells;      /* 8 字节一格；f64 按位存 */
  VkBuffer buf;
  VkDeviceMemory mem;
  VkDeviceSize bytes;
} Buf;

static void die(const char *what, int code) {
  fprintf(stderr, "omni_vk: %s（VkResult %d）\n", what, code);
  exit(2);
}

static void usage(const char *why) {
  fprintf(stderr, "omni_vk: %s\n用法：omni_vk MODULE.spv ENTRY --grid N "
          "[--buf i64:v,v,...] [--push i64:v|f64:v]\n", why);
  exit(2);
}

#define VKCHK(x, what) do { VkResult _r = (x); if (_r != VK_SUCCESS) die(what, _r); } while (0)

/* ---------------------------------------------------------------- 模块自述
 * 头 5 个字之后是指令流，每条指令第一个字是 (长度 << 16 | opcode)。
 * 只看两条：OpCapability(17) 说要什么特性，OpExecutionMode(16) 的 LocalSize(17) 说工作组多大。
 * 这样「要不要 Float64」「一组多少道」都是从这份模块里读出来的，不是宿主和发射器
 * 各记一份的约定 —— 那种约定迟早会走散。
 */
static void scanModule(const uint32_t *w, size_t nw, int *needF64, int *needI64, uint32_t *localX) {
  size_t i = 5;
  while (i < nw) {
    uint32_t op = w[i] & 0xffff;
    uint32_t len = w[i] >> 16;
    if (len == 0 || i + len > nw) break;
    if (op == 17 && len >= 2) {
      if (w[i + 1] == 10) *needF64 = 1;   /* Capability Float64 */
      if (w[i + 1] == 11) *needI64 = 1;   /* Capability Int64 */
    }
    if (op == 16 && len >= 6 && w[i + 2] == 17) *localX = w[i + 3];  /* ExecutionMode LocalSize */
    i += len;
  }
}

static uint32_t *readWords(const char *path, size_t *nwOut) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "omni_vk: 打不开 %s\n", path); exit(2); }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (n <= 0 || (n % 4) != 0) { fprintf(stderr, "omni_vk: %s 不像 SPIR-V（%ld 字节）\n", path, n); exit(2); }
  uint32_t *w = (uint32_t *)malloc((size_t)n);
  if (fread(w, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "omni_vk: 读不完 %s\n", path); exit(2); }
  fclose(f);
  if (w[0] != 0x07230203) { fprintf(stderr, "omni_vk: %s 的魔数不对\n", path); exit(2); }
  *nwOut = (size_t)n / 4;
  return w;
}

/* `i64:1,2,3` / `f64:1.5,-2` -> 一格一个 8 字节值。f64 按位塞进同一片存储。 */
static void parseCells(const char *spec, int *isF, uint32_t *n, uint64_t **cells) {
  const char *colon = strchr(spec, ':');
  if (!colon) usage("--buf / --push 要写成 类型:值[,值...]");
  size_t tn = (size_t)(colon - spec);
  if (tn == 3 && strncmp(spec, "f64", 3) == 0) *isF = 1;
  else if (tn == 3 && strncmp(spec, "i64", 3) == 0) *isF = 0;
  else usage("元素类型只能是 i64 或 f64");
  uint32_t cap = 1;
  for (const char *p = colon + 1; *p; p++) if (*p == ',') cap++;
  uint64_t *out = (uint64_t *)calloc(cap, 8);
  uint32_t k = 0;
  const char *p = colon + 1;
  if (*p == 0) { *n = 0; *cells = out; return; }
  while (*p && k < cap) {
    char *end = NULL;
    if (*isF) {
      double d = strtod(p, &end);
      memcpy(&out[k], &d, 8);
    } else {
      long long v = strtoll(p, &end, 10);
      int64_t s = (int64_t)v;
      memcpy(&out[k], &s, 8);
    }
    if (end == p) usage("--buf / --push 里有个值读不出来");
    k++;
    p = (*end == ',') ? end + 1 : end;
  }
  *n = k;
  *cells = out;
}

/* ------------------------------------------------------------------- 主流程 */

int main(int argc, char **argv) {
  if (argc < 3) usage("至少要 MODULE.spv 与 ENTRY");
  const char *modPath = argv[1];
  const char *entry = argv[2];
  uint32_t grid = 0;
  Buf bufs[MAX_BUF];
  uint32_t nbuf = 0;
  uint64_t push[MAX_PUSH];
  uint32_t npush = 0;
  memset(bufs, 0, sizeof bufs);
  memset(push, 0, sizeof push);

  for (int i = 3; i < argc; i++) {
    if (strcmp(argv[i], "--grid") == 0 && i + 1 < argc) { grid = (uint32_t)strtoul(argv[++i], NULL, 10); continue; }
    if (strcmp(argv[i], "--buf") == 0 && i + 1 < argc) {
      if (nbuf == MAX_BUF) usage("缓冲太多");
      Buf *b = &bufs[nbuf];
      parseCells(argv[++i], &b->isF, &b->n, &b->cells);
      b->bytes = (VkDeviceSize)(b->n == 0 ? 8 : b->n * 8);  /* 空缓冲也要有一格，Vulkan 不收 0 字节 */
      nbuf++;
      continue;
    }
    if (strcmp(argv[i], "--push") == 0 && i + 1 < argc) {
      int isF = 0;
      uint32_t n = 0;
      uint64_t *cells = NULL;
      parseCells(argv[++i], &isF, &n, &cells);
      for (uint32_t k = 0; k < n; k++) {
        if (npush == MAX_PUSH) usage("push constant 太多");
        push[npush++] = cells[k];
      }
      free(cells);
      continue;
    }
    usage("认不出的参数");
  }
  if (grid == 0) usage("--grid 要大于 0");

  size_t nw = 0;
  uint32_t *words = readWords(modPath, &nw);
  int needF64 = 0;
  int needI64 = 0;
  uint32_t localX = 1;
  scanModule(words, nw, &needF64, &needI64, &localX);
  if (localX == 0) localX = 1;

  /* ---- instance。macOS 上的 ICD 是 MoltenVK，它要 portability 那条枚举扩展；
   * 别的平台上没有这条扩展，所以先试带、失败再试不带 —— 平台差异吞在这里，
   * 上面的测试轴不必知道。 */
  VkInstance inst = VK_NULL_HANDLE;
  {
    const char *exts[] = { "VK_KHR_portability_enumeration" };
    VkInstanceCreateInfo ici;
    memset(&ici, 0, sizeof ici);
    ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ici.flags = 0x00000001;   /* VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR */
    ici.enabledExtensionCount = 1;
    ici.ppEnabledExtensionNames = exts;
    if (vkCreateInstance(&ici, NULL, &inst) != VK_SUCCESS) {
      memset(&ici, 0, sizeof ici);
      ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
      VKCHK(vkCreateInstance(&ici, NULL, &inst), "vkCreateInstance");
    }
  }

  /* ---- 挑一个有 compute 队列、而且特性够的物理设备。够不上就退 3（测试轴记 skip）。 */
  uint32_t ndev = 0;
  vkEnumeratePhysicalDevices(inst, &ndev, NULL);
  if (ndev == 0) { fprintf(stderr, "omni_vk: 没有 Vulkan 设备\n"); return 3; }
  if (ndev > 8) ndev = 8;
  VkPhysicalDevice devs[8];
  vkEnumeratePhysicalDevices(inst, &ndev, devs);
  VkPhysicalDevice phys = VK_NULL_HANDLE;
  uint32_t qfam = 0;
  char devName[256] = "?";
  for (uint32_t i = 0; i < ndev && phys == VK_NULL_HANDLE; i++) {
    VkPhysicalDeviceFeatures f;
    vkGetPhysicalDeviceFeatures(devs[i], &f);
    if (needF64 && !f.shaderFloat64) continue;
    if (needI64 && !f.shaderInt64) continue;
    uint32_t nq = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(devs[i], &nq, NULL);
    if (nq > 16) nq = 16;
    VkQueueFamilyProperties qs[16];
    vkGetPhysicalDeviceQueueFamilyProperties(devs[i], &nq, qs);
    for (uint32_t q = 0; q < nq; q++) {
      if (qs[q].queueFlags & VK_QUEUE_COMPUTE_BIT) {
        VkPhysicalDeviceProperties p;
        vkGetPhysicalDeviceProperties(devs[i], &p);
        snprintf(devName, sizeof devName, "%s", p.deviceName);
        phys = devs[i];
        qfam = q;
        break;
      }
    }
  }
  if (phys == VK_NULL_HANDLE) {
    /* 说清是「谁要什么、谁给什么」，而不是只报一句缺特性 —— Apple 的 Metal 没有双精度，
     * 这条消息会被测试轴原样印出来当 skip 的理由，含糊就等于查不出原因。 */
    fprintf(stderr, "omni_vk: 没有设备能跑这份模块。模块要 Float64=%d Int64=%d；\n", needF64, needI64);
    for (uint32_t i = 0; i < ndev; i++) {
      VkPhysicalDeviceProperties p;
      VkPhysicalDeviceFeatures f;
      vkGetPhysicalDeviceProperties(devs[i], &p);
      vkGetPhysicalDeviceFeatures(devs[i], &f);
      fprintf(stderr, "  设备 %u（%s）给 shaderFloat64=%d shaderInt64=%d\n",
              i, p.deviceName, f.shaderFloat64, f.shaderInt64);
    }
    return 3;
  }
  fprintf(stderr, "omni_vk: %s，工作组 %u，组数 %u\n", devName, localX, (grid + localX - 1) / localX);

  /* ---- 逻辑设备 + 队列。要用的特性显式打开：Int64/Float64 不打开的话，
   * 模块里的 OpCapability 就是一句空话（驱动会拒，或者更糟：给个错答案）。 */
  VkDevice dev = VK_NULL_HANDLE;
  VkQueue queue = VK_NULL_HANDLE;
  {
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci;
    memset(&qci, 0, sizeof qci);
    qci.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qci.queueFamilyIndex = qfam;
    qci.queueCount = 1;
    qci.pQueuePriorities = &prio;
    VkPhysicalDeviceFeatures want;
    memset(&want, 0, sizeof want);
    want.shaderInt64 = needI64 ? VK_TRUE : VK_FALSE;
    want.shaderFloat64 = needF64 ? VK_TRUE : VK_FALSE;
    const char *dexts[] = { "VK_KHR_portability_subset" };
    VkDeviceCreateInfo dci;
    memset(&dci, 0, sizeof dci);
    dci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.queueCreateInfoCount = 1;
    dci.pQueueCreateInfos = &qci;
    dci.pEnabledFeatures = &want;
    /* portability_subset 在 MoltenVK 上是必须声明的；不支持它的平台上要去掉这一条 */
    dci.enabledExtensionCount = 1;
    dci.ppEnabledExtensionNames = dexts;
    if (vkCreateDevice(phys, &dci, NULL, &dev) != VK_SUCCESS) {
      dci.enabledExtensionCount = 0;
      dci.ppEnabledExtensionNames = NULL;
      VKCHK(vkCreateDevice(phys, &dci, NULL, &dev), "vkCreateDevice");
    }
    vkGetDeviceQueue(dev, qfam, 0, &queue);
  }

  /* ---- 缓冲：HOST_VISIBLE|HOST_COHERENT，映射着填、映射着读回。
   * 不走 staging + 拷贝：这是个测试工具，要的是"结果对不对"，不是带宽。 */
  VkPhysicalDeviceMemoryProperties memProps;
  vkGetPhysicalDeviceMemoryProperties(phys, &memProps);
  for (uint32_t i = 0; i < nbuf; i++) {
    Buf *b = &bufs[i];
    VkBufferCreateInfo bci;
    memset(&bci, 0, sizeof bci);
    bci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bci.size = b->bytes;
    bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VKCHK(vkCreateBuffer(dev, &bci, NULL, &b->buf), "vkCreateBuffer");
    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(dev, b->buf, &req);
    uint32_t pick = UINT32_MAX;
    for (uint32_t m = 0; m < memProps.memoryTypeCount; m++) {
      const VkMemoryPropertyFlags need = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT
        | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
      if ((req.memoryTypeBits & (1u << m)) && (memProps.memoryTypes[m].propertyFlags & need) == need) {
        pick = m;
        break;
      }
    }
    if (pick == UINT32_MAX) { fprintf(stderr, "omni_vk: 没有 host-visible 的内存类型\n"); return 3; }
    VkMemoryAllocateInfo mai;
    memset(&mai, 0, sizeof mai);
    mai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    mai.allocationSize = req.size;
    mai.memoryTypeIndex = pick;
    VKCHK(vkAllocateMemory(dev, &mai, NULL, &b->mem), "vkAllocateMemory");
    VKCHK(vkBindBufferMemory(dev, b->buf, b->mem, 0), "vkBindBufferMemory");
    void *p = NULL;
    VKCHK(vkMapMemory(dev, b->mem, 0, b->bytes, 0, &p), "vkMapMemory");
    memset(p, 0, (size_t)b->bytes);
    if (b->n > 0) memcpy(p, b->cells, (size_t)b->n * 8);
    vkUnmapMemory(dev, b->mem);
  }

  /* ---- 描述符：set 0，binding 0..nbuf-1，全是 storage buffer。
   * 顺序就是命令行上 --buf 的顺序，也就是发射器给缓冲形参编 binding 的顺序。 */
  VkDescriptorSetLayoutBinding binds[MAX_BUF];
  memset(binds, 0, sizeof binds);
  for (uint32_t i = 0; i < nbuf; i++) {
    binds[i].binding = i;
    binds[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    binds[i].descriptorCount = 1;
    binds[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
  }
  VkDescriptorSetLayout setLayout;
  {
    VkDescriptorSetLayoutCreateInfo ci;
    memset(&ci, 0, sizeof ci);
    ci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    ci.bindingCount = nbuf;
    ci.pBindings = binds;
    VKCHK(vkCreateDescriptorSetLayout(dev, &ci, NULL, &setLayout), "vkCreateDescriptorSetLayout");
  }
  VkDescriptorPool pool;
  {
    VkDescriptorPoolSize sz;
    sz.type = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    sz.descriptorCount = nbuf == 0 ? 1 : nbuf;
    VkDescriptorPoolCreateInfo ci;
    memset(&ci, 0, sizeof ci);
    ci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    ci.maxSets = 1;
    ci.poolSizeCount = 1;
    ci.pPoolSizes = &sz;
    VKCHK(vkCreateDescriptorPool(dev, &ci, NULL, &pool), "vkCreateDescriptorPool");
  }
  VkDescriptorSet set;
  {
    VkDescriptorSetAllocateInfo ai;
    memset(&ai, 0, sizeof ai);
    ai.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
    ai.descriptorPool = pool;
    ai.descriptorSetCount = 1;
    ai.pSetLayouts = &setLayout;
    VKCHK(vkAllocateDescriptorSets(dev, &ai, &set), "vkAllocateDescriptorSets");
    VkDescriptorBufferInfo infos[MAX_BUF];
    VkWriteDescriptorSet writes[MAX_BUF];
    memset(infos, 0, sizeof infos);
    memset(writes, 0, sizeof writes);
    for (uint32_t i = 0; i < nbuf; i++) {
      infos[i].buffer = bufs[i].buf;
      infos[i].offset = 0;
      infos[i].range = bufs[i].bytes;
      writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
      writes[i].dstSet = set;
      writes[i].dstBinding = i;
      writes[i].descriptorCount = 1;
      writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
      writes[i].pBufferInfo = &infos[i];
    }
    if (nbuf > 0) vkUpdateDescriptorSets(dev, nbuf, writes, 0, NULL);
  }

  /* ---- 管线：push constant 一段 8*npush 字节，从 0 开始 —— 与发射器给
   * push constant 块排成员偏移的规则（序号 × 8）是同一条。 */
  VkPipelineLayout layout;
  {
    VkPushConstantRange pcr;
    pcr.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    pcr.offset = 0;
    pcr.size = npush * 8;
    VkPipelineLayoutCreateInfo ci;
    memset(&ci, 0, sizeof ci);
    ci.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    ci.setLayoutCount = 1;
    ci.pSetLayouts = &setLayout;
    ci.pushConstantRangeCount = npush > 0 ? 1 : 0;
    ci.pPushConstantRanges = npush > 0 ? &pcr : NULL;
    VKCHK(vkCreatePipelineLayout(dev, &ci, NULL, &layout), "vkCreatePipelineLayout");
  }
  VkShaderModule shader;
  {
    VkShaderModuleCreateInfo ci;
    memset(&ci, 0, sizeof ci);
    ci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    ci.codeSize = nw * 4;
    ci.pCode = words;
    VKCHK(vkCreateShaderModule(dev, &ci, NULL, &shader), "vkCreateShaderModule");
  }
  VkPipeline pipe;
  {
    VkComputePipelineCreateInfo ci;
    memset(&ci, 0, sizeof ci);
    ci.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
    ci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    ci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    ci.stage.module = shader;
    ci.stage.pName = entry;   /* 入口名就是 OpEntryPoint 里那个字符串（MIR 的函数名） */
    ci.layout = layout;
    VKCHK(vkCreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipe), "vkCreateComputePipelines");
  }

  /* ---- 录一条命令：绑管线、绑描述符、灌 push constant、dispatch。 */
  VkCommandPool cpool;
  {
    VkCommandPoolCreateInfo ci;
    memset(&ci, 0, sizeof ci);
    ci.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    ci.queueFamilyIndex = qfam;
    VKCHK(vkCreateCommandPool(dev, &ci, NULL, &cpool), "vkCreateCommandPool");
  }
  VkCommandBuffer cmd;
  {
    VkCommandBufferAllocateInfo ai;
    memset(&ai, 0, sizeof ai);
    ai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    ai.commandPool = cpool;
    ai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    ai.commandBufferCount = 1;
    VKCHK(vkAllocateCommandBuffers(dev, &ai, &cmd), "vkAllocateCommandBuffers");
    VkCommandBufferBeginInfo bi;
    memset(&bi, 0, sizeof bi);
    bi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    VKCHK(vkBeginCommandBuffer(cmd, &bi), "vkBeginCommandBuffer");
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
    if (npush > 0) {
      vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, npush * 8, push);
    }
    vkCmdDispatch(cmd, (grid + localX - 1) / localX, 1, 1);
    VKCHK(vkEndCommandBuffer(cmd), "vkEndCommandBuffer");
  }

  /* ---- 提交并等完。等的是 fence 而不是 vkQueueWaitIdle：要的就是"这一次 dispatch 结束了"。 */
  {
    VkFence fence;
    VkFenceCreateInfo fci;
    memset(&fci, 0, sizeof fci);
    fci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    VKCHK(vkCreateFence(dev, &fci, NULL, &fence), "vkCreateFence");
    VkSubmitInfo si;
    memset(&si, 0, sizeof si);
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1;
    si.pCommandBuffers = &cmd;
    VKCHK(vkQueueSubmit(queue, 1, &si, fence), "vkQueueSubmit");
    VkResult w = vkWaitForFences(dev, 1, &fence, VK_TRUE, 10ull * 1000 * 1000 * 1000);
    if (w != VK_SUCCESS) die("vkWaitForFences（10 秒还没跑完）", w);
    vkDestroyFence(dev, fence, NULL);
  }

  /* ---- 读回并打印：一行一个缓冲，值之间一个空格。
   * 整数用 %lld（和 Omni 的 print 一样是十进制补码），real 用 %.17g ——
   * 17 位有效数字能精确往返，所以比对方可以按数值比而不必猜格式。 */
  for (uint32_t i = 0; i < nbuf; i++) {
    Buf *b = &bufs[i];
    void *p = NULL;
    VKCHK(vkMapMemory(dev, b->mem, 0, b->bytes, 0, &p), "vkMapMemory（读回）");
    for (uint32_t k = 0; k < b->n; k++) {
      uint64_t cell;
      memcpy(&cell, (char *)p + (size_t)k * 8, 8);
      if (k > 0) printf(" ");
      if (b->isF) {
        double d;
        memcpy(&d, &cell, 8);
        printf("%.17g", d);
      } else {
        int64_t v;
        memcpy(&v, &cell, 8);
        printf("%lld", (long long)v);
      }
    }
    printf("\n");
    vkUnmapMemory(dev, b->mem);
  }
  fflush(stdout);

  /* 收尾。进程马上就退了，但显式销毁是为了让 validation layer（如果开着）不报泄漏 ——
   * 这份工具将来要开 layer 查"描述符绑错了没"，那时这几行就有用了。 */
  vkDestroyPipeline(dev, pipe, NULL);
  vkDestroyShaderModule(dev, shader, NULL);
  vkDestroyPipelineLayout(dev, layout, NULL);
  vkDestroyDescriptorPool(dev, pool, NULL);
  vkDestroyDescriptorSetLayout(dev, setLayout, NULL);
  vkDestroyCommandPool(dev, cpool, NULL);
  for (uint32_t i = 0; i < nbuf; i++) {
    vkDestroyBuffer(dev, bufs[i].buf, NULL);
    vkFreeMemory(dev, bufs[i].mem, NULL);
    free(bufs[i].cells);
  }
  vkDestroyDevice(dev, NULL);
  vkDestroyInstance(inst, NULL);
  free(words);
  return 0;
}


