/**
 * pi-teacher 自己的业务运行设置：SQLite `setting` 表，键值都是文本。
 * 与 Pi 的 `settings.json`（pi-config.ts）无关——那是 SDK 定义字段的文件，塞业务字段
 * 进去等于依赖它对未知键的容忍度。缺行即取代码默认值，因此不需要 seed。
 *
 * 一个共用间隔与四段文案：
 * - `reminder_interval_turns`：每隔多少轮用户消息在消息末尾追加一次维护提醒；0 表示全部关闭
 * - `reminder_text_make_card_on` / `reminder_text_make_card_off` / `reminder_text_ta`：三种基础文案
 * - `reminder_text_learning_essence`：仅学习会话在基础文案后追加的精华维护提醒
 * 文案含标签；缺行或空串时用 prompts/defaults.ts 的出厂文案，不覆盖已有自定义内容。
 */
import type Database from "better-sqlite3";
import { HttpError } from "../routes/http.ts";
import { REMINDER_TEXT_DEFAULTS, type ReminderKind } from "../prompts/defaults.ts";

export const REMINDER_INTERVAL_TURNS_KEY = "reminder_interval_turns";
export const REMINDER_INTERVAL_TURNS_DEFAULT = 30;
/** 上限只是防手滑（例如把 30 打成 30000 还以为关掉了），不是业务约束。 */
export const REMINDER_INTERVAL_TURNS_MAX = 10_000;
/** 文案上限同样只防手滑（整段粘贴错东西）；一条提醒不该长过一屏。 */
export const REMINDER_TEXT_MAX_LENGTH = 4_000;

const REMINDER_TEXT_KEYS: Record<ReminderKind, string> = {
  makeCardOn: "reminder_text_make_card_on",
  makeCardOff: "reminder_text_make_card_off",
  ta: "reminder_text_ta",
  learningEssence: "reminder_text_learning_essence",
};
export const REMINDER_KINDS = Object.keys(REMINDER_TEXT_KEYS) as ReminderKind[];

export interface AppSettings {
  /** 维护提醒间隔（轮）；0 = 关闭。 */
  reminderIntervalTurns: number;
  /** 三段基础文案与学习精华追加段；用户没改过的就是出厂文案。 */
  reminderTexts: Record<ReminderKind, string>;
}

/** 补丁：文案传空串表示恢复出厂文案（删行）；关闭提醒统一用间隔 0，不靠清空文案。 */
export interface AppSettingsPatch {
  reminderIntervalTurns?: number;
  reminderTexts?: Partial<Record<ReminderKind, string>>;
}

/** 补丁里允许出现的字段名（HTTP 侧用它把业务字段与 Pi 字段拆开）。 */
export const APP_SETTINGS_FIELDS = new Set<keyof AppSettings>(["reminderIntervalTurns", "reminderTexts"]);

function parseInterval(raw: string | undefined): number {
  if (raw === undefined) return REMINDER_INTERVAL_TURNS_DEFAULT;
  const value = Number(raw);
  // 表里出现非法值（手改库）时回落默认值，而不是让每一次 prompt 都抛错。
  return Number.isInteger(value) && value >= 0 && value <= REMINDER_INTERVAL_TURNS_MAX ? value : REMINDER_INTERVAL_TURNS_DEFAULT;
}

export function readAppSettings(db: Database.Database): AppSettings {
  const rows = new Map(
    (db.prepare("SELECT key, value FROM setting").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]),
  );
  const reminderTexts = {} as Record<ReminderKind, string>;
  for (const kind of REMINDER_KINDS) {
    const stored = rows.get(REMINDER_TEXT_KEYS[kind])?.trim();
    reminderTexts[kind] = stored || REMINDER_TEXT_DEFAULTS[kind];
  }
  return { reminderIntervalTurns: parseInterval(rows.get(REMINDER_INTERVAL_TURNS_KEY)), reminderTexts };
}

/** 某一种提醒当前生效的文案（表里的或出厂的）。 */
export function readReminderText(db: Database.Database, kind: ReminderKind): string {
  return readAppSettings(db).reminderTexts[kind];
}

/** 只校验业务字段；调用方保证传进来的对象只含 APP_SETTINGS_FIELDS 里的键。 */
export function readAppSettingsPatch(body: Record<string, unknown>): AppSettingsPatch {
  const patch: AppSettingsPatch = {};
  if ("reminderIntervalTurns" in body) {
    const value = body.reminderIntervalTurns;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > REMINDER_INTERVAL_TURNS_MAX) {
      throw new HttpError(400, `reminderIntervalTurns 必须是 0 到 ${REMINDER_INTERVAL_TURNS_MAX} 之间的整数（0 表示关闭）`);
    }
    patch.reminderIntervalTurns = value;
  }
  if ("reminderTexts" in body) {
    const texts = body.reminderTexts;
    if (!texts || typeof texts !== "object" || Array.isArray(texts)) throw new HttpError(400, "reminderTexts 必须是对象");
    const entries = Object.entries(texts as Record<string, unknown>);
    if (!entries.length) throw new HttpError(400, "reminderTexts 至少要包含一种文案");
    patch.reminderTexts = {};
    for (const [kind, value] of entries) {
      if (!Object.hasOwn(REMINDER_TEXT_KEYS, kind)) throw new HttpError(400, `未知的提醒文案种类「${kind.slice(0, 40)}」`);
      if (typeof value !== "string") throw new HttpError(400, `reminderTexts.${kind} 必须是字符串（空串表示恢复默认）`);
      if (value.length > REMINDER_TEXT_MAX_LENGTH) throw new HttpError(400, `reminderTexts.${kind} 最多 ${REMINDER_TEXT_MAX_LENGTH} 个字符`);
      patch.reminderTexts[kind as ReminderKind] = value;
    }
  }
  return patch;
}

export function writeAppSettings(db: Database.Database, patch: AppSettingsPatch): void {
  const upsert = db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const remove = db.prepare("DELETE FROM setting WHERE key = ?");
  db.transaction(() => {
    if (patch.reminderIntervalTurns !== undefined) upsert.run(REMINDER_INTERVAL_TURNS_KEY, String(patch.reminderIntervalTurns));
    for (const [kind, value] of Object.entries(patch.reminderTexts ?? {}) as Array<[ReminderKind, string]>) {
      // 空串 = 恢复出厂文案：删行而不是存空串，读侧就不用区分「没改过」和「改成空」。
      if (value.trim()) upsert.run(REMINDER_TEXT_KEYS[kind], value);
      else remove.run(REMINDER_TEXT_KEYS[kind]);
    }
  })();
}
