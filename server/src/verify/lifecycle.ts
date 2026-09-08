/**
 * 生命周期验证（PRD 验收清单两项）：
 *   1. 空闲回收：PI_TEACHER_IDLE_TIMEOUT_MS 秒级可配置 → 会话 wrapper 被销毁
 *      （jsonl 保留、注册表清空）
 *   2. SIGTERM 优雅退出：先发 session_shutdown 再 dispose，进程 0 退出码
 *
 * 不依赖 HTTP：进程内建会话（复刻 run-real 的最小路径）。
 * 跑法：
 *   PI_TEACHER_PROVIDER=agnes PI_TEACHER_MODEL=agnes-2.5-flash npm run verify:lifecycle
 * 或：
 *   node --experimental-strip-types 直接跑（见 package.json scripts）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";

const CHILD_SCRIPT = path.resolve(import.meta.dirname, "lifecycle-child.ts");

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
    if (detail !== undefined) console.error(`    ${JSON.stringify(detail)}`);
  }
}

async function main(): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-lifecycle-"));
  const workspaceRoot = path.join(homeDir, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const env = {
    ...process.env,
    PI_TEACHER_IDLE_TIMEOUT_MS: "2000", // 2 秒空闲即回收
    PI_TEACHER_LIFECYCLE_HOME: homeDir,
    PI_TEACHER_LIFECYCLE_WORKSPACE: workspaceRoot,
  };

  // —— 子进程：建会话 → 等注册表有 wrapper → 打印 sessionFile → 等回收 ——
  const child = fork(CHILD_SCRIPT, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let childOutput = "";
  child.stdout?.on("data", (chunk) => { childOutput += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { childOutput += chunk.toString(); });

  const sessionFile = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("子进程未在 30s 内报出 sessionFile")), 30_000);
    child.on("message", (message: string) => {
      if (message.startsWith("SESSION_FILE=")) {
        clearTimeout(timeout);
        resolve(message.slice("SESSION_FILE=".length));
      }
    });
    child.on("exit", (code) => reject(new Error(`子进程提前退出 code=${code}\n${childOutput}`)));
  });

  // jsonl 是惰性落盘的（首条消息才建文件）：轮询等它出现，证明会话真实写入过。
  let fileExistsWhileAlive = false;
  for (let i = 0; i < 40; i++) {
    if (await fs.stat(sessionFile).then(() => true).catch(() => false)) {
      fileExistsWhileAlive = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check("会话运行期间 jsonl 已落盘（消息驱动）", fileExistsWhileAlive, sessionFile);

  // 等子进程报出「已回收」（wrapper 销毁后子进程退出并报 code）
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });
  check("空闲超时后 wrapper 自动回收（子进程以 0 退出）", exitCode === 0, { exitCode, childOutput });
  const contentAfterReclaim = await fs.readFile(sessionFile, "utf8").catch(() => "");
  check(
    "回收后 jsonl 保留且含消息",
    contentAfterReclaim.includes("冒烟完成") || contentAfterReclaim.includes('"message"'),
    contentAfterReclaim.slice(0, 120),
  );
  check("回收后注册表为空（WRAPPERS_CLEAN=1）", childOutput.includes("WRAPPERS_CLEAN=1"), childOutput);

  // —— SIGTERM 优雅退出：起第二个子进程，短暂空闲后发 SIGTERM ——
  console.log("\n[2] SIGTERM 优雅退出");
  const gracefulChild = fork(CHILD_SCRIPT, ["stay-alive"], {
    env: { ...env, PI_TEACHER_IDLE_TIMEOUT_MS: "60000" }, // 60s 空闲不回收，等我们 SIGTERM
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let gracefulOutput = "";
  gracefulChild.stdout?.on("data", (c) => { gracefulOutput += c.toString(); });
  gracefulChild.stderr?.on("data", (c) => { gracefulOutput += c.toString(); });

  await new Promise<void>((resolve) => {
    gracefulChild.on("message", (m: string) => { if (m === "READY") resolve(); });
    gracefulChild.on("exit", () => resolve()); // 兜底：异常退出也别挂死
  });
  gracefulChild.kill("SIGTERM");
  const gracefulExit = await new Promise<number>((resolve) => {
    gracefulChild.on("exit", (code, signal) => resolve(code ?? (signal ? -1 : -1)));
  });
  check("SIGTERM 后进程 0 退出码", gracefulExit === 0, { gracefulExit, gracefulOutput });
  check("session_shutdown 事件已发出", gracefulOutput.includes("shutdown_emitted"), gracefulOutput);
  check("shutdown 后 dispose 被调用", gracefulOutput.includes("disposed"), gracefulOutput);

  await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("lifecycle 异常退出：", error);
  process.exit(1);
});
