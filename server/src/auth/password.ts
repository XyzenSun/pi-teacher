/**
 * 密码哈希与校验：scrypt + 随机盐（Node 内置 crypto，无第三方依赖）。
 *
 * 比较「归一长度 + timingSafeEqual」的写法取自 pi-web web-auth.ts:9-11 的
 * 思路（SHA-256 把两个任意长度输入变成定长，等长才允许 timingSafeEqual）。
 * 存储格式：scrypt$N$r$p$saltHex$hashHex，自描述便于将来调参。
 */
import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

/**
 * 手工包装（promisify(scrypt) 在 Node 类型下重载推断不佳，选项参数
 * 会被吞掉）。错误与结果都走正常路径：调用方只关心 Buffer。
 */
function scryptAsync(password: string, salt: Buffer, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** 恒定时间比较：把两侧都 SHA-256 归一到 32 字节再 timingSafeEqual。 */
function secretsEqual(actual: string, expected: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  // 格式不合法一律拒绝（不抛错：登录失败路径统一返回 false）
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expectedHash = parts[5];
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0) {
    return false;
  }
  try {
    const derived = await scryptAsync(password.normalize("NFKC"), salt, { N, r, p });
    return secretsEqual(derived.toString("hex"), expectedHash);
  } catch {
    return false;
  }
}
