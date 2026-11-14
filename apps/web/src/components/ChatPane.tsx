import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  MessageMeta,
  Conversation,
  ProviderPublic,
  TodoItem,
  ToolCall,
} from '@mayak/shared';
import { adoptCompare, api, streamCompare, streamMessage } from '../api';
import { useI18n } from '../i18n';
import { modelLabel, visibleModels } from '../models';
import { MarkdownView } from './MarkdownView';
import { MatrixRain } from './MatrixRain';
import {
  ensurePermission,
  localFsSupported,
  pickFolder,
  runLocalOp,
  savedFolder,
  setStorageMode,
  storageMode,
} from '../local-fs';
import { ComposerOrbit } from './ComposerOrbit';
import { QUICK_START } from '../scenarios';
import { OPEN_BILLING_EVENT } from './BillingPane';
import { USAGE_EVENT } from './UsageMeter';
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
  /** Быстрый старт: создать готового агента из сценария. */
  onQuickStart?: (scenarioId: string) => void;
  onConversation: (conversation: Conversation) => void;
  onDeleted: (id: string) => void;
  /** Открыть другой чат (например, подзадачу оркестратора). */
}

interface Choice {
  providerId: string;
  model: string;
  kind: ProviderPublic['kind'];
}

interface LaneView {
  key: string;
  conversationId: string;
  text: string;
  reasoning: string;
  tools: ToolCall[];
  doneTools: number;
  final?: ChatMessage;
  error?: string;
  done: boolean;
}

interface CompareView {
  question: string;
  lanes: LaneView[];
}

export function ChatPane({
  conversationId,
  agentId,
  defaultProviderId,
  defaultModel,
  providers,
  projectId = null,
  onMenu,
  onQuickStart,
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
  const [compareOn, setCompareOn] = useState(false);
  // Где агент хранит файлы: в облаке (сервер) или в папке на компьютере.
  const [folder, setFolder] =
    useState<Awaited<ReturnType<typeof savedFolder>>>(null);
  // По умолчанию файлы и память агента — в папке на компьютере пользователя.
  const [workLocal, setWorkLocal] = useState(
    () => storageMode(agentId) === 'local',
  );
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [planOpen, setPlanOpen] = useState(true);
  // Терминал: команды пользователя в рабочей папке агента с живым выводом.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState('/');
  const [previewKey, setPreviewKey] = useState(0);
  const [terminalHistory, setTerminalHistory] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(
        localStorage.getItem('qastom-terminal-history') ?? '[]',
      );
      return Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const terminalAbort = useRef<AbortController | null>(null);
  const terminalOut = useRef<HTMLPreElement>(null);
  const [extraModels, setExtraModels] = useState<string[]>([]);
  const [compare, setCompare] = useState<CompareView | null>(null);
  const [adopting, setAdopting] = useState(false);
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

  const refreshTodos = async () => {
    try {
      const result = await api.todos(agentId);
      setTodos(result.todos);
    } catch {
      // план — необязательная подсказка, ошибку не показываем
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: обновляем при смене агента
  useEffect(() => {
    void refreshTodos();
  }, [agentId]);

  useEffect(() => {
    if (terminalOut.current)
      terminalOut.current.scrollTop = terminalOut.current.scrollHeight;
  }, [terminalOutput]);

  useEffect(
    () => () => {
      terminalAbort.current?.abort();
    },
    [],
  );

  const appendTerminal = (text: string) =>
    setTerminalOutput((current) => (current + text).slice(-200_000));
  const previewScope = projectId ? `project-${projectId}` : agentId;
  const previewSrc = `/api/preview/${encodeURIComponent(previewScope)}/${previewPath
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;

  async function runTerminal() {
    const command = terminalCommand.trim();
    if (!command || terminalRunning) return;
    const scope = projectId ? `project-${projectId}` : agentId;
    const controller = new AbortController();
    terminalAbort.current = controller;
    setTerminalRunning(true);
    appendTerminal(`$ ${command}\n`);
    setTerminalCommand('');
    setTerminalHistory((current) => {
      const next = [...current.filter((item) => item !== command), command].slice(
        -50,
      );
      try {
        localStorage.setItem(
          'qastom-terminal-history',
          JSON.stringify(next),
        );
      } catch {
        // история просто не запомнится
      }
      return next;
    });
    setHistoryIndex(-1);
    try {
      const response = await fetch('/api/workspace/terminal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scope, command, timeoutSec: 600 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        appendTerminal(`Ошибка: ${data.error ?? response.status}\n`);
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        appendTerminal('Пустой поток вывода\n');
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.type === 'chunk' && typeof event.data === 'string')
            appendTerminal(event.data);
          else if (event.type === 'error' && typeof event.message === 'string')
            appendTerminal(`\n${event.message}\n`);
          else if (event.type === 'exit')
            appendTerminal(
              `\n[код выхода ${String(event.code ?? '—')}${
                event.timedOut ? ', таймаут' : ''
              }, ${String(event.ms ?? 0)} мс]\n`,
            );
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        appendTerminal(
          `Ошибка: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    } finally {
      setTerminalRunning(false);
      terminalAbort.current = null;
    }
  }

  useEffect(() => {
    if (localFsSupported()) void savedFolder().then(setFolder);
  }, []);

  // У каждого агента своя настройка: по умолчанию компьютер, но можно выбрать облако.
  // biome-ignore lint/correctness/useExhaustiveDependencies: реагируем только на смену агента
  useEffect(() => {
    if (localFsSupported()) setWorkLocal(storageMode(agentId) === 'local');
  }, [agentId]);

  function chooseLocal(on: boolean) {
    setWorkLocal(on);
    setStorageMode(agentId, on ? 'local' : 'cloud');
  }

  async function toggleStorage() {
    if (workLocal && folder) {
      chooseLocal(false);
      return;
    }
    const handle = folder ?? (await pickFolder());
    if (!handle) return;
    setFolder(handle);
    chooseLocal(true);
  }

  async function changeFolder() {
    const handle = await pickFolder();
    if (handle) {
      setFolder(handle);
      chooseLocal(true);
    }
  }

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
    setCompare(null);
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

  function toggleCompare() {
    if (compareOn) {
      setCompareOn(false);
      return;
    }
    if (extraModels.length === 0) {
      const other = choices.find((item) => keyOf(item) !== choice);
      setExtraModels(other ? [keyOf(other)] : []);
    }
    setCompareOn(true);
  }

  function patchLane(index: number, patch: (lane: LaneView) => LaneView) {
    setCompare((current) =>
      current
        ? {
            ...current,
            lanes: current.lanes.map((lane, i) =>
              i === index ? patch(lane) : lane,
            ),
          }
        : current,
    );
  }

  async function sendCompare(text: string) {
    const content = text.trim();
    const keys = [...new Set([choice, ...extraModels].filter(Boolean))];
    const picks = keys
      .map((key) => choices.find((item) => keyOf(item) === key))
      .filter((item): item is Choice => Boolean(item));
    if (!content || busy || uploading) return;
    if (picks.length < 2) {
      setError(t('compareNeedTwo'));
      return;
    }
    setError('');
    setBusy(true);
    setDraft('');
    const pendingFiles = files;
    setFiles([]);
    setCompare({
      question: content,
      lanes: picks.map((pick) => ({
        key: keyOf(pick),
        conversationId: '',
        text: '',
        reasoning: '',
        tools: [],
        doneTools: 0,
        done: false,
      })),
    });
    try {
      const id = await ensureConversation();
      const controller = new AbortController();
      abortRef.current = controller;
      await streamCompare(
        id,
        {
          content,
          locale,
          lanes: picks.map((pick) => ({
            providerId: pick.providerId,
            model: pick.model,
          })),
          attachments: pendingFiles.map((file) => file.id),
        },
        (event) => {
          if (event.type === 'lanes')
            setCompare((current) =>
              current
                ? {
                    ...current,
                    lanes: current.lanes.map((lane, i) => ({
                      ...lane,
                      conversationId: event.lanes[i]?.conversationId ?? '',
                    })),
                  }
                : current,
            );
          if (event.type === 'error') setError(event.message);
          if (event.type !== 'lane') return;
          const inner = event.event;
          patchLane(event.lane, (lane) => {
            if (inner.type === 'text')
              return { ...lane, text: lane.text + inner.delta };
            if (inner.type === 'reasoning')
              return { ...lane, reasoning: lane.reasoning + inner.delta };
            if (inner.type === 'tool_start')
              return { ...lane, tools: [...lane.tools, inner.call] };
            if (inner.type === 'error')
              return { ...lane, error: inner.message, done: true };
            if (inner.type === 'done') return { ...lane, done: true };
            if (inner.type === 'message') {
              if (inner.message.role === 'tool')
                return { ...lane, doneTools: lane.doneTools + 1 };
              if (inner.message.role === 'assistant')
                return inner.message.meta
                  ? { ...lane, final: inner.message, text: '', reasoning: '' }
                  : { ...lane, text: '', reasoning: '' };
            }
            return lane;
          });
        },
        controller.signal,
      );
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError'))
        setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
      abortRef.current = null;
      void refreshTodos();
      setCompare((current) =>
        current
          ? {
              ...current,
              lanes: current.lanes.map((lane) => ({ ...lane, done: true })),
            }
          : current,
      );
      window.dispatchEvent(new Event(USAGE_EVENT));
    }
  }

  async function adopt(lane: LaneView) {
    const id = conversationId ?? createdRef.current;
    if (!id || !lane.conversationId || adopting) return;
    setAdopting(true);
    try {
      const result = await adoptCompare(id, lane.conversationId);
      setMessages(result.messages);
      setTitle(result.conversation.title);
      onConversation(result.conversation);
      setChoice(lane.key);
      setCompare(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setAdopting(false);
    }
  }

  async function send(text: string, reuseAttachments?: string[]) {
    if (compareOn && !reuseAttachments) {
      await sendCompare(text);
      return;
    }
    setCompare(null);
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
    // По умолчанию файлы и память агента лежат на компьютере: если папка ещё
    // не выбрана, предлагаем выбрать её прямо сейчас (клик по «Отправить» — жест).
    let activeFolder = folder;
    if (localFsSupported() && workLocal && !activeFolder) {
      activeFolder = await pickFolder();
      if (!activeFolder) {
        setBusy(false);
        setError(
          'Выберите папку на компьютере — в ней будут файлы и память агента. Или переключитесь на облако.',
        );
        return;
      }
      setFolder(activeFolder);
    }
    let id = conversationId;
    try {
      if (!id) id = await ensureConversation();
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming('');
      setReasoning('');
      setPendingTools([]);
      const local = workLocal && activeFolder ? activeFolder : null;
      if (local && !(await ensurePermission(local))) {
        setError(
          'Нет доступа к папке на компьютере — разрешите доступ или переключитесь на облако.',
        );
        return;
      }
      await streamMessage(
        id,
        {
          content,
          providerId: selected.providerId,
          model: selected.model,
          locale,
          attachments: pendingFiles.map((file) => file.id),
          localFolder: local?.name,
        },
        (event) => {
          if (event.type === 'local_fs' && local) {
            void runLocalOp(local, event.op, event.args).then(
              (result) => api.localFsReply(event.id, { result }),
              (reason: unknown) =>
                api.localFsReply(event.id, {
                  error:
                    reason instanceof Error ? reason.message : String(reason),
                }),
            );
            return;
          }
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
      void refreshTodos();
      window.dispatchEvent(new Event(USAGE_EVENT));
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
  const isEmpty =
    messages.length === 0 && !streaming && !reasoning && !busy && !compare;
  // В режиме сравнения поле ввода всегда внизу, ответы — над ним.
  const hero = isEmpty && !compareOn;

  const composer = (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send(draft);
      }}
    >
      <ComposerOrbit busy={busy} />
      {terminalOpen && (
        <section className="terminal-panel">
          <header>
            <strong>🖥 Терминал</strong>
            <span className="muted">
              {projectId ? 'папка проекта' : 'папка агента'}
            </span>
            <button
              type="button"
              className="ghost slim"
              onClick={() => setTerminalOutput('')}
            >
              Очистить
            </button>
            <button
              type="button"
              className="icon-btn quiet tiny"
              aria-label="Закрыть терминал"
              onClick={() => {
                terminalAbort.current?.abort();
                setTerminalOpen(false);
              }}
            >
              <IconClose />
            </button>
          </header>
          <pre ref={terminalOut} className="terminal-output">
            {terminalOutput || 'Команды выполняются в рабочей папке. Например: npm test, git status, ls -la'}
          </pre>
          <div className="terminal-row">
            <span>$</span>
            <input
              value={terminalCommand}
              placeholder="npm test"
              disabled={terminalRunning}
              onChange={(event) => setTerminalCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runTerminal();
                  return;
                }
                if (event.key === 'ArrowUp' && terminalHistory.length > 0) {
                  event.preventDefault();
                  const next =
                    historyIndex <= 0
                      ? 0
                      : Math.max(0, historyIndex - 1);
                  setHistoryIndex(next);
                  setTerminalCommand(terminalHistory[terminalHistory.length - 1 - next] ?? '');
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  if (historyIndex <= 0) {
                    setHistoryIndex(-1);
                    setTerminalCommand('');
                  } else {
                    const next = historyIndex - 1;
                    setHistoryIndex(next);
                    setTerminalCommand(
                      terminalHistory[terminalHistory.length - 1 - next] ?? '',
                    );
                  }
                }
              }}
            />
            {terminalRunning ? (
              <button
                type="button"
                className="ghost slim"
                onClick={() => terminalAbort.current?.abort()}
              >
                ■ Стоп
              </button>
            ) : (
              <button
                type="button"
                className="primary-btn slim"
                onClick={() => void runTerminal()}
              >
                Запустить
              </button>
            )}
          </div>
          <p className="hint">
            Команда идёт в песочнице (свой пользователь, без прямого интернета).
            «Стоп» прерывает выполнение. Ctrl+C в поле команды не работает.
          </p>
        </section>
      )}
      {todos.length > 0 && (
        <div className="plan-panel">
          <button
            type="button"
            className="plan-toggle"
            aria-expanded={planOpen}
            onClick={() => setPlanOpen((value) => !value)}
          >
            📋 План · {todos.filter((item) => item.done).length}/{todos.length}
            <span>{planOpen ? '▾' : '▸'}</span>
          </button>
          {planOpen && (
            <ul>
              {todos.map((item) => (
                <li key={item.id} className={item.done ? 'done' : ''}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={(event) => {
                      const done = event.target.checked;
                      setTodos((current) =>
                        current.map((todo) =>
                          todo.id === item.id ? { ...todo, done } : todo,
                        ),
                      );
                      void api.setTodo(item.id, done).catch(() =>
                        void refreshTodos(),
                      );
                    }}
                  />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
      {compareOn && (
        <div className="compare-row">
          <span className="compare-label">{t('compareWith')}</span>
          {compareOn &&
            extraModels.map((key, index) => (
              <span key={`extra-${index}`} className="compare-extra">
                <ModelSelect
                  providers={providers}
                  value={key}
                  label={t('modelLabel')}
                  className="composer-model"
                  onChange={(next) =>
                    setExtraModels((current) =>
                      current.map((item, i) => (i === index ? next : item)),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-btn quiet tiny"
                  aria-label={t('compareRemove')}
                  title={t('compareRemove')}
                  onClick={() => {
                    const next = extraModels.filter((_, i) => i !== index);
                    setExtraModels(next);
                    if (next.length === 0) setCompareOn(false);
                  }}
                >
                  <IconClose />
                </button>
              </span>
            ))}
          {compareOn && extraModels.length < 2 && choices.length > 2 && (
            <button
              type="button"
              className="compare-chip ghosty"
              onClick={() => {
                const used = new Set([choice, ...extraModels]);
                const other = choices.find((item) => !used.has(keyOf(item)));
                if (other)
                  setExtraModels((current) => [...current, keyOf(other)]);
              }}
            >
              {t('compareAdd')}
            </button>
          )}
        </div>
      )}
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
        {choices.length > 1 && (
          <button
            type="button"
            className={compareOn ? 'compare-chip on' : 'compare-chip'}
            title={t('compareTitle')}
            aria-pressed={compareOn}
            onClick={toggleCompare}
          >
            ⚖ {t('compare')}
            {compareOn ? ` · ${1 + extraModels.length}` : ''}
          </button>
        )}
        {localFsSupported() && (
          <span className="storage-switch">
            <button
              type="button"
              className={
                workLocal && folder ? 'compare-chip on' : 'compare-chip'
              }
              title={
                workLocal
                  ? folder
                    ? `Файлы и память агента — в папке «${folder.name}» на этом компьютере. Нажмите, чтобы вернуться в облако.`
                    : 'Файлы и память агента будут храниться в выбранной папке на этом компьютере. Нажмите, чтобы выбрать папку.'
                  : 'Файлы и память агента хранятся в облаке (на сервере). Нажмите, чтобы выбрать папку на компьютере.'
              }
              onClick={() => void toggleStorage()}
            >
              {workLocal
                ? folder
                  ? `💻 ${folder.name}`
                  : '💻 Папка на компьютере'
                : '☁ Облако'}
            </button>
            {workLocal && folder && (
              <button
                type="button"
                className="icon-btn quiet tiny"
                title="Выбрать другую папку"
                aria-label="Выбрать другую папку"
                onClick={() => void changeFolder()}
              >
                ⋯
              </button>
            )}
          </span>
        )}
        {!(workLocal && folder) && (
          <>
            <button
              type="button"
              className={terminalOpen ? 'compare-chip on' : 'compare-chip'}
              title="Терминал: выполнить команду в рабочей папке агента и видеть вывод"
              aria-pressed={terminalOpen}
              onClick={() => setTerminalOpen((value) => !value)}
            >
              🖥 Терминал
            </button>
            <button
              type="button"
              className={previewOpen ? 'compare-chip on' : 'compare-chip'}
              title="Превью: открыть index.html или собранный сайт из рабочей папки"
              aria-pressed={previewOpen}
              onClick={() => setPreviewOpen((value) => !value)}
            >
              👁 Превью
            </button>
          </>
        )}
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
    <section className={hero ? 'chat empty' : 'chat'}>
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
      {hero ? (
        <div className="hero">
          <div className="welcome">
            <BeaconMark />
            <h1>{t('emptyTitle')}</h1>
          </div>
          {composer}
          {onQuickStart && (
            <div className="quick-start">
              {QUICK_START.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="quick-card"
                  onClick={() => onQuickStart(item.id)}
                >
                  <span className="quick-emoji">{item.emoji}</span>
                  <strong>{item.title}</strong>
                  <span className="muted">{item.hint}</span>
                </button>
              ))}
            </div>
          )}
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
              {isEmpty && compareOn && (
                <p className="compare-empty">{t('compareEmpty')}</p>
              )}
              {renderMessages(
                messages,
                t,
                (text) => void send(text),
                editHandlers,
                conversationId,
              )}
              {(reasoning || streaming) && (
                <article className="bubble assistant">
                  {reasoning && (
                    <ReasoningBlock
                      text={reasoning}
                      label={t('reasoning')}
                      open
                      live={!streaming}
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
              {compare && (
                <CompareBlock
                  view={compare}
                  providers={providers}
                  adopting={adopting}
                  onAdopt={(lane) => void adopt(lane)}
                />
              )}
              {busy &&
                !compare &&
                !streaming &&
                !reasoning &&
                pendingTools.length === 0 && (
                  <div className="thinking-matrix">
                    <MatrixRain />
                    <span>
                      <i />
                      {t('thinking')}
                    </span>
                  </div>
                )}
              {error && (
                <p className="error-line">
                  {error === 'offline' ? t('serverDown') : error}
                  {/«Оплата»/.test(error) && (
                    <button
                      type="button"
                      className="lane-take pay-link"
                      onClick={() =>
                        window.dispatchEvent(new Event(OPEN_BILLING_EVENT))
                      }
                    >
                      Перейти к оплате
                    </button>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="composer-dock">{composer}</div>
        </>
      )}
      {previewOpen && (
        <div
          className="preview-overlay"
          role="dialog"
          aria-label="Превью рабочей папки"
        >
          <div className="preview-window">
            <header>
              <strong>👁 Превью</strong>
              <input
                value={previewPath}
                placeholder="/"
                aria-label="Путь в рабочей папке"
                onChange={(event) => setPreviewPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setPreviewKey((value) => value + 1);
                  }
                }}
              />
              <button
                type="button"
                className="ghost slim"
                onClick={() => setPreviewKey((value) => value + 1)}
              >
                Обновить
              </button>
              <a
                className="ghost slim"
                href={previewSrc}
                target="_blank"
                rel="noreferrer"
              >
                В новой вкладке
              </a>
              <button
                type="button"
                className="icon-btn quiet tiny"
                aria-label="Закрыть превью"
                onClick={() => setPreviewOpen(false)}
              >
                <IconClose />
              </button>
            </header>
            <iframe
              key={previewKey}
              title="Превью"
              src={previewSrc}
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            />
            <p className="hint">
              Превью из рабочей папки агента. Для сайта нужен index.html в корне
              или собранный проект (например, npm run build). Скрипты превью
              изолированы от аккаунта и не видят cookie Маяка.
            </p>
          </div>
        </div>
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
  const { t } = useI18n();
  return (
    <select
      className={className}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {providers
        .filter(
          (provider) => provider.enabled && visibleModels(provider).length > 0,
        )
        .map((provider) => (
          <optgroup key={provider.id} label={provider.name}>
            {visibleModels(provider).map((model) => (
              <option
                key={`${provider.id}:${model}`}
                value={`${provider.id}:${model}`}
              >
                {modelLabel(provider, model, t)}
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
  conversationId: string | null,
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
        {message.meta && <MetaLine meta={message.meta} />}
        {message.meta?.checkpointId && conversationId && (
          <UndoCheckpoint
            conversationId={conversationId}
            checkpointId={message.meta.checkpointId}
          />
        )}
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
              running={!result && edit.busy}
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
  const special =
    result?.startsWith('ASK:') ||
    result?.startsWith('APPROVAL:') ||
    result?.startsWith('DIFF:') ||
    result?.startsWith('IMAGE:') ||
    result?.startsWith('DELEGATE:');
  const summary = hidden ? '' : toolSummary(args);
  const live = running && result === undefined;
  return (
    <div className={live ? 'tool running' : 'tool'}>
      {live && name !== 'generate_image' && <MatrixRain />}
      <header>
        {hidden ? <strong>{t(hidden)}</strong> : <code>{name}</code>}
        {summary && <em className="tool-summary">{summary}</em>}
        <span>
          {live ? labelRunning : result !== undefined ? labelDone : labelArgs}
        </span>
      </header>
      {hidden && name === 'delegate' && <DelegateTitles args={args} />}
      {name === 'generate_image' && live && (
        <div className="image-matrix">
          <MatrixRain />
          <span>
            <i />
            {t('imageDrawing')}
          </span>
        </div>
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
      {/* Сырые аргументы и ответ инструмента — только по клику, чтобы не засорять чат. */}
      {!live &&
        !hidden &&
        !special &&
        (result !== undefined || args !== '{}') && (
          <details className="tool-details">
            <summary>{t('toolDetails')}</summary>
            {args && args !== '{}' && (
              <pre>
                <em>{labelArgs}</em>
                {pretty(args)}
              </pre>
            )}
            {result !== undefined && (
              <div className="tool-result">{result}</div>
            )}
          </details>
        )}
    </div>
  );
}

/** Коротко, что делает инструмент: запрос поиска, адрес, путь или команда. */
function toolSummary(args: string): string {
  try {
    const value = JSON.parse(args) as Record<string, unknown>;
    for (const key of [
      'query',
      'url',
      'command',
      'path',
      'pattern',
      'repo',
      'name',
      'title',
    ]) {
      const item = value[key];
      if (typeof item === 'string' && item.trim())
        return item.length > 90 ? `${item.slice(0, 87)}…` : item;
    }
  } catch {
    // аргументы не JSON — без подписи
  }
  return '';
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

/** Колонки сравнения: один вопрос — несколько моделей рядом. */
function CompareBlock({
  view,
  providers,
  adopting,
  onAdopt,
}: {
  view: CompareView;
  providers: ProviderPublic[];
  adopting: boolean;
  onAdopt: (lane: LaneView) => void;
}) {
  const { t } = useI18n();
  const finished = view.lanes.filter((lane) => lane.final?.meta);
  const settled = view.lanes.every((lane) => lane.done);
  const allDone = settled && finished.length > 1;
  // Значок — только если колонка заметно лучше остальных, а не при ничьей.
  const best = (
    value: (lane: LaneView) => number | null,
    margin: number,
  ): LaneView | undefined => {
    if (!allDone) return undefined;
    const scored = finished
      .map((lane) => ({ lane, score: value(lane) }))
      .filter(
        (item): item is { lane: LaneView; score: number } =>
          item.score !== null,
      )
      .sort((a, b) => a.score - b.score);
    if (scored.length < 2) return undefined;
    const [first, second] = scored;
    return second!.score - first!.score > Math.max(margin, second!.score * 0.1)
      ? first!.lane
      : undefined;
  };
  const fastest = best((lane) => lane.final?.meta?.ms ?? null, 500);
  const cheapest = best((lane) => lane.final?.meta?.costUsd ?? null, 0.000_01);
  const label = (key: string) => {
    const [providerId, ...rest] = key.split(':');
    const model = rest.join(':');
    const provider = providers.find((item) => item.id === providerId);
    return provider ? modelLabel(provider, model, t) : model;
  };
  return (
    <>
      <article className="bubble user">
        <MarkdownView text={view.question} />
      </article>
      <div className={`compare cols-${view.lanes.length}`}>
        {view.lanes.map((lane) => (
          <div key={lane.key + lane.conversationId} className="lane">
            <header>
              <strong>{label(lane.key)}</strong>
              {lane === fastest && (
                <span className="lane-badge">{t('compareFastest')}</span>
              )}
              {lane === cheapest && (
                <span className="lane-badge">{t('compareCheapest')}</span>
              )}
            </header>
            {lane.tools.length > 0 && (
              <ul className="lane-steps">
                {lane.tools.map((call, index) => (
                  <li
                    key={call.id}
                    className={index < lane.doneTools ? 'ok' : 'run'}
                  >
                    {call.name}
                  </li>
                ))}
              </ul>
            )}
            <div className="lane-body">
              {lane.final ? (
                <MarkdownView text={lane.final.content} />
              ) : lane.text ? (
                <MarkdownView text={lane.text} />
              ) : !lane.done ? (
                <div className="thinking-matrix small">
                  <MatrixRain />
                  <span>{t('compareWaiting')}</span>
                </div>
              ) : null}
              {lane.error && <p className="error-line">{lane.error}</p>}
            </div>
            {lane.final?.meta && <MetaLine meta={lane.final.meta} />}
            {lane.final && (
              <button
                type="button"
                className="lane-take"
                disabled={adopting || !settled}
                onClick={() => onAdopt(lane)}
              >
                {t('compareTake')}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="compare-note">{t('compareNote')}</p>
    </>
  );
}

const compact = (value: number) =>
  value >= 1000
    ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
    : `${value}`;

/** Цена ответа: центы с двумя значащими цифрами, иначе доллары. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** Кнопка «Отменить изменения хода»: возвращает файлы рабочей папки к точке до хода. */
function UndoCheckpoint({
  conversationId,
  checkpointId,
}: {
  conversationId: string;
  checkpointId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [note, setNote] = useState('');
  async function restore() {
    if (busy || done) return;
    if (
      !window.confirm(
        'Вернуть файлы рабочей папки к состоянию до этого хода? Изменения агента за ход будут отменены.',
      )
    )
      return;
    setBusy(true);
    setNote('');
    try {
      const result = await api.restoreCheckpoint(conversationId, checkpointId);
      setDone(true);
      setNote(
        `Восстановлено файлов: ${result.restored}, удалено новых: ${result.removed}`,
      );
    } catch (error) {
      setNote(
        error instanceof Error ? error.message : 'Не удалось откатить файлы',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="undo-checkpoint">
      <button
        type="button"
        className="ghost slim"
        disabled={busy || done}
        onClick={() => void restore()}
      >
        {busy
          ? 'Откатываю…'
          : done
            ? '↶ Изменения отменены'
            : '↶ Отменить изменения хода'}
      </button>
      {note && <span className="hint">{note}</span>}
    </div>
  );
}

/** Подпись под ответом: модель, время, шаги, токены и цена хода. */
function MetaLine({ meta }: { meta: MessageMeta }) {
  const { t } = useI18n();
  const seconds = meta.ms / 1000;
  return (
    <div
      className="msg-meta"
      title={meta.exact ? undefined : t('metaEstimate')}
    >
      <span className="meta-model">{meta.model}</span>
      <span>
        {seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} {t('metaSec')}
      </span>
      {meta.steps > 1 && (
        <span>
          {meta.steps} {t('metaSteps')}
        </span>
      )}
      {meta.tools > 0 && (
        <span>
          {meta.tools} {t('metaTools')}
        </span>
      )}
      <span>
        {compact(meta.inputTokens)} → {compact(meta.outputTokens)}{' '}
        {t('metaTokens')}
        {meta.exact ? '' : ' ≈'}
      </span>
      {meta.costUsd !== null && (
        <span className="meta-cost">
          {meta.costUsd === 0 ? t('metaFree') : formatCost(meta.costUsd)}
        </span>
      )}
    </div>
  );
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
  live,
}: {
  text: string;
  label: string;
  open?: boolean;
  /** Модель ещё думает: поверх окна идёт «матрица». */
  live?: boolean;
}) {
  const body = useRef<HTMLDivElement>(null);
  // Пока модель думает, держим в окне последние строки рассуждения.
  useEffect(() => {
    if (live && body.current)
      body.current.scrollTop = body.current.scrollHeight;
  }, [live, text]);
  return (
    <details className={live ? 'reasoning live' : 'reasoning'} open={open}>
      {live && <MatrixRain />}
      <summary>{label}</summary>
      <div className="reasoning-body" ref={body}>
        {text}
      </div>
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
    for (const model of visibleModels(provider)) {
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
