import Database from "better-sqlite3";

/**
 * 数据库连接单例。
 *
 * dev 阶段 SQLite 文件落 tools-dev/dev-data/pi-teacher.db（PRD 对齐结论），
 * 不碰真实部署路径 ~/pi-teacher/。WAL 模式：单用户多会话并发读写时
 * 读不阻塞写，进程内多 Pi 会话并发调工具时避免 SQLITE_BUSY。
 */

let sharedConnection: Database.Database | undefined;

export function openDatabase(dbPath: string): Database.Database {
    if (sharedConnection) {
        // dev 脚本单进程，重复 open 视为编程错误——早暴露优于静默复用
        throw new Error(`Database already opened: ${sharedConnection.name}`);
    }
    sharedConnection = new Database(dbPath);
    sharedConnection.pragma("journal_mode = WAL");
    return sharedConnection;
}

/** 供工具层取连接；须在 openDatabase 之后调用。 */
export function getDatabase(): Database.Database {
    if (!sharedConnection) {
        throw new Error("Database not opened. Call openDatabase() first.");
    }
    return sharedConnection;
}

/** 验证脚本结束时调用，释放句柄让 WAL checkpoint 落盘。 */
export function closeDatabase(): void {
    if (sharedConnection) {
        sharedConnection.close();
        sharedConnection = undefined;
    }
}
