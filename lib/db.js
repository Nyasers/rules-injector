// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/db.js — data.db 统一状态库（node:sqlite，零依赖）
// 模板：hana-remote-dev connection-store（DELETE journal 保单文件、busy_timeout、外键）
// 职责：meta（schema 版本等）+ injected_sessions（注入判据）+ option_cards（卡片数据与消费状态，0.8.7）
// 注：0.8.0 曾建 card_consumed 空表（从未写入），0.8.7 由 option_cards 取代；残留空表不迁移不删除，代码不再引用
// 容错：init 失败（db 损坏/不可读）抛错由上层捕获，插件不崩，工具报「未初始化」。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DB_FILE = "data.db";
const SCHEMA_VERSION = "1";
// 纯时间 TTL 除旧（双表统一，24h）：option_cards 与渲染层失效语义同步；injected_sessions 判据保留窗口，
// 超时删除后会话重新活跃会重新注入（清单跟随会话活跃度）
const CARD_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class StateDb {
  /** @type {DatabaseSync|null} */
  #db = null;
  #dataDir;

  constructor(dataDir) {
    this.#dataDir = dataDir;
  }

  /** 打开 db、建表、幂等。失败抛错（调用方决定容错策略）。 */
  init() {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(this.#dataDir, DB_FILE));
    this.#db = db;
    db.exec("PRAGMA journal_mode = DELETE"); // 单文件约束：无 -wal/-shm 侧车
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS injected_sessions (
        session_id  TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        injected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS option_cards (
        card_id TEXT PRIMARY KEY,
        q       TEXT NOT NULL,
        o       TEXT NOT NULL,
        c       INTEGER NOT NULL,
        p       TEXT,
        value   TEXT NOT NULL DEFAULT '',
        mode    TEXT NOT NULL DEFAULT '',
        ts      INTEGER
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
    `);
  }

  /** 关闭（幂等）。 */
  close() {
    if (this.#db) {
      try { this.#db.close(); } catch { /* ignore */ }
      this.#db = null;
    }
  }

  get ok() { return this.#db !== null; }

  #requireDb() {
    if (!this.#db) throw new Error("data.db 未初始化");
    return this.#db;
  }

  // ─── meta ───
  getMeta(key) {
    const row = this.#requireDb().prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }
  setMeta(key, value) {
    this.#requireDb()
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  // ─── injected_sessions（注入判据） ───
  /** 取某会话最后注入的清单指纹；无记录返回 null。 */
  getFingerprint(sessionId) {
    const row = this.#requireDb().prepare("SELECT fingerprint FROM injected_sessions WHERE session_id = ?").get(sessionId);
    return row ? row.fingerprint : null;
  }
  /** upsert：每会话恒一条（主键天然替代 jsonl 的尾部剔除逻辑）；写入时顺带 TTL 除旧（判据保留窗口）。 */
  setFingerprint(sessionId, fingerprint) {
    const db = this.#requireDb();
    db.prepare(
      "INSERT INTO injected_sessions (session_id, fingerprint, injected_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET fingerprint = excluded.fingerprint, injected_at = excluded.injected_at"
    ).run(sessionId, fingerprint, new Date().toISOString());
    // TTL 除旧：injected_at 为 ISO 字符串（字典序 = 时间序），删除超出保留窗口的判据（会话重新活跃时重新注入）
    db.prepare("DELETE FROM injected_sessions WHERE injected_at < ?")
      .run(new Date(Date.now() - SESSION_TTL_MS).toISOString());
  }
  /** 全部会话指纹（上下文压缩重注入用）。 */
  allFingerprints() {
    const rows = this.#requireDb().prepare("SELECT session_id, fingerprint FROM injected_sessions").all();
    return Object.fromEntries(rows.map((r) => [r.session_id, r.fingerprint]));
  }
  countSessions() {
    return this.#requireDb().prepare("SELECT COUNT(*) AS n FROM injected_sessions").get().n;
  }

  // ─── option_cards（卡片数据 + 消费状态，0.8.7） ───
  /** 创建卡片：INSERT OR IGNORE 幂等（同 id 保留首条）。返回是否成功插入。 */
  createCard({ cardId, q, o, c, p }) {
    const res = this.#requireDb()
      .prepare("INSERT OR IGNORE INTO option_cards (card_id, q, o, c, p) VALUES (?, ?, ?, ?, ?)")
      .run(cardId, q, o, c, p ?? null);
    return res.changes > 0;
  }
  /** 消费标记：条件更新（仅未消费可写），幂等防重。返回是否实际更新。 */
  markCardConsumed(cardId, value, mode) {
    const res = this.#requireDb()
      .prepare("UPDATE option_cards SET value = ?, mode = ?, ts = ? WHERE card_id = ? AND ts IS NULL")
      .run(String(value ?? ""), String(mode ?? ""), Date.now(), cardId);
    return res.changes > 0;
  }
  /** 取卡片整行（含消费状态）；无记录返回 null。 */
  getCard(cardId) {
    return this.#requireDb().prepare("SELECT * FROM option_cards WHERE card_id = ?").get(cardId) || null;
  }
  /** TTL 除旧：删除创建时间早于 cutoffMs 的过期记录（含已消费），与渲染层 24h 失效语义同步。 */
  pruneCards(cutoffMs) {
    this.#requireDb().prepare("DELETE FROM option_cards WHERE c < ?").run(cutoffMs);
  }
  /** TTL 除旧：删除注入时间早于 cutoffMs 的判据（会话重新活跃时重新注入）。 */
  pruneSessions(cutoffMs) {
    this.#requireDb().prepare("DELETE FROM injected_sessions WHERE injected_at < ?").run(new Date(cutoffMs).toISOString());
  }
}
