/**
 * 认证路由：status / setup / login / logout / me / username / password。
 * 首启动流程（PRD 实现要点 8）：user 表空 → needs-setup → 设密码 → 登录。
 * 改名与改密都要求当前密码，失败信息不区分账号是否存在。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { buildClearCookie, buildSessionCookie, requireAuth, SESSION_COOKIE_NAME } from "../auth/middleware.ts";
import {
  createLoginSession, destroyLoginSession, destroyOtherLoginSessions, renameLoginSessions,
} from "../auth/session-store.ts";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

function getUser(db: Database.Database): UserRow | undefined {
  return db.prepare("SELECT * FROM user ORDER BY id LIMIT 1").get() as UserRow | undefined;
}

export function createAuthRouter(db: Database.Database): Router {
  const router = Router();

  // GET /api/auth/status —— 前端启动先问这个：needs-setup 决定进设密码页还是登录页
  router.get("/status", (_req: Request, res: Response) => {
    res.json({ needsSetup: getUser(db) === undefined });
  });

  // POST /api/auth/setup —— 仅 user 表空时可用；创建即视为登录态
  router.post("/setup", async (req: Request, res: Response) => {
    if (getUser(db) !== undefined) {
      res.status(409).json({ error: "账号已存在，请直接登录" });
      return;
    }
    const { username, password } = req.body as { username?: string; password?: string };
    if (typeof username !== "string" || !username.trim() || typeof password !== "string" || password.length < 6) {
      res.status(400).json({ error: "用户名不能为空，密码至少 6 位" });
      return;
    }
    const passwordHash = await hashPassword(password);
    db.prepare("INSERT INTO user (username, password_hash) VALUES (?, ?)").run(username.trim(), passwordHash);
    const session = createLoginSession(username.trim());
    res.setHeader("Set-Cookie", buildSessionCookie(session.token));
    res.json({ success: true, username: username.trim() });
  });

  // POST /api/auth/login —— 失败不区分「用户名错」与「密码错」（防枚举）
  router.post("/login", async (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };
    const user = getUser(db);
    if (
      typeof username !== "string" || typeof password !== "string"
      || !user || user.username !== username
      || !(await verifyPassword(password, user.password_hash))
    ) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }
    const session = createLoginSession(user.username);
    res.setHeader("Set-Cookie", buildSessionCookie(session.token));
    res.json({ success: true, username: user.username });
  });

  // POST /api/auth/logout
  router.post("/logout", (req: Request, res: Response) => {
    const raw = req.headers.cookie ?? "";
    for (const part of raw.split(";")) {
      const eq = part.indexOf("=");
      if (eq !== -1 && part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
        destroyLoginSession(part.slice(eq + 1).trim().split(".")[0]);
      }
    }
    res.setHeader("Set-Cookie", buildClearCookie());
    res.json({ success: true });
  });

  // GET /api/auth/me —— 会话探测。auth router 整体挂在 requireAuth 之前
  // （status/setup/login 免登录），me 单独补一层局部守卫才能拿到 req.session。
  router.get("/me", requireAuth, (req: Request, res: Response) => {
    res.json({ username: req.session?.username ?? null });
  });

  // PATCH /api/auth/username —— 改名同样要验当前密码：cookie 被盗时不能让攻击者
  // 悄悄改掉账号标识。单用户模型下只操作 user 表唯一那一行（ADR-0022）。
  router.patch("/username", requireAuth, async (req: Request, res: Response) => {
    const { username, currentPassword } = req.body as { username?: unknown; currentPassword?: unknown };
    if (typeof username !== "string" || !username.trim() || username.trim().length > 100) {
      res.status(400).json({ error: "用户名不能为空，且不能超过 100 个字符" });
      return;
    }
    const user = getUser(db);
    if (typeof currentPassword !== "string" || !user || !(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ error: "当前密码错误" });
      return;
    }
    const next = username.trim();
    db.prepare("UPDATE user SET username = ? WHERE id = ?").run(next, user.id);
    renameLoginSessions(next);
    res.json({ success: true, username: next });
  });

  // PATCH /api/auth/password —— 验旧密码 → 改哈希 → 失效其他登录态 → 给当前会话换发新 token
  router.patch("/password", requireAuth, async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      res.status(400).json({ error: "新密码至少 6 位" });
      return;
    }
    const user = getUser(db);
    if (typeof currentPassword !== "string" || !user || !(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ error: "当前密码错误" });
      return;
    }
    if (await verifyPassword(newPassword, user.password_hash)) {
      res.status(400).json({ error: "新密码不能与当前密码相同" });
      return;
    }
    db.prepare("UPDATE user SET password_hash = ? WHERE id = ?").run(await hashPassword(newPassword), user.id);
    // 旧 token 一律作废（含本次调用者的），再给当前浏览器换发一个新的：
    // 既保证别处会话立即失效，也不必让操作者重新登录。
    destroyOtherLoginSessions(undefined);
    const session = createLoginSession(user.username);
    res.setHeader("Set-Cookie", buildSessionCookie(session.token));
    res.json({ success: true });
  });

  return router;
}
