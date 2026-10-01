// 事件溯源账本的类型定义：发言队列、频道、字幕、译员交接

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type ChannelStatus = 'active' | 'handoff' | 'standby';

export type Room = {
  id: string;
  name: string;
  topic: string;
  simultaneousChannels: number;
};

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
  status: ChannelStatus;
  health: number;
  /** 交接启动时记录的旧译员，交接期间到达的字幕归到其名下 */
  outgoingInterpreter?: string;
};

export type Term = {
  id: string;
  phrase: string;
  translation: string;
  language: string;
  approved: boolean;
};

export type CaptionRevision = {
  rev: number;
  text: string;
  at: string;
  interpreter: string;
};

export type Caption = {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  interpreter: string;
  text: string;
  revision: number;
  revisions: CaptionRevision[];
  at: string;
};

export type Audit = {
  id: string;
  at: string;
  roomId: string;
  message: string;
};

/** 由事件流回放得到的可读状态 */
export type ConferenceState = {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
};

export type LedgerEventType =
  | 'room.switch'
  | 'queue.add'
  | 'queue.status'
  | 'queue.remaining'
  | 'channel.upsert'
  | 'handoff.start'
  | 'handoff.complete'
  | 'caption.publish'
  | 'caption.revise'
  | 'term.upsert'
  | 'term.approve'
  | 'audit.log';

export type LedgerEvent = {
  id: string;
  /** 单调递增的事件序号，用于乐观并发控制 */
  seq: number;
  roomId: string;
  at: string;
  type: LedgerEventType;
  payload: Record<string, any>;
};

export type IntentStatus = 'pending' | 'committed' | 'conflict' | 'rolled-back';

/** 意图：先持久化，再尝试原子提交；提交失败也能据此恢复 */
export type PendingIntent = {
  id: string;
  roomId: string;
  type: LedgerEventType;
  payload: Record<string, any>;
  /** 意图基于的账本版本，提交时比对 */
  baseSeq: number;
  priority: number;
  createdAt: string;
  status: IntentStatus;
  attempts: number;
  /** 与之冲突的其他标签页事件 id */
  conflictWith?: string[];
  merged?: boolean;
  resultEventId?: string;
  error?: string;
};

export type LedgerV2 = {
  version: 2;
  headSeq: number;
  rooms: Room[];
  events: LedgerEvent[];
  pending: PendingIntent[];
  activeRoomId: string;
  lowLatency: boolean;
};

/** 冲突合并优先级：数字越大越优先；已确认字幕最高，绝不丢弃 */
export const PRIORITY = {
  caption: 100,
  handoffComplete: 80,
  handoffStart: 70,
  queueStatus: 60,
  queueAdd: 50,
  termApprove: 30,
  roomSwitch: 10,
  audit: 0
} as const;

export const LEDGER_KEY = 'conference-interpretation-v2';
/** 意图单独存储：记录意图永不覆盖事件流 */
export const PENDING_KEY = 'conference-interpretation-v2-pending';
export const LEGACY_KEY = 'conference-interpretation-v1';

/** 交接超时阈值：超时后未完成的交接仍可继续，仅在界面上标记 */
export const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;
