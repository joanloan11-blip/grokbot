export const SKILL_CATALOG = [
  {
    id: 'avito-api',
    name: 'Avito API',
    description:
      'Объявления, чаты и аналитика Авито через собственный коннектор',
  },
  {
    id: 'competitive-landscape',
    name: 'Конкурентная среда',
    description: 'Сравнение конкурентов и поиск отличий для любой ниши',
  },
  {
    id: 'data-quality-frameworks',
    name: 'Качество данных',
    description: 'Проверки полноты, точности и согласованности данных',
  },
  {
    id: 'data-storytelling',
    name: 'Истории на основе данных',
    description: 'Понятные выводы, графики и отчёты для аудитории',
  },
  {
    id: 'imagegen',
    name: 'Генерация изображений',
    description: 'Промпты, иллюстрации и редактирование через доступную модель',
  },
  {
    id: 'kpi-dashboard-design',
    name: 'KPI и дашборды',
    description: 'Метрики и панели для управления бизнесом',
  },
  {
    id: 'startup-financial-modeling',
    name: 'Финансовая модель',
    description: 'Выручка, затраты, денежный поток и сценарии',
  },
  {
    id: 'reverse-engineer-anything',
    name: 'Разбор устройства ПО',
    description: 'Исследование файлов, протоколов и поведения программ',
  },
  {
    id: 'openai-docs',
    name: 'Документация OpenAI',
    description: 'Поиск и объяснение официальной документации API',
  },
  {
    id: 'documents',
    name: 'Документы',
    description: 'Структура, редактирование и подготовка документов',
  },
  {
    id: 'spreadsheets',
    name: 'Таблицы и расчёты',
    description: 'Анализ таблиц, формулы и проверка расчётов',
  },
  {
    id: 'presentations',
    name: 'Презентации',
    description: 'Сценарий, структура и содержание слайдов',
  },
  {
    id: 'pdf',
    name: 'PDF',
    description: 'Чтение, извлечение текста и таблиц, формы, склейка и разрезка',
  },
  {
    id: 'xlsx',
    name: 'Excel (XLSX)',
    description: 'Формулы, стили, проверка расчётов и большие таблицы',
  },
  {
    id: 'frontend-design',
    name: 'Фронтенд-дизайн',
    description: 'Палитра, типографика и раскладка без шаблонного вида',
  },
  {
    id: 'code-review-and-quality',
    name: 'Ревью кода',
    description: 'Пять осей проверки: корректность, читаемость, тесты, безопасность, скорость',
  },
  {
    id: 'test-driven-development',
    name: 'Разработка через тесты',
    description: 'Red-green-refactor: сначала падающий тест, потом минимальный код',
  },
  {
    id: 'debugging-and-error-recovery',
    name: 'Отладка',
    description: 'Системный разбор ошибки до корневой причины, а не наугад',
  },
  {
    id: 'webapp-testing',
    name: 'Тестирование веб-приложений',
    description: 'Playwright: разведка DOM, действия, скриншоты и проверки',
  },
] as const;

export interface ConnectorPreset {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** Что вставить в поля и где это взять — показываем в форме подключения. */
  hint: string;
  /** Пример адреса MCP-сервера (Streamable HTTP). */
  urlPlaceholder: string;
  /** Подпись к полю токена. */
  tokenLabel: string;
  /** Где взять токен / что делать, если он не нужен. */
  tokenHint: string;
}

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Репозитории, задачи и pull request',
    hint: 'Официальный удалённый MCP-сервер GitHub — адрес ниже. Для приватных репозиториев нужен личный токен (PAT) с доступом к ним.',
    urlPlaceholder: 'https://api.githubcopilot.com/mcp/',
    tokenLabel: 'Bearer-токен (GitHub Personal Access Token)',
    tokenHint:
      'GitHub → Settings → Developer settings → Personal access tokens → Generate new token. Вставьте токен (начинается с ghp_ или github_pat_); права — repo и read:org.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    emoji: '⚡',
    description: 'Базы данных и проекты',
    hint: 'Адрес MCP-сервера Supabase содержит ref проекта: Dashboard → Project Settings → General → Reference ID. Подставьте свой ref в адрес ниже.',
    urlPlaceholder:
      'https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnop',
    tokenLabel: 'Bearer-токен (Supabase Personal Access Token)',
    tokenHint:
      'Supabase → Account → Access Tokens → Generate new token. Токен начинается с sbp_.',
  },
  {
    id: 'skyscanner',
    name: 'Skyscanner',
    emoji: '✈️',
    description: 'Поиск и сравнение авиабилетов',
    hint: 'Публичного MCP-сервера у Skyscanner нет. Вставьте адрес своего MCP-сервера для поиска билетов (self-hosted или партнёрский); обычно он заканчивается на /mcp.',
    urlPlaceholder: 'https://your-skyscanner-mcp.example/mcp',
    tokenLabel: 'Bearer-токен (если ваш MCP-сервер его требует)',
    tokenHint:
      'Возьмите токен у того, кто выдал вам MCP-сервер. Если сервер работает без токена — оставьте поле пустым.',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    emoji: '✉️',
    description: 'Почта и черновики',
    hint: 'У Google нет одного публичного MCP-адреса. Нужен MCP-сервер Google Workspace — свой (self-hosted) или корпоративный. Вставьте его endpoint; доступ к Gmail он получает по своему OAuth.',
    urlPlaceholder: 'https://your-google-mcp.example/mcp',
    tokenLabel: 'Bearer-токен вашего Google MCP-сервера',
    tokenHint:
      'Если сервер требует Bearer — вставьте его токен. Если доступ настроен через OAuth внутри сервера, оставьте поле пустым.',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    emoji: '📅',
    description: 'Календарь и события',
    hint: 'Вставьте endpoint своего MCP-сервера для Google Calendar (self-hosted или корпоративный): у Google нет одного публичного MCP-адреса. Календарь сервер читает по своему OAuth.',
    urlPlaceholder: 'https://your-google-mcp.example/mcp',
    tokenLabel: 'Bearer-токен вашего Google MCP-сервера',
    tokenHint:
      'Если сервер требует Bearer — вставьте токен; при OAuth внутри сервера поле можно оставить пустым.',
  },
  {
    id: 'google-contacts',
    name: 'Google Contacts',
    emoji: '👥',
    description: 'Контакты',
    hint: 'Вставьте endpoint своего MCP-сервера Google (self-hosted или корпоративный) — публичного адреса для всех у Google нет. Контакты сервер читает по своему OAuth.',
    urlPlaceholder: 'https://your-google-mcp.example/mcp',
    tokenLabel: 'Bearer-токен вашего Google MCP-сервера',
    tokenHint:
      'Если сервер требует Bearer — вставьте токен; при OAuth внутри сервера поле можно оставить пустым.',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    emoji: '📁',
    description: 'Документы и файлы',
    hint: 'Вставьте endpoint своего MCP-сервера Google Drive (self-hosted или корпоративный) — единого публичного адреса нет. Доступ к файлам сервер получает по своему OAuth.',
    urlPlaceholder: 'https://your-google-mcp.example/mcp',
    tokenLabel: 'Bearer-токен вашего Google MCP-сервера',
    tokenHint:
      'Если сервер требует Bearer — вставьте токен; при OAuth внутри сервера поле можно оставить пустым.',
  },
  {
    id: 'avito',
    name: 'Авито',
    emoji: '🟢',
    description: 'Ваш кабинет: объявления, чаты и статистика',
    hint: 'Для своего кабинета Авито MCP не обязателен: откройте Настройки → Авито и вставьте Client_id, Client_secret и Profile_id из личного кабинета — Маяк сам проверит ключи. MCP-путь — только если у вас уже есть свой MCP-сервер Авито.',
    urlPlaceholder: 'https://your-avito-mcp.example/mcp',
    tokenLabel: 'Bearer-токен вашего MCP-сервера Авито',
    tokenHint:
      'Из настроек вашего MCP-сервера. Если он работает без токена — оставьте пустым.',
  },
  {
    id: 'moysklad',
    name: 'МойСклад',
    emoji: '📦',
    description: 'Ваши товары, цены и остатки',
    hint: 'Для МойСклад проще встроенный коннектор (Настройки → MCP или плагин «МойСклад» в агенте). MCP-путь нужен, только если у вас свой сервер — вставьте его endpoint.',
    urlPlaceholder: 'https://your-moysklad-mcp.example/mcp',
    tokenLabel: 'Bearer-токен вашего MCP-сервера МойСклад',
    tokenHint:
      'Из настроек вашего MCP-сервера или оставьте пустым, если он без токена.',
  },
  {
    id: 'custom',
    name: 'Свой MCP',
    emoji: '🧩',
    description: 'Любой сервер с транспортом Streamable HTTP',
    hint: 'Вставьте адрес своего MCP-сервера из его документации — обычно он заканчивается на /mcp. Это не адрес сайта и не REST API. Если сервер требует ключ, он идёт в поле токена.',
    urlPlaceholder: 'https://your-mcp.example/mcp',
    tokenLabel: 'Bearer-токен (если сервер его требует)',
    tokenHint:
      'Скопируйте токен из настроек вашего MCP-сервера. Если он без авторизации — поле можно оставить пустым.',
  },
];

export function isPublicSkill(name: string): boolean {
  return (
    name === 'summary' ||
    name === 'translate' ||
    SKILL_CATALOG.some((skill) => skill.id === name)
  );
}
