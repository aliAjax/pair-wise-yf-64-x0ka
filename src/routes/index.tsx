import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  ACTIVE_ROOM_KEY,
  LOW_LATENCY_KEY,
  cancelIntent,
  captionSchema,
  isHandoffStale,
  makeCaptionContext,
  openLedger,
  peekView,
  queueFormSchema,
  readStoredPreference,
  recoverIntent,
  subscribe,
  transact,
  writeStoredPreference,
  type Channel,
  type Caption,
  type ConferenceState,
  type Intent,
  type LedgerEvent,
  type LedgerView,
  type QueueForm,
  type Speech
} from '~/ledger';

type Notice = { tone: 'ok' | 'warn' | 'error'; text: string } | undefined;

const statusText: Record<Speech['status'] | '', string> = {
  '': '未知',
  queued: '等待中',
  speaking: '发言中',
  done: '已完成',
  skipped: '已跳过'
};

const priorityText = { critical: '关键', high: '高', normal: '普通', low: '低' } as const;

function eventSummary(event: LedgerEvent) {
  const payload = event.payload;
  switch (payload.type) {
    case 'snapshot-imported': return `本地数据升级到 v2（来源 v${payload.sourceVersion}）`;
    case 'queue-added': return `${payload.speech.speaker} 加入队列`;
    case 'queue-status-changed': return `发言切换：${statusText[payload.from] || '未知'} → ${statusText[payload.to]}`;
    case 'queue-time-adjusted': return `剩余时间调整 ${payload.deltaSeconds} 秒`;
    case 'handoff-started': return `${payload.language} 频道开始交接：冻结 ${payload.fromInterpreter} 区间`;
    case 'handoff-completed': return `${payload.language} 频道交接完成：${payload.fromInterpreter} → ${payload.toInterpreter}`;
    case 'caption-submitted': return `字幕 v${payload.caption.revision} 归属 ${payload.caption.interpreter}`;
    case 'term-approved': return `术语 ${payload.termId} 已批准`;
    case 'audit-logged': return payload.message;
  }
}

function captionBadge(caption: Caption) {
  if (caption.isCurrent) return '当前版本';
  if (caption.outcome === 'stale-handoff') return '旧译员·已保留';
  if (caption.outcome === 'retained-conflict') return '冲突版本·已保留';
  return '历史版本';
}

export default component$(() => {
  const locale = useSpeakLocale();
  const initialView = peekView();
  const state = useStore<ConferenceState>({
    rooms: initialView.rooms,
    activeRoomId: initialView.activeRoomId,
    speechQueue: initialView.speechQueue,
    channels: initialView.channels,
    terms: initialView.terms,
    captions: initialView.captions,
    audits: initialView.audits,
    lowLatency: initialView.lowLatency
  });
  const ledger = useSignal<Pick<LedgerView, 'version' | 'intents' | 'conflicts' | 'events'>>({
    version: initialView.version,
    intents: initialView.intents,
    conflicts: initialView.conflicts,
    events: initialView.events
  });
  const activeRoomId = useSignal(readStoredPreference(ACTIVE_ROOM_KEY, initialView.activeRoomId));
  const lowLatency = useSignal(readStoredPreference(LOW_LATENCY_KEY, initialView.lowLatency ? '1' : '') === '1');
  const notice = useSignal<Notice>(undefined);
  const handoffDrafts = useStore<Record<string, string>>({});
  const captionLoader = useSignal({ text: '' });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueFormSchema)
  });

  const syncFromLedger = $(() => {
    const view = peekView();
    state.rooms = view.rooms;
    state.activeRoomId = view.activeRoomId;
    state.speechQueue = view.speechQueue;
    state.channels = view.channels;
    state.terms = view.terms;
    state.captions = view.captions;
    state.audits = view.audits;
    state.lowLatency = view.lowLatency || lowLatency.value;
    ledger.value = { version: view.version, intents: view.intents, conflicts: view.conflicts, events: view.events };
  });

  const report = $((tone: 'ok' | 'warn' | 'error', text: string) => {
    notice.value = { tone, text };
  });

  useVisibleTask$(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const resume = () => {
      if (document.hidden || cancelled) return;
      void openLedger().then(() => { if (!cancelled) return syncFromLedger(); }).catch((error: unknown) => {
        if (!cancelled) report('error', error instanceof Error ? error.message : '账本恢复失败');
      });
    };
    openLedger().then(() => { if (!cancelled) return syncFromLedger(); }).catch((error: unknown) => {
      if (!cancelled) report('error', error instanceof Error ? error.message : '账本打开失败');
    });
    unsubscribe = subscribe(() => { if (!cancelled) syncFromLedger(); });
    document.addEventListener('visibilitychange', resume);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', resume);
      unsubscribe?.();
    };
  });

  const activeRoom = () => state.rooms.find((room) => room.id === activeRoomId.value) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === activeRoomId.value);
  const roomChannels = () => state.channels.filter((item) => item.roomId === activeRoomId.value);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const openIntents = () => ledger.value.intents.filter((intent) => intent.status === 'prepared' || intent.status === 'failed');
  const roomAudits = () => state.audits.filter((audit) => audit.roomId === activeRoomId.value).slice(0, 8);
  const roomConflicts = () => ledger.value.conflicts.filter((conflict) => !conflict.roomId || conflict.roomId === activeRoomId.value).slice(0, 6);
  const roomCaptions = () => state.captions.filter((caption) => caption.roomId === activeRoomId.value).slice(0, 12);

  const selectRoom$ = $(async (roomId: string) => {
    activeRoomId.value = roomId;
    writeStoredPreference(ACTIVE_ROOM_KEY, roomId);
    await transact({ type: 'audit-logged', roomId, message: `切换到 ${state.rooms.find((room) => room.id === roomId)?.name ?? roomId}` });
    await syncFromLedger();
  });

  const toggleLowLatency$ = $(() => {
    lowLatency.value = !lowLatency.value;
    writeStoredPreference(LOW_LATENCY_KEY, lowLatency.value ? '1' : '');
    report('ok', lowLatency.value ? '低延迟模式已开启：队列、交接和已确认字幕仍完整落账。' : '低延迟模式已退出。');
  });

  const addSpeech$ = $(async (values: QueueForm) => {
    try {
      await transact({
        type: 'queue-add',
        roomId: activeRoomId.value,
        speech: {
          speaker: values.speaker,
          delegation: values.delegation,
          language: values.language,
          topic: values.topic,
          plannedSeconds: values.plannedSeconds
        }
      });
      queueLoader.value = { speaker: '', delegation: '', language: values.language, topic: '', plannedSeconds: 300 };
      await report('ok', '入队意图已先写入账本并原子提交。');
    } catch (error) {
      await report('error', error instanceof Error ? error.message : '入队失败');
    } finally {
      await syncFromLedger();
    }
  });

  const changeSpeechStatus$ = $(async (speech: Speech, next: Speech['status']) => {
    try {
      await transact({ type: 'queue-status', roomId: speech.roomId, speechId: speech.id, status: next });
      await report('ok', '发言切换已提交；冲突会在事件账本中保留并可恢复。');
    } catch (error) {
      await report('warn', error instanceof Error ? error.message : '发言切换冲突，可在下方恢复');
    } finally {
      await syncFromLedger();
    }
  });

  const adjustTime$ = $(async (speech: Speech, deltaSeconds: number) => {
    try {
      await transact({ type: 'queue-adjust-time', roomId: speech.roomId, speechId: speech.id, deltaSeconds }, { priority: 'low' });
    } catch (error) {
      await report('warn', error instanceof Error ? error.message : '时间调整冲突');
    } finally {
      await syncFromLedger();
    }
  });

  const startHandoff$ = $(async (channel: Channel) => {
    try {
      await transact({ type: 'handoff-start', roomId: channel.roomId, channelId: channel.id }, { priority: 'high' });
      handoffDrafts[channel.id] ??= '';
      await report('ok', `交接单已持久化：${channel.interpreter} 的旧译文区间冻结，关页后仍可继续。`);
    } catch (error) {
      await report('warn', error instanceof Error ? error.message : '交接启动失败');
    } finally {
      await syncFromLedger();
    }
  });

  const completeHandoff$ = $(async (channel: Channel) => {
    if (channel.status !== 'handoff' || !channel.handoffFrom || !channel.handoffEpoch) return;
    const toInterpreter = handoffDrafts[channel.id]?.trim() || `替补译员-${channel.language}`;
    try {
      await transact({
        type: 'handoff-complete',
        roomId: channel.roomId,
        channelId: channel.id,
        toInterpreter,
        fromInterpreter: channel.handoffFrom,
        handoffEpoch: channel.handoffEpoch
      }, { priority: 'critical' });
      handoffDrafts[channel.id] = '';
      await report('ok', `交接原子完成；此后字幕归属 ${toInterpreter}，旧译员迟到修订只会保留为历史版本。`);
    } catch (error) {
      await report('warn', error instanceof Error ? error.message : '交接完成失败，意图已保留，可恢复');
    } finally {
      await syncFromLedger();
    }
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = currentSpeech();
    const channel = roomChannels().find((item) => item.language === '中文');
    if (!speech || !channel) {
      await report('warn', '当前厅没有发言或中文频道，无法提交字幕。');
      return;
    }
    try {
      await transact(makeCaptionContext(channel, speech.id, speech.roomId, values.text.trim()), { priority: 'high' });
      captionLoader.value = { text: '' };
      await report('ok', '字幕修订已追加为不可覆盖的版本；即使冲突也不会删除已确认文本。');
    } catch (error) {
      await report('error', error instanceof Error ? error.message : '字幕提交失败，可从意图列表恢复');
    } finally {
      await syncFromLedger();
    }
  });

  const approveTerm$ = $(async (termId: string) => {
    await transact({ type: 'term-approve', termId }, { priority: 'normal' });
    await syncFromLedger();
  });

  const retryIntent$ = $(async (intent: Intent, force: boolean) => {
    try {
      await recoverIntent(intent.id, force);
      await report('ok', force ? '已按关键优先级重新合并。' : '未完成意图已恢复提交。');
    } catch (error) {
      await report('warn', error instanceof Error ? error.message : '恢复失败');
    } finally {
      await syncFromLedger();
    }
  });

  const cancelIntent$ = $(async (intentId: string) => {
    await cancelIntent(intentId);
    await syncFromLedger();
  });

  const noticeClass = () => `notice ${notice.value?.tone ?? ''}`;

  return (
    <main class={`conference-shell ${lowLatency.value ? 'low-latency' : ''}`}>
      <header class="hero">
        <div>
          <span class="pill">{locale.lang} · 事件账本 v2 · seq {ledger.value.version}</span>
          <h1>同声传译与发言队列</h1>
          <p>{activeRoom().name} · {activeRoom().topic}</p>
        </div>
        <div class="header-actions">
          <select value={activeRoomId.value} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>
            {state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}
          </select>
          <button class="secondary" onClick$={toggleLowLatency$}>{lowLatency.value ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      {notice.value && <div class={noticeClass()}>{notice.value.text}</div>}

      <section class="ledger-strip panel">
        <div><b>原子提交</b><span>先持久化意图，再在跨标签页锁内追加事件</span></div>
        <div><b>待恢复</b><span>{openIntents().length} 条</span></div>
        <div><b>冲突记录</b><span>{ledger.value.conflicts.length} 条，字幕只保留不覆盖</span></div>
        <div><b>低延迟</b><span>{lowLatency.value ? '仅停用装饰动态，关键状态仍落账' : '完整动态模式'}</span></div>
      </section>

      <section class="grid">
        <article class="panel">
          <div class="panel-title"><h2>发言队列</h2><span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span></div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div class="muted">{speech.delegation} · {speech.language} · {speech.topic}</div>
                <div class="muted">剩余 {Math.floor(speech.remainingSeconds / 60)}:{String(speech.remainingSeconds % 60).padStart(2, '0')}</div>
              </div>
              <span class="pill">{statusText[speech.status]}</span>
              <div class="button-stack">
                {speech.status === 'queued' && <button onClick$={() => changeSpeechStatus$(speech, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && <button onClick$={() => changeSpeechStatus$(speech, 'done')}>结束</button>}
                {(speech.status === 'queued' || speech.status === 'speaking') && <button class="secondary" onClick$={() => adjustTime$(speech, -60)}>减1分钟</button>}
                {speech.status === 'queued' && <button class="danger" onClick$={() => changeSpeechStatus$(speech, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <QueueForm class="queue-form" onSubmit$={addSpeech$}>
            <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
            <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
            <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
            <QueueField name="language">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="源语言" />}</QueueField>
            <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
            <button type="submit">记录意图并入队</button>
          </QueueForm>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div class="channel-row" key={channel.id}>
              <div class="panel-title">
                <b>{channel.language} · {channel.interpreter}</b>
                <span class={`pill ${channel.status === 'handoff' ? 'warning' : ''}`}>{channel.status === 'handoff' ? `交接中 · 第${channel.handoffEpoch ?? channel.epoch + 1}代` : '值守中'}</span>
              </div>
              {!lowLatency.value && <Progress.Root class="decorative" value={channel.health} max={100} />}
              {channel.status === 'handoff' && (
                <div class="handoff-box">
                  <span>{channel.handoffFrom} 的译文区间已冻结；迟到旧译文不会记到新译员名下。</span>
                  {isHandoffStale(channel) && <b>交接超过 10 分钟：可关页重开后继续同一张交接单。</b>}
                  <input value={handoffDrafts[channel.id] ?? ''} onInput$={(event) => handoffDrafts[channel.id] = (event.target as HTMLInputElement).value} placeholder={`接替译员，默认：替补译员-${channel.language}`} />
                </div>
              )}
              <div class="button-stack">
                {channel.status !== 'handoff' && <button class="secondary" onClick$={() => startHandoff$(channel)}>开始交接</button>}
                {channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel)}>原子完成交接</button>}
              </div>
            </div>
          ))}

          <h3>实时字幕修正</h3>
          {currentSpeech() ? (
            <CaptionForm onSubmit$={publishCaption$}>
              <CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前中文字幕" />}</CaptionField>
              <button type="submit">先记录意图，再提交新版</button>
            </CaptionForm>
          ) : <p>当前没有发言中的代表。</p>}
          <div class="caption-list">
            {roomCaptions().map((caption) => (
              <div class={`caption-card ${caption.isCurrent ? 'current' : 'retained'}`} key={`${caption.id}-${caption.revision}`}>
                <div class="panel-title"><b>{caption.interpreter} · v{caption.revision}</b><span class="pill">{captionBadge(caption)}</span></div>
                <p>{caption.text}</p>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section class="grid bottom-grid">
        <article class="panel">
          <h2>意图、冲突与恢复</h2>
          {openIntents().length === 0 && <p class="muted">没有未完成提交。所有操作均已追加到事件流。</p>}
          {openIntents().map((intent) => (
            <div class="intent-row" key={intent.id}>
              <div>
                <b>{intent.type}</b>
                <div class="muted">优先级：{priorityText[intent.priority]} · 基于 seq {intent.baseVersion} · 尝试 {intent.attempts} 次</div>
                {intent.lastError && <div class="error-text">{intent.lastError}</div>}
              </div>
              <div class="button-stack">
                <button onClick$={() => retryIntent$(intent, false)}>恢复提交</button>
                <button class="secondary" onClick$={() => retryIntent$(intent, true)}>按高优先级合并</button>
                <button class="danger" onClick$={() => cancelIntent$(intent.id)}>取消</button>
              </div>
            </div>
          ))}
          <h3>本厅冲突合并记录</h3>
          {roomConflicts().length === 0 && <p class="muted">暂无冲突。</p>}
          {roomConflicts().map((conflict) => (
            <div class="conflict-row" key={conflict.id}>
              <b>{conflict.kind}</b>
              <span>{conflict.message}</span>
            </div>
          ))}
        </article>

        <article class="panel">
          <h2>可恢复事件流</h2>
          {ledger.value.events.slice(-10).reverse().map((event) => (
            <div class="event-row" key={event.id}>
              <span class="seq">#{event.seq}</span>
              <div><div>{eventSummary(event)}</div><small>{new Date(event.at).toLocaleTimeString()} · {priorityText[event.priority]}</small></div>
            </div>
          ))}
          <h3>操作时间线</h3>
          {roomAudits().map((audit) => <div class="timeline-row" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>

      <section class="panel terms-panel">
        <h2>术语库</h2>
        <div class="terms-grid">
          {state.terms.map((term) => (
            <div class="term-row" key={term.id}>
              <div><b>{term.phrase}</b><div class="muted">{term.translation} · {term.language}</div></div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '事件溯源、可恢复的发言队列、译员交接与字幕修订本地账本' }]
};
