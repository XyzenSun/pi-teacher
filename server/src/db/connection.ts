import Database from "better-sqlite3";

/**
 * 数据库连接单例。
 *
 * 路径由调用方决定：server 进程用数据目录（~/pi-teacher/data/ 或测试临时
 * 目录），verify 脚本用临时文件。WAL 模式：单用户多会话并发读写时读不阻塞
 * 写，进程内多 Pi 会话并发调工具时避免 SQLITE_BUSY。
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
