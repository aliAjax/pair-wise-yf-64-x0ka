import { z } from 'zod';

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type InterpreterStatus = 'active' | 'handoff' | 'standby';
export type Priority = 'critical' | 'high' | 'normal' | 'low';
export type IntentStatus = 'prepared' | 'committed' | 'failed' | 'superseded' | 'cancelled';
export type CaptionOutcome = 'adopted' | 'retained-conflict' | 'stale-handoff';

export type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
export type Speech = {
  id: string;
  roomId: string;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  updatedAt: string;
};
export type Channel = {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: InterpreterStatus;
  health: number;
  epoch: number;
  handoffFrom?: string;
  handoffEpoch?: number;
  handoffStartedAt?: string;
  lastHandoffAt?: string;
};
export type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
export type Caption = {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  interpreterId: string;
  interpreter: string;
  epoch: number;
  text: string;
  revision: number;
  at: string;
  outcome: CaptionOutcome;
  isCurrent: boolean;
  sourceIntentId: string;
};
export type Audit = { id: string; at: string; roomId: string; message: string };
export type ConflictRecord = {
  id: string;
  at: string;
  intentId: string;
  roomId: string;
  kind: string;
  message: string;
  resolution: 'blocked' | 'retained' | 'superseded';
  recoverable: boolean;
};

export interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
}

export type IntentPayload =
  | { type: 'queue-add'; roomId: string; speech: Omit<Speech, 'id' | 'roomId' | 'remainingSeconds' | 'status' | 'updatedAt'> }
  | { type: 'queue-status'; roomId: string; speechId: string; status: SpeechStatus }
  | { type: 'queue-adjust-time'; roomId: string; speechId: string; deltaSeconds: number }
  | { type: 'handoff-start'; roomId: string; channelId: string }
  | { type: 'handoff-complete'; roomId: string; channelId: string; toInterpreter: string; fromInterpreter: string; handoffEpoch: number }
  | { type: 'caption-submit'; roomId: string; speechId: string; language: string; text: string; interpreterId: string; interpreter: string; epoch: number }
  | { type: 'term-approve'; termId: string }
  | { type: 'audit-logged'; roomId: string; message: string };

export type Intent = {
  id: string;
  clientId: string;
  type: IntentPayload['type'];
  payload: IntentPayload;
  baseVersion: number;
  priority: Priority;
  status: IntentStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastError?: string;
  resolution?: string;
  force?: boolean;
};

export type EventPayload =
  | { type: 'snapshot-imported'; state: ConferenceState; sourceVersion: number }
  | { type: 'queue-added'; speech: Speech }
  | { type: 'queue-status-changed'; roomId: string; speechId: string; from: SpeechStatus | ''; to: SpeechStatus }
  | { type: 'queue-time-adjusted'; roomId: string; speechId: string; deltaSeconds: number }
  | { type: 'handoff-started'; roomId: string; channelId: string; language: string; fromInterpreter: string; handoffEpoch: number }
  | { type: 'handoff-completed'; roomId: string; channelId: string; language: string; fromInterpreter: string; toInterpreter: string; completedEpoch: number }
  | { type: 'caption-submitted'; caption: Omit<Caption, 'id' | 'at' | 'isCurrent'> }
  | { type: 'term-approved'; termId: string }
  | { type: 'audit-logged'; roomId: string; message: string };

export type LedgerEvent = {
  id: string;
  seq: number;
  at: string;
  sourceIntentId: string;
  priority: Priority;
  payload: EventPayload;
};

export type Ledger = {
  schemaVersion: 2;
  clientId: string;
  events: LedgerEvent[];
  intents: Intent[];
  conflicts: ConflictRecord[];
  createdAt: string;
  updatedAt: string;
};

export type LedgerView = ConferenceState & {
  version: number;
  clientId: string;
  intents: Intent[];
  conflicts: ConflictRecord[];
  events: LedgerEvent[];
};

export const LEDGER_KEY = 'conference-ledger-v2';
export const LEGACY_STATE_KEY = 'conference-interpretation-v1';
export const ACTIVE_ROOM_KEY = 'conference-active-room-v2';
export const LOW_LATENCY_KEY = 'conference-low-latency-v2';
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

const CLIENT_KEY = 'conference-client-id-v2';
const MAX_CONFLICTS = 100;
const MAX_INTENT_ARCHIVE = 100;

const priorityRank: Record<Priority, number> = { critical: 4, high: 3, normal: 2, low: 1 };

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix: string) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isoMinutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function createSeedState(): ConferenceState {
  return {
    rooms: [
      { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
      { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
    ],
    activeRoomId: 'hall-a',
    speechQueue: [
      { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: isoMinutesAgo(2) },
      { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: isoMinutesAgo(2) },
      { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: isoMinutesAgo(2) }
    ],
    channels: [
      { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96, epoch: 0 },
      { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91, epoch: 0 },
      { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88, epoch: 0 },
      { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94, epoch: 0 }
    ],
    terms: [
      { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
      { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
      { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
    ],
    captions: [
      { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreterId: 'ch-a-zh', interpreter: '周雨', epoch: 0, text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: isoMinutesAgo(1), outcome: 'adopted', isCurrent: true, sourceIntentId: 'seed-caption-1' }
    ],
    audits: [
      { id: 'audit-1', at: isoMinutesAgo(0), roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
      { id: 'audit-2', at: isoMinutesAgo(2), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
    ],
    lowLatency: false
  };
}

function asArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

export function normalizeState(raw: Partial<ConferenceState> | null | undefined): ConferenceState {
  const seed = createSeedState();
  const rooms = asArray<Room>(raw?.rooms, seed.rooms).map((room) => ({
    id: String(room.id),
    name: String(room.name ?? room.id),
    topic: String(room.topic ?? ''),
    simultaneousChannels: Number(room.simultaneousChannels ?? 1)
  }));
  const roomIds = new Set(rooms.map((room) => room.id));
  const activeRoomId = raw?.activeRoomId && roomIds.has(raw.activeRoomId) ? raw.activeRoomId : rooms[0]?.id ?? seed.activeRoomId;

  const speechQueue = asArray<Speech>(raw?.speechQueue, seed.speechQueue).map((speech) => ({
    id: String(speech.id),
    roomId: roomIds.has(speech.roomId) ? speech.roomId : activeRoomId,
    speaker: String(speech.speaker ?? ''),
    delegation: String(speech.delegation ?? ''),
    language: String(speech.language ?? ''),
    topic: String(speech.topic ?? ''),
    plannedSeconds: Number(speech.plannedSeconds ?? 300),
    remainingSeconds: Number(speech.remainingSeconds ?? speech.plannedSeconds ?? 300),
    status: speech.status,
    updatedAt: String(speech.updatedAt ?? nowIso())
  }));

  const channels = asArray<Channel>(raw?.channels, seed.channels).map((channel) => ({
    id: String(channel.id),
    roomId: roomIds.has(channel.roomId) ? channel.roomId : activeRoomId,
    language: String(channel.language ?? ''),
    interpreter: String(channel.interpreter ?? '未分配'),
    status: channel.status,
    health: Number(channel.health ?? 100),
    epoch: Number(channel.epoch ?? 0),
    handoffFrom: channel.handoffFrom,
    handoffEpoch: channel.handoffEpoch,
    handoffStartedAt: channel.handoffStartedAt,
    lastHandoffAt: channel.lastHandoffAt
  }));

  const terms = asArray<Term>(raw?.terms, seed.terms).map((term) => ({
    id: String(term.id),
    phrase: String(term.phrase ?? ''),
    translation: String(term.translation ?? ''),
    language: String(term.language ?? ''),
    approved: Boolean(term.approved)
  }));

  const speechIds = new Set(speechQueue.map((speech) => speech.id));
  const rawCaptions = asArray<Partial<Caption>>(raw?.captions, seed.captions);
  const latestCaptionIndex = new Map<string, number>();
  rawCaptions.forEach((caption, index) => {
    const captionRoomId = caption.roomId && roomIds.has(caption.roomId) ? caption.roomId : activeRoomId;
    latestCaptionIndex.set(`${captionRoomId}:${caption.speechId}:${caption.language}`, index);
  });
  const captions: Caption[] = rawCaptions.map((caption, index) => {
    const roomId = caption.roomId && roomIds.has(caption.roomId) ? caption.roomId : activeRoomId;
    const outcome: CaptionOutcome = caption.outcome === 'retained-conflict' || caption.outcome === 'stale-handoff' ? caption.outcome : 'adopted';
    return {
    id: String(caption.id ?? `migrated-caption-${index + 1}`),
    speechId: String(caption.speechId ?? ''),
    roomId,
    language: String(caption.language ?? '中文'),
    interpreterId: String(caption.interpreterId ?? `legacy-interpreter-${index + 1}`),
    interpreter: String(caption.interpreter ?? '旧版译员'),
    epoch: Number(caption.epoch ?? 0),
    text: String(caption.text ?? ''),
    revision: Number(caption.revision ?? index + 1),
    at: String(caption.at ?? nowIso()),
    outcome,
    isCurrent: Boolean(caption.isCurrent ?? latestCaptionIndex.get(`${roomId}:${caption.speechId}:${caption.language}`) === index),
    sourceIntentId: String(caption.sourceIntentId ?? `legacy-caption-${index + 1}`)
    };
  }).filter((caption) => speechIds.has(caption.speechId) || rawCaptions.length > 0);

  const audits = asArray<Audit>(raw?.audits, seed.audits).map((audit) => ({
    id: String(audit.id ?? createId('audit')),
    at: String(audit.at ?? nowIso()),
    roomId: roomIds.has(audit.roomId) ? audit.roomId : activeRoomId,
    message: String(audit.message ?? '')
  }));

  return { rooms, activeRoomId, speechQueue, channels, terms, captions, audits, lowLatency: Boolean(raw?.lowLatency) };
}

function auditForEvent(event: LedgerEvent): Audit | null {
  const p = event.payload;
  const roomId = 'roomId' in p && typeof p.roomId === 'string' ? p.roomId : '';
  const base = { id: createId('audit'), at: event.at, roomId };
  switch (p.type) {
    case 'snapshot-imported': return { ...base, roomId: p.state.activeRoomId, message: `已从 v${p.sourceVersion} 本地账本恢复并升级，字幕与交接记录保留` };
    case 'queue-added': return { ...base, roomId: p.speech.roomId, message: `${p.speech.speaker} 已加入发言队列` };
    case 'queue-status-changed': return { ...base, roomId: p.roomId, message: `发言 ${p.speechId} 状态从 ${p.from || '未知'} 更新为 ${p.to}` };
    case 'queue-time-adjusted': return { ...base, roomId: p.roomId, message: `发言 ${p.speechId} 剩余时间调整 ${p.deltaSeconds > 0 ? '+' : ''}${p.deltaSeconds} 秒` };
    case 'handoff-started': return { ...base, message: `${p.language} 频道启动译员交接：${p.fromInterpreter} 的译文区间已冻结` };
    case 'handoff-completed': return { ...base, message: `${p.language} 频道由 ${p.fromInterpreter} 交给 ${p.toInterpreter}，后续字幕归属新译员` };
    case 'caption-submitted': return { ...base, roomId: p.caption.roomId, message: `字幕 v${p.caption.revision} 已确认，归属 ${p.caption.interpreter}${p.caption.outcome === 'adopted' ? '' : '（保留为冲突版本）'}` };
    case 'term-approved': return { ...base, roomId: '', message: `术语 ${p.termId} 已批准` };
    case 'audit-logged': return { ...base, message: p.message };
  }
}

export function replay(events: LedgerEvent[], initial: ConferenceState = createSeedState()): ConferenceState {
  let state = initial;
  for (const event of events) {
    const p = event.payload;
    switch (p.type) {
      case 'snapshot-imported':
        state = normalizeState(p.state);
        break;
      case 'queue-added':
        state = { ...state, speechQueue: [...state.speechQueue, p.speech] };
        break;
      case 'queue-status-changed': {
        state = {
          ...state,
          speechQueue: state.speechQueue.map((speech) => {
            if (speech.id === p.speechId) return { ...speech, status: p.to, updatedAt: event.at };
            if (p.to === 'speaking' && speech.roomId === state.speechQueue.find((item) => item.id === p.speechId)?.roomId && speech.status === 'speaking') {
              return { ...speech, status: 'done', updatedAt: event.at };
            }
            return speech;
          })
        };
        break;
      }
      case 'queue-time-adjusted':
        state = { ...state, speechQueue: state.speechQueue.map((speech) => speech.id === p.speechId ? { ...speech, remainingSeconds: Math.max(0, speech.remainingSeconds + p.deltaSeconds), updatedAt: event.at } : speech) };
        break;
      case 'handoff-started':
        state = {
          ...state,
          channels: state.channels.map((channel) => channel.id === p.channelId ? {
            ...channel,
            status: 'handoff',
            handoffFrom: p.fromInterpreter,
            handoffEpoch: p.handoffEpoch,
            handoffStartedAt: event.at
          } : channel)
        };
        break;
      case 'handoff-completed':
        state = {
          ...state,
          channels: state.channels.map((channel) => channel.id === p.channelId ? {
            ...channel,
            interpreter: p.toInterpreter,
            status: 'active',
            epoch: p.completedEpoch,
            handoffFrom: undefined,
            handoffEpoch: undefined,
            handoffStartedAt: undefined,
            lastHandoffAt: event.at,
            health: Math.min(100, channel.health + 2)
          } : channel)
        };
        break;
      case 'caption-submitted': {
        const adopted = p.caption.outcome === 'adopted';
        const caption: Caption = { ...p.caption, id: createId('caption'), at: event.at, isCurrent: adopted };
        state = {
          ...state,
          captions: [
            caption,
            ...state.captions.map((existing) => adopted && existing.speechId === caption.speechId && existing.language === caption.language ? { ...existing, isCurrent: false } : existing)
          ]
        };
        break;
      }
      case 'term-approved':
        state = { ...state, terms: state.terms.map((term) => term.id === p.termId ? { ...term, approved: true } : term) };
        break;
      case 'audit-logged':
        break;
    }
    const audit = auditForEvent(event);
    if (audit) state = { ...state, audits: [audit, ...state.audits].slice(0, 300) };
  }
  return state;
}

function emptyLedger(clientId: string, seed = true): Ledger {
  const timestamp = nowIso();
  const ledger: Ledger = { schemaVersion: 2, clientId, events: [], intents: [], conflicts: [], createdAt: timestamp, updatedAt: timestamp };
  if (!seed) return ledger;
  const state = createSeedState();
  ledger.events = [{ id: createId('evt'), seq: 1, at: timestamp, sourceIntentId: 'local-bootstrap', priority: 'critical', payload: { type: 'snapshot-imported', state, sourceVersion: 2 } }];
  return ledger;
}

function parseLedger(raw: string | null, clientId: string): Ledger | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<Ledger>;
  if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.events)) throw new Error('无法识别的账本版本');
  return {
    schemaVersion: 2,
    clientId: String(parsed.clientId ?? clientId),
    events: parsed.events as LedgerEvent[],
    intents: asArray<Intent>(parsed.intents, []),
    conflicts: asArray<ConflictRecord>(parsed.conflicts, []),
    createdAt: String(parsed.createdAt ?? nowIso()),
    updatedAt: String(parsed.updatedAt ?? nowIso())
  };
}

function getClientId() {
  if (typeof localStorage === 'undefined') return 'server';
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = createId('client');
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

function readLatest(clientId: string): Ledger {
  const raw = localStorage.getItem(LEDGER_KEY);
  const ledger = parseLedger(raw, clientId);
  return ledger ?? emptyLedger(clientId);
}

function writeLedger(ledger: Ledger) {
  ledger.updatedAt = nowIso();
  localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  cachedView = undefined;
  notifySameTab();
}

async function withLock<T>(label: string, fn: () => T): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request: (name: string, options: { mode: 'exclusive'; signal: AbortSignal }, callback: () => T | Promise<T>) => Promise<T> } }).locks;
  if (!locks?.request) return fn();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    return await locks.request(label, { mode: 'exclusive', signal: controller.signal }, fn);
  } finally {
    clearTimeout(timeout);
  }
}

function toView(ledger: Ledger): LedgerView {
  const state = replay(ledger.events);
  return { ...state, version: ledger.events.length, clientId: ledger.clientId, intents: ledger.intents, conflicts: ledger.conflicts, events: ledger.events };
}

let cachedView: LedgerView | undefined;
const listeners = new Set<() => void>();
function notifySameTab() {
  cachedView = undefined;
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  if (typeof window !== 'undefined') {
    const storageListener = (event: StorageEvent) => {
      if (event.key === LEDGER_KEY) {
        cachedView = undefined;
        listener();
      }
    };
    window.addEventListener('storage', storageListener);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', storageListener);
    };
  }
  return () => listeners.delete(listener);
}

export function peekView(): LedgerView {
  if (cachedView) return cachedView;
  if (typeof localStorage === 'undefined') {
    const state = createSeedState();
    return { ...state, version: 0, clientId: 'server', intents: [], conflicts: [], events: [] };
  }
  const clientId = getClientId();
  try {
    const ledger = parseLedger(localStorage.getItem(LEDGER_KEY), clientId);
    if (ledger) cachedView = toView(ledger);
  } catch {
    cachedView = undefined;
  }
  if (!cachedView) {
    cachedView = toView(emptyLedger(clientId));
  }
  return cachedView;
}

function priorityForIntent(payload: IntentPayload, force = false): Priority {
  if (force) return 'critical';
  switch (payload.type) {
    case 'handoff-complete': return 'critical';
    case 'queue-status': return payload.status === 'queued' ? 'normal' : 'high';
    case 'handoff-start':
    case 'caption-submit':
      return 'high';
    case 'queue-add':
    case 'term-approve':
    case 'audit-logged':
      return 'normal';
    case 'queue-adjust-time': return 'low';
  }
}

export async function prepareIntent(payload: IntentPayload, options: { force?: boolean; priority?: Priority } = {}): Promise<Intent> {
  if (typeof localStorage === 'undefined') throw new Error('本地账本只能在浏览器中准备事务');
  return withLock('conference-ledger-v2-write', () => {
    const clientId = getClientId();
    const ledger = readLatest(clientId);
    const timestamp = nowIso();
    const intent: Intent = {
      id: createId('intent'),
      clientId,
      type: payload.type,
      payload,
      baseVersion: ledger.events.length,
      priority: options.priority ?? priorityForIntent(payload, options.force),
      status: 'prepared',
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: 0,
      force: options.force
    };
    ledger.intents = [intent, ...ledger.intents].slice(0, MAX_INTENT_ARCHIVE);
    writeLedger(ledger);
    return intent;
  });
}

function eventBase(ledger: Ledger, intent: Intent, payload: EventPayload): LedgerEvent {
  return { id: createId('evt'), seq: ledger.events.length + 1, at: nowIso(), sourceIntentId: intent.id, priority: intent.priority, payload };
}

function lastEventFor(ledger: Ledger, predicate: (payload: EventPayload) => boolean) {
  for (let index = ledger.events.length - 1; index >= 0; index -= 1) {
    const event = ledger.events[index];
    if (predicate(event.payload)) return event;
  }
  return undefined;
}

function addConflict(ledger: Ledger, intent: Intent, kind: string, message: string, resolution: ConflictRecord['resolution'], recoverable = true) {
  ledger.conflicts = [{ id: createId('conflict'), at: nowIso(), intentId: intent.id, roomId: roomIdOf(intent.payload), kind, message, resolution, recoverable }, ...ledger.conflicts].slice(0, MAX_CONFLICTS);
}

function roomIdOf(payload: IntentPayload) {
  return 'roomId' in payload ? payload.roomId : '';
}

function failIntent(ledger: Ledger, intent: Intent, message: string, kind: string) {
  intent.status = 'failed';
  intent.attempts += 1;
  intent.updatedAt = nowIso();
  intent.lastError = message;
  addConflict(ledger, intent, kind, message, 'blocked');
}

type PlannedEvent = { event: EventPayload; outcome?: CaptionOutcome; idempotent?: boolean };

function plan(ledger: Ledger, intent: Intent): PlannedEvent | { error: string; kind: string } {
  const state = replay(ledger.events);
  const payload = intent.payload;

  if (ledger.events.some((event) => event.sourceIntentId === intent.id)) return { idempotent: true, event: { type: 'audit-logged', roomId: roomIdOf(payload), message: '重复提交已按幂等处理' } };

  switch (payload.type) {
    case 'queue-add': {
      const speech: Speech = { ...payload.speech, id: createId('speech'), roomId: payload.roomId, remainingSeconds: payload.speech.plannedSeconds, status: 'queued', updatedAt: nowIso() };
      return { event: { type: 'queue-added', speech } };
    }
    case 'queue-status': {
      const speech = state.speechQueue.find((item) => item.id === payload.speechId);
      if (!speech) return { error: '发言已不存在，无法切换状态', kind: 'queue-missing' };
      if (speech.status === payload.status) return { idempotent: true, event: { type: 'audit-logged', roomId: payload.roomId, message: '发言状态未变化' } };
      const remote = lastEventFor(ledger, (candidate) => (candidate.type === 'queue-status-changed' || candidate.type === 'queue-added') && 'speechId' in candidate && candidate.speechId === payload.speechId);
      if (remote?.payload.type === 'queue-status-changed') {
        const winner = intent.force || priorityRank[intent.priority] > priorityRank[remote.priority] || intent.createdAt > remote.at;
        if (!winner) return { error: `另一标签页已将发言切换为 ${remote.payload.to}，当前提交优先级不足`, kind: 'queue-status-conflict' };
      }
      return { event: { type: 'queue-status-changed', roomId: payload.roomId, speechId: payload.speechId, from: speech.status, to: payload.status } };
    }
    case 'queue-adjust-time': {
      const speech = state.speechQueue.find((item) => item.id === payload.speechId);
      if (!speech) return { error: '发言已不存在，无法调整时间', kind: 'queue-missing' };
      if (speech.status === 'done' || speech.status === 'skipped') return { error: '发言已结束，时间调整未提交', kind: 'queue-terminal-conflict' };
      return { event: { type: 'queue-time-adjusted', roomId: payload.roomId, speechId: payload.speechId, deltaSeconds: payload.deltaSeconds } };
    }
    case 'handoff-start': {
      const channel = state.channels.find((item) => item.id === payload.channelId);
      if (!channel) return { error: '频道不存在，无法开始交接', kind: 'channel-missing' };
      if (channel.status === 'handoff') return { idempotent: true, event: { type: 'audit-logged', roomId: payload.roomId, message: '该频道已有未完成交接，已恢复原交接单' } };
      return { event: { type: 'handoff-started', roomId: payload.roomId, channelId: channel.id, language: channel.language, fromInterpreter: channel.interpreter, handoffEpoch: channel.epoch + 1 } };
    }
    case 'handoff-complete': {
      const channel = state.channels.find((item) => item.id === payload.channelId);
      if (!channel) return { error: '频道不存在，无法完成交接', kind: 'channel-missing' };
      if (channel.status !== 'handoff' || !channel.handoffEpoch) return { error: '交接已被其他标签页完成或取消， stale handoff', kind: 'handoff-stale' };
      if (channel.handoffEpoch !== payload.handoffEpoch || channel.handoffFrom !== payload.fromInterpreter) {
        if (!intent.force) return { error: '交接代次不一致：检测到另一轮交接，旧完成请求已阻止', kind: 'handoff-epoch-conflict' };
      }
      const remote = lastEventFor(ledger, (candidate) => (candidate.type === 'handoff-completed' || candidate.type === 'handoff-started') && 'channelId' in candidate && candidate.channelId === payload.channelId);
      if (remote?.payload.type === 'handoff-completed' && !intent.force && priorityRank[intent.priority] <= priorityRank[remote.priority]) {
        return { error: `另一标签页已确认 ${remote.payload.toInterpreter} 接替`, kind: 'handoff-complete-conflict' };
      }
      return { event: { type: 'handoff-completed', roomId: payload.roomId, channelId: channel.id, language: channel.language, fromInterpreter: channel.handoffFrom ?? payload.fromInterpreter, toInterpreter: payload.toInterpreter, completedEpoch: channel.handoffEpoch } };
    }
    case 'caption-submit': {
      const speech = state.speechQueue.find((item) => item.id === payload.speechId);
      const channel = state.channels.find((item) => item.roomId === payload.roomId && item.language === payload.language);
      if (!speech || !channel) return { error: '发言或频道已消失，字幕未提交', kind: 'caption-target-missing' };
      const revision = state.captions.filter((caption) => caption.speechId === payload.speechId && caption.language === payload.language).length + 1;
      const stale = channel.epoch !== payload.epoch || channel.interpreter !== payload.interpreter;
      const latest = (() => {
        for (const caption of state.captions) {
          if (caption.speechId === payload.speechId && caption.language === payload.language && caption.isCurrent) return caption;
        }
        return undefined;
      })();
      const latestEvent = latest ? ledger.events.find((event) => event.payload.type === 'caption-submitted' && event.payload.caption.sourceIntentId === latest.sourceIntentId) : undefined;
      let outcome: CaptionOutcome = 'adopted';
      if (stale) outcome = 'stale-handoff';
      else if (latest && latestEvent) {
        const incomingWins = intent.force || priorityRank[intent.priority] > priorityRank[latestEvent.priority] || (priorityRank[intent.priority] === priorityRank[latestEvent.priority] && intent.createdAt > latestEvent.at);
        if (!incomingWins) outcome = 'retained-conflict';
      }
      return {
        outcome,
        event: {
          type: 'caption-submitted',
          caption: {
            speechId: payload.speechId,
            roomId: payload.roomId,
            language: payload.language,
            interpreterId: payload.interpreterId,
            interpreter: payload.interpreter,
            epoch: payload.epoch,
            text: payload.text,
            revision,
            outcome,
            sourceIntentId: intent.id
          }
        }
      };
    }
    case 'term-approve': {
      const term = state.terms.find((item) => item.id === payload.termId);
      if (!term) return { error: '术语不存在', kind: 'term-missing' };
      if (term.approved) return { idempotent: true, event: { type: 'audit-logged', roomId: roomIdOf(payload), message: '术语此前已批准' } };
      return { event: { type: 'term-approved', termId: payload.termId } };
    }
    case 'audit-logged':
      return { event: { type: 'audit-logged', roomId: payload.roomId, message: payload.message } };
  }
}

function pruneIntents(intents: Intent[]) {
  const open = intents.filter((intent) => intent.status === 'prepared' || intent.status === 'failed');
  const done = intents.filter((intent) => intent.status !== 'prepared' && intent.status !== 'failed');
  return [...open, ...done].slice(0, MAX_INTENT_ARCHIVE);
}

export async function commitIntent(intentId: string, options: { force?: boolean } = {}): Promise<LedgerView> {
  return withLock('conference-ledger-v2-write', () => {
    const clientId = getClientId();
    const ledger = readLatest(clientId);
    const intent = ledger.intents.find((item) => item.id === intentId);
    if (!intent) throw new Error('待提交意图不存在，可能已被清理');
    if (intent.status === 'committed' || intent.status === 'superseded') return toView(ledger);
    if (intent.status === 'cancelled') throw new Error('该提交已取消');
    if (options.force) {
      intent.force = true;
      intent.priority = 'critical';
    }
    intent.attempts += 1;
    intent.updatedAt = nowIso();

    const planned = plan(ledger, intent);
    if ('error' in planned) {
      failIntent(ledger, intent, planned.error, planned.kind);
      writeLedger(ledger);
      const error = new Error(planned.error) as Error & { recoverable: boolean };
      error.recoverable = true;
      throw error;
    }

    if (!planned.idempotent) ledger.events.push(eventBase(ledger, intent, planned.event));
    intent.status = 'committed';
    intent.resolution = planned.idempotent ? 'idempotent' : planned.outcome === 'adopted' || !planned.outcome ? 'committed' : `retained:${planned.outcome}`;
    intent.lastError = undefined;
    intent.updatedAt = nowIso();
    if (planned.outcome && planned.outcome !== 'adopted') {
      addConflict(ledger, intent, planned.outcome, planned.outcome === 'stale-handoff' ? '交接后到达的旧译文字幕已保留，但不会成为当前字幕' : '并行字幕修订已按优先级保留为版本', 'retained', false);
    }
    ledger.intents = pruneIntents(ledger.intents);
    writeLedger(ledger);
    return toView(ledger);
  });
}

export async function transact(payload: IntentPayload, options: { force?: boolean; priority?: Priority } = {}) {
  const intent = await prepareIntent(payload, options);
  return commitIntent(intent.id, options);
}

export async function cancelIntent(intentId: string) {
  return withLock('conference-ledger-v2-write', () => {
    const clientId = getClientId();
    const ledger = readLatest(clientId);
    const intent = ledger.intents.find((item) => item.id === intentId);
    if (intent && intent.status !== 'committed') {
      intent.status = 'cancelled';
      intent.updatedAt = nowIso();
      writeLedger(ledger);
    }
    return toView(ledger);
  });
}

export async function recoverIntent(intentId: string, force = false) {
  return commitIntent(intentId, { force });
}

export async function openLedger() {
  if (typeof localStorage === 'undefined') return peekView();
  return withLock('conference-ledger-v2-write', () => {
    const clientId = getClientId();
    let ledger: Ledger;
    const existingRaw = localStorage.getItem(LEDGER_KEY);
    const existing = parseLedger(existingRaw, clientId);
    if (existing) {
      ledger = existing;
    } else {
      ledger = emptyLedger(clientId, false);
      const legacyRaw = localStorage.getItem(LEGACY_STATE_KEY);
      if (legacyRaw) {
        const legacy = normalizeState(JSON.parse(legacyRaw) as ConferenceState);
        const at = nowIso();
        ledger.events.push({ id: createId('evt'), seq: 1, at, sourceIntentId: 'schema-migration-v1-v2', priority: 'critical', payload: { type: 'snapshot-imported', state: legacy, sourceVersion: 1 } });
        if (legacy.activeRoomId) localStorage.setItem(ACTIVE_ROOM_KEY, legacy.activeRoomId);
        if (legacy.lowLatency) localStorage.setItem(LOW_LATENCY_KEY, '1');
      } else {
        const seeded = emptyLedger(clientId, true);
        ledger.events = seeded.events;
      }
      writeLedger(ledger);
    }

    for (const intent of ledger.intents) {
      if (intent.status !== 'prepared' || intent.attempts > 0) continue;
      try {
        const planned = plan(ledger, intent);
        if ('error' in planned) failIntent(ledger, intent, planned.error, planned.kind);
        else {
          if (!planned.idempotent) ledger.events.push(eventBase(ledger, intent, planned.event));
          intent.status = 'committed';
          intent.resolution = planned.idempotent ? 'idempotent' : 'recovered';
          intent.updatedAt = nowIso();
        }
      } catch (error) {
        failIntent(ledger, intent, error instanceof Error ? error.message : '恢复失败', 'recovery');
      }
    }
    ledger.intents = pruneIntents(ledger.intents);
    writeLedger(ledger);
    return toView(ledger);
  });
}

export function readStoredPreference(key: string, fallback: string) {
  if (typeof localStorage === 'undefined') return fallback;
  return localStorage.getItem(key) ?? fallback;
}

export function writeStoredPreference(key: string, value: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
}

export function currentCaptionsFor(view: Pick<LedgerView, 'captions'>, roomId: string) {
  const current = new Map<string, Caption>();
  for (const caption of view.captions.filter((item) => item.roomId === roomId)) {
    const key = `${caption.speechId}:${caption.language}`;
    if (!current.has(key)) current.set(key, caption);
  }
  return [...current.values()];
}

export function isHandoffStale(channel: Channel, at = Date.now()) {
  return channel.status === 'handoff' && !!channel.handoffStartedAt && at - new Date(channel.handoffStartedAt).getTime() > HANDOFF_TTL_MS;
}

export function makeCaptionContext(channel: Channel, speechId: string, roomId: string, text: string): Extract<IntentPayload, { type: 'caption-submit' }> {
  if (channel.status === 'handoff') {
    return { type: 'caption-submit', roomId, speechId, language: channel.language, text, interpreterId: channel.id, interpreter: channel.handoffFrom ?? channel.interpreter, epoch: channel.handoffEpoch ? channel.handoffEpoch - 1 : channel.epoch };
  }
  return { type: 'caption-submit', roomId, speechId, language: channel.language, text, interpreterId: channel.id, interpreter: channel.interpreter, epoch: channel.epoch };
}

export const queueFormSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
export type QueueForm = z.infer<typeof queueFormSchema>;
export const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
