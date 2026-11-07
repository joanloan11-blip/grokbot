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
] as const;

export const CONNECTOR_PRESETS = [
  {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    description: 'Репозитории, задачи и pull request',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    emoji: '⚡',
    description: 'Базы данных и проекты',
  },
  {
    id: 'skyscanner',
    name: 'Skyscanner',
    emoji: '✈️',
    description: 'Поиск и сравнение авиабилетов',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    emoji: '✉️',
    description: 'Почта и черновики',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    emoji: '📅',
    description: 'Календарь и события',
  },
  {
    id: 'google-contacts',
    name: 'Google Contacts',
    emoji: '👥',
    description: 'Контакты',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    emoji: '📁',
    description: 'Документы и файлы',
  },
  {
    id: 'avito',
    name: 'Авито',
    emoji: '🟢',
    description: 'Ваш кабинет: объявления, чаты и статистика',
  },
  {
    id: 'moysklad',
    name: 'МойСклад',
    emoji: '📦',
    description: 'Ваши товары, цены и остатки',
  },
] as const;

export function isPublicSkill(name: string): boolean {
  return (
    name === 'summary' ||
    name === 'translate' ||
    SKILL_CATALOG.some((skill) => skill.id === name)
  );
}
