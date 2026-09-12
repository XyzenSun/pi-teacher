/**
 * catalog-check：模型目录单例对界面外配置修改的感知验证。
 *
 * 全程使用临时 PI_CODING_AGENT_DIR 与临时 homeDir，绝不触碰用户真实 ~/.pi/agent/
 * 与真实 ~/pi-teacher/。背景：getModelCatalog 是进程级单例，原本只在界面内保存
 * 配置时刷新；用户用 pi CLI、手动编辑或版本升级迁移改了 models.json / auth.json
 * 后，运行中的后端会永远拿着旧快照——表现为「设置页显示已配置、模型列表却说
 * 默认模型不可用」。修复方式是指纹检测自动 refresh，本脚本验证该行为。
 *
 * 覆盖：
 *   1. 首次加载读取当前 models.json
 *   2. 界面外修改 models.json 后，getModelCatalog 自动重载
 *   3. 界面外修改 auth.json 后，getModelCatalog 自动重载且不抛错
 *   4. 配置未变化时重复调用不抛错（指纹一致路径）
 *   5. 显式 refreshModelCatalog（界面保存路径）能加载新配置
 *   6. 默认模型不可用时 selectDefaultModel 抛 503（开会话语义保持，供路由降级捕获）
 *   7. 默认模型可用时 selectDefaultModel 返回目录中的该模型
 *
 * 跑法：npm run verify:catalog
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-agent-"));
const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-home-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_TEACHER_PROVIDER;
delete process.env.PI_TEACHER_MODEL;

// 动态导入必须在环境变量设置之后：getAgentDir() 在首次调用时才读环境，
// 但静态 import 会让被测模块在改写之前就完成求值。
const { getModelCatalog, refreshModelCatalog, selectDefaultModel } = await import("../session/models.ts");
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

/** 写一份只含一个 provider 的 models.json；apiKey 用明文，保证模型进入 available。 */
async function writeModelsJson(providerId: string, modelId: string): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        [providerId]: {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          apiKey: "sk-test-not-a-real-key",
          models: [{ id: modelId, reasoning: false }],
        },
      },
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/** settings.json 的全局作用域在 agentDir 下；默认模型写在这里。 */
async function writeDefaultModel(providerId: string, modelId: string): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ defaultProvider: providerId, defaultModel: modelId }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function modelIds(): Promise<string[]> {
  const runtime = await getModelCatalog();
  return runtime.getModels().map((model) => `${model.provider}/${model.id}`);
}

try {
  console.log("\n[1] 首次加载与无变化重复调用");
  await writeModelsJson("provider-a", "model-a1");
  check("首次加载读到 models.json 的 provider", (await modelIds()).includes("provider-a/model-a1"));
  check("配置未变化时重复调用不抛错", (await modelIds()).includes("provider-a/model-a1"));

  console.log("\n[2] 界面外修改 models.json → 自动重载");
  await writeModelsJson("provider-b", "model-b1");
  check("界面外改 provider 后目录自动重载", (await modelIds()).includes("provider-b/model-b1"));
  check("重载后旧 provider 被替换（非叠加）", !(await modelIds()).includes("provider-a/model-a1"));

  console.log("\n[3] 界面外修改 auth.json → 自动重载且不抛错");
  await fs.writeFile(path.join(agentDir, "auth.json"), "{}\n", { encoding: "utf8", mode: 0o600 });
  check("auth.json 变化后目录仍可获取", (await modelIds()).includes("provider-b/model-b1"));

  console.log("\n[4] 显式 refreshModelCatalog（界面保存路径）");
  await writeModelsJson("provider-c", "model-c1");
  await refreshModelCatalog();
  check("显式刷新加载新配置", (await modelIds()).includes("provider-c/model-c1"));

  console.log("\n[5] selectDefaultModel 语义（开会话路径）");
  await writeDefaultModel("provider-c", "model-c1");
  {
    const runtime = await getModelCatalog();
    const available = await runtime.getAvailable();
    check("明文 apiKey 的模型进入 available", available.some((model) => model.provider === "provider-c" && model.id === "model-c1"));
    const selected = selectDefaultModel(runtime, homeDir);
    check("默认模型可用时返回该模型", selected?.provider === "provider-c" && selected?.id === "model-c1");
  }
  await writeDefaultModel("provider-c", "model-does-not-exist");
  {
    const runtime = await getModelCatalog();
    try {
      selectDefaultModel(runtime, homeDir);
      check("默认模型不可用时抛 503（应被拒绝）", false);
    } catch (error) {
      check("默认模型不可用时抛 503", error instanceof HttpError && error.status === 503);
    }
  }

  console.log("\n[6] 路由层降级：GET /api/models");
  {
    const { createModelsRouter } = await import("../routes/models.ts");
    const { default: express } = await import("express");
    // createModelsRouter 只读 homeDir；真实 AppState 的 db/dataDir 与本路由无关，
    // 这里用真 express + 真路由函数 + 临时端口验证 HTTP 形状，不是 mock。
    const state = { homeDir } as unknown as Parameters<typeof createModelsRouter>[0];
    const app = express();
    app.use("/api/models", createModelsRouter(state));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      // 上一节留下的 settings.json 仍指向不存在的模型，正好是降级场景。
      const broken = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
      check("默认模型不可用时列表照常返回（不再整接口 503）",
        Array.isArray(broken.models) && broken.models.some((model: { provider: string }) => model.provider === "provider-c"));
      check("默认模型不可用时 defaultModel 为 null", broken.defaultModel === null);
      await writeDefaultModel("provider-c", "model-c1");
      const fixed = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
      check("默认模型恢复后返回该模型",
        fixed.defaultModel?.provider === "provider-c" && fixed.defaultModel?.id === "model-c1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await fs.rm(agentDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
}
