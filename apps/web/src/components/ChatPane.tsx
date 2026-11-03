import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  Conversation,
  ProviderPublic,
  ToolCall,
} from '@mayak/shared';
import { api, streamMessage } from '../api';
import { useI18n } from '../i18n';
import { MarkdownView } from './MarkdownView';
import { IconMenu, IconSend, IconStop } from './icons';

interface Props {
  conversationId: string | null;
  agentId: string;
  defaultProviderId: string | null;
  defaultModel: string | null;
  providers: ProviderPublic[];
  onMenu: () => void;
  onConversation: (conversation: Conversation) => void;
  onDeleted: (id: string) => void;
}

interface Choice {
  providerId: string;
  model: string;
  kind: ProviderPublic['kind'];
}

export function ChatPane({
  conversationId,
  agentId,
  defaultProviderId,
  defaultModel,
  providers,
  onMenu,
  onConversation,
  onDeleted,
}: Props) {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [pendingTools, setPendingTools] = useState<ToolCall[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const skipReload = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const choices = useMemo(() => flattenChoices(providers), [providers]);

  useEffect(() => {
    if (skipReload.current) {
      skipReload.current = false;
      return;
    }
    abortRef.current?.abort();
    setStreaming('');
    setReasoning('');
    setPendingTools([]);
    setBusy(false);
    setError('');
    setConfirmDelete(false);
    if (!conversationId) {
      setMessages([]);
      setTitle('');
      const first = choiceFor(choices, defaultProviderId, defaultModel);
      setChoice(first ? keyOf(first) : '');
      return;
    }
    let cancelled = false;
    void api.conversation(conversationId).then(
      (data) => {
        if (cancelled) return;
        setMessages(data.messages);
        setTitle(data.conversation.title);
        const match = choices.find(
          (item) =>
            item.providerId === data.conversation.providerId &&
            item.model === data.conversation.model,
        );
        const fallback = choiceFor(choices, defaultProviderId, defaultModel);
        setChoice(match ? keyOf(match) : fallback ? keyOf(fallback) : '');
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : t('error'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [conversationId, choices, t, defaultProviderId, defaultModel]);

  const scrollKey = `${messages.length}:${streaming}:${reasoning.length}:${pendingTools.length}:${messages.at(-1)?.id ?? ''}`;
  useEffect(() => {
    if (scrollKey.length === 0) return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [scrollKey]);

  const selected = choices.find((item) => keyOf(item) === choice) ?? choices[0];

  async function persistChoice(next: string, id: string | null) {
    setChoice(next);
    const item = choices.find((choiceItem) => keyOf(choiceItem) === next);
    if (!item || !id) return;
    const updated = await api.updateConversation(id, {
      providerId: item.providerId,
      model: item.model,
    });
    onConversation(updated);
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    if (!selected) {
      setError(t('noProviders'));
      return;
    }
    setError('');
    setBusy(true);
    setDraft('');
    let id = conversationId;
    try {
      if (!id) {
        const created = await api.createConversation({
          locale,
          agentId,
          providerId: selected.providerId,
          model: selected.model,
        });
        id = created.id;
        setTitle(created.title);
        skipReload.current = true;
        onConversation(created);
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming('');
      setReasoning('');
      setPendingTools([]);
      await streamMessage(
        id,
        {
          content,
          providerId: selected.providerId,
          model: selected.model,
          locale,
        },
        (event) => {
          if (event.type === 'text')
            setStreaming((current) => current + event.delta);
          if (event.type === 'reasoning')
            setReasoning((current) => current + event.delta);
          if (event.type === 'title') {
            setTitle(event.title);
            onConversation({
              id: id as string,
              title: event.title,
              agentId,
              providerId: selected.providerId,
              model: selected.model,
              createdAt: '',
              updatedAt: new Date().toISOString(),
            });
          }
          if (event.type === 'tool_start')
            setPendingTools((current) => [...current, event.call]);
          if (event.type === 'message') {
            if (event.message.role === 'assistant') {
              setStreaming('');
              setReasoning('');
            }
            if (event.message.role === 'tool') {
              setPendingTools((current) =>
                current.filter((call) => call.id !== event.message.toolCallId),
              );
            }
            setMessages((current) => {
              if (current.some((item) => item.id === event.message.id))
                return current;
              return [...current, event.message];
            });
          }
          if (event.type === 'error') setError(event.message);
        },
        controller.signal,
      );
      const fresh = await api.conversation(id);
      setMessages(fresh.messages);
      setTitle(fresh.conversation.title);
      onConversation(fresh.conversation);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        if (id) {
          const fresh = await api.conversation(id).catch(() => null);
          if (fresh) {
            setMessages(fresh.messages);
            setTitle(fresh.conversation.title);
          }
        }
      } else {
        setError(reason instanceof Error ? reason.message : t('error'));
      }
    } finally {
      setBusy(false);
      setStreaming('');
      setPendingTools([]);
      abortRef.current = null;
    }
  }

  async function rename(next: string) {
    if (!conversationId) return;
    const updated = await api.updateConversation(conversationId, {
      title: next.trim() || title,
    });
    setTitle(updated.title);
    onConversation(updated);
    setEditingTitle(false);
  }

  const hints = [
    { label: t('hintSkill'), text: 'skill summary' },
    { label: t('hintEcho'), text: 'echo привет из Маяка' },
    { label: t('hintAdd'), text: 'add 2 3' },
  ];

  return (
    <section className="chat">
      <header className="topbar">
        <button
          className="icon-btn menu-btn"
          type="button"
          onClick={onMenu}
          aria-label={t('menu')}
        >
          <IconMenu />
        </button>
        <div className="title-block">
          {conversationId && editingTitle ? (
            <input
              className="title-input"
              defaultValue={title}
              ref={(node) => node?.focus()}
              aria-label={t('edit')}
              onBlur={(event) => void rename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  void rename((event.target as HTMLInputElement).value);
                if (event.key === 'Escape') setEditingTitle(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="title-btn"
              onClick={() => conversationId && setEditingTitle(true)}
            >
              {conversationId ? title || t('newChat') : t('newChat')}
            </button>
          )}
        </div>
        <label className="model-pick">
          <span>{t('modelLabel')}</span>
          <select
            value={choice}
            onChange={(event) =>
              void persistChoice(event.target.value, conversationId)
            }
          >
            {providers
              .filter(
                (provider) => provider.enabled && provider.models.length > 0,
              )
              .map((provider) => (
                <optgroup key={provider.id} label={provider.name}>
                  {provider.models.map((model) => (
                    <option
                      key={`${provider.id}:${model}`}
                      value={`${provider.id}:${model}`}
                    >
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
        </label>
        {conversationId && (
          <button
            type="button"
            className={confirmDelete ? 'danger' : 'ghost slim'}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              void api
                .deleteConversation(conversationId)
                .then(() => onDeleted(conversationId));
            }}
          >
            {confirmDelete ? t('confirmDelete') : t('delete')}
          </button>
        )}
      </header>
      <div className="transcript" ref={scroller}>
        {messages.length === 0 && !streaming && (
          <div className="welcome">
            <p className="eyebrow">{t('brand')}</p>
            <h1>{t('emptyTitle')}</h1>
            <p>{t('emptyBody')}</p>
            <div className="hints">
              {hints.map((hint) => (
                <button
                  key={hint.text}
                  type="button"
                  onClick={() => setDraft(hint.text)}
                >
                  <strong>{hint.label}</strong>
                  <code>{hint.text}</code>
                </button>
              ))}
            </div>
          </div>
        )}
        {renderMessages(messages, t)}
        {(reasoning || streaming) && (
          <article className="bubble assistant">
            <span className="who">{t('assistant')}</span>
            {reasoning && (
              <ReasoningBlock text={reasoning} label={t('reasoning')} open />
            )}
            {streaming && <MarkdownView text={streaming} />}
          </article>
        )}
        {pendingTools.map((call) => (
          <ToolCard
            key={call.id}
            name={call.name}
            args={call.arguments}
            running
            labelRunning={t('toolRunning')}
            labelArgs={t('toolArgs')}
            labelDone={t('toolDone')}
          />
        ))}
        {busy && !streaming && !reasoning && pendingTools.length === 0 && (
          <p className="thinking">
            <i />
            {t('thinking')}
          </p>
        )}
        {error && (
          <p className="error-line">
            {error === 'offline' ? t('serverDown') : error}
          </p>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          ref={box}
          value={draft}
          placeholder={t('chatPlaceholder')}
          rows={1}
          onChange={(event) => {
            setDraft(event.target.value);
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
        />
        {busy ? (
          <button
            className="send stop"
            type="button"
            onClick={() => abortRef.current?.abort()}
            aria-label={t('stop')}
          >
            <IconStop />
          </button>
        ) : (
          <button
            className="send"
            type="submit"
            disabled={!draft.trim()}
            aria-label={t('send')}
          >
            <IconSend />
          </button>
        )}
      </form>
    </section>
  );
}

function renderMessages(
  messages: ChatMessage[],
  t: ReturnType<typeof useI18n>['t'],
) {
  const nodes = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    if (message.role === 'user') {
      nodes.push(
        <article key={message.id} className="bubble user">
          <span className="who">{t('you')}</span>
          <MarkdownView text={message.content} />
        </article>,
      );
      continue;
    }
    const calls = message.toolCalls ?? [];
    nodes.push(
      <article key={message.id} className="bubble assistant">
        <span className="who">{t('assistant')}</span>
        {message.reasoning && (
          <ReasoningBlock text={message.reasoning} label={t('reasoning')} />
        )}
        {message.content && <MarkdownView text={message.content} />}
        {calls.map((call) => {
          const result = messages.find(
            (item) => item.role === 'tool' && item.toolCallId === call.id,
          );
          return (
            <ToolCard
              key={call.id}
              name={call.name}
              args={call.arguments}
              result={result?.content}
              labelRunning={t('toolRunning')}
              labelArgs={t('toolArgs')}
              labelDone={t('toolDone')}
            />
          );
        })}
      </article>,
    );
  }
  return nodes;
}

function ToolCard({
  name,
  args,
  result,
  running,
  labelRunning,
  labelArgs,
  labelDone,
}: {
  name: string;
  args: string;
  result?: string;
  running?: boolean;
  labelRunning: string;
  labelArgs: string;
  labelDone: string;
}) {
  return (
    <div className={running ? 'tool running' : 'tool'}>
      <header>
        <code>{name}</code>
        <span>
          {running
            ? labelRunning
            : result !== undefined
              ? labelDone
              : labelArgs}
        </span>
      </header>
      {args && args !== '{}' && (
        <pre>
          <em>{labelArgs}</em>
          {pretty(args)}
        </pre>
      )}
      {result !== undefined && <div className="tool-result">{result}</div>}
    </div>
  );
}

function ReasoningBlock({
  text,
  label,
  open,
}: {
  text: string;
  label: string;
  open?: boolean;
}) {
  return (
    <details className="reasoning" open={open}>
      <summary>{label}</summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function flattenChoices(providers: ProviderPublic[]): Choice[] {
  const out: Choice[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      out.push({ providerId: provider.id, model, kind: provider.kind });
    }
  }
  return out;
}

function choiceFor(
  choices: Choice[],
  providerId: string | null,
  model: string | null,
): Choice | undefined {
  return (
    choices.find(
      (item) => item.providerId === providerId && item.model === model,
    ) ??
    choices.find((item) => item.providerId === providerId) ??
    choices.find(
      (item) => item.kind === 'deepseek' && item.model === 'deepseek-chat',
    ) ??
    choices[0]
  );
}

function keyOf(choice: Choice): string {
  return `${choice.providerId}:${choice.model}`;
}
