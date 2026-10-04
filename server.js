'use strict';

/**
 * 水质实验室 · 样本分装与混样溯源工作台
 *
 * 核心不变量：
 *  - 每个操作有唯一操作号；同一操作号重复提交相同内容时幂等返回，不重复扣量。
 *  - 一次操作的来源瓶不得重复，取用体积均为正整数，目标瓶体积 = 取用量之和。
 *  - 任一时刻任何瓶的余量不得为负（按 操作时间 + 入库顺序 重放全量台账校验）。
 *  - 更正历史操作的取用量时，在事务内重算；若导致后续操作超用，整次更正回滚，
 *    原数据保持不变，并返回冲突记录。
 *  - better-sqlite3 为同步驱动，所有写操作包裹在事务中串行执行，
 *    并发请求争用同一来源瓶时天然保证体积守恒。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lab.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS bottles (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('original','derived')),
  created_time   TEXT NOT NULL,                 -- 原瓶为采样时间，衍生瓶为创建它的操作时间
  initial_volume INTEGER NOT NULL DEFAULT 0 CHECK (initial_volume >= 0),
  created_op     TEXT                           -- 衍生瓶由哪个操作创建
);
CREATE TABLE IF NOT EXISTS operations (
  op_id         TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL UNIQUE,        -- 入库顺序，用于同一时间戳下的稳定排序
  target_bottle TEXT NOT NULL,
  op_time       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_sources (
  op_id         TEXT NOT NULL REFERENCES operations(op_id) ON DELETE CASCADE,
  source_bottle TEXT NOT NULL,
  volume        INTEGER NOT NULL CHECK (volume > 0),
  PRIMARY KEY (op_id, source_bottle)            -- 同一操作内来源不得重复
);
CREATE INDEX IF NOT EXISTS idx_op_sources_bottle ON operation_sources(source_bottle);
CREATE INDEX IF NOT EXISTS idx_operations_target ON operations(target_bottle);
CREATE TABLE IF NOT EXISTS batches (
  batch_id     TEXT PRIMARY KEY,
  plan_hash    TEXT NOT NULL,                 -- 规范化批次计划的 SHA-256，用于幂等返回与冲突判定
  item_count   INTEGER NOT NULL,
  committed_at TEXT NOT NULL                  -- 服务器提交时刻（ISO 字符串）
);
CREATE TABLE IF NOT EXISTS batch_items (
  batch_id TEXT NOT NULL REFERENCES batches(batch_id),
  idx      INTEGER NOT NULL,                  -- 批内录入顺序（0 起）；同操作时间时按此序核算
  op_id    TEXT NOT NULL UNIQUE REFERENCES operations(op_id),
  PRIMARY KEY (batch_id, idx)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('ledger_version', '0')").run();

// ---------------------------------------------------------------- 工具与校验

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function normId(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, 'BAD_ID', `${field}不能为空`);
  return v.trim();
}

function normTime(v, field) {
  if (typeof v !== 'string' || !TIME_RE.test(v.trim())) {
    throw new ApiError(400, 'BAD_TIME', `${field}格式应为 YYYY-MM-DDTHH:MM（如 2026-10-04T09:30）`);
  }
  const t = v.trim();
  return t.length === 16 ? t + ':00' : t; // 统一为 YYYY-MM-DDTHH:MM:SS，字典序即时间序
}

function normVolume(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, 'BAD_VOLUME', `${field}必须为正整数（毫升）`);
  }
  return n;
}

function parseSources(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'NO_SOURCES', '每次操作至少需要一个来源瓶');
  }
  const seen = new Set();
  return raw.map((s, i) => {
    const bottle = normId(s && s.bottle, `来源瓶编号（第 ${i + 1} 行）`);
    const volume = normVolume(s && s.volume, `取用体积（第 ${i + 1} 行）`);
    if (seen.has(bottle)) throw new ApiError(400, 'DUP_SOURCE', `同一操作内来源瓶 ${bottle} 重复`);
    seen.add(bottle);
    return { bottle, volume };
  });
}

// ---------------------------------------------------------------- 预编译语句

const qBottle     = db.prepare('SELECT * FROM bottles WHERE id = ?');
const qInsBottle  = db.prepare('INSERT INTO bottles (id, kind, created_time, initial_volume, created_op) VALUES (?, ?, ?, ?, ?)');
const qOp         = db.prepare('SELECT * FROM operations WHERE op_id = ?');
const qInsOp      = db.prepare('INSERT INTO operations (op_id, seq, target_bottle, op_time) VALUES (?, ?, ?, ?)');
const qNextSeq    = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM operations');
const qOpSources  = db.prepare('SELECT source_bottle, volume FROM operation_sources WHERE op_id = ? ORDER BY source_bottle');
const qInsSource  = db.prepare('INSERT INTO operation_sources (op_id, source_bottle, volume) VALUES (?, ?, ?)');
const qDelSources = db.prepare('DELETE FROM operation_sources WHERE op_id = ?');
const qBatch      = db.prepare('SELECT * FROM batches WHERE batch_id = ?');
const qInsBatch   = db.prepare('INSERT INTO batches (batch_id, plan_hash, item_count, committed_at) VALUES (?, ?, ?, ?)');
const qInsBatchItem = db.prepare('INSERT INTO batch_items (batch_id, idx, op_id) VALUES (?, ?, ?)');
const qVersion    = db.prepare("SELECT value FROM meta WHERE key = 'ledger_version'");
const qBumpVersion = db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'ledger_version'");

/**
 * 台账版本号：任何写操作（登记原瓶 / 单条操作 / 更正 / 批次提交）成功提交后递增。
 * 批次提交凭据与版本号绑定；预演后若台账变化，凭据自动失效，须重新预演。
 */
function ledgerVersion() { return parseInt(qVersion.get().value, 10); }

// ------------------------------------------------------- 台账重放（守恒校验）

/** 从数据库加载全量台账：瓶 + 按 (操作时间, 入库顺序) 排序的操作及其来源。 */
function loadLedger() {
  const bottles = db.prepare('SELECT id, kind, initial_volume, created_time FROM bottles').all();
  const ops = db.prepare('SELECT op_id, seq, target_bottle, op_time FROM operations ORDER BY op_time, seq').all();
  const srcRows = db.prepare('SELECT op_id, source_bottle, volume FROM operation_sources ORDER BY source_bottle').all();
  const byOp = new Map();
  for (const s of srcRows) {
    if (!byOp.has(s.op_id)) byOp.set(s.op_id, []);
    byOp.get(s.op_id).push({ bottle: s.source_bottle, volume: s.volume });
  }
  return { bottles, ops: ops.map((o) => ({ ...o, sources: byOp.get(o.op_id) || [] })) };
}

/** 操作排序：先按操作时间，同一时间按入库顺序（批内即录入顺序）。 */
const cmpOps = (a, b) => (a.op_time < b.op_time ? -1 : a.op_time > b.op_time ? 1 : a.seq - b.seq);

/**
 * 按 (操作时间, 入库顺序) 重放操作序列，计算每个瓶的余量。
 * 任一取用使余量为负即记录冲突；冲突瓶按 0 继续推演，以便后续冲突的
 * “可用量”仍然可读。返回 { balances, conflicts }。
 */
function replayLedger(bottleRows, ops) {
  const balances = new Map();
  for (const b of bottleRows) {
    if (b.kind === 'original') balances.set(b.id, b.initial_volume);
  }
  const conflicts = [];
  for (const op of ops) {
    let total = 0;
    for (const s of op.sources) {
      const avail = balances.get(s.bottle) || 0;
      if (s.volume > avail) {
        conflicts.push({ op_id: op.op_id, bottle: s.bottle, requested: s.volume, available: avail });
        balances.set(s.bottle, 0);
      } else {
        balances.set(s.bottle, avail - s.volume);
      }
      total += s.volume;
    }
    balances.set(op.target_bottle, (balances.get(op.target_bottle) || 0) + total);
  }
  return { balances, conflicts };
}

/** 重放当前数据库中的全量台账。 */
function recompute() {
  const { bottles, ops } = loadLedger();
  return replayLedger(bottles, ops);
}

// ---------------------------------------------------------------- 业务事务

function sameSources(a, b) {
  if (a.length !== b.length) return false;
  const key = (s) => s.map((x) => `${x.bottle}=${x.volume}`).sort().join('|');
  return key(a) === key(b);
}

/** 新建分装/混样操作（事务）。重复操作号且内容一致 → 幂等返回；不一致 → 409。 */
const createOperation = db.transaction((p) => {
  const existing = qOp.get(p.op_id);
  if (existing) {
    const oldSrcs = qOpSources.all(p.op_id).map((s) => ({ bottle: s.source_bottle, volume: s.volume }));
    const identical =
      existing.target_bottle === p.target &&
      existing.op_time === p.op_time &&
      sameSources(oldSrcs, p.sources);
    if (identical) {
      return { ok: true, idempotent: true, message: `操作号 ${p.op_id} 已提交过相同内容，幂等返回，未重复扣量` };
    }
    throw new ApiError(409, 'OP_CONFLICT', `操作号 ${p.op_id} 已存在且内容不一致，请更换操作号`);
  }
  if (qBottle.get(p.target)) {
    throw new ApiError(409, 'BOTTLE_CONFLICT', `目标瓶编号 ${p.target} 已存在（编号冲突）`);
  }
  for (const s of p.sources) {
    const b = qBottle.get(s.bottle);
    if (!b) throw new ApiError(400, 'SOURCE_NOT_FOUND', `来源瓶 ${s.bottle} 不存在`);
    if (p.op_time < b.created_time) {
      throw new ApiError(400, 'TIME_BEFORE_SOURCE',
        `操作时间 ${p.op_time} 早于来源瓶 ${s.bottle} 的创建时间 ${b.created_time}`);
    }
  }
  qInsOp.run(p.op_id, qNextSeq.get().next, p.target, p.op_time);
  qInsBottle.run(p.target, 'derived', p.op_time, 0, p.op_id);
  for (const s of p.sources) qInsSource.run(p.op_id, s.bottle, s.volume);

  const { conflicts } = recompute();
  if (conflicts.length) {
    throw new ApiError(409, 'OVERDRAW', '取用量超过来源瓶可用余量，操作已拒绝，数据未变更', conflicts);
  }
  qBumpVersion.run();
  return { ok: true, idempotent: false, message: `操作 ${p.op_id} 已登记` };
});

/** 更正历史操作的取用量（事务）。导致后续超用 → 整体回滚并返回冲突记录。 */
const correctOperation = db.transaction((opId, sources) => {
  const op = qOp.get(opId);
  if (!op) throw new ApiError(404, 'OP_NOT_FOUND', `操作 ${opId} 不存在`);
  for (const s of sources) {
    const b = qBottle.get(s.bottle);
    if (!b) throw new ApiError(400, 'SOURCE_NOT_FOUND', `来源瓶 ${s.bottle} 不存在`);
    if (op.op_time < b.created_time) {
      throw new ApiError(400, 'TIME_BEFORE_SOURCE',
        `操作时间 ${op.op_time} 早于来源瓶 ${s.bottle} 的创建时间 ${b.created_time}`);
    }
  }
  qDelSources.run(opId);
  for (const s of sources) qInsSource.run(opId, s.bottle, s.volume);

  const { conflicts } = recompute();
  if (conflicts.length) {
    throw new ApiError(409, 'CORRECTION_REJECTED',
      '更正将导致以下操作超用，整次更正已拒绝，原数据保持不变', conflicts);
  }
  qBumpVersion.run();
  return { ok: true, message: `操作 ${opId} 的取用量已更正，相关瓶余量已按操作顺序重算` };
});

// ---------------------------------------------------------------- 批次（预演 / 提交）

/** 提交凭据签名密钥：默认进程启动时随机生成，重启后旧凭据自动失效（需重新预演）。 */
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

/** 逐条规范化批次条目：格式错误收集到对应条目而不中断（预演需逐条反馈）。 */
function normalizeBatchItems(rawItems) {
  const items = [];
  const itemErrors = new Map(); // index -> [{code, message}]
  const pushErr = (i, code, message) => {
    if (!itemErrors.has(i)) itemErrors.set(i, []);
    itemErrors.get(i).push({ code, message });
  };
  rawItems.forEach((raw, i) => {
    const it = { op_id: null, target: null, op_time: null, sources: [] };
    const n = i + 1;
    try { it.op_id = normId(raw && raw.op_id, `操作号（第 ${n} 条）`); } catch (e) { pushErr(i, e.code, e.message); }
    try { it.target = normId(raw && raw.target_bottle, `目标瓶编号（第 ${n} 条）`); } catch (e) { pushErr(i, e.code, e.message); }
    try { it.op_time = normTime(raw && raw.op_time, `操作时间（第 ${n} 条）`); } catch (e) { pushErr(i, e.code, e.message); }
    const rawSrcs = raw && raw.sources;
    if (!Array.isArray(rawSrcs) || rawSrcs.length === 0) {
      pushErr(i, 'NO_SOURCES', `第 ${n} 条操作至少需要一个来源瓶`);
    } else {
      const seen = new Set();
      rawSrcs.forEach((s, j) => {
        let bottle = null; let volume = null; let bad = false;
        try { bottle = normId(s && s.bottle, `来源瓶编号（第 ${n} 条第 ${j + 1} 行）`); } catch (e) { pushErr(i, e.code, e.message); bad = true; }
        try { volume = normVolume(s && s.volume, `取用体积（第 ${n} 条第 ${j + 1} 行）`); } catch (e) { pushErr(i, e.code, e.message); bad = true; }
        if (!bad) {
          if (seen.has(bottle)) pushErr(i, 'DUP_SOURCE', `第 ${n} 条操作内来源瓶 ${bottle} 重复`);
          else { seen.add(bottle); it.sources.push({ bottle, volume }); }
        }
      });
    }
    items.push(it);
  });
  return { items, itemErrors };
}

/**
 * 批次业务校验（预演与提交共用，提交时在事务内重跑）：
 * 编号冲突（批内 / 现有台账）、来源存在性（可引用批内前项生成的瓶）、
 * 操作时间不得早于来源创建时间。返回 Map(index -> errors)。
 */
function validateBatchItems(items) {
  const errMap = new Map();
  const pushErr = (i, code, message) => {
    if (!errMap.has(i)) errMap.set(i, []);
    errMap.get(i).push({ code, message });
  };
  const opFirst = new Map();     // 批内操作号 -> 首次出现的条目下标
  const targetFirst = new Map(); // 批内目标瓶 -> 生成它的条目下标
  items.forEach((it, i) => {
    if (it.op_id && !opFirst.has(it.op_id)) opFirst.set(it.op_id, i);
    if (it.target && !targetFirst.has(it.target)) targetFirst.set(it.target, i);
  });
  items.forEach((it, i) => {
    if (!it.op_id || !it.target || !it.op_time || it.sources.length === 0) return; // 格式错误已记录
    const n = i + 1;
    if (qOp.get(it.op_id)) pushErr(i, 'OP_CONFLICT', `第 ${n} 条：操作号 ${it.op_id} 已存在（与现有台账冲突）`);
    if (opFirst.get(it.op_id) !== i) pushErr(i, 'OP_DUP_IN_BATCH', `第 ${n} 条：操作号 ${it.op_id} 与第 ${opFirst.get(it.op_id) + 1} 条重复`);
    if (qBottle.get(it.target)) pushErr(i, 'BOTTLE_CONFLICT', `第 ${n} 条：目标瓶编号 ${it.target} 已存在（编号冲突）`);
    if (targetFirst.get(it.target) !== i) pushErr(i, 'TARGET_DUP_IN_BATCH', `第 ${n} 条：目标瓶 ${it.target} 与第 ${targetFirst.get(it.target) + 1} 条重复`);
    for (const s of it.sources) {
      const b = qBottle.get(s.bottle);
      if (b) {
        if (it.op_time < b.created_time) {
          pushErr(i, 'TIME_BEFORE_SOURCE', `第 ${n} 条：操作时间 ${it.op_time} 早于来源瓶 ${s.bottle} 的创建时间 ${b.created_time}`);
        }
        continue;
      }
      const j = targetFirst.get(s.bottle);
      if (j === undefined) {
        pushErr(i, 'SOURCE_NOT_FOUND', `第 ${n} 条：来源瓶 ${s.bottle} 不存在（台账与批内前项中均无）`);
      } else if (j >= i) {
        pushErr(i, 'SOURCE_NOT_YET_CREATED', `第 ${n} 条：来源瓶 ${s.bottle} 由本批第 ${j + 1} 条生成，只能引用录入顺序在前的条目生成的瓶`);
      } else if (it.op_time < items[j].op_time) {
        pushErr(i, 'TIME_BEFORE_SOURCE', `第 ${n} 条：操作时间 ${it.op_time} 早于来源瓶 ${s.bottle} 的创建时间 ${items[j].op_time}（本批第 ${j + 1} 条生成）`);
      }
    }
  });
  return errMap;
}

/**
 * 模拟重放：把批次条目作为虚拟操作（虚拟入库顺序 = 当前最大 seq 之后按录入顺序
 * 连续分配，与提交时的真实行为一致）追加到当前台账末尾，按 (操作时间, 入库顺序)
 * 全量重放。excludeIdx 中的条目（格式非法、无法模拟）不参与。
 * 返回 { conflicts, projected }，projected 为受影响瓶（批内来源 ∪ 目标）的预计余量。
 */
function simulateBatch(items, excludeIdx) {
  const ledger = loadLedger();
  const baseSeq = ledger.ops.reduce((m, o) => Math.max(m, o.seq), 0);
  const vBottles = [];
  const vOps = [];
  items.forEach((it, i) => {
    if (excludeIdx.has(i)) return;
    vBottles.push({ id: it.target, kind: 'derived', initial_volume: 0 });
    vOps.push({
      op_id: it.op_id, seq: baseSeq + vOps.length + 1, target_bottle: it.target, op_time: it.op_time,
      sources: it.sources.map((s) => ({ bottle: s.bottle, volume: s.volume })),
    });
  });
  const allOps = [...ledger.ops, ...vOps].sort(cmpOps);
  const { balances, conflicts } = replayLedger([...ledger.bottles, ...vBottles], allOps);
  const affected = new Set();
  items.forEach((it, i) => {
    if (excludeIdx.has(i)) return;
    affected.add(it.target);
    for (const s of it.sources) affected.add(s.bottle);
  });
  const projected = [...affected].sort().map((id) => ({
    bottle: id,
    in_batch: vBottles.some((b) => b.id === id),
    remaining: balances.get(id) ?? 0,
  }));
  return { conflicts, projected };
}

/** 批次计划的规范化内容哈希：绑定批次号与全部条目，用于凭据与幂等判定。 */
function planHashOf(batchId, items) {
  const canonical = JSON.stringify({
    batch_id: batchId,
    items: items.map((it) => ({
      op_id: it.op_id, target_bottle: it.target, op_time: it.op_time,
      sources: it.sources.map((s) => ({ bottle: s.bottle, volume: s.volume })),
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** 提交凭据：绑定 计划哈希 + 当前台账版本，HMAC 签名防篡改。 */
function signCommitToken(version, planHash) {
  const mac = crypto.createHmac('sha256', TOKEN_SECRET).update(`v1.${version}.${planHash}`).digest('hex');
  return `v1.${version}.${planHash}.${mac}`;
}

function verifyCommitToken(token, planHash) {
  if (typeof token !== 'string' || !token) {
    throw new ApiError(400, 'TOKEN_REQUIRED', '缺少提交凭据 commit_token：请先调用 POST /api/batches/preview 预演');
  }
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new ApiError(400, 'BAD_TOKEN', '提交凭据格式无效，请重新预演获取');
  }
  const [, ver, ph, mac] = parts;
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(`v1.${ver}.${ph}`).digest('hex');
  const a = Buffer.from(mac); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(409, 'BAD_TOKEN', '提交凭据无效（可能已过期或被篡改），请重新预演');
  }
  if (ph !== planHash) {
    throw new ApiError(409, 'PLAN_CHANGED', '提交内容与预演时的计划不一致，请重新预演');
  }
  if (parseInt(ver, 10) !== ledgerVersion()) {
    throw new ApiError(409, 'STALE_TOKEN', '预演后台账已发生变化（有新登记 / 操作 / 更正 / 批次提交），预演结果已失效，请重新预演');
  }
}

/** 条目错误列表（按录入顺序），用于响应 details。 */
function itemErrorList(items, errMap) {
  return [...errMap.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([i, errors]) => ({ index: i, op_id: items[i] ? items[i].op_id : null, errors }));
}

/**
 * 提交批次（单事务）：幂等判定 → 核对凭据 → 重跑业务校验 → 落库 → 重放全账。
 * 任一环节失败整体回滚，整批不落库。
 */
const commitBatch = db.transaction((batchId, items, planHash, token) => {
  const existing = qBatch.get(batchId);
  if (existing) {
    if (existing.plan_hash === planHash) {
      return { ok: true, idempotent: true, batch_id: batchId, committed: existing.item_count,
               message: `批次 ${batchId} 已成功提交过相同内容，幂等返回，未重复扣量` };
    }
    throw new ApiError(409, 'BATCH_CONFLICT', `批次号 ${batchId} 已提交过不同内容，请更换批次号`);
  }
  verifyCommitToken(token, planHash);
  const biz = validateBatchItems(items);
  if (biz.size) {
    throw new ApiError(409, 'BATCH_ITEMS_INVALID', '批次条目校验失败，整批未提交', itemErrorList(items, biz));
  }
  qInsBatch.run(batchId, planHash, items.length, new Date().toISOString());
  items.forEach((it, i) => {
    qInsOp.run(it.op_id, qNextSeq.get().next, it.target, it.op_time);
    qInsBottle.run(it.target, 'derived', it.op_time, 0, it.op_id);
    for (const s of it.sources) qInsSource.run(it.op_id, s.bottle, s.volume);
    qInsBatchItem.run(batchId, i, it.op_id);
  });
  const { balances, conflicts } = recompute();
  if (conflicts.length) {
    const opToIdx = new Map(items.map((it, i) => [it.op_id, i]));
    throw new ApiError(409, 'OVERDRAW', '批次重放全账后出现超用，整批已回滚，数据未变更',
      conflicts.map((c) => ({ index: opToIdx.has(c.op_id) ? opToIdx.get(c.op_id) : null, ...c })));
  }
  qBumpVersion.run();
  const affected = new Set();
  for (const it of items) { affected.add(it.target); for (const s of it.sources) affected.add(s.bottle); }
  return {
    ok: true, idempotent: false, batch_id: batchId, committed: items.length,
    projected_balances: [...affected].sort().map((id) => ({ bottle: id, remaining: balances.get(id) ?? 0 })),
    message: `批次 ${batchId} 已提交：${items.length} 条操作已登记，相关瓶余量已重算`,
  };
});

// ---------------------------------------------------------------- 谱系查询

/** 完整来源谱系（向上递归到原始瓶），带深度保护。 */
function lineage(bottleId, depth = 0) {
  if (depth > 100) return { bottle: bottleId, truncated: true };
  const op = db.prepare('SELECT * FROM operations WHERE target_bottle = ?').get(bottleId);
  if (!op) return { bottle: bottleId, original: true };
  const srcs = qOpSources.all(op.op_id);
  return {
    bottle: bottleId,
    op: { op_id: op.op_id, op_time: op.op_time },
    sources: srcs.map((s) => ({ volume: s.volume, node: lineage(s.source_bottle, depth + 1) })),
  };
}

function opsInvolving(bottleId) {
  const asTarget = db.prepare('SELECT * FROM operations WHERE target_bottle = ?').all(bottleId);
  const asSource = db.prepare(`
    SELECT o.*, s.volume AS drawn_volume FROM operations o
    JOIN operation_sources s ON s.op_id = o.op_id
    WHERE s.source_bottle = ?`).all(bottleId);
  return { as_target: asTarget, as_source: asSource };
}

// ---------------------------------------------------------------- HTTP 层

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e instanceof ApiError) {
      return res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
    }
    console.error(e);
    res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  }
};

/** 登记原始瓶（事务）：提交后台账版本递增，已发放的批次凭据随之失效。 */
const createBottle = db.transaction((id, t, v) => {
  if (qBottle.get(id)) throw new ApiError(409, 'BOTTLE_CONFLICT', `瓶编号 ${id} 已存在（编号冲突）`);
  qInsBottle.run(id, 'original', t, v, null);
  qBumpVersion.run();
  return { ok: true, message: `原始瓶 ${id} 已登记` };
});

app.post('/api/bottles', wrap((req, res) => {
  const id = normId(req.body.bottle_id, '瓶编号');
  const t = normTime(req.body.sample_time, '采样时间');
  const v = normVolume(req.body.initial_volume, '初始体积');
  res.status(201).json(createBottle(id, t, v));
}));

app.post('/api/operations', wrap((req, res) => {
  const p = {
    op_id: normId(req.body.op_id, '操作号'),
    target: normId(req.body.target_bottle, '目标瓶编号'),
    op_time: normTime(req.body.op_time, '操作时间'),
    sources: parseSources(req.body.sources),
  };
  const result = createOperation(p);
  res.status(result.idempotent ? 200 : 201).json(result);
}));

app.post('/api/operations/:opId/correct', wrap((req, res) => {
  const sources = parseSources(req.body.sources);
  res.json(correctOperation(req.params.opId, sources));
}));

app.get('/api/bottles', wrap((req, res) => {
  const { balances } = recompute();
  const rows = db.prepare('SELECT * FROM bottles ORDER BY created_time, id').all()
    .map((b) => ({ ...b, remaining: balances.get(b.id) ?? 0 }));
  res.json(rows);
}));

app.get('/api/bottles/:id', wrap((req, res) => {
  const b = qBottle.get(req.params.id);
  if (!b) throw new ApiError(404, 'BOTTLE_NOT_FOUND', `瓶 ${req.params.id} 不存在`);
  const { balances } = recompute();
  res.json({ ...b, remaining: balances.get(b.id) ?? 0, lineage: lineage(b.id), operations: opsInvolving(b.id) });
}));

app.get('/api/operations', wrap((req, res) => {
  const ops = db.prepare(`
    SELECT o.*, bi.batch_id AS batch_id FROM operations o
    LEFT JOIN batch_items bi ON bi.op_id = o.op_id
    ORDER BY o.op_time, o.seq`).all();
  const srcs = db.prepare('SELECT * FROM operation_sources ORDER BY source_bottle').all();
  const byOp = {};
  for (const s of srcs) (byOp[s.op_id] = byOp[s.op_id] || []).push({ bottle: s.source_bottle, volume: s.volume });
  res.json(ops.map((o) => {
    const list = byOp[o.op_id] || [];
    return { ...o, sources: list, total: list.reduce((a, s) => a + s.volume, 0) };
  }));
}));

// ---------------------------------------------------------------- 批次 HTTP 接口

/**
 * 批次预演（不写库）：逐条可行性 + 受影响瓶预计余量 + 提交凭据。
 * 凭据绑定 批次计划哈希 与 当前台账版本；全部条目通过才发放。
 */
app.post('/api/batches/preview', wrap((req, res) => {
  const batchId = normId(req.body.batch_id, '批次号');
  const rawItems = req.body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiError(400, 'NO_ITEMS', '批次至少需要一条操作（items 为非空数组）');
  }
  const { items, itemErrors } = normalizeBatchItems(rawItems);
  const topErrors = [];
  const planHash = planHashOf(batchId, items);
  const existing = qBatch.get(batchId);
  if (existing) {
    topErrors.push(existing.plan_hash === planHash
      ? { code: 'BATCH_ALREADY_COMMITTED', message: `批次号 ${batchId} 已成功提交过相同内容，重复提交将幂等返回，不会重复扣量` }
      : { code: 'BATCH_CONFLICT', message: `批次号 ${batchId} 已提交过不同内容，请更换批次号` });
  }
  // 业务校验（编号冲突 / 来源存在性 / 时间先后），与提交共用同一实现
  const biz = validateBatchItems(items);
  for (const [i, errs] of biz) {
    if (!itemErrors.has(i)) itemErrors.set(i, []);
    itemErrors.get(i).push(...errs);
  }
  // 模拟重放：格式非法的条目无法参与，其余条目按计划追加到当前台账末尾
  const brokenIdx = new Set([...itemErrors.keys()].filter((i) => !items[i].op_id || !items[i].op_time || !items[i].target));
  const sim = simulateBatch(items, brokenIdx);
  const opToIdx = new Map();
  items.forEach((it, i) => { if (it.op_id && !opToIdx.has(it.op_id)) opToIdx.set(it.op_id, i); });
  for (const c of sim.conflicts) {
    const err = { code: 'OVERDRAW', message: `超用：从瓶 ${c.bottle} 需取 ${c.requested} mL，该时刻可用仅 ${c.available} mL` };
    if (opToIdx.has(c.op_id)) {
      const i = opToIdx.get(c.op_id);
      if (!itemErrors.has(i)) itemErrors.set(i, []);
      itemErrors.get(i).push(err);
    } else {
      topErrors.push({ code: 'LEDGER_CONFLICT', message: `现有台账操作 ${c.op_id} 从瓶 ${c.bottle} 需取 ${c.requested} mL，可用仅 ${c.available} mL` });
    }
  }
  const itemResults = items.map((it, i) => ({
    index: i, op_id: it.op_id, ok: !itemErrors.has(i), errors: itemErrors.get(i) || [],
  }));
  const ok = topErrors.length === 0 && itemResults.every((r) => r.ok);
  const version = ledgerVersion();
  res.json({
    ok,
    batch_id: batchId,
    plan_hash: planHash,
    ledger_version: version,
    errors: topErrors,
    items: itemResults,
    projected_balances: sim.projected,
    commit_token: ok ? signCommitToken(version, planHash) : null,
    message: ok
      ? `预演通过：批次 ${batchId} 共 ${items.length} 条操作可提交；凭据已绑定当前台账（版本 ${version}），提交前若台账变化需重新预演`
      : '预演未通过：请修正下列问题后重新预演（未写入任何数据）',
  });
}));

/**
 * 批次提交（单事务，整批落库或整体回滚）：
 * 相同批次号 + 相同内容 → 幂等返回（200）；相同批次号 + 不同内容 → 409。
 */
app.post('/api/batches/commit', wrap((req, res) => {
  const batchId = normId(req.body.batch_id, '批次号');
  const rawItems = req.body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiError(400, 'NO_ITEMS', '批次至少需要一条操作（items 为非空数组）');
  }
  const { items, itemErrors } = normalizeBatchItems(rawItems);
  if (itemErrors.size) {
    throw new ApiError(400, 'BATCH_ITEMS_INVALID', '批次条目存在格式错误，整批未提交', itemErrorList(items, itemErrors));
  }
  const result = commitBatch(batchId, items, planHashOf(batchId, items), req.body.commit_token);
  res.status(result.idempotent ? 200 : 201).json(result);
}));

app.get('/api/batches', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM batches ORDER BY committed_at, batch_id').all());
}));

app.get('/api/batches/:batchId', wrap((req, res) => {
  const b = qBatch.get(req.params.batchId);
  if (!b) throw new ApiError(404, 'BATCH_NOT_FOUND', `批次 ${req.params.batchId} 不存在`);
  const items = db.prepare(`
    SELECT bi.idx, o.op_id, o.target_bottle, o.op_time
    FROM batch_items bi JOIN operations o ON o.op_id = bi.op_id
    WHERE bi.batch_id = ? ORDER BY bi.idx`).all(b.batch_id)
    .map((r) => ({
      index: r.idx, op_id: r.op_id, target_bottle: r.target_bottle, op_time: r.op_time,
      sources: qOpSources.all(r.op_id).map((s) => ({ bottle: s.source_bottle, volume: s.volume })),
    }));
  res.json({ ...b, items });
}));

// ---------------------------------------------------------------- 初始化数据

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM bottles').get().c > 0) return;
  db.transaction(() => {
    qInsBottle.run('W2026-001', 'original', '2026-09-30T08:00:00', 1000, null);
    qInsBottle.run('W2026-002', 'original', '2026-09-30T09:00:00', 800, null);
    qInsBottle.run('W2026-003', 'original', '2026-10-01T08:30:00', 500, null);

    qInsOp.run('OP-0001', 1, 'MIX-001', '2026-10-01T10:00:00');
    qInsBottle.run('MIX-001', 'derived', '2026-10-01T10:00:00', 0, 'OP-0001');
    qInsSource.run('OP-0001', 'W2026-001', 200);
    qInsSource.run('OP-0001', 'W2026-002', 150);

    qInsOp.run('OP-0002', 2, 'ALQ-001', '2026-10-02T09:00:00');
    qInsBottle.run('ALQ-001', 'derived', '2026-10-02T09:00:00', 0, 'OP-0002');
    qInsSource.run('OP-0002', 'MIX-001', 100);

    qBumpVersion.run();
  })();
  console.log('[init] 数据库为空，已写入示例数据（3 个原始瓶 + 2 条操作）');
}

seed();

const server = app.listen(PORT, () => {
  console.log(`水质实验室样本溯源工作台已启动: http://localhost:${PORT}`);
  console.log(`数据库文件: ${DB_PATH}`);
});

process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
process.on('SIGINT', () => server.close(() => { db.close(); process.exit(0); }));
