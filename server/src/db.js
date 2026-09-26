import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * 持久化状态机：
 *   releases     —— 发布意图（staging → activating → published；staging → failed）
 *   receipts     —— 每台采集器的暂存回执（先落设备、再落库，崩溃后靠 reconcile 补记）
 *   generations  —— 生效代次（在 activating 时预占，单调递增、与发布一一对应）
 *   activations  —— 每台采集器“实际生效”的确认记录（以设备 GET /active 回报为准）。
 *                   仅当全部目标都确认 release_id/digest/generation 与发布一致时，
 *                   发布才允许从 activating 翻转为 published。
 */
const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS releases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_key  TEXT NOT NULL UNIQUE,
  digest       TEXT NOT NULL,
  params       TEXT NOT NULL,
  targets      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'staging'
               CHECK (status IN ('staging', 'activating', 'published', 'failed')),
  generation   INTEGER,
  created_at   TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS receipts (
  release_id  INTEGER NOT NULL REFERENCES releases (id),
  device_id   TEXT    NOT NULL,
  digest      TEXT    NOT NULL,
  staged_at   TEXT    NOT NULL,
  recorded_at TEXT    NOT NULL,
  PRIMARY KEY (release_id, device_id)
);

CREATE TABLE IF NOT EXISTS generations (
  generation   INTEGER PRIMARY KEY,
  release_id   INTEGER NOT NULL UNIQUE REFERENCES releases (id),
  published_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS activations (
  release_id   INTEGER NOT NULL REFERENCES releases (id),
  device_id    TEXT    NOT NULL,
  generation   INTEGER NOT NULL,
  digest       TEXT    NOT NULL,
  activated_at TEXT    NOT NULL,
  confirmed_at TEXT    NOT NULL,
  PRIMARY KEY (release_id, device_id)
);
`

export function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/**
 * 版本迁移。
 * v0（旧库，无 activations 表、状态 CHECK 不含 activating）→ v1：
 *   - 重建 releases 表以放开状态集合；
 *   - 新建 activations 表；
 *   - 修复旧版本可能留下的“本地已 published 但设备仅部分切换”记录：
 *     凡缺少全部目标生效确认的 published 一律降级为 activating，
 *     由启动核对逐台补齐，未补齐前页面/接口不得显示已发布。
 */
function migrate(db) {
  const current = db.pragma('user_version', { simple: true })
  if (current >= SCHEMA_VERSION) {
    db.exec(SCHEMA) // 兜底：缺表补表
    return
  }

  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  )

  if (!tables.has('releases')) {
    db.exec(SCHEMA)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
    return
  }

  db.pragma('foreign_keys = OFF')
  try {
    const apply = db.transaction(() => {
      db.exec(`
        CREATE TABLE releases_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          release_key  TEXT NOT NULL UNIQUE,
          digest       TEXT NOT NULL,
          params       TEXT NOT NULL,
          targets      TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'staging'
                       CHECK (status IN ('staging', 'activating', 'published', 'failed')),
          generation   INTEGER,
          created_at   TEXT NOT NULL,
          published_at TEXT
        );
        INSERT INTO releases_new
          (id, release_key, digest, params, targets, status, generation, created_at, published_at)
        SELECT id, release_key, digest, params, targets, status, generation, created_at, published_at
        FROM releases;
        DROP TABLE releases;
        ALTER TABLE releases_new RENAME TO releases;

        CREATE TABLE IF NOT EXISTS activations (
          release_id   INTEGER NOT NULL REFERENCES releases (id),
          device_id    TEXT    NOT NULL,
          generation   INTEGER NOT NULL,
          digest       TEXT    NOT NULL,
          activated_at TEXT    NOT NULL,
          confirmed_at TEXT    NOT NULL,
          PRIMARY KEY (release_id, device_id)
        );
      `)

      // 修复：旧代码在逐台最终切换前就已置 published 的记录，回退到 activating 等待核对。
      const countConfirmed = db.prepare(
        'SELECT COUNT(*) AS c FROM activations WHERE release_id = ?'
      )
      const downgrade = db.prepare(
        "UPDATE releases SET status = 'activating' WHERE id = ? AND status = 'published'"
      )
      for (const row of db.prepare('SELECT id, targets FROM releases').all()) {
        const expected = JSON.parse(row.targets).length
        if (countConfirmed.get(row.id).c < expected) downgrade.run(row.id)
      }
    })
    apply()
  } finally {
    db.pragma('foreign_keys = ON')
  }

  const violations = db.pragma('foreign_key_check')
  if (violations.length > 0) {
    throw new Error(`数据库迁移外键校验失败: ${JSON.stringify(violations)}`)
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

/** 在单个事务中执行 fn，全部成功才提交，用于代次的原子预占/翻转。 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
