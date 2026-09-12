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
 *   7. 全局目录布局幂等补建；USER.md + style.md 注入段落四态；user-preferences 校验与原子写
 *   8. 用户环境变量：env / .env 首次导入优先级、三态补丁、受保护变量名、process.env 同步、出口不含隐藏值
 *
 * 跑法：npm run verify:config
 */
import { promises as fs, existsSync, readFileSync, statSync } from "node:fs";
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
const { ensureGlobalLayout } = await import("../db/seed.ts");
const { GLOBAL_AGENTS_MD, MATERIALS_INDEX_PLACEHOLDER, USER_PREFERENCES_PLACEHOLDER } = await import("../prompts/defaults.ts");
const { buildAppendedSystemPrompt } = await import("../projection/system-prompt-builder.ts");
const { readHomeMarkdownContent, writeHomeMarkdown, readHomeMarkdown } = await import("../config/home-markdown.ts");
const { BUILTIN_USER_ENV, bootstrapUserEnv, listUserEnv, readUserEnvPatch, applyUserEnvPatch, deleteUserEnv } = await import("../config/user-env.ts");
const { initializeSchema } = await import("../db/schema.ts");
const { default: Database } = await import("better-sqlite3");

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

  console.log("\n[7] 全局布局与偏好注入四态");
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-home-"));
  const workPath = path.join(homeDir, "learn", "1", "pi", "1");
  await fs.mkdir(workPath, { recursive: true });
  try {
    ensureGlobalLayout(homeDir);
    for (const relative of ["AGENTS.md", "USER.md", "materials/index.md", "materials/origins", "assets", "llm-text-to-img"]) {
      check(`补建 ${relative}`, statSync(path.join(homeDir, relative)) !== undefined);
    }
    check("USER.md 初始为占位注释", readFileSync(path.join(homeDir, "USER.md"), "utf8") === USER_PREFERENCES_PLACEHOLDER);
    const seededAgentsMd = readFileSync(path.join(homeDir, "AGENTS.md"), "utf8");
    check("新全局 AGENTS.md 使用唯一出厂常量", seededAgentsMd === GLOBAL_AGENTS_MD);
    check("出厂规则明确 files 输入、质量判断、规整直归档与原件整理分流", seededAgentsMd.includes("先实际阅读")
      && seededAgentsMd.includes("正确且可学习") && seededAgentsMd.includes("内容与排版规整")
      && seededAgentsMd.includes("files/") && seededAgentsMd.includes("materials/origins/") && seededAgentsMd.includes("materials/index.md"));
    check("出厂规则明确模型归档责任与学习专属精华", seededAgentsMd.includes("程序不会代办")
      && seededAgentsMd.includes("只有学习会话默认提供空的") && seededAgentsMd.includes("独立于卡片"));
    check("资料索引只初始化占位内容，不代模型写资料", readFileSync(path.join(homeDir, "materials", "index.md"), "utf8") === MATERIALS_INDEX_PLACEHOLDER);
    const customGlobalRules = Buffer.from("# 用户改过的全局规则\r\n\r\n- 保留排版与尾随空格  \r\n", "utf8");
    await fs.writeFile(path.join(homeDir, "AGENTS.md"), customGlobalRules);
    await fs.chmod(path.join(homeDir, "AGENTS.md"), 0o640);
    await fs.writeFile(path.join(homeDir, "materials", "index.md"), "# 用户整理过的资料索引\n");
    ensureGlobalLayout(homeDir);
    ensureGlobalLayout(homeDir);
    check("重复补建不覆盖已有 AGENTS.md 的字节与权限", readFileSync(path.join(homeDir, "AGENTS.md")).equals(customGlobalRules)
      && (statSync(path.join(homeDir, "AGENTS.md")).mode & 0o777) === 0o640);
    check("重复补建不覆盖已有资料索引", readFileSync(path.join(homeDir, "materials", "index.md"), "utf8") === "# 用户整理过的资料索引\n");

    // ADR-0036：会话级引导块无条件输出——两层都空时也要告诉模型 pi-session-user.md 是什么，
    // 否则维护提醒里的「更新到 pi-session-user.md」无从落地。
    const bareGuidance = buildAppendedSystemPrompt(homeDir, workPath);
    check("占位 USER.md + 无 style.md → 只有会话级引导块", bareGuidance.startsWith("<会话级用户偏好>") && !bareGuidance.includes("<全局用户偏好>") && !bareGuidance.includes("<教学风格>") && !bareGuidance.includes("以下为用户偏好与教学风格"));
    await fs.writeFile(path.join(workPath, "style.md"), "   \n");
    check("空白 style.md 视为空", buildAppendedSystemPrompt(homeDir, workPath) === bareGuidance);
    await fs.writeFile(path.join(workPath, "style.md"), "先给结论再解释。\n");
    const styleOnly = buildAppendedSystemPrompt(homeDir, workPath);
    check("仅风格：有风格块与会话级引导，无全局块", styleOnly.includes("<教学风格>\n先给结论再解释。\n</教学风格>")
      && styleOnly.includes("<会话级用户偏好>") && styleOnly.includes("pi-session-user.md") && !styleOnly.includes("<全局用户偏好>"));
    check("不传 homeDir 时退化为只读 style.md", buildAppendedSystemPrompt(undefined, workPath) === styleOnly);
    await fs.writeFile(path.join(homeDir, "USER.md"), "- 多给代码示例\n");
    const both = buildAppendedSystemPrompt(homeDir, workPath);
    check("偏好+风格：三块齐全且顺序为全局→风格→会话级", both.indexOf("<全局用户偏好>\n- 多给代码示例\n</全局用户偏好>") > 0
      && both.indexOf("<全局用户偏好>") < both.indexOf("<教学风格>") && both.indexOf("<教学风格>") < both.indexOf("<会话级用户偏好>"));
    check("段落以固定引导句开头", both.startsWith("以下为用户偏好与教学风格，会话级内容优先于全局内容。"));
    await fs.writeFile(path.join(workPath, "style.md"), "");
    const preferencesOnly = buildAppendedSystemPrompt(homeDir, workPath);
    check("仅偏好：无风格块，仍有会话级引导", preferencesOnly.includes("<全局用户偏好>") && !preferencesOnly.includes("<教学风格>") && preferencesOnly.includes("<会话级用户偏好>"));
    check("程序不读会话级偏好文件", !existsSync(path.join(workPath, "pi-session-user.md")) && preferencesOnly.includes("pi-session-user.md"));

    await rejects("user-preferences 拒绝多余键", () => readHomeMarkdownContent({ content: "x", other: 1 }, "user-preferences"), "只接收 content");
    await rejects("user-preferences 拒绝非文本", () => readHomeMarkdownContent({ content: 1 }, "user-preferences"), "必须是文本");
    await rejects("user-preferences 超长被拒", () => readHomeMarkdownContent({ content: "偏".repeat(8001) }, "user-preferences"), "8000");
    check("global-agents-md 上限更宽", readHomeMarkdownContent({ content: "规".repeat(8001) }, "global-agents-md").length === 8001);
    await rejects("global-agents-md 超过 20000 被拒", () => readHomeMarkdownContent({ content: "规".repeat(20001) }, "global-agents-md"), "20000");
    const userMdBefore = readFileSync(path.join(homeDir, "USER.md"), "utf8");
    await fs.chmod(path.join(homeDir, "USER.md"), 0o600);
    writeHomeMarkdown(homeDir, "user-preferences", "- 术语保留英文\n");
    check("原子写入生效且沿用原文件权限", readHomeMarkdown(homeDir, "user-preferences").content === "- 术语保留英文\n" && (statSync(path.join(homeDir, "USER.md")).mode & 0o777) === 0o600);
    check("写入后无临时残留", !(await fs.readdir(homeDir)).some((name) => name.endsWith(".tmp")));
    check("读取只回相对文件名", readHomeMarkdown(homeDir, "user-preferences").path === "USER.md" && !JSON.stringify(readHomeMarkdown(homeDir, "user-preferences")).includes(homeDir));
    writeHomeMarkdown(homeDir, "global-agents-md", "# 改过的全局规则\n");
    check("全局 AGENTS.md 走同一套原子写", readHomeMarkdown(homeDir, "global-agents-md").content === "# 改过的全局规则\n" && readHomeMarkdown(homeDir, "global-agents-md").path === "AGENTS.md");
    check("之前的内容确实被替换", userMdBefore !== readHomeMarkdown(homeDir, "user-preferences").content);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }

  console.log("\n[8] 用户环境变量（ADR-0034）");
  // 独立 key 名，避免与真实部署的 TAVILY_* 环境变量互相干扰；结束时全部清理。
  const envHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-userenv-"));
  const envDb = new Database(path.join(envHome, "user-env.db"));
  const ENV_VALUE = `tvly-verify-${Math.random().toString(36).slice(2)}`;
  const DOTENV_VALUE = `dotenv-verify-${Math.random().toString(36).slice(2)}`;
  const savedTavily = { key: process.env.TAVILY_API_KEY, base: process.env.TAVILY_BASE_URL, timeout: process.env.TAVILY_TIMEOUT };
  try {
    // 旧数据目录里带 secret 列的表必须被幂等迁移掉，行数据保留。
    envDb.exec("CREATE TABLE user_env (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 1)");
    envDb.prepare("INSERT INTO user_env (key, value, secret) VALUES ('LEGACY_ROW', 'kept', 1)").run();
    initializeSchema(envDb, envHome);
    initializeSchema(envDb, envHome);
    const userEnvColumns = (envDb.prepare("PRAGMA table_info(user_env)").all() as Array<{ name: string }>).map((column) => column.name);
    check("旧表的 secret 列被幂等迁移掉", JSON.stringify(userEnvColumns) === JSON.stringify(["key", "value"]), userEnvColumns);
    check("迁移保留已有行", (envDb.prepare("SELECT value FROM user_env WHERE key = 'LEGACY_ROW'").get() as { value: string })?.value === "kept");
    envDb.prepare("DELETE FROM user_env WHERE key = 'LEGACY_ROW'").run();

    delete process.env.TAVILY_BASE_URL;
    delete process.env.TAVILY_TIMEOUT;
    process.env.TAVILY_API_KEY = ENV_VALUE;
    await fs.writeFile(path.join(envHome, ".env"), `TAVILY_API_KEY=stale-dotenv-value\nTAVILY_BASE_URL=https://dotenv.example.invalid\nMY_SKILL_TOKEN=${DOTENV_VALUE}\nPATH=/evil\nlowercase=x\n`);
    const dotenvBefore = readFileSync(path.join(envHome, ".env"), "utf8");
    const first = bootstrapUserEnv(envDb, envHome);
    check("内置项从环境变量首次导入", first.fromEnv.includes("TAVILY_API_KEY"), first);
    check(".env 只导入表里没有的 key，且跳过受保护与非法名", JSON.stringify([...first.fromDotenv].sort()) === JSON.stringify(["MY_SKILL_TOKEN", "TAVILY_BASE_URL"]), first);
    check("env 优先于 .env：同名 key 保留 env 的值", process.env.TAVILY_API_KEY === ENV_VALUE);
    check(".env 文件字节不变", readFileSync(path.join(envHome, ".env"), "utf8") === dotenvBefore);
    check("引导后 process.env 含 .env 导入的自定义项", process.env.MY_SKILL_TOKEN === DOTENV_VALUE && process.env.TAVILY_BASE_URL === "https://dotenv.example.invalid");
    process.env.TAVILY_API_KEY = "changed-in-container-env";
    const second = bootstrapUserEnv(envDb, envHome);
    check("再次启动不重复导入", second.fromEnv.length === 0 && second.fromDotenv.length === 0, second);
    check("表为准：容器 env 后来的改动不覆盖表", process.env.TAVILY_API_KEY === ENV_VALUE);

    const listed = listUserEnv(envDb);
    check("已设置的内置项明文回显", listed.find((item) => item.key === "TAVILY_API_KEY")?.value === ENV_VALUE && listed.find((item) => item.key === "TAVILY_API_KEY")?.configured === true);
    check("内置未设置项仍在列且 configured=false、无 value", listed.find((item) => item.key === "TAVILY_TIMEOUT")?.configured === false
      && listed.find((item) => item.key === "TAVILY_TIMEOUT")?.builtin === true && !("value" in listed.find((item) => item.key === "TAVILY_TIMEOUT")!));
    check(".env 导入的自定义项标记为用户项且回显值", listed.find((item) => item.key === "MY_SKILL_TOKEN")?.builtin === false && listed.find((item) => item.key === "MY_SKILL_TOKEN")?.value === DOTENV_VALUE);
    // 期望值从 BUILTIN_USER_ENV 动态构造：内置项顺序即定义顺序，用户项按名排在后面；
    // 硬编码会在内置项扩充（ADR-0040/0041 加了 13 项）后悄悄过期。
    const expectedOrder = [...BUILTIN_USER_ENV.map((item) => item.key), "MY_SKILL_TOKEN"];
    check("列表按内置项在前、用户项按名排序", listed.map((item) => item.key).join(",") === expectedOrder.join(","));

    await rejects("受保护变量 PATH 被拒", () => readUserEnvPatch({ PATH: "/x" }), "部署环境管理");
    await rejects("受保护前缀 PI_TEACHER_ 被拒", () => readUserEnvPatch({ PI_TEACHER_HOME: "/x" }), "部署环境管理");
    await rejects("NODE_OPTIONS 被拒", () => readUserEnvPatch({ NODE_OPTIONS: "--x" }), "部署环境管理");
    await rejects("小写变量名被拒", () => readUserEnvPatch({ lowercase: "x" }), "无效");
    await rejects("数字开头被拒", () => readUserEnvPatch({ "1ABC": "x" }), "无效");
    await rejects("空串值被拒", () => readUserEnvPatch({ TAVILY_TIMEOUT: "" }), "不能为空");
    await rejects("纯空白值被拒", () => readUserEnvPatch({ TAVILY_TIMEOUT: "   " }), "不能为空");
    await rejects("非文本值被拒", () => readUserEnvPatch({ TAVILY_TIMEOUT: { value: "30s" } }), "必须是文本");
    await rejects("超长值被拒", () => readUserEnvPatch({ TAVILY_TIMEOUT: "x".repeat(4001) }), "上限");
    await rejects("空补丁被拒", () => readUserEnvPatch({}), "至少");

    applyUserEnvPatch(envDb, readUserEnvPatch({ TAVILY_TIMEOUT: "30s", NEW_PLAIN: "plain", TAVILY_API_KEY: "rotated-value" }));
    check("保存后 process.env 立即反映新值", process.env.TAVILY_TIMEOUT === "30s" && process.env.NEW_PLAIN === "plain" && process.env.TAVILY_API_KEY === "rotated-value");
    check("覆盖写回表且列表回显", listUserEnv(envDb).find((item) => item.key === "TAVILY_API_KEY")?.value === "rotated-value"
      && listUserEnv(envDb).find((item) => item.key === "NEW_PLAIN")?.value === "plain");
    deleteUserEnv(envDb, "NEW_PLAIN");
    check("删除用户项后从列表与 process.env 移除", !listUserEnv(envDb).some((item) => item.key === "NEW_PLAIN") && process.env.NEW_PLAIN === undefined);
    deleteUserEnv(envDb, "TAVILY_API_KEY");
    check("清除内置项后仍在列但 configured=false，且 process.env 移除", listUserEnv(envDb).find((item) => item.key === "TAVILY_API_KEY")?.configured === false && process.env.TAVILY_API_KEY === undefined);
    await rejects("删除不存在的用户项 404", () => deleteUserEnv(envDb, "NOT_THERE"), "不存在");
    await rejects("删除受保护名被拒", () => deleteUserEnv(envDb, "PATH"), "部署环境管理");
  } finally {
    envDb.close();
    await fs.rm(envHome, { recursive: true, force: true });
    for (const key of ["MY_SKILL_TOKEN", "NEW_PLAIN"]) delete process.env[key];
    for (const [key, value] of [["TAVILY_API_KEY", savedTavily.key], ["TAVILY_BASE_URL", savedTavily.base], ["TAVILY_TIMEOUT", savedTavily.timeout]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }

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
