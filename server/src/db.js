import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * 持久化状态机：
 *   releases    —— 发布意图（staging → published | failed）
 *   receipts    —— 每台采集器的暂存回执（先落设备、再落库，崩溃后靠 reconcile 补记）
 *   generations —— 生效代次，单调递增，仅在全部回执匹配时原子推进
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS releases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_key  TEXT NOT NULL UNIQUE,
  digest       TEXT NOT NULL,
  params       TEXT NOT NULL,
  targets      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'staging'
               CHECK (status IN ('staging', 'published', 'failed')),
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
`

export function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

/** 在单个事务中执行 fn，全部成功才提交，用于代次的原子推进。 */
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
