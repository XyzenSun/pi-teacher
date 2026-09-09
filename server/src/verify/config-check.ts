/**
 * config-check：Pi 配置读写的独立真实验证。
 *
 * 全程使用临时 PI_CODING_AGENT_DIR，绝不触碰用户真实 ~/.pi/agent/——
 * 这一点由脚本开头的目录改写和结尾的断言共同保证。
 *
 * 覆盖：
 *   1. 出口脱敏：apiKey / header 值、`$ENV` 与 `!command` 引用都不出现在响应里
 *   2. 三态语义：缺省保持、字符串覆盖、null 清除，掩码回传等于保持
 *   3. 严格白名单：未知字段、非 Known API、非法 header 名一律拒绝且不落盘
 *   4. 原子写：校验失败时原文件字节与权限都不变
 *   5. 高级字段保留：结构化编辑不会抹掉 compat / cost 等手写配置
 *   6. 注释与尾逗号容忍：能读带 `//` 注释的 models.json
 *
 * 跑法：npm run verify:config
 */
import { promises as fs, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_TEACHER_PROVIDER;
delete process.env.PI_TEACHER_MODEL;

// 动态导入必须在环境变量设置之后：getAgentDir() 在首次调用时才读环境，
// 但静态 import 会让被测模块在改写之前就完成求值。
const {
  SECRET_MASK, listProviderViews, modelsJsonPath, readDefaultModel, readProviderPatch,
  providerJsonView, providerPatchFromJson, saveProvider, deleteProvider, assertProviderId,
} = await import("../config/pi-config.ts");
const { HttpError } = await import("../routes/http.ts");

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
    if (detail !== undefined) console.error(`    ${String(JSON.stringify(detail)).slice(0, 400)}`);
  }
}

async function rejects(name: string, operation: () => Promise<unknown> | unknown, fragment: string): Promise<void> {
  try {
    await operation();
    check(`${name}（应被拒绝）`, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, error instanceof HttpError && message.includes(fragment), message);
  }
}

// 真实机密样本：只在本进程内存和临时文件里出现，绝不会进日志或断言输出。
const PLAINTEXT_KEY = `sk-verify-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const ENV_REFERENCE = "$PI_TEACHER_VERIFY_TOKEN";
const COMMAND_REFERENCE = "!cat /run/secrets/verify-token";
const HEADER_SECRET = `hdr-${Math.random().toString(36).slice(2)}`;

const SEEDED_MODELS_JSON = `{
  // 带注释与尾逗号的真实写法，SDK 允许，界面读取也必须容忍
  "providers": {
    "plainkey": {
      "name": "明文凭据 Provider",
      "api": "openai-completions",
      "baseUrl": "https://example.invalid/v1",
      "apiKey": ${JSON.stringify(PLAINTEXT_KEY)},
      "headers": { "X-Verify-Token": ${JSON.stringify(HEADER_SECRET)} },
      "models": [
        { "id": "m-1", "name": "模型一", "contextWindow": 128000 },
      ],
      "compat": { "supportsDeveloperRole": true },
    },
    "envref": {
      "api": "anthropic-messages",
      "baseUrl": "https://env.example.invalid/v1",
      "apiKey": ${JSON.stringify(ENV_REFERENCE)},
      "models": [{ "id": "m-env" }],
    },
    "cmdref": {
      "api": "openai-responses",
      "baseUrl": "https://cmd.example.invalid/v1",
      "apiKey": ${JSON.stringify(COMMAND_REFERENCE)},
      "models": [{ "id": "m-cmd" }],
    },
  },
}
`;

async function main(): Promise<void> {
  const filePath = modelsJsonPath();
  await fs.writeFile(filePath, SEEDED_MODELS_JSON, { encoding: "utf8", mode: 0o600 });

  console.log("\n[1] 出口脱敏");
  const views = listProviderViews();
  const serialized = JSON.stringify(views);
  check("三个 provider 全部读出（注释与尾逗号被容忍）", views.length === 3, views.map((view) => view.id));
  check("明文 apiKey 不出现在响应中", !serialized.includes(PLAINTEXT_KEY));
  check("$ENV 引用不出现在响应中", !serialized.includes(ENV_REFERENCE) && !serialized.includes("PI_TEACHER_VERIFY_TOKEN"));
  check("!command 引用不出现在响应中", !serialized.includes(COMMAND_REFERENCE) && !serialized.includes("/run/secrets"));
  check("header 值不出现在响应中", !serialized.includes(HEADER_SECRET));
  const plain = views.find((view) => view.id === "plainkey")!;
  check("已配置凭据折叠成布尔", plain.apiKeyConfigured === true);
  check("只给出 header 名称", JSON.stringify(plain.headerNames) === JSON.stringify(["X-Verify-Token"]));
  check("识别出结构化编辑覆盖不到的高级字段", plain.advancedKeys.includes("compat"), plain.advancedKeys);
  check("api 在 Known API 列表内时不告警", plain.apiUnknown === false);

  console.log("\n[2] 三态语义");
  const keptMask = readProviderPatch({ apiKey: SECRET_MASK });
  check("掩码回传视为保持不变（不进入补丁）", !("apiKey" in keptMask), keptMask);
  const keptEmpty = readProviderPatch({ apiKey: "" });
  check("空串视为保持不变（清除必须显式 null）", !("apiKey" in keptEmpty), keptEmpty);
  const cleared = readProviderPatch({ apiKey: null });
  check("null 表示清除", cleared.apiKey === null);

  await saveProvider("plainkey", readProviderPatch({ name: "改名后的 Provider", apiKey: SECRET_MASK }));
  const afterMaskSave = readFileSync(filePath, "utf8");
  check("掩码保存后原 apiKey 未被覆盖", afterMaskSave.includes(PLAINTEXT_KEY));
  check("掩码字符串没有被写进文件", !afterMaskSave.includes(SECRET_MASK));
  check("同次保存的普通字段真实生效", JSON.parse(afterMaskSave).providers.plainkey.name === "改名后的 Provider");
  check("结构化保存保留了 compat 等高级字段", JSON.parse(afterMaskSave).providers.plainkey.compat.supportsDeveloperRole === true);
  check("结构化保存保留了模型的 contextWindow", JSON.parse(afterMaskSave).providers.plainkey.models[0].contextWindow === 128000);

  await saveProvider("envref", readProviderPatch({ apiKey: null }));
  const afterClear = JSON.parse(readFileSync(filePath, "utf8")) as { providers: Record<string, Record<string, unknown>> };
  check("显式 null 真的清除了凭据", !("apiKey" in afterClear.providers.envref));
  check("清除凭据后出口标记为未配置", listProviderViews().find((view) => view.id === "envref")!.apiKeyConfigured === false);

  console.log("\n[3] 严格白名单");
  await rejects("未知 provider 字段被拒", () => readProviderPatch({ nickname: "x" }), "不支持的 provider 字段");
  await rejects("拼错的 baseURL 被拒", () => readProviderPatch({ baseURL: "https://x.invalid" }), "不支持的 provider 字段");
  await rejects("非 Known API 被拒", () => readProviderPatch({ api: "openai-chat" }), "api 必须是以下之一");
  await rejects("非法 header 名被拒", () => readProviderPatch({ headers: { "Bad Header": "v" } }), "header 名称无效");
  await rejects("模型条目多余字段被拒", () => readProviderPatch({ models: [{ id: "m", cost: 1 }] }), "模型条目不支持字段");
  await rejects("重复模型 id 被拒", () => readProviderPatch({ models: [{ id: "m" }, { id: "m" }] }), "模型 id 重复");
  await rejects("非法 provider 标识被拒", () => assertProviderId("../escape"), "provider 标识");
  await rejects("新建 provider 必须给 api", () => saveProvider("brandnew", readProviderPatch({ name: "无 api" })), "必须指定 api 类型");

  // 高级 JSON 视图必须能被原样保存：视图里含 compat、模型 reasoning 等 Pi 管辖字段，
  // 若一律拒绝，「打开视图 → 直接保存」这一最自然的动作就会失败（真实浏览器验收发现）。
  console.log("\n[3b] 脱敏 JSON 视图可原样回存");
  const jsonView = providerJsonView("plainkey");
  check("视图里的凭据是固定掩码", jsonView.apiKey === SECRET_MASK, jsonView.apiKey);
  check("视图保留 Pi 管辖的高级字段", typeof jsonView.compat === "object" && jsonView.compat !== null);
  const roundTrip = providerPatchFromJson(jsonView);
  check("原样回存不报错且掩码视为保持", !("apiKey" in roundTrip.patch), roundTrip.patch);
  check("被忽略的 Pi 管辖字段明确回报", roundTrip.ignoredKeys.includes("compat") && roundTrip.ignoredKeys.includes("models[].contextWindow"), roundTrip.ignoredKeys);
  const beforeRoundTrip = readFileSync(filePath, "utf8");
  await saveProvider("plainkey", roundTrip.patch);
  const afterRoundTrip = JSON.parse(readFileSync(filePath, "utf8")) as { providers: Record<string, Record<string, any>> };
  check("原样回存后凭据仍在", beforeRoundTrip.includes(PLAINTEXT_KEY) && readFileSync(filePath, "utf8").includes(PLAINTEXT_KEY));
  check("原样回存后 compat 未丢失", afterRoundTrip.providers.plainkey.compat.supportsDeveloperRole === true);
  check("原样回存后模型 contextWindow 未丢失", afterRoundTrip.providers.plainkey.models[0].contextWindow === 128000);
  await rejects("JSON 视图里的非法值仍被拒", () => providerPatchFromJson({ api: "openai-chat" }), "api 必须是以下之一");

  console.log("\n[4] 写入安全");
  const before = readFileSync(filePath, "utf8");
  const beforeMode = statSync(filePath).mode & 0o777;
  // 自定义模型缺 baseUrl 是 SDK 才知道的规则（我们的白名单看不出问题），
  // 正好用来验证「候选加载校验」这一层确实生效。
  await rejects(
    "SDK 拒绝的配置不落盘（自定义模型缺 baseUrl）",
    () => saveProvider("needsbase", readProviderPatch({ api: "openai-completions", models: [{ id: "x" }] })),
    "未通过 Pi 的模型定义校验",
  );
  check("被拒绝的保存没有改动原文件", readFileSync(filePath, "utf8") === before);
  check("文件权限保持 0600", (statSync(filePath).mode & 0o777) === 0o600 && beforeMode === 0o600, beforeMode.toString(8));
  const leftovers = (await fs.readdir(path.dirname(filePath))).filter((name) => name.includes(".tmp"));
  check("没有残留临时文件", leftovers.length === 0, leftovers);

  // 别人早就写坏的 provider 不能让界面永久无法保存：只有本次改动涉及的
  // provider 出错才拒绝，其余降级为 warnings。
  const broken = JSON.parse(readFileSync(filePath, "utf8")) as { providers: Record<string, unknown> };
  broken.providers.legacybroken = { api: "openai-completions", models: [{ id: "legacy" }] };
  await fs.writeFile(filePath, `${JSON.stringify(broken, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const savedDespiteOthers = await saveProvider("plainkey", readProviderPatch({ name: "他人坏配置不阻断" }));
  check("其他 provider 的既有错误不阻断保存", savedDespiteOthers.provider.name === "他人坏配置不阻断");
  check("坏 provider 以警告形式回报", savedDespiteOthers.warnings.some((warning) => warning.includes("legacybroken")), savedDespiteOthers.warnings);
  check("警告不含绝对路径", savedDespiteOthers.warnings.every((warning) => !/\s\/\S+/.test(warning)), savedDespiteOthers.warnings);
  await deleteProvider("legacybroken");

  await deleteProvider("cmdref");
  check("删除 provider 生效", listProviderViews().every((view) => view.id !== "cmdref"));
  const afterDelete = readFileSync(filePath, "utf8");
  check("删除不影响其他 provider 的凭据", afterDelete.includes(PLAINTEXT_KEY));

  console.log("\n[5] 默认模型来源");
  const settingsDefault = readDefaultModel(agentDir);
  check("无环境变量时默认模型可编辑", settingsDefault.editable === true && settingsDefault.source !== "env", settingsDefault);
  process.env.PI_TEACHER_PROVIDER = "verify-provider";
  process.env.PI_TEACHER_MODEL = "verify-model";
  const envDefault = readDefaultModel(agentDir);
  check("环境变量固定时来源为 env 且不可编辑", envDefault.source === "env" && envDefault.editable === false, envDefault);
  delete process.env.PI_TEACHER_PROVIDER;
  delete process.env.PI_TEACHER_MODEL;

  console.log("\n[6] 隔离性");
  check("被测路径位于临时 agent 目录内", path.resolve(filePath).startsWith(path.resolve(agentDir)), path.dirname(filePath));
  check("没有落到用户真实 ~/.pi", !path.resolve(filePath).startsWith(path.join(os.homedir(), ".pi")));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
}

try {
  await main();
} finally {
  await fs.rm(agentDir, { recursive: true, force: true });
}
if (failed > 0) process.exitCode = 1;
