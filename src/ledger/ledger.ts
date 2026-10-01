// 事件溯源本地账本：意图记录 -> CAS 原子提交 -> 冲突按优先级合并 -> 失败可恢复
// 多标签页通过 localStorage 的 storage 事件同步对方已提交的事件。

import {
  HANDOFF_TIMEOUT_MS,
  LEDGER_KEY,
  LEGACY_KEY,
  PENDING_KEY,
  PRIORITY,
  type Audit,
  type Caption,
  type CaptionRevision,
  type Channel,
  type ConferenceState,
  type LedgerEvent,
  type LedgerEventType,
  type LedgerV2,
  type PendingIntent,
  type Speech,
  type SpeechStatus,
  type Term
} from './types';

export { LEDGER_KEY, LEGACY_KEY, PRIORITY };

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* 内存中的当前账本（客户端唯一事实来源）                                */
/* ------------------------------------------------------------------ */

let current: LedgerV2 | null = null;

export function getLedger(): LedgerV2 {
  if (!current) current = loadLedger();
  return current;
}

export function setLedger(ledger: LedgerV2) {
  current = ledger;
}

/* ------------------------------------------------------------------ */
/* 种子数据（与旧版演示数据一致）                                       */
/* ------------------------------------------------------------------ */

export function createEmptyLedger(): LedgerV2 {
  return { version: 2, headSeq: 0, rooms: [], events: [], pending: [], activeRoomId: '', lowLatency: false };
}

export function seedLedger(): LedgerV2 {
  const ledger = createEmptyLedger();
  const t = now();
  ledger.rooms = [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ];
  ledger.activeRoomId = 'hall-a';

  let s = 0;
  const push = (roomId: string, type: LedgerEventType, payload: Record<string, any>, at: string = t) => {
    ledger.events.push({ id: uuid(), seq: ++s, roomId, at, type, payload });
  };

  const channels: Channel[] = [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
  ];
  for (const channel of channels) push(channel.roomId, 'channel.upsert', { channel });

  const speeches: Speech[] = [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: t },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: t },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: t }
  ];
  for (const speech of speeches) push(speech.roomId, 'queue.add', { speech });

  const caption: Caption = {
    id: 'caption-1',
    speechId: 'speech-1',
    roomId: 'hall-a',
    language: '中文',
    interpreter: '周雨',
    text: '我们需要把适应资金与可衡量的社区韧性目标绑定。',
    revision: 2,
    revisions: [
      { rev: 1, text: '我们需要把适应资金与社区韧性目标绑定。', at: t, interpreter: '周雨' },
      { rev: 2, text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', at: t, interpreter: '周雨' }
    ],
    at: t
  };
  push('hall-a', 'caption.publish', { caption });

  push('global', 'term.upsert', { term: { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true } });
  push('global', 'term.upsert', { term: { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true } });
  push('global', 'term.upsert', { term: { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false } });

  push('hall-a', 'audit.log', {
    audit: { id: 'audit-1', at: t, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' }
  });
  push('hall-a', 'audit.log', {
    audit: { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  });

  ledger.headSeq = s;
  return ledger;
}

/* ------------------------------------------------------------------ */
/* 持久化：事件流与意图分离存储，记录意图永不覆盖事件流                  */
/* ------------------------------------------------------------------ */

type EventsSnapshot = Pick<LedgerV2, 'version' | 'headSeq' | 'rooms' | 'events' | 'activeRoomId' | 'lowLatency'>;

function readEventsRaw(): EventsSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 2 && Array.isArray(parsed.events)) return parsed as EventsSnapshot;
  } catch (err) {
    console.warn('事件账本读取失败', err);
  }
  return null;
}

function persistEvents(ledger: EventsSnapshot) {
  if (typeof localStorage === 'undefined') return;
  try {
    const snapshot: EventsSnapshot = {
      version: 2,
      headSeq: ledger.headSeq,
      rooms: ledger.rooms,
      events: ledger.events,
      activeRoomId: ledger.activeRoomId,
      lowLatency: ledger.lowLatency
    };
    localStorage.setItem(LEDGER_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('事件账本持久化失败', err);
  }
}

function readPendingRaw(): PendingIntent[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PendingIntent[];
  } catch (err) {
    console.warn('意图记录读取失败', err);
  }
  return [];
}

function persistPending(intents: PendingIntent[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(intents));
  } catch (err) {
    console.warn('意图记录持久化失败', err);
  }
}

/** 记录意图：追加到意图存储，绝不触碰事件流 */
function persistIntent(intent: PendingIntent) {
  const intents = readPendingRaw().filter((item) => item.id !== intent.id);
  intents.push(intent);
  persistPending(intents);
}

/** 更新意图状态（提交成功/失败后） */
function updateIntent(intent: PendingIntent) {
  const intents = readPendingRaw().map((item) => (item.id === intent.id ? intent : item));
  persistPending(intents);
}

/** 对外保留的整账本持久化入口（事件 + 意图） */
export function persistLedger(ledger: LedgerV2) {
  persistEvents(ledger);
  persistPending(ledger.pending);
}

export function loadLedger(): LedgerV2 {
  const stored = readEventsRaw();
  if (stored) {
    const ledger: LedgerV2 = { ...stored, pending: [] };
    // 合并意图存储（去重）
    const byId = new Map<string, PendingIntent>();
    for (const item of readPendingRaw()) byId.set(item.id, item);
    for (const item of ledger.pending) if (!byId.has(item.id)) byId.set(item.id, item);
    ledger.pending = [...byId.values()];
    return ledger;
  }
  const migrated = migrateLegacy();
  if (migrated) {
    persistLedger(migrated);
    return migrated;
  }
  const seeded = seedLedger();
  persistLedger(seeded);
  return seeded;
}

/* ------------------------------------------------------------------ */
/* 旧版 v1 数据迁移：升级后旧数据仍可读                                  */
/* ------------------------------------------------------------------ */

function migrateLegacy(): LedgerV2 | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let v1: any;
  try {
    v1 = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v1 || !Array.isArray(v1.rooms)) return null;

  const ledger = createEmptyLedger();
  ledger.rooms = v1.rooms;
  ledger.activeRoomId = typeof v1.activeRoomId === 'string' ? v1.activeRoomId : (v1.rooms[0]?.id ?? '');
  ledger.lowLatency = !!v1.lowLatency;

  let s = 0;
  const push = (roomId: string, type: LedgerEventType, payload: Record<string, any>, at: string = now()) => {
    ledger.events.push({ id: uuid(), seq: ++s, roomId, at, type, payload });
  };

  for (const channel of v1.channels ?? []) push(channel.roomId, 'channel.upsert', { channel });
  for (const speech of v1.speechQueue ?? []) push(speech.roomId, 'queue.add', { speech });
  for (const caption of v1.captions ?? []) {
    const rev = Number.isFinite(caption.revision) ? caption.revision : 1;
    const migrated: Caption = {
      ...caption,
      revisions: [{ rev, text: caption.text, at: caption.at, interpreter: caption.interpreter }]
    };
    push(caption.roomId, 'caption.publish', { caption: migrated }, caption.at);
  }
  for (const term of v1.terms ?? []) push('global', 'term.upsert', { term });
  for (const audit of v1.audits ?? []) push(audit.roomId ?? 'global', 'audit.log', { audit }, audit.at);

  ledger.headSeq = s;
  return ledger;
}

/* ------------------------------------------------------------------ */
/* 事件回放：从事件流得到可读状态                                        */
/* ------------------------------------------------------------------ */

export function deriveState(ledger: LedgerV2): ConferenceState {
  const speechQueue: Speech[] = [];
  const channels: Channel[] = [];
  const terms: Term[] = [];
  const captions: Caption[] = [];
  const audits: Audit[] = [];

  for (const event of ledger.events) {
    switch (event.type) {
      case 'queue.add': {
        speechQueue.push({ ...event.payload.speech });
        break;
      }
      case 'queue.status': {
        const speech = speechQueue.find((item) => item.id === event.payload.speechId);
        if (speech) {
          speech.status = event.payload.status;
          speech.updatedAt = event.at;
          if (event.payload.status === 'speaking') {
            for (const other of speechQueue) {
              if (other.id !== speech.id && other.roomId === event.roomId && other.status === 'speaking') {
                other.status = 'done';
              }
            }
          }
        }
        break;
      }
      case 'queue.remaining': {
        const speech = speechQueue.find((item) => item.id === event.payload.speechId);
        if (speech) {
          speech.remainingSeconds = event.payload.remainingSeconds;
          speech.updatedAt = event.at;
        }
        break;
      }
      case 'channel.upsert': {
        const index = channels.findIndex((item) => item.id === event.payload.channel.id);
        if (index >= 0) channels[index] = { ...event.payload.channel };
        else channels.push({ ...event.payload.channel });
        break;
      }
      case 'handoff.start': {
        const channel = channels.find((item) => item.id === event.payload.channelId);
        if (channel) {
          channel.status = 'handoff';
          channel.outgoingInterpreter = event.payload.outgoingInterpreter;
        }
        break;
      }
      case 'handoff.complete': {
        const channel = channels.find((item) => item.id === event.payload.channelId);
        if (channel) {
          channel.status = 'active';
          channel.interpreter = event.payload.interpreter;
          channel.outgoingInterpreter = undefined;
          channel.health = Math.min(100, channel.health + 2);
        }
        break;
      }
      case 'caption.publish': {
        const caption: Caption = { ...event.payload.caption, revisions: [...(event.payload.caption.revisions ?? [])] };
        captions.push(caption);
        break;
      }
      case 'caption.revise': {
        const caption = captions.find((item) => item.id === event.payload.captionId);
        if (caption) {
          const revision: CaptionRevision = {
            rev: event.payload.rev,
            text: event.payload.text,
            at: event.at,
            interpreter: event.payload.interpreter
          };
          caption.revisions.push(revision);
          caption.revisions.sort((a, b) => a.rev - b.rev || a.at.localeCompare(b.at));
          const current = caption.revisions[caption.revisions.length - 1];
          caption.text = current.text;
          caption.revision = current.rev;
          caption.interpreter = current.interpreter;
          caption.at = current.at;
        }
        break;
      }
      case 'term.upsert': {
        terms.push({ ...event.payload.term });
        break;
      }
      case 'term.approve': {
        const term = terms.find((item) => item.id === event.payload.termId);
        if (term) term.approved = true;
        break;
      }
      case 'audit.log': {
        audits.push({ ...event.payload.audit });
        break;
      }
      case 'room.switch': {
        // activeRoomId 由账本字段维护，这里仅占位
        break;
      }
    }
  }

  audits.sort((a, b) => b.at.localeCompare(a.at));

  return {
    rooms: ledger.rooms.map((room) => ({ ...room })),
    activeRoomId: ledger.activeRoomId,
    speechQueue,
    channels,
    terms,
    captions,
    audits,
    lowLatency: ledger.lowLatency
  };
}

/* ------------------------------------------------------------------ */
/* 意图提交：先记录意图，再原子提交                                     */
/* ------------------------------------------------------------------ */

export type CommitInput = {
  type: LedgerEventType;
  roomId: string;
  payload: Record<string, any>;
  priority: number;
};

export type CommitResult = {
  ok: boolean;
  conflict: boolean;
  merged: boolean;
  intent: PendingIntent;
  reason?: string;
};

/**
 * 提交一个意图。
 * 1. 先把意图写入意图存储并持久化（关页后重开可恢复），绝不覆盖事件流
 * 2. 再尝试 CAS 原子提交：比对 baseSeq，一致才追加事件
 * 3. 不一致则按优先级合并，合并不了则标记 conflict，等待人工/重试
 */
export function commitIntent(ledger: LedgerV2, input: CommitInput): CommitResult {
  const intent: PendingIntent = {
    id: uuid(),
    roomId: input.roomId,
    type: input.type,
    payload: input.payload,
    baseSeq: ledger.headSeq,
    priority: input.priority,
    createdAt: now(),
    status: 'pending',
    attempts: 0
  };
  ledger.pending.push(intent);
  persistIntent(intent); // 意图先落盘（独立存储，不影响事件流）

  return attemptCommit(ledger, intent);
}

function attemptCommit(ledger: LedgerV2, intent: PendingIntent): CommitResult {
  // 提交前读取事件流，纳入其他标签页已经提交的事件
  const stored = readEventsRaw();
  if (stored && stored.headSeq > ledger.headSeq) {
    adoptEvents(ledger, stored);
  }

  if (ledger.headSeq === intent.baseSeq) {
    appendCommit(ledger, intent);
    return { ok: true, conflict: false, merged: false, intent };
  }

  // 检测到冲突：基于间隔事件重新合并
  const intervening = ledger.events.filter((event) => event.seq > intent.baseSeq && event.seq <= ledger.headSeq);
  const resolution = resolveConflict(ledger, intent, intervening);
  if (!resolution.ok) {
    intent.status = 'conflict';
    intent.attempts += 1;
    intent.error = resolution.reason;
    updateIntent(intent);
    return { ok: false, conflict: true, merged: false, intent, reason: resolution.reason };
  }

  for (const event of resolution.events) {
    event.seq = ++ledger.headSeq;
    ledger.events.push(event);
    if (event.type === 'room.switch') ledger.activeRoomId = event.payload.roomId;
  }
  intent.status = 'committed';
  intent.merged = true;
  intent.conflictWith = intervening.map((event) => event.id);
  intent.resultEventId = resolution.events[resolution.events.length - 1]?.id;
  prunePending(ledger);
  persistEvents(ledger);
  updateIntent(intent);
  return { ok: true, conflict: true, merged: true, intent };
}

function appendCommit(ledger: LedgerV2, intent: PendingIntent) {
  const event = buildEvent(ledger, intent);
  event.seq = ++ledger.headSeq;
  ledger.events.push(event);
  if (event.type === 'room.switch') ledger.activeRoomId = event.payload.roomId;
  intent.status = 'committed';
  intent.resultEventId = event.id;
  prunePending(ledger);
  persistEvents(ledger);
  updateIntent(intent);
}

/** 重试一个冲突/失败的意图（基于最新版本重新合并提交） */
export function retryIntent(ledger: LedgerV2, intentId: string): CommitResult | null {
  const intent = ledger.pending.find((item) => item.id === intentId);
  if (!intent) return null;
  intent.status = 'pending';
  intent.error = undefined;
  updateIntent(intent);
  return attemptCommit(ledger, intent);
}

/** 放弃一个无法自动合并的意图 */
export function rollbackIntent(ledger: LedgerV2, intentId: string) {
  const intent = ledger.pending.find((item) => item.id === intentId);
  if (intent) {
    intent.status = 'rolled-back';
    updateIntent(intent);
  }
}

/* ------------------------------------------------------------------ */
/* 冲突合并规则                                                        */
/* ------------------------------------------------------------------ */

type Resolution = { ok: true; events: LedgerEvent[] } | { ok: false; reason: string };

function resolveConflict(ledger: LedgerV2, intent: PendingIntent, intervening: LedgerEvent[]): Resolution {
  const sameRoom = intervening.filter((event) => event.roomId === intent.roomId || event.roomId === 'global');
  if (sameRoom.length === 0) {
    // 其他厅的事件，互不影响，直接变基
    return { ok: true, events: [buildEvent(ledger, intent)] };
  }

  for (const other of sameRoom) {
    const verdict = resolvePair(ledger, intent, other);
    if (verdict === 'drop') {
      return {
        ok: false,
        reason: `与已提交的 ${other.type} 冲突，且优先级 ${intent.priority} 不高于对方`
      };
    }
  }
  return { ok: true, events: [buildEvent(ledger, intent)] };
}

/**
 * 逐条合并。返回 'adapt'（接受我方提交）或 'drop'（我方意图过期）。
 * 合并中会直接改写 intent.payload。
 */
function resolvePair(ledger: LedgerV2, intent: PendingIntent, other: LedgerEvent): 'adapt' | 'drop' {
  // 字幕 vs 字幕：合并修订历史，已确认字幕绝不丢弃
  if (intent.type === 'caption.publish' && other.type === 'caption.publish') {
    const mine = intent.payload.caption as Caption;
    const theirs = other.payload.caption as Caption;
    if (mine.speechId === theirs.speechId && mine.language === theirs.language) {
      const state = deriveState(ledger);
      const existing = state.captions.find((item) => item.id === theirs.id) ?? theirs;
      const maxRev = Math.max(
        0,
        ...existing.revisions.map((item) => item.rev),
        ...mine.revisions.map((item) => item.rev)
      );
      intent.type = 'caption.revise';
      intent.payload = { captionId: theirs.id, text: mine.text, interpreter: mine.interpreter, rev: maxRev + 1 };
    }
    return 'adapt';
  }

  if (intent.type === 'caption.revise' && other.type === 'caption.publish') {
    const mineId = intent.payload.captionId as string;
    const theirs = other.payload.caption as Caption;
    if (mineId === theirs.id) return 'adapt';
    return 'adapt';
  }

  if (intent.type === 'caption.publish' && other.type === 'caption.revise') {
    const mine = intent.payload.caption as Caption;
    if (mine.id === other.payload.captionId) {
      // 对方修订了我方刚发布的字幕：我方发布过期，改为对其字幕的修订
      intent.type = 'caption.revise';
      intent.payload = { captionId: mine.id, text: mine.text, interpreter: mine.interpreter, rev: 0 };
    }
    return 'adapt';
  }

  // 字幕 vs 交接：译员归属在 buildEvent 中按当前频道状态重新判定
  if (intent.type.startsWith('caption.') && (other.type === 'handoff.start' || other.type === 'handoff.complete')) {
    return 'adapt';
  }

  // 交接开始 vs 交接完成（同频道）：完成优先，开始过期
  if (intent.type === 'handoff.start' && other.type === 'handoff.complete' && intent.payload.channelId === other.payload.channelId) {
    return 'drop';
  }

  // 队列状态冲突：校验状态机，非法迁移丢弃
  if (intent.type === 'queue.status' && other.type === 'queue.status' && intent.payload.speechId === other.payload.speechId) {
    const state = deriveState(ledger);
    const speech = state.speechQueue.find((item) => item.id === intent.payload.speechId);
    if (speech && !validTransition(speech.status, intent.payload.status)) {
      return 'drop';
    }
    return 'adapt';
  }

  return 'adapt';
}

function validTransition(from: SpeechStatus, to: SpeechStatus): boolean {
  if (from === to) return false;
  if (from === 'queued') return to === 'speaking' || to === 'skipped';
  if (from === 'speaking') return to === 'done' || to === 'skipped';
  return false;
}

/* ------------------------------------------------------------------ */
/* 事件构造：字幕译员归属按交接状态判定                                  */
/* ------------------------------------------------------------------ */

function buildEvent(ledger: LedgerV2, intent: PendingIntent): LedgerEvent {
  const payload: Record<string, any> = { ...intent.payload };

  if (intent.type === 'caption.publish' || intent.type === 'caption.revise') {
    const state = deriveState(ledger);
    const captionId = intent.type === 'caption.publish' ? payload.caption?.id : payload.captionId;
    const caption = state.captions.find((item) => item.id === captionId);
    const speechId = intent.type === 'caption.publish' ? payload.caption?.speechId : caption?.speechId;
    const speech = state.speechQueue.find((item) => item.id === speechId);
    const language = intent.type === 'caption.publish' ? payload.caption?.language : caption?.language;
    const channel = speech
      ? state.channels.find((item) => item.roomId === speech.roomId && item.language === language)
      : undefined;

    if (channel) {
      // 交接期间到达的旧译文归旧译员；交接完成后才归新译员
      const interpreter =
        channel.status === 'handoff' && channel.outgoingInterpreter ? channel.outgoingInterpreter : channel.interpreter;
      if (intent.type === 'caption.publish') payload.caption = { ...payload.caption, interpreter };
      else payload.interpreter = interpreter;
    }

    if (intent.type === 'caption.revise') {
      const target = state.captions.find((item) => item.id === payload.captionId);
      const maxRev = target ? Math.max(0, ...target.revisions.map((item) => item.rev)) : 0;
      payload.rev = Math.max(payload.rev ?? 0, maxRev) + 1;
    }
  }

  return { id: uuid(), seq: 0, roomId: intent.roomId, at: now(), type: intent.type, payload };
}

/* ------------------------------------------------------------------ */
/* 跨标签页同步                                                        */
/* ------------------------------------------------------------------ */

function adoptEvents(ledger: LedgerV2, stored: EventsSnapshot) {
  ledger.rooms = stored.rooms;
  ledger.events = stored.events;
  ledger.headSeq = stored.headSeq;
  ledger.activeRoomId = stored.activeRoomId;
  ledger.lowLatency = stored.lowLatency;
}

/** 接收其他标签页写入的账本（storage 事件触发）：纳管事件并合并意图 */
export function adoptLedger(ledger: LedgerV2, stored: LedgerV2) {
  adoptEvents(ledger, stored);
  const byId = new Map<string, PendingIntent>();
  for (const item of stored.pending ?? []) byId.set(item.id, item);
  for (const item of ledger.pending) if (!byId.has(item.id)) byId.set(item.id, item);
  ledger.pending = [...byId.values()];
}

function prunePending(ledger: LedgerV2) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  ledger.pending = ledger.pending.filter((item) => {
    if (item.status === 'pending' || item.status === 'conflict') return true;
    return new Date(item.createdAt).getTime() > cutoff;
  });
  persistPending(ledger.pending);
}

/* ------------------------------------------------------------------ */
/* 查询辅助                                                            */
/* ------------------------------------------------------------------ */

/** 未完成的交接：频道处于 handoff，或存在未提交的 handoff.start 意图 */
export function pendingHandoffs(ledger: LedgerV2) {
  const state = deriveState(ledger);
  const nowMs = Date.now();
  return state.channels
    .filter((channel) => channel.status === 'handoff')
    .map((channel) => {
      const startEvent = [...ledger.events]
        .reverse()
        .find((event) => event.type === 'handoff.start' && event.payload.channelId === channel.id);
      const startedAt = startEvent?.at ?? '';
      const timedOut = !!startedAt && nowMs - new Date(startedAt).getTime() > HANDOFF_TIMEOUT_MS;
      return { channel, startedAt, timedOut };
    });
}

/** 仍处于冲突状态、等待人工处理的意图 */
export function conflictIntents(ledger: LedgerV2) {
  return ledger.pending.filter((item) => item.status === 'conflict');
}

/** 已记录意图但尚未提交（关页后重开可继续） */
export function uncommittedIntents(ledger: LedgerV2) {
  return ledger.pending.filter((item) => item.status === 'pending');
}

/** 演示用：模拟另一个标签页并发提交了一条字幕（用于验证冲突合并） */
export function simulateOtherTabCommit(ledger: LedgerV2): boolean {
  const state = deriveState(ledger);
  const speech = state.speechQueue.find((item) => item.roomId === ledger.activeRoomId && item.status === 'speaking');
  if (!speech) return false;
  const channel = state.channels.find((item) => item.roomId === speech.roomId && item.language === '中文');
  // 优先当前发言的字幕，否则回退到该厅最近的字幕
  const caption =
    state.captions.find((item) => item.speechId === speech.id && item.language === '中文') ??
    state.captions
      .filter((item) => item.roomId === speech.roomId && item.language === '中文')
      .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!caption) return false;

  const stored = readEventsRaw() ?? ledger;
  const event: LedgerEvent = {
    id: uuid(),
    seq: stored.headSeq + 1,
    roomId: speech.roomId,
    at: now(),
    type: 'caption.revise',
    payload: {
      captionId: caption.id,
      text: `${caption.text}（他标签页并发修订）`,
      interpreter: channel?.interpreter ?? caption.interpreter,
      rev: Math.max(...caption.revisions.map((item) => item.rev)) + 1
    }
  };
  stored.events.push(event);
  stored.headSeq = event.seq;
  persistEvents(stored);
  // 注意：不 adopt 到内存账本——模拟我方标签页尚未收到 storage 事件，
  // 下次提交时才会发现 baseSeq 已过期并触发冲突合并
  return true;
}
