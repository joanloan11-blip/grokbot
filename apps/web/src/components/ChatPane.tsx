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
import {
  BeaconMark,
  IconArrowUp,
  IconClose,
  IconFile,
  IconMic,
  IconPaperclip,
  IconSidebar,
  IconStop,
  IconTrash,
} from './icons';

interface Props {
  conversationId: string | null;
  agentId: string;
  defaultProviderId: string | null;
  defaultModel: string | null;
  providers: ProviderPublic[];
  barPicker?: boolean;
  /** Новые чаты создаются в этом проекте. */
  projectId?: string | null;
  onMenu: () => void;
  onConversation: (conversation: Conversation) => void;
  onDeleted: (id: string) => void;
  /** Открыть другой чат (например, подзадачу оркестратора). */
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
  projectId = null,
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
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const skipReload = useRef(false);
  const createdRef = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const choices = useMemo(() => flattenChoices(providers), [providers]);

  useEffect(() => {
    if (conversationId) createdRef.current = null;
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
    if (!skipReload.current) setFiles([]);
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

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    if (createdRef.current) return createdRef.current;
    const created = await api.createConversation({
      locale,
      agentId,
      providerId: selected?.providerId,
      model: selected?.model,
      projectId,
    });
    createdRef.current = created.id;
    setTitle(created.title);
    skipReload.current = true;
    onConversation(created);
    return created.id;
  }

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    if (!selected) {
      setError(t('noProviders'));
      return;
    }
    setError('');
    setUploading(true);
    try {
      const id = await ensureConversation();
      for (const file of Array.from(list).slice(0, 10)) {
        if (file.size > 8_000_000) {
          setError(`${file.name}: > 8 MB`);
          continue;
        }
        const saved = await api.uploadFile(id, file);
        setFiles((current) => [
          ...current,
          {
            ...saved,
            preview: file.type.startsWith('image/')
              ? URL.createObjectURL(file)
              : undefined,
          },
        ]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        setRecording(false);
        recorderRef.current = null;
        if (!chunks.length) return;
        setTranscribing(true);
        try {
          const text = await api.transcribe(
            new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
            locale,
          );
          if (text) {
            setDraft((current) =>
              current.trim() ? `${current.trim()} ${text}` : text,
            );
            box.current?.focus();
          }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : t('error'));
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setError(t('micDenied'));
    }
  }

  const editHandlers: EditHandlers = {
    busy,
    onSaveReply: async (messageId, text) => {
      try {
        const saved = await api.editMessage(messageId, text);
        setMessages((current) =>
          current.map((item) =>
            item.id === messageId ? { ...item, content: saved.content } : item,
          ),
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t('error'));
      }
    },
    onResend: async (message, text) => {
      try {
        const result = await api.rewindMessage(message.id);
        setMessages((current) => {
          const index = current.findIndex((item) => item.id === message.id);
          return index >= 0 ? current.slice(0, index) : current;
        });
        await send(text, result.attachments);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t('error'));
      }
    },
  };

  async function send(text: string, reuseAttachments?: string[]) {
    const typed = text.trim();
    const pendingFiles = reuseAttachments
      ? reuseAttachments.map((id) => ({ id }))
      : files;
    if ((!typed && pendingFiles.length === 0) || busy || uploading) return;
    const content = typed;
    if (!selected) {
      setError(t('noProviders'));
      return;
    }
    setError('');
    setBusy(true);
    if (!reuseAttachments) {
      setDraft('');
      setFiles([]);
    }
    let id = conversationId;
    try {
      if (!id) id = await ensureConversation();
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
          attachments: pendingFiles.map((file) => file.id),
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
              userId: null,
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
    { label: t('hintSearchLabel'), text: t('hintSearchText') },
    { label: t('hintPlanLabel'), text: t('hintPlanText') },
    { label: t('hintRoutineLabel'), text: t('hintRoutineText') },
    { label: t('hintCodeLabel'), text: t('hintCodeText') },
  ];
  const isEmpty = messages.length === 0 && !streaming && !reasoning && !busy;

  const composer = (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send(draft);
      }}
    >
      {files.length > 0 && (
        <div className="attach-list">
          {files.map((file) => (
            <span key={file.id} className="attach-chip">
              {file.preview ? <img src={file.preview} alt="" /> : <IconFile />}
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={t('removeFile')}
                onClick={() =>
                  setFiles((current) =>
                    current.filter((item) => item.id !== file.id),
                  )
                }
              >
                <IconClose />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        value={draft}
        placeholder={
          recording
            ? t('stopRecording')
            : transcribing
              ? t('transcribing')
              : t('chatPlaceholder')
        }
        rows={1}
        onChange={(event) => {
          setDraft(event.target.value);
          event.target.style.height = 'auto';
          event.target.style.height = `${Math.min(event.target.scrollHeight, 220)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send(draft);
          }
        }}
      />
      <div className="composer-row">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,.csv,.docx,.xlsx"
          onChange={(event) => void attach(event.target.files)}
        />
        <button
          type="button"
          className="icon-btn quiet"
          aria-label={t('attach')}
          title={uploading ? t('uploading') : t('attach')}
          disabled={uploading}
          onClick={() => fileInput.current?.click()}
        >
          <IconPaperclip />
        </button>
        <ModelSelect
          providers={providers}
          value={choice}
          label={t('modelLabel')}
          className="composer-model"
          onChange={(next) => void persistChoice(next, conversationId)}
        />
        <span className="composer-spacer" />
        <button
          type="button"
          className={
            recording ? 'icon-btn mic recording' : 'icon-btn quiet mic'
          }
          aria-label={recording ? t('stopRecording') : t('voiceInput')}
          title={recording ? t('stopRecording') : t('voiceInput')}
          disabled={transcribing}
          onClick={() => void toggleRecording()}
        >
          <IconMic />
        </button>
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
            disabled={(!draft.trim() && files.length === 0) || uploading}
            aria-label={t('send')}
          >
            <IconArrowUp />
          </button>
        )}
      </div>
    </form>
  );

  return (
    <section className={isEmpty ? 'chat empty' : 'chat'}>
      <header className="topbar">
        <button
          className="icon-btn menu-btn"
          type="button"
          onClick={onMenu}
          aria-label={t('showSidebar')}
          title={t('showSidebar')}
        >
          <IconSidebar />
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
          ) : conversationId ? (
            <button
              type="button"
              className="title-btn"
              onClick={() => setEditingTitle(true)}
            >
              {title || t('newChat')}
            </button>
          ) : null}
        </div>
        {conversationId && (
          <button
            type="button"
            className={confirmDelete ? 'danger slim' : 'icon-btn quiet'}
            aria-label={t('delete')}
            title={t('delete')}
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
            {confirmDelete ? t('confirmDelete') : <IconTrash />}
          </button>
        )}
      </header>
      {isEmpty ? (
        <div className="hero">
          <div className="welcome">
            <BeaconMark />
            <h1>{t('emptyTitle')}</h1>
          </div>
          {composer}
          <div className="hints">
            {hints.map((hint) => (
              <button
                key={hint.label}
                type="button"
                onClick={() => {
                  setDraft(hint.text);
                  box.current?.focus();
                }}
              >
                {hint.label}
              </button>
            ))}
          </div>
          {error && (
            <p className="error-line">
              {error === 'offline' ? t('serverDown') : error}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="transcript" ref={scroller}>
            <div className="thread">
              {renderMessages(
                messages,
                t,
                (text) => void send(text),
                editHandlers,
              )}
              {(reasoning || streaming) && (
                <article className="bubble assistant">
                  {reasoning && (
                    <ReasoningBlock
                      text={reasoning}
                      label={t('reasoning')}
                      open
                    />
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
              {busy &&
                !streaming &&
                !reasoning &&
                pendingTools.length === 0 && (
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
          </div>
          <div className="composer-dock">{composer}</div>
        </>
      )}
    </section>
  );
}

function ModelSelect({
  providers,
  value,
  onChange,
  label,
  className,
}: {
  providers: ProviderPublic[];
  value: string;
  onChange: (next: string) => void;
  label?: string;
  className?: string;
}) {
  return (
    <select
      className={className}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {providers
        .filter((provider) => provider.enabled && provider.models.length > 0)
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
  );
}

interface EditHandlers {
  busy: boolean;
  /** Ответ модели: заменить текст. */
  onSaveReply: (id: string, text: string) => Promise<void>;
  /** Своё сообщение: удалить его и всё после, отправить новый текст. */
  onResend: (message: ChatMessage, text: string) => Promise<void>;
}

function renderMessages(
  messages: ChatMessage[],
  t: ReturnType<typeof useI18n>['t'],
  onSend: (text: string) => void,
  edit: EditHandlers,
) {
  const nodes = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    if (message.role === 'user') {
      nodes.push(
        <article key={message.id} className="bubble user">
          <span className="who">{t('you')}</span>
          {message.attachments?.length ? (
            <div className="msg-files">
              {message.attachments.map((file) =>
                file.mime.startsWith('image/') ? (
                  <a
                    key={file.id}
                    href={`/api/files/${file.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      src={`/api/files/${file.id}`}
                      alt={file.name}
                      loading="lazy"
                    />
                  </a>
                ) : (
                  <a
                    key={file.id}
                    className="attach-chip"
                    href={`/api/files/${file.id}`}
                  >
                    <IconFile />
                    <span>{file.name}</span>
                  </a>
                ),
              )}
            </div>
          ) : null}
          <EditableText message={message} edit={edit} />
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
        {message.content && <EditableText message={message} edit={edit} />}
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
              onSend={onSend}
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
  onSend,
}: {
  name: string;
  args: string;
  result?: string;
  running?: boolean;
  labelRunning: string;
  labelArgs: string;
  labelDone: string;
  onSend?: (text: string) => void;
}) {
  const { t } = useI18n();
  // Задания для других моделей (подзадачи, сообщения агентам, промпт картинки) не показываем.
  const hidden = PROMPT_TOOLS[name];
  return (
    <div className={running ? 'tool running' : 'tool'}>
      <header>
        {hidden ? <strong>{t(hidden)}</strong> : <code>{name}</code>}
        <span>
          {running
            ? labelRunning
            : result !== undefined
              ? labelDone
              : labelArgs}
        </span>
      </header>
      {hidden && name === 'delegate' && <DelegateTitles args={args} />}
      {!hidden && args && args !== '{}' && (
        <pre>
          <em>{labelArgs}</em>
          {pretty(args)}
        </pre>
      )}
      {result?.startsWith('ASK:') && onSend && (
        <AskChoices raw={result.slice(4)} onSend={onSend} />
      )}
      {result?.startsWith('APPROVAL:') && <ApprovalCard raw={result} />}
      {result?.startsWith('DIFF:') && <DiffView raw={result.slice(5)} />}
      {result?.startsWith('IMAGE:') && <ImageResult raw={result.slice(6)} />}
      {result?.startsWith('DELEGATE:') && (
        <DelegateView raw={result.slice(9)} />
      )}
      {result !== undefined &&
        !result.startsWith('ASK:') &&
        !result.startsWith('APPROVAL:') &&
        !result.startsWith('DIFF:') &&
        !result.startsWith('IMAGE:') &&
        !result.startsWith('DELEGATE:') && (
          <div className="tool-result">{result}</div>
        )}
    </div>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Без https или без разрешения — старый способ.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Текст сообщения с кнопками «Копировать» и «Изменить». */
function EditableText({
  message,
  edit,
}: {
  message: ChatMessage;
  edit: EditHandlers;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const mine = message.role === 'user';

  if (editing)
    return (
      <form
        className="msg-edit"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || saving) return;
          setSaving(true);
          void (
            mine
              ? edit.onResend(message, text)
              : edit.onSaveReply(message.id, text)
          )
            .then(() => setEditing(false))
            .finally(() => setSaving(false));
        }}
      >
        <textarea
          value={text}
          rows={Math.min(16, Math.max(3, text.split('\n').length + 1))}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        <p className="hint">{mine ? t('resendHint') : t('editedHint')}</p>
        <div className="row-actions">
          <button className="primary-btn slim" type="submit" disabled={saving}>
            {mine ? t('resend') : t('save')}
          </button>
          <button
            className="ghost slim"
            type="button"
            onClick={() => {
              setText(message.content);
              setEditing(false);
            }}
          >
            {t('cancel')}
          </button>
        </div>
      </form>
    );

  return (
    <>
      <MarkdownView text={message.content} />
      <div className="msg-actions">
        <button
          type="button"
          className="msg-act"
          onClick={() =>
            void copyToClipboard(message.content).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? t('copied') : t('copy')}
        </button>
        <button
          type="button"
          className="msg-act"
          disabled={edit.busy}
          onClick={() => {
            setText(message.content);
            setEditing(true);
          }}
        >
          {t('editMessage')}
        </button>
      </div>
    </>
  );
}

/** Инструменты, чьи аргументы — промпты для других моделей. Значение — подпись вместо имени. */
const PROMPT_TOOLS: Record<
  string,
  Parameters<ReturnType<typeof useI18n>['t']>[0]
> = {
  delegate: 'toolDelegate',
  send_to_agent: 'toolSendAgent',
  task: 'toolTask',
  generate_image: 'toolImage',
  create_routine: 'toolRoutine',
};

/** Только названия подзадач, без текста заданий. */
function DelegateTitles({ args }: { args: string }) {
  let titles: string[] = [];
  try {
    const parsed = JSON.parse(args) as {
      tasks?: { title?: string; agent?: string }[];
    };
    titles = (parsed.tasks ?? []).map(
      (item, index) => item.title || `${index + 1}`,
    );
  } catch {
    titles = [];
  }
  if (!titles.length) return null;
  return (
    <ul className="delegate-titles">
      {titles.map((title, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: порядок задач не меняется
        <li key={index}>{title}</li>
      ))}
    </ul>
  );
}

function AskChoices({
  raw,
  onSend,
}: {
  raw: string;
  onSend: (text: string) => void;
}) {
  let question = raw;
  let options: string[] = [];
  try {
    const parsed = JSON.parse(raw) as { question?: string; options?: string[] };
    question = parsed.question || raw;
    options = parsed.options ?? [];
  } catch {
    options = [];
  }
  return (
    <div className="tool-result">
      <p>{question}</p>
      <div className="row-actions">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className="ghost slim"
            onClick={() => onSend(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({ raw }: { raw: string }) {
  const id = raw.split(':')[1] ?? '';
  const [state, setState] = useState(raw);
  return (
    <div className="tool-result">
      <p>Подтвердить действие?</p>
      {state.startsWith('APPROVAL:') && (
        <div className="row-actions">
          <button
            type="button"
            className="primary-btn"
            onClick={() =>
              void fetch(`/api/approvals/${id}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ approve: true }),
              }).then(() => setState('Подтверждено'))
            }
          >
            Да
          </button>
          <button
            type="button"
            className="ghost slim"
            onClick={() =>
              void fetch(`/api/approvals/${id}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ approve: false }),
              }).then(() => setState('Отклонено'))
            }
          >
            Нет
          </button>
        </div>
      )}
      {!state.startsWith('APPROVAL:') && <p>{state}</p>}
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

interface PendingFile {
  id: string;
  name: string;
  mime: string;
  preview?: string;
}

function DiffView({ raw }: { raw: string }) {
  const { t } = useI18n();
  let diff: {
    file: string;
    created: boolean;
    added: number;
    removed: number;
    lines: string[];
  };
  try {
    diff = JSON.parse(raw);
  } catch {
    return <div className="tool-result">{raw}</div>;
  }
  return (
    <div className="diff">
      <header>
        <code>{diff.file}</code>
        {diff.created && <em>{t('diffNew')}</em>}
        <span className="plus">+{diff.added}</span>
        <span className="minus">−{diff.removed}</span>
      </header>
      <pre>
        {diff.lines.map((line, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: строки диффа не имеют id
            key={index}
            className={
              line === '@@'
                ? 'gap'
                : line.startsWith('+')
                  ? 'add'
                  : line.startsWith('-')
                    ? 'del'
                    : 'ctx'
            }
          >
            {line === '@@' ? '⋯' : line}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

function ImageResult({ raw }: { raw: string }) {
  const { t } = useI18n();
  let image: { id: string; name: string; prompt?: string };
  try {
    image = JSON.parse(raw);
  } catch {
    return null;
  }
  const url = `/api/files/${image.id}`;
  return (
    <figure className="gen-image">
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={image.name} loading="lazy" />
      </a>
      <figcaption>
        <span>{image.name}</span>
        <a href={url} download={image.name}>
          {t('download')}
        </a>
      </figcaption>
    </figure>
  );
}

interface DelegateItem {
  agent: string;
  emoji: string;
  title: string;
  status: 'done' | 'error' | 'timeout';
  result: string;
  conversationId: string | null;
  seconds: number;
}

function DelegateView({ raw }: { raw: string }) {
  let results: DelegateItem[] = [];
  try {
    results = (JSON.parse(raw) as { results?: DelegateItem[] }).results ?? [];
  } catch {
    return null;
  }
  return (
    <div className="delegate">
      {results.map((item, index) => (
        <details
          // biome-ignore lint/suspicious/noArrayIndexKey: порядок подзадач фиксирован
          key={index}
          className={`sub ${item.status}`}
        >
          <summary>
            <span className="sub-state">
              {item.status === 'done'
                ? '✓'
                : item.status === 'timeout'
                  ? '⏱'
                  : '✕'}
            </span>
            <strong>{item.title}</strong>
            <span className="sub-agent">
              {item.emoji} {item.agent}
            </span>
            <span className="sub-time">{item.seconds} с</span>
          </summary>
          <div className="sub-body">
            <MarkdownView text={item.result} />
          </div>
        </details>
      ))}
    </div>
  );
}
