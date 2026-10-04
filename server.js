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
 *
 * 批次（连续分装 / 混样）：
 *  - POST /api/batches/preview 仅预演：逐条可行性 + 受影响瓶预计余量 + 提交凭据，不写库。
 *  - POST /api/batches/commit   在一个事务内核验凭据、重放全账、整批落库或整批拒绝。
 *  - 批内可引用前项（录入顺序在前）生成的瓶；同时间按录入顺序入库。
 *  - 已提交批次相同内容重复提交 → 幂等返回；同批次号不同内容 → 409。
 *  - 凭据绑定计划内容与当前台账，台账变化后凭据失效，须重新预演。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lab.db');

// 凭据有效期（毫秒）。凭据为签名令牌，不写库；进程重启后旧凭据失效，需重新预演。
const PREVIEW_TTL_MS = parseInt(process.env.PREVIEW_TTL_MS || String(30 * 60 * 1000), 10);
const MAX_BATCH_ENTRIES = 500;
const MAX_SOURCES_PER_ENTRY = 100;

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
  op_time       TEXT NOT NULL,
  batch_id      TEXT                            -- 批次号；单条登记为 NULL
);
CREATE TABLE IF NOT EXISTS operation_sources (
  op_id         TEXT NOT NULL REFERENCES operations(op_id) ON DELETE CASCADE,
  source_bottle TEXT NOT NULL,
  volume        INTEGER NOT NULL CHECK (volume > 0),
  PRIMARY KEY (op_id, source_bottle)            -- 同一操作内来源不得重复
);
CREATE TABLE IF NOT EXISTS batches (
  batch_id      TEXT PRIMARY KEY,               -- 已成功提交的批次
  plan_digest   TEXT NOT NULL,                  -- 提交时的计划内容指纹
  ledger_digest TEXT NOT NULL,                  -- 提交所基于的台账指纹
  entry_count   INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_sources_bottle ON operation_sources(source_bottle);
CREATE INDEX IF NOT EXISTS idx_operations_target ON operations(target_bottle);
`);

// 兼容旧库：为既有 operations 表补 batch_id 列（须在批次相关索引之前）
if (!db.prepare('PRAGMA table_info(operations)').all().some((c) => c.name === 'batch_id')) {
  db.exec('ALTER TABLE operations ADD COLUMN batch_id TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_operations_batch ON operations(batch_id);');

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
const qAllBottles = db.prepare('SELECT * FROM bottles ORDER BY id');
const qInsBottle  = db.prepare('INSERT INTO bottles (id, kind, created_time, initial_volume, created_op) VALUES (?, ?, ?, ?, ?)');
const qOp         = db.prepare('SELECT * FROM operations WHERE op_id = ?');
const qAllOps     = db.prepare('SELECT op_id, seq, target_bottle, op_time, batch_id FROM operations ORDER BY op_id');
const qInsOp      = db.prepare('INSERT INTO operations (op_id, seq, target_bottle, op_time, batch_id) VALUES (?, ?, ?, ?, ?)');
const qNextSeq    = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM operations');
const qOpSources  = db.prepare('SELECT source_bottle, volume FROM operation_sources WHERE op_id = ? ORDER BY source_bottle');
const qAllSources = db.prepare('SELECT op_id, source_bottle, volume FROM operation_sources ORDER BY op_id, source_bottle');
const qInsSource  = db.prepare('INSERT INTO operation_sources (op_id, source_bottle, volume) VALUES (?, ?, ?)');
const qDelSources = db.prepare('DELETE FROM operation_sources WHERE op_id = ?');
const qBatch      = db.prepare('SELECT * FROM batches WHERE batch_id = ?');
const qInsBatch   = db.prepare('INSERT INTO batches (batch_id, plan_digest, ledger_digest, entry_count, created_at) VALUES (?, ?, ?, ?, ?)');

// ------------------------------------------------------- 台账重放（守恒校验）

/**
 * 按 (操作时间, 入库顺序) 重放全部操作，计算每个瓶的余量。
 * 任一取用使余量为负即记录冲突；冲突瓶按 0 继续推演，以便后续冲突的
 * “可用量”仍然可读。返回 { balances, conflicts }。
 */
function recompute() {
  const balances = new Map();
  for (const b of qAllBottles.all()) {
    if (b.kind === 'original') balances.set(b.id, b.initial_volume);
  }
  const ops = db.prepare('SELECT op_id, target_bottle FROM operations ORDER BY op_time, seq').all();
  const conflicts = [];
  for (const op of ops) {
    const srcs = qOpSources.all(op.op_id);
    let total = 0;
    for (const s of srcs) {
      const avail = balances.get(s.source_bottle) || 0;
      if (s.volume > avail) {
        conflicts.push({ op_id: op.op_id, bottle: s.source_bottle, requested: s.volume, available: avail });
        balances.set(s.source_bottle, 0);
      } else {
        balances.set(s.source_bottle, avail - s.volume);
      }
      total += s.volume;
    }
    balances.set(op.target_bottle, (balances.get(op.target_bottle) || 0) + total);
  }
  return { balances, conflicts };
}

// ------------------------------------------------- 指纹、凭据（HMAC 签名令牌）

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 计划内容的规范化串：同一批次号 + 逐条（按录入顺序）的
 * 操作号/目标瓶/操作时间/来源（瓶=体积，按录入顺序）。
 * 仅做 trim，不做时间/数值归一化，保证与客户端回传的原始输入逐字对应。
 */
function canonicalPlan(batchId, rawOps) {
  const lines = [String(batchId || '').trim()];
  for (const o of rawOps) {
    const srcs = Array.isArray(o && o.sources)
      ? o.sources.map((s) => `${String(s && s.bottle != null ? s.bottle : '').trim()}=${String(s && s.volume != null ? s.volume : '').trim()}`)
      : [];
    lines.push([
      String(o && o.op_id != null ? o.op_id : '').trim(),
      String(o && o.target_bottle != null ? o.target_bottle : '').trim(),
      String(o && o.op_time != null ? o.op_time : '').trim(),
      srcs.join(','),
    ].join('|'));
  }
  return lines.join('\n');
}

function planDigest(batchId, rawOps) {
  return sha256(canonicalPlan(batchId, rawOps));
}

/** 当前台账（瓶 / 操作 / 来源）的内容指纹；任一处变化都会改变。 */
function ledgerDigest() {
  const parts = [];
  for (const b of qAllBottles.all()) {
    parts.push(`B|${b.id}|${b.kind}|${b.created_time}|${b.initial_volume}|${b.created_op || ''}`);
  }
  for (const o of qAllOps.all()) {
    parts.push(`O|${o.op_id}|${o.seq}|${o.target_bottle}|${o.op_time}|${o.batch_id || ''}`);
  }
  for (const s of qAllSources.all()) {
    parts.push(`S|${s.op_id}|${s.source_bottle}|${s.volume}`);
  }
  return sha256(parts.join('\n'));
}

// 进程级签名密钥；重启后此前下发的凭据作废（提交时要求重新预演）
const TOKEN_SECRET = process.env.PREVIEW_SECRET
  ? Buffer.from(process.env.PREVIEW_SECRET, 'utf8')
  : crypto.randomBytes(32);

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(data) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(data, 'utf8').digest();
}

/** 签发提交凭据：绑定 批次号 + 计划指纹 + 台账指纹 + 过期时间。 */
function issueCredential(batchId, pDigest, lDigest) {
  const payload = { b: batchId, p: pDigest, l: lDigest, exp: Date.now() + PREVIEW_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  return { token: `${body}.${b64url(hmac(body))}`, expires_at: new Date(payload.exp).toISOString() };
}

/** 校验凭据签名与有效期；返回 payload。任何异常统一抛 STALE_PREVIEW。 */
function verifyCredential(token) {
  let payload;
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) throw new Error('bad token');
    const expect = b64url(hmac(body));
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad sig');
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) {
    throw new ApiError(409, 'STALE_PREVIEW', '提交凭据无效，请重新预演后再提交');
  }
  if (!payload.exp || Date.now() > payload.exp) {
    throw new ApiError(409, 'STALE_PREVIEW', '预演已过期，请重新预演后再提交');
  }
  return payload;
}

// ----------------------------------------------------------- 批次预演（纯内存）

/**
 * 对整批计划做逐条校验与全账重放，不写入数据库。
 *
 * 逐条问题（issue）按条目收集，不因首条错误中断：
 *  BAD_FIELD / NO_SOURCES / DUP_SOURCE        非法字段、缺失/重复来源
 *  OP_ID_CONFLICT                             批内重复操作号或与现有操作号冲突
 *  BOTTLE_CONFLICT                            目标瓶批内重复或与现有瓶冲突
 *  SOURCE_NOT_FOUND                           来源缺失（含引用后项/自身将生成的瓶）
 *  TIME_BEFORE_SOURCE                         操作时间早于来源瓶创建时间
 *  OVERDRAW                                   全账重放中某时刻超用
 *
 * 返回 { entries, affected, conflicts, viable, baseBalances, projectedBalances }。
 */
function simulateBatch(rawOps) {
  const existingBottles = new Map(qAllBottles.all().map((b) => [b.id, b]));
  const existingOps = new Map(qAllOps.all().map((o) => [o.op_id, o]));

  // ---- 第 1 步：逐条解析字段（错误收集，不抛异常）----
  const entries = rawOps.map((raw, i) => {
    const e = {
      index: i + 1,
      raw,
      op_id: null,
      target: null,
      op_time: null,
      sources: [],
      total: 0,
      issues: [],
    };
    const add = (code, message, extra) => e.issues.push(Object.assign({ code, message }, extra || {}));

    try { e.op_id = normId(raw && raw.op_id, '操作号'); }
    catch (err) { add(err.code, err.message); }

    try { e.target = normId(raw && raw.target_bottle, '目标瓶编号'); }
    catch (err) { add(err.code, err.message); }

    try { e.op_time = normTime(raw && raw.op_time, '操作时间'); }
    catch (err) { add(err.code, err.message); }

    if (!Array.isArray(raw && raw.sources) || raw.sources.length === 0) {
      add('NO_SOURCES', `第 ${i + 1} 条至少需要一个来源瓶`);
    } else if (raw.sources.length > MAX_SOURCES_PER_ENTRY) {
      add('NO_SOURCES', `第 ${i + 1} 条来源瓶数量超过上限 ${MAX_SOURCES_PER_ENTRY}`);
    } else {
      const seen = new Set();
      raw.sources.forEach((s, j) => {
        let bottle = null;
        let volume = null;
        try { bottle = normId(s && s.bottle, '来源瓶编号'); }
        catch (err) { add(err.code, `第 ${i + 1} 条第 ${j + 1} 行来源：${err.message}`); }
        try { volume = normVolume(s && s.volume, '取用体积'); }
        catch (err) { add(err.code, `第 ${i + 1} 条第 ${j + 1} 行体积：${err.message}`); }
        if (bottle) {
          if (seen.has(bottle)) add('DUP_SOURCE', `第 ${i + 1} 条内来源瓶 ${bottle} 重复`);
          seen.add(bottle);
        }
        if (bottle && volume !== null) e.sources.push({ bottle, volume });
      });
    }
    e.total = e.sources.reduce((a, s) => a + s.volume, 0);
    return e;
  });

  // ---- 第 2 步：批内编号冲突 + 虚拟瓶（前项生成的瓶）注册表 ----
  const seenOpIds = new Map();
  const seenTargets = new Map();
  /** 虚拟瓶：批内将生成的瓶 → { created_time, creatorIndex } */
  const virtualBottles = new Map();

  entries.forEach((e) => {
    if (e.op_id) {
      if (existingOps.has(e.op_id)) {
        e.issues.push({ code: 'OP_ID_CONFLICT', message: `操作号 ${e.op_id} 已存在于当前台账（编号冲突）` });
      } else if (seenOpIds.has(e.op_id)) {
        e.issues.push({ code: 'OP_ID_CONFLICT', message: `操作号 ${e.op_id} 在批内第 ${seenOpIds.get(e.op_id)} 条已使用（批内编号冲突）` });
      } else {
        seenOpIds.set(e.op_id, e.index);
      }    }
    if (e.target) {
      if (existingBottles.has(e.target)) {
        e.issues.push({ code: 'BOTTLE_CONFLICT', message: `目标瓶 ${e.target} 已存在于当前台账（编号冲突）` });
      } else if (seenTargets.has(e.target)) {
        e.issues.push({ code: 'BOTTLE_CONFLICT', message: `目标瓶 ${e.target} 在批内第 ${seenTargets.get(e.target)} 条已作为目标瓶（批内编号冲突）` });
      } else {
        seenTargets.set(e.target, e.index);
        // 操作号/目标/时间均合法时登记为可供后项引用的虚拟瓶
        if (e.op_id && e.op_time) virtualBottles.set(e.target, { created_time: e.op_time, creatorIndex: e.index });
      }
    }
  });

  // ---- 第 3 步：来源存在性（现有瓶或前项虚拟瓶）与时间约束 ----
  const base = recompute(); // 当前真实台账的余量（仅含现有操作）
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM operations').get().m;

  /** 可否纳入预演重放：所有结构性条件满足（时间早于来源的问题仍参与重放，由重放暴露超用） */
  entries.forEach((e) => {
    const structurallyClean = e.issues.length === 0;
    if (!structurallyClean) { e.replayable = false; return; }

    for (const s of e.sources) {
      const real = existingBottles.get(s.bottle);
      const virt = virtualBottles.get(s.bottle);
      if (real) {
        if (e.op_time < real.created_time) {
          e.issues.push({
            code: 'TIME_BEFORE_SOURCE',
            message: `操作时间 ${e.op_time} 早于来源瓶 ${s.bottle} 的创建时间 ${real.created_time}`,
            bottle: s.bottle, created_time: real.created_time,
          });
        }
      } else if (virt) {
        // 仅可引用“前项”生成的瓶（录入顺序严格在前）
        if (virt.creatorIndex >= e.index) {
          e.issues.push({
            code: 'SOURCE_NOT_FOUND',
            message: `来源瓶 ${s.bottle} 尚不存在：它由批内第 ${virt.creatorIndex} 条生成，仅可被其后条目引用`,
            bottle: s.bottle,
          });
        } else if (e.op_time < virt.created_time) {
          e.issues.push({
            code: 'TIME_BEFORE_SOURCE',
            message: `操作时间 ${e.op_time} 早于来源瓶 ${s.bottle} 的创建时间 ${virt.created_time}（批内第 ${virt.creatorIndex} 条）`,
            bottle: s.bottle, created_time: virt.created_time,
          });
        }
      } else {
        e.issues.push({ code: 'SOURCE_NOT_FOUND', message: `来源瓶 ${s.bottle} 不存在（台账与批内前项均无此瓶）`, bottle: s.bottle });
      }
    }
    // 来源缺失则无法可靠参与重放；仅“时间早于来源”仍参与，以暴露任一时刻超用
    e.replayable = !e.issues.some((x) => x.code === 'SOURCE_NOT_FOUND');
  });

  // ---- 第 4 步：合并现有操作 + 批内可重放条目，按 (时间, 入库顺序) 重放 ----
  const replayOps = [];
  for (const o of qAllOps.all()) replayOps.push({ key: o.op_id, op_id: o.op_id, target: o.target_bottle, time: o.op_time, seq: o.seq, entry: null });
  entries.forEach((e) => {
    if (!e.replayable) return;
    replayOps.push({
      key: e.index, op_id: e.op_id, target: e.target, time: e.op_time,
      // 批内条目排在所有现有 seq 之后；同时间批内依录入顺序
      seq: maxSeq + e.index, entry: e.index,
    });
  });
  replayOps.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.seq - b.seq));

  const balances = new Map();
  for (const b of qAllBottles.all()) if (b.kind === 'original') balances.set(b.id, b.initial_volume);

  const conflicts = [];
  const srcByOp = new Map();
  for (const s of qAllSources.all()) {
    if (!srcByOp.has(s.op_id)) srcByOp.set(s.op_id, []);
    srcByOp.get(s.op_id).push(s);
  }

  for (const op of replayOps) {
    // 批内条目的来源键为 bottle；现有台账来源键为 source_bottle
    const rawSrcs = op.entry
      ? entries[op.entry - 1].sources
      : (srcByOp.get(op.key) || []);
    const srcs = rawSrcs.map((s) => ({ bottle: s.bottle !== undefined ? s.bottle : s.source_bottle, volume: s.volume }));
    let total = 0;
    for (const s of srcs) {
      const avail = balances.get(s.bottle) ?? 0;
      if (s.volume > avail) {
        const c = { op_id: op.op_id, bottle: s.bottle, requested: s.volume, available: avail, entry_index: op.entry };
        conflicts.push(c);
        if (op.entry) {
          entries[op.entry - 1].issues.push({
            code: 'OVERDRAW',
            message: `第 ${op.entry} 条在 ${op.time} 从瓶 ${s.bottle} 取 ${s.volume} mL，该时刻可用仅 ${avail} mL（超用）`,
            bottle: s.bottle, requested: s.volume, available: avail, at_time: op.time,
          });
        }
        balances.set(s.bottle, 0);
      } else {
        balances.set(s.bottle, avail - s.volume);
      }
      total += s.volume;
    }
    balances.set(op.target, (balances.get(op.target) || 0) + total);
  }

  // ---- 第 5 步：受影响瓶（批内涉及）的 当前余量 vs 预计余量 ----
  const affectedSet = new Set();
  for (const e of entries) {
    if (!e.replayable) continue;
    affectedSet.add(e.target);
    for (const s of e.sources) affectedSet.add(s.bottle);
  }
  const kindOf = (id) => (existingBottles.get(id) ? existingBottles.get(id).kind : virtualBottles.has(id) ? 'derived' : null);
  const affected = [...affectedSet].sort().map((id) => ({
    bottle: id,
    kind: kindOf(id),
    current_remaining: base.balances.get(id) ?? (existingBottles.has(id) ? 0 : null),
    projected_remaining: balances.get(id) ?? 0,
  }));

  const viable = entries.length > 0 && entries.every((e) => e.issues.length === 0);
  return {
    entries,
    affected,
    conflicts,
    viable,
    baseBalances: base.balances,
    projectedBalances: balances,
  };
}

/** 预演结果对外的条目形状 */
function entryView(e) {
  return {
    index: e.index,
    op_id: e.op_id,
    target_bottle: e.target,
    op_time: e.op_time,
    sources: e.sources,
    total: e.total,
    viable: e.issues.length === 0,
    issues: e.issues,
  };
}

function runPreview(batchId, rawOps) {
  const sim = simulateBatch(rawOps);
  const pDigest = planDigest(batchId, rawOps);
  const lDigest = ledgerDigest();
  const credential = issueCredential(batchId, pDigest, lDigest);
  return {
    batch_id: batchId,
    entry_count: sim.entries.length,
    viable: sim.viable,
    issue_count: sim.entries.reduce((a, e) => a + e.issues.length, 0),
    credential: { token: credential.token, plan_digest: pDigest, ledger_digest: lDigest, expires_at: credential.expires_at },
    entries: sim.entries.map(entryView),
    affected_bottles: sim.affected,
    message: sim.viable
      ? `预演通过：${sim.entries.length} 条操作全部可行，凭据 ${Math.round(PREVIEW_TTL_MS / 60000)} 分钟内有效，未写入任何数据`
      : '预演未通过：以下条目存在问题，整批将不会落库；修正后请重新预演',
  };
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
  qInsOp.run(p.op_id, qNextSeq.get().next, p.target, p.op_time, null);
  qInsBottle.run(p.target, 'derived', p.op_time, 0, p.op_id);
  for (const s of p.sources) qInsSource.run(p.op_id, s.bottle, s.volume);

  const { conflicts } = recompute();
  if (conflicts.length) {
    throw new ApiError(409, 'OVERDRAW', '取用量超过来源瓶可用余量，操作已拒绝，数据未变更', conflicts);
  }
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
  return { ok: true, message: `操作 ${opId} 的取用量已更正，相关瓶余量已按操作顺序重算` };
});

/**
 * 批次提交（事务）：
 *  1) 同批次号已提交且计划一致 → 幂等返回，不再扣量；计划不一致 → 409。
 *  2) 核验凭据（签名 / 有效期 / 批次号 / 计划指纹 / 台账指纹）。
 *  3) 重放全账复核；任一条目不可行 → 整批拒绝，不落库。
 *  4) 按录入顺序分配入库 seq 并写入操作、衍生瓶、来源与批次记录。
 */
const commitBatch = db.transaction((batchId, rawOps, token) => {
  const pDigest = planDigest(batchId, rawOps);
  const known = qBatch.get(batchId);
  if (known) {
    if (known.plan_digest === pDigest) {
      return {
        ok: true, idempotent: true, batch_id: batchId, entry_count: known.entry_count,
        message: `批次 ${batchId} 已成功提交过相同内容，幂等返回，未重复扣量`,
      };
    }
    throw new ApiError(409, 'BATCH_CONFLICT',
      `批次号 ${batchId} 已用于另一份不同内容的计划，同批次号不允许不同内容`);
  }

  const cred = verifyCredential(token);
  if (cred.b !== batchId || cred.p !== pDigest) {
    throw new ApiError(409, 'STALE_PREVIEW', '提交凭据与本次批次号或计划内容不匹配，请重新预演');
  }
  if (cred.l !== ledgerDigest()) {
    throw new ApiError(409, 'LEDGER_CHANGED',
      '预演之后计划所基于的台账（瓶 / 操作 / 来源）已变化，请重新预演后再提交');
  }

  const sim = simulateBatch(rawOps);
  if (!sim.viable) {
    throw new ApiError(409, 'BATCH_REJECTED',
      '批次中存在不可行条目，整批未落库（无任何数据变更）',
      sim.entries.filter((e) => e.issues.length).map(entryView));
  }

  const baseDigest = ledgerDigest();
  let seq = qNextSeq.get().next;
  const created = [];
  for (const e of sim.entries) {
    qInsOp.run(e.op_id, seq++, e.target, e.op_time, batchId);
    qInsBottle.run(e.target, 'derived', e.op_time, 0, e.op_id);
    for (const s of e.sources) qInsSource.run(e.op_id, s.bottle, s.volume);
    created.push({ index: e.index, op_id: e.op_id, target_bottle: e.target });
  }

  // 落库后以真实全账再核一遍守恒（与凭据双重保险）
  const { conflicts } = recompute();
  if (conflicts.length) {
    throw new ApiError(409, 'OVERDRAW', '批次提交复核时发现超用，整批已回滚，数据未变更', conflicts);
  }

  qInsBatch.run(batchId, pDigest, baseDigest, sim.entries.length, new Date().toISOString());
  return {
    ok: true, idempotent: false, batch_id: batchId, entry_count: sim.entries.length,
    entries: created,
    message: `批次 ${batchId} 已整批提交：${sim.entries.length} 条操作已登记，余量与谱系即时可查`,
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
app.use(express.json({ limit: '2mb' }));
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

/** 解析批次请求公共部分：批次号 + 按录入顺序排列的 operations */
function readBatchBody(body) {
  const batchId = normId(body && body.batch_id, '批次号');
  const rawOps = body && body.operations;
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw new ApiError(400, 'NO_OPERATIONS', '批次至少需要一条操作（operations 必须为非空数组，按录入顺序排列）');
  }
  if (rawOps.length > MAX_BATCH_ENTRIES) {
    throw new ApiError(400, 'TOO_MANY_ENTRIES', `单次批次不得超过 ${MAX_BATCH_ENTRIES} 条操作`);
  }
  return { batchId, rawOps };
}

app.post('/api/bottles', wrap((req, res) => {
  const id = normId(req.body.bottle_id, '瓶编号');
  const t = normTime(req.body.sample_time, '采样时间');
  const v = normVolume(req.body.initial_volume, '初始体积');
  if (qBottle.get(id)) throw new ApiError(409, 'BOTTLE_CONFLICT', `瓶编号 ${id} 已存在（编号冲突）`);
  qInsBottle.run(id, 'original', t, v, null);
  res.status(201).json({ ok: true, message: `原始瓶 ${id} 已登记` });
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

// ---- 批次：预演（不写库）----
app.post('/api/batches/preview', wrap((req, res) => {
  const { batchId, rawOps } = readBatchBody(req.body);
  res.json(runPreview(batchId, rawOps));
}));

// ---- 批次：提交（事务内核验凭据并重放全账）----
app.post('/api/batches/commit', wrap((req, res) => {
  const { batchId, rawOps } = readBatchBody(req.body);
  const token = req.body && req.body.credential && req.body.credential.token;
  if (typeof token !== 'string' || !token) {
    throw new ApiError(400, 'NO_CREDENTIAL', '缺少提交凭据 credential.token，请先调用预演接口');
  }
  const result = commitBatch(batchId, rawOps, token);
  res.status(result.idempotent ? 200 : 201).json(result);
}));

// ---- 批次：查询 ----
app.get('/api/batches', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM batches ORDER BY created_at, batch_id').all();
  const countOps = db.prepare('SELECT COUNT(*) AS c FROM operations WHERE batch_id = ?');
  res.json(rows.map((r) => ({ ...r, operation_count: countOps.get(r.batch_id).c })));
}));

app.get('/api/batches/:id', wrap((req, res) => {
  const batch = qBatch.get(req.params.id);
  if (!batch) throw new ApiError(404, 'BATCH_NOT_FOUND', `批次 ${req.params.id} 不存在`);
  const ops = db.prepare('SELECT * FROM operations WHERE batch_id = ? ORDER BY seq').all(req.params.id);
  const result = { ...batch, operations: [] };
  for (const o of ops) {
    const list = qOpSources.all(o.op_id).map((s) => ({ bottle: s.source_bottle, volume: s.volume }));
    result.operations.push({
      index: result.operations.length + 1,
      op_id: o.op_id, target_bottle: o.target_bottle, op_time: o.op_time,
      sources: list, total: list.reduce((a, s) => a + s.volume, 0),
    });
  }
  res.json(result);
}));

app.get('/api/bottles', wrap((req, res) => {
  const { balances } = recompute();
  const rows = qAllBottles.all()
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
  const ops = db.prepare('SELECT * FROM operations ORDER BY op_time, seq').all();
  const srcs = qAllSources.all();
  const byOp = {};
  for (const s of srcs) (byOp[s.op_id] = byOp[s.op_id] || []).push({ bottle: s.source_bottle, volume: s.volume });
  res.json(ops.map((o) => {
    const list = byOp[o.op_id] || [];
    return { ...o, sources: list, total: list.reduce((a, s) => a + s.volume, 0) };
  }));
}));

// ---------------------------------------------------------------- 初始化数据

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM bottles').get().c > 0) return;
  db.transaction(() => {
    qInsBottle.run('W2026-001', 'original', '2026-09-30T08:00:00', 1000, null);
    qInsBottle.run('W2026-002', 'original', '2026-09-30T09:00:00', 800, null);
    qInsBottle.run('W2026-003', 'original', '2026-10-01T08:30:00', 500, null);

    qInsOp.run('OP-0001', 1, 'MIX-001', '2026-10-01T10:00:00', null);
    qInsBottle.run('MIX-001', 'derived', '2026-10-01T10:00:00', 0, 'OP-0001');
    qInsSource.run('OP-0001', 'W2026-001', 200);
    qInsSource.run('OP-0001', 'W2026-002', 150);

    qInsOp.run('OP-0002', 2, 'ALQ-001', '2026-10-02T09:00:00', null);
    qInsBottle.run('ALQ-001', 'derived', '2026-10-02T09:00:00', 0, 'OP-0002');
    qInsSource.run('OP-0002', 'MIX-001', 100);
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
