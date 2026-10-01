import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  adoptLedger,
  commitIntent,
  conflictIntents,
  deriveState,
  getLedger,
  loadLedger,
  pendingHandoffs,
  retryIntent,
  rollbackIntent,
  simulateOtherTabCommit,
  uncommittedIntents
} from '~/ledger/ledger';
import { LEDGER_KEY, PRIORITY, type ConferenceState } from '~/ledger/types';

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
const fmtClock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(deriveState(getLedger()));
  const toasts = useSignal<string[]>([]);
  const reviseDrafts = useStore<Record<string, string>>({});
  const completeDrafts = useStore<Record<string, string>>({});

  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  const pushToast$ = $((message: string) => {
    toasts.value = [...toasts.value, message];
    setTimeout(() => {
      toasts.value = toasts.value.slice(1);
    }, 4000);
  });

  const syncState$ = $(() => {
    const derived = deriveState(getLedger());
    Object.assign(state, derived);
  });

  // 客户端启动：加载账本（含 v1 迁移），并监听其他标签页的提交
  useVisibleTask$(() => {
    const ledger = loadLedger();
    adoptLedger(getLedger(), ledger);
    syncState$();

    const onStorage = (event: StorageEvent) => {
      if (event.key !== LEDGER_KEY) return;
      const fresh = loadLedger();
      adoptLedger(getLedger(), fresh);
      syncState$();
      pushToast$('已同步其他标签页的最新提交');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const roomCaptions = () =>
    state.captions
      .filter((caption) => caption.roomId === state.activeRoomId)
      .sort((a, b) => b.at.localeCompare(a.at));

  const conflicts = () => conflictIntents(getLedger());
  const handoffs = () => pendingHandoffs(getLedger()).filter((item) => item.channel.roomId === state.activeRoomId);
  const uncommitted = () => uncommittedIntents(getLedger()).filter((item) => item.roomId === state.activeRoomId);

  const selectRoom$ = $((roomId: string) => {
    const result = commitIntent(getLedger(), {
      type: 'room.switch',
      roomId,
      payload: { roomId },
      priority: PRIORITY.roomSwitch
    });
    if (result.ok) {
      syncState$();
      if (result.merged) pushToast$('会议厅切换已与其他标签页的操作合并');
    }
  });

  const addSpeech$ = $((values: QueueForm) => {
    const speech = {
      id: crypto.randomUUID(),
      roomId: state.activeRoomId,
      ...values,
      remainingSeconds: values.plannedSeconds,
      status: 'queued' as const,
      updatedAt: new Date().toISOString()
    };
    const result = commitIntent(getLedger(), {
      type: 'queue.add',
      roomId: state.activeRoomId,
      payload: { speech },
      priority: PRIORITY.queueAdd
    });
    if (result.ok) {
      syncState$();
      pushToast$(`${values.speaker} 已加入发言队列`);
    }
  });

  const advanceSpeech$ = $((speechId: string, status: 'speaking' | 'done' | 'skipped') => {
    const result = commitIntent(getLedger(), {
      type: 'queue.status',
      roomId: state.activeRoomId,
      payload: { speechId, status },
      priority: PRIORITY.queueStatus
    });
    if (result.ok) {
      syncState$();
      if (result.merged) pushToast$('队列状态已按优先级与其他标签页合并');
    } else {
      pushToast$(result.reason ?? '队列状态冲突，已保留待处理');
    }
  });

  const adjustRemaining$ = $((speechId: string, delta: number) => {
    const speech = state.speechQueue.find((item) => item.id === speechId);
    if (!speech) return;
    const remainingSeconds = Math.max(0, speech.remainingSeconds + delta);
    commitIntent(getLedger(), {
      type: 'queue.remaining',
      roomId: state.activeRoomId,
      payload: { speechId, remainingSeconds },
      priority: PRIORITY.queueStatus
    });
    syncState$();
  });

  const startHandoff$ = $((channelId: string) => {
    const channel = state.channels.find((item) => item.id === channelId);
    if (!channel) return;
    const result = commitIntent(getLedger(), {
      type: 'handoff.start',
      roomId: state.activeRoomId,
      payload: { channelId, outgoingInterpreter: channel.interpreter },
      priority: PRIORITY.handoffStart
    });
    if (result.ok) {
      syncState$();
      pushToast$(`${channel.language} 频道开始交接，交接期间字幕归 ${channel.interpreter}`);
    } else {
      pushToast$(result.reason ?? '交接启动失败');
    }
  });

  const completeHandoff$ = $((channelId: string) => {
    const channel = state.channels.find((item) => item.id === channelId);
    if (!channel) return;
    const interpreter = completeDrafts[channelId]?.trim() || `替补译员-${channel.language}`;
    const result = commitIntent(getLedger(), {
      type: 'handoff.complete',
      roomId: state.activeRoomId,
      payload: { channelId, interpreter },
      priority: PRIORITY.handoffComplete
    });
    if (result.ok) {
      syncState$();
      pushToast$(`${interpreter} 已接续 ${channel.language} 频道`);
    } else {
      pushToast$(result.reason ?? '交接完成失败');
    }
  });

  const publishCaption$ = $((values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    const channel = state.channels.find((item) => item.roomId === speech.roomId && item.language === '中文');
    const caption = {
      id: crypto.randomUUID(),
      speechId: speech.id,
      roomId: speech.roomId,
      language: '中文',
      interpreter: channel?.interpreter ?? '中文',
      text: values.text.trim(),
      revision: 1,
      revisions: [{ rev: 1, text: values.text.trim(), at: new Date().toISOString(), interpreter: channel?.interpreter ?? '中文' }],
      at: new Date().toISOString()
    };
    const result = commitIntent(getLedger(), {
      type: 'caption.publish',
      roomId: speech.roomId,
      payload: { caption },
      priority: PRIORITY.caption
    });
    if (result.ok) {
      syncState$();
      captionLoader.value = { text: '' };
      if (result.merged) pushToast$('字幕已与其他标签页的修订合并，历史版本均保留');
    } else {
      pushToast$(result.reason ?? '字幕提交失败，已保留为待处理');
    }
  });

  const reviseCaption$ = $((captionId: string) => {
    const text = (reviseDrafts[captionId] ?? '').trim();
    if (!text) return;
    const caption = state.captions.find((item) => item.id === captionId);
    if (!caption) return;
    const result = commitIntent(getLedger(), {
      type: 'caption.revise',
      roomId: caption.roomId,
      payload: { captionId, text, interpreter: caption.interpreter, rev: 0 },
      priority: PRIORITY.caption
    });
    if (result.ok) {
      reviseDrafts[captionId] = '';
      syncState$();
      if (result.merged) pushToast$('字幕修订已合并，旧版本未丢失');
    } else {
      pushToast$(result.reason ?? '字幕修订失败');
    }
  });

  const approveTerm$ = $((termId: string) => {
    commitIntent(getLedger(), {
      type: 'term.approve',
      roomId: 'global',
      payload: { termId },
      priority: PRIORITY.termApprove
    });
    syncState$();
  });

  const toggleLowLatency$ = $(() => {
    const ledger = getLedger();
    ledger.lowLatency = !ledger.lowLatency;
    commitIntent(ledger, {
      type: 'audit.log',
      roomId: state.activeRoomId,
      payload: {
        audit: {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          roomId: state.activeRoomId,
          message: ledger.lowLatency ? '已切换到低延迟模式，关键状态继续持久化' : '已退出低延迟模式'
        }
      },
      priority: PRIORITY.audit
    });
    syncState$();
  });

  const retryConflict$ = $((intentId: string) => {
    const result = retryIntent(getLedger(), intentId);
    if (result?.ok) {
      syncState$();
      pushToast$('已基于最新版本重新提交并合并');
    } else {
      pushToast$(result?.reason ?? '仍无法自动合并');
    }
  });

  const rollbackConflict$ = $((intentId: string) => {
    rollbackIntent(getLedger(), intentId);
    syncState$();
  });

  const simulateOtherTab$ = $(() => {
    if (simulateOtherTabCommit(getLedger())) {
      syncState$();
      pushToast$('已模拟另一标签页并发提交，下次提交将触发冲突合并');
    }
  });

  const currentChannel = () =>
    currentSpeech() ? state.channels.find((item) => item.roomId === currentSpeech()!.roomId && item.language === '中文') : undefined;

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      {toasts.value.length > 0 && (
        <div style="position:fixed;top:16px;right:16px;z-index:50;display:flex;flex-direction:column;gap:8px;max-width:320px">
          {toasts.value.map((toast, index) => (
            <div key={index} class="pill" style="background:#0d7772;color:#fff;padding:10px 14px;box-shadow:0 8px 20px rgba(0,0,0,.15)">{toast}</div>
          ))}
        </div>
      )}

      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>{activeRoom().name} · {activeRoom().topic}</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <span class="pill" style="background:#eef6f5;color:#456">● 多标签页同步已启用</span>
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>
            {state.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </select>
          <button class="secondary" onClick$={toggleLowLatency$}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      {conflicts().length > 0 && (
        <section class="panel" style="margin-bottom:18px;border-color:#f0c4bf;background:#fdf3f2">
          <h2 style="margin-top:0">检测到多标签页冲突</h2>
          {conflicts().map((intent) => (
            <div key={intent.id} style="padding:10px 0;border-bottom:1px solid #f0c4bf;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
              <div>
                <b>{intent.type}</b>
                <div style="color:#8a4a45;font-size:13px">{intent.error ?? '与其他标签页的提交冲突'}</div>
                <div style="color:#638087;font-size:12px">意图于 {fmtTime(intent.createdAt)} 记录，已尝试 {intent.attempts} 次</div>
              </div>
              <div style="display:flex;gap:8px">
                <button onClick$={() => retryConflict$(intent.id)}>按优先级重新合并</button>
                <button class="secondary" onClick$={() => rollbackConflict$(intent.id)}>放弃本意图</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {handoffs().length > 0 && (
        <section class="panel" style="margin-bottom:18px;border-color:#f0d9a8;background:#fdf8ec">
          <h2 style="margin-top:0">未完成的译员交接（关页/超时后仍可继续）</h2>
          {handoffs().map(({ channel, startedAt, timedOut }) => (
            <div key={channel.id} style="padding:10px 0;border-bottom:1px solid #f0d9a8;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
              <div>
                <b>{channel.language} · {channel.interpreter} → 交接中</b>
                <div style="color:#8a6d2f;font-size:13px">
                  {startedAt ? `始于 ${fmtTime(startedAt)}` : ''}
                  {timedOut ? ' · 已超时，可继续完成' : ''}
                  {' · 期间字幕仍归 '}{channel.outgoingInterpreter}
                </div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <input
                  style="width:200px"
                  placeholder={`替补译员-${channel.language}`}
                  value={completeDrafts[channel.id] ?? ''}
                  onInput$={(event) => (completeDrafts[channel.id] = (event.target as HTMLInputElement).value)}
                />
                <button onClick$={() => completeHandoff$(channel.id)}>继续并完成交接</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {uncommitted().length > 0 && (
        <section class="panel" style="margin-bottom:18px;border-color:#d5e5e3;background:#f6fbfa">
          <h2 style="margin-top:0">已记录意图但尚未提交</h2>
          {uncommitted().map((intent) => (
            <div key={intent.id} style="padding:8px 0;display:flex;justify-content:space-between;gap:12px;align-items:center">
              <div>
                <b>{intent.type}</b>
                <div style="color:#638087;font-size:12px">{fmtTime(intent.createdAt)} · 提交失败后可在此恢复</div>
              </div>
              <button class="secondary" onClick$={() => retryConflict$(intent.id)}>重新提交</button>
            </div>
          ))}
        </section>
      )}

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div>
                <div style="color:#086764;font-size:12px">剩余 {fmtClock(speech.remainingSeconds)} / {fmtClock(speech.plannedSeconds)}</div>
              </div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && (
                  <>
                    <button onClick$={() => advanceSpeech$(speech.id, 'done')}>结束</button>
                    <button class="secondary" onClick$={() => adjustRemaining$(speech.id, -60)}>减1分钟</button>
                    <button class="secondary" onClick$={() => adjustRemaining$(speech.id, 60)}>加1分钟</button>
                  </>
                )}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(speech.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">
                {(field, props) => (
                  <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="发言人" />
                )}
              </QueueField>
              <QueueField name="delegation">
                {(field, props) => (
                  <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="代表团" />
                )}
              </QueueField>
              <QueueField name="topic">
                {(field, props) => (
                  <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="议题" />
                )}
              </QueueField>
              <QueueField name="plannedSeconds" type="number">
                {(field, props) => (
                  <input {...props} type="number" value={field.value} onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))} placeholder="计划秒数" />
                )}
              </QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between">
                <b>{channel.language} · {channel.interpreter}</b>
                <span class="pill">{channel.status === 'handoff' ? `交接中（${channel.outgoingInterpreter} 仍在传译）` : channel.status}</span>
              </div>
              <div class="decorative" style="margin:8px 0">
                <Progress.Root value={channel.health} max={100} />
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                {channel.status !== 'handoff' && <button class="secondary" onClick$={() => startHandoff$(channel.id)}>开始交接</button>}
                {channel.status === 'handoff' && (
                  <>
                    <input
                      style="width:180px"
                      placeholder={`替补译员-${channel.language}`}
                      value={completeDrafts[channel.id] ?? ''}
                      onInput$={(event) => (completeDrafts[channel.id] = (event.target as HTMLInputElement).value)}
                    />
                    <button onClick$={() => completeHandoff$(channel.id)}>完成交接</button>
                  </>
                )}
              </div>
            </div>
          ))}

          <h3>实时字幕修正</h3>
          {currentSpeech() ? (
            <>
              {currentChannel()?.status === 'handoff' && (
                <div class="pill" style="background:#fdf3f2;color:#8a4a45;margin-bottom:8px">
                  交接期间到达的字幕将记为 {currentChannel()?.outgoingInterpreter}，不会落到新译员名下
                </div>
              )}
              <CaptionForm onSubmit$={publishCaption$}>
                <CaptionField name="text">
                  {(field, props) => (
                    <textarea
                      {...props}
                      rows={3}
                      value={field.value}
                      onInput$={(event) => (field.value = (event.target as HTMLTextAreaElement).value)}
                      placeholder="输入或修正当前字幕"
                    />
                  )}
                </CaptionField>
                <button type="submit">提交新版字幕</button>
              </CaptionForm>
            </>
          ) : (
            <p>当前没有发言中的代表。</p>
          )}
          {roomCaptions().map((caption) => (
            <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}>
              <b>{caption.interpreter} · v{caption.revision}</b>
              <p style="margin:6px 0">{caption.text}</p>
              <details style="font-size:12px;color:#638087">
                <summary>历史版本（{caption.revisions.length}）</summary>
                {caption.revisions.map((revision) => (
                  <div key={revision.rev} style="padding:4px 0">
                    v{revision.rev} · {revision.interpreter} · {fmtTime(revision.at)} — {revision.text}
                  </div>
                ))}
              </details>
              <div style="display:flex;gap:6px;margin-top:6px">
                <input
                  style="flex:1"
                  placeholder="修正为新版本"
                  value={reviseDrafts[caption.id] ?? ''}
                  onInput$={(event) => (reviseDrafts[caption.id] = (event.target as HTMLInputElement).value)}
                />
                <button class="secondary" onClick$={() => reviseCaption$(caption.id)}>修订</button>
              </div>
            </div>
          ))}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => (
            <div class="queue-row" key={term.id}>
              <span />
              <div>
                <b>{term.phrase}</b>
                <div>{term.translation} · {term.language}</div>
              </div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button>
            </div>
          ))}
        </article>
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>操作与交接时间线</h2>
            <button class="secondary" style="font-size:12px;padding:6px 10px" onClick$={simulateOtherTab$}>模拟另一标签页并发</button>
          </div>
          {state.audits
            .filter((audit) => audit.roomId === state.activeRoomId)
            .slice(0, 10)
            .map((audit) => (
              <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}>
                <small>{fmtTime(audit.at)}</small>
                <div>{audit.message}</div>
              </div>
            ))}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
