/**
 * 生命周期验证（PRD 验收清单两项）：
 *   1. 空闲回收：PI_TEACHER_IDLE_TIMEOUT_MS 秒级可配置 → 学习会话 wrapper 被销毁
 *      （jsonl 保留、注册表清空）；同进程里以 resident 打开的固定助教不被回收（ADR-0035）
 *   2. SIGTERM 优雅退出：先发 session_shutdown 再 dispose，进程 0 退出码；助教与学习会话一起关
 *
 * 不依赖 HTTP：子进程用新 Schema 在真实临时数据库里建 Space + Pi Session，
 * 再走 bridge 建真实 SDK 会话（复刻 run-real 的最小路径，全程无 mock）。
 *
 * 跑法：
 *   PI_TEACHER_PROVIDER=agnes PI_TEACHER_MODEL=agnes-2.5-flash npm run verify:lifecycle
 * 模型环境不显式给时用部署默认（agnes / agnes-2.5-flash）；只传名字，不碰凭据。
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
    if (detail !== undefined) console.error(`    ${String(JSON.stringify(detail)).slice(0, 600)}`);
  }
}

/** 子进程通过 IPC 报出的路径：会话 JSONL、该 Pi Session 独占的工作目录、固定助教的工作目录。 */
interface ChildPaths {
  sessionFile: string;
  workPath: string;
  taWorkPath: string;
}

/** 同一标记在子进程输出里出现的次数（学习会话与助教各打一次）。 */
function countMarker(output: string, marker: string): number {
  return output.split(marker).length - 1;
}

async function main(): Promise<void> {
  // 每个 home 是一次性的：数据库、Space 目录、Pi 目录都在里面，结束时整体删除
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-lifecycle-"));

  const env = {
    ...process.env,
    PI_TEACHER_IDLE_TIMEOUT_MS: "2000", // 2 秒空闲即回收
    PI_TEACHER_LIFECYCLE_HOME: homeDir,
    // 真实 SDK 路径需要真模型：默认取部署配置，不输出凭据
    PI_TEACHER_PROVIDER: process.env.PI_TEACHER_PROVIDER ?? "agnes",
    PI_TEACHER_MODEL: process.env.PI_TEACHER_MODEL ?? "agnes-2.5-flash",
  };
  console.log(`[1] 空闲回收（模型 ${env.PI_TEACHER_PROVIDER}/${env.PI_TEACHER_MODEL}）`);

  // —— 子进程：建会话 → 等注册表有 wrapper → 打印 sessionFile → 等回收 ——
  const child = fork(CHILD_SCRIPT, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let childOutput = "";
  child.stdout?.on("data", (chunk) => { childOutput += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { childOutput += chunk.toString(); });

  const childPaths = await new Promise<ChildPaths>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`子进程未在 60s 内报出 sessionFile\n${childOutput}`)), 60_000);
    const collected: Partial<ChildPaths> = {};
    child.on("message", (message: string) => {
      if (message.startsWith("SESSION_FILE=")) collected.sessionFile = message.slice("SESSION_FILE=".length);
      if (message.startsWith("WORK_PATH=")) collected.workPath = message.slice("WORK_PATH=".length);
      if (message.startsWith("TA_WORK_PATH=")) collected.taWorkPath = message.slice("TA_WORK_PATH=".length);
      if (collected.sessionFile && collected.workPath && collected.taWorkPath) {
        clearTimeout(timeout);
        resolve(collected as ChildPaths);
      }
    });
    child.on("exit", (code) => reject(new Error(`子进程提前退出 code=${code}\n${childOutput}`)));
  });
  const { sessionFile, workPath, taWorkPath } = childPaths;

  check(
    "会话 JSONL 落在该 Pi Session 独占目录内（ADR-0030 布局）",
    path.dirname(path.resolve(sessionFile)) === path.resolve(workPath),
    { sessionFile, workPath },
  );
  check(
    "工作目录在 home 的 learn/<space-id>/pi/<pi-session-id> 下",
    /learn[/\\]\d+[/\\]pi[/\\]\d+$/.test(path.resolve(workPath)) && path.resolve(workPath).startsWith(path.resolve(homeDir)),
    workPath,
  );
  // 新 Schema 在建行时就写了 SDK header，所以文件此刻必然存在；随后模型消息会追加条目。
  check("会话运行期间 jsonl 已落盘", await fs.stat(sessionFile).then(() => true).catch(() => false), sessionFile);
  check(
    "AGENTS.md / style.md 投影与 JSONL 同在该对话目录",
    await fs.stat(path.join(workPath, "AGENTS.md")).then(() => true).catch(() => false)
      && await fs.stat(path.join(workPath, "style.md")).then(() => true).catch(() => false),
    workPath,
  );

  // 等子进程报出「已回收」（wrapper 销毁后子进程退出并报 code）
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });
  check("空闲超时后学习 wrapper 自动回收、助教显式关闭后子进程以 0 退出", exitCode === 0, { exitCode, childOutput });
  check("学习会话被回收时常驻助教仍活着（TA_ALIVE_AFTER_RECLAIM=1）", childOutput.includes("TA_ALIVE_AFTER_RECLAIM=1"), childOutput);
  check(
    "助教工作目录在 home 的 ta/pi/<pi-session-id> 下",
    /ta[/\\]pi[/\\]\d+$/.test(path.resolve(taWorkPath)) && path.resolve(taWorkPath).startsWith(path.resolve(homeDir)),
    taWorkPath,
  );
  const contentAfterReclaim = await fs.readFile(sessionFile, "utf8").catch(() => "");
  const reclaimedLines = contentAfterReclaim.trim() === "" ? [] : contentAfterReclaim.trim().split("\n");
  check("回收后 jsonl 保留（未随 wrapper 一起删）", reclaimedLines.length > 0, reclaimedLines.length);
  const reclaimedRoles = reclaimedLines
    .map((line) => { try { return JSON.parse(line) as { message?: { role?: string } }; } catch { return {}; } })
    .map((entry) => entry.message?.role)
    .filter((role): role is string => typeof role === "string");
  check(
    "回收后 jsonl 含真实对话消息（真 SDK 路径跑通过）",
    reclaimedRoles.includes("user") && reclaimedRoles.includes("assistant"),
    [...new Set(reclaimedRoles)],
  );
  check("回收后注册表为空（WRAPPERS_CLEAN=1）", childOutput.includes("WRAPPERS_CLEAN=1"), childOutput);
  check("回收路径也走了 dispose（学习会话）", childOutput.includes("disposed learn"), childOutput);
  check("回收前发出 session_shutdown（扩展有机会收尾）", childOutput.includes("shutdown_emitted learn"), childOutput);
  check("助教只在显式 shutdown 时 dispose 一次（不是被空闲回收）", countMarker(childOutput, "disposed ta") === 1, childOutput);

  // —— SIGTERM 优雅退出：起第二个子进程，短暂空闲后发 SIGTERM ——
  console.log("\n[2] SIGTERM 优雅退出");
  const gracefulChild = fork(CHILD_SCRIPT, ["stay-alive"], {
    env: { ...env, PI_TEACHER_IDLE_TIMEOUT_MS: "60000" }, // 60s 空闲不回收，等我们 SIGTERM
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let gracefulOutput = "";
  gracefulChild.stdout?.on("data", (c) => { gracefulOutput += c.toString(); });
  gracefulChild.stderr?.on("data", (c) => { gracefulOutput += c.toString(); });

  let gracefulSessionFile = "";
  await new Promise<void>((resolve) => {
    gracefulChild.on("message", (m: string) => {
      if (m.startsWith("SESSION_FILE=")) gracefulSessionFile = m.slice("SESSION_FILE=".length);
      if (m === "READY") resolve();
    });
    gracefulChild.on("exit", () => resolve()); // 兜底：异常退出也别挂死
  });
  check("stay-alive 子进程已就绪（真实会话已建）", gracefulSessionFile !== "", gracefulOutput);
  gracefulChild.kill("SIGTERM");
  const gracefulExit = await new Promise<number>((resolve) => {
    gracefulChild.on("exit", (code, signal) => resolve(code ?? (signal ? -1 : -1)));
  });
  check("SIGTERM 后进程 0 退出码", gracefulExit === 0, { gracefulExit, gracefulOutput });
  check("session_shutdown 事件已发出（学习会话与助教各一次）", countMarker(gracefulOutput, "shutdown_emitted learn") === 1 && countMarker(gracefulOutput, "shutdown_emitted ta") === 1, gracefulOutput);
  check("shutdown 后 dispose 被调用（学习会话与助教各一次）", countMarker(gracefulOutput, "disposed learn") === 1 && countMarker(gracefulOutput, "disposed ta") === 1, gracefulOutput);
  check(
    "SIGTERM 退出后 jsonl 仍在磁盘上",
    gracefulSessionFile !== "" && await fs.stat(gracefulSessionFile).then(() => true).catch(() => false),
    gracefulSessionFile,
  );

  await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("lifecycle 异常退出：", error);
  process.exit(1);
});
