import { useEffect, useRef, useState } from 'react';
import type { BillingPlan } from '@mayak/shared';
import { BeaconMark } from './icons';
import { MatrixRain } from './MatrixRain';
import '../landing.css';

/** Главная страница для гостей: что умеет QASTOM AGENT, тарифы, вход и регистрация. */

const PROMPTS = [
  'Сравни три облака по цене за GPU и собери таблицу',
  'Найди, почему падает тест login, и почини',
  'Нарисуй обложку для поста про запуск продукта',
  'Каждый понедельник присылай сводку новостей рынка',
  'Разбери мою папку с договорами и найди штрафы',
];

const MODELS = [
  'GPT-5.5',
  'Claude Sonnet',
  'Claude Opus',
  'DeepSeek V4',
  'Gemini',
  'Qwen 3.5',
  'Llama 3.3',
  'Kimi',
  'GPT-OSS',
  'Mistral',
  'NVIDIA Nemotron',
];

const FEATURES: { icon: string; title: string; text: string; tag?: string }[] =
  [
    {
      icon: '⚖',
      title: 'Сравнение моделей',
      text: 'Один вопрос — две или три модели рядом. Видно, кто быстрее, кто дешевле, и одним кликом берёте лучший ответ.',
      tag: 'только у нас',
    },
    {
      icon: '₽',
      title: 'Цена каждого ответа',
      text: 'Под ответом — модель, время, шаги и стоимость. Никаких сюрпризов в конце месяца.',
      tag: 'прозрачно',
    },
    {
      icon: '🧠',
      title: 'Агенты с навыками',
      text: 'Свои агенты с инструкциями, навыками и плагинами: поиск, память, расписание, команда агентов.',
    },
    {
      icon: '</>',
      title: 'Код как у инженера',
      text: 'Скачивает репозиторий с GitHub, читает, правит, запускает тесты в песочнице и открывает pull request.',
    },
    {
      icon: '💻',
      title: 'Папка на компьютере',
      text: 'Выберите папку на своём компьютере — агент работает с файлами прямо в ней. Или храните всё в облаке.',
    },
    {
      icon: '⛓',
      title: 'Коннекторы MCP',
      text: 'Подключайте свои сервисы по MCP: CRM, склад, базы знаний — агент сам вызывает нужные инструменты.',
    },
    {
      icon: '🌐',
      title: 'Интернет и новости',
      text: 'Свежий поиск, новости с датами и источниками, чтение страниц по ссылке.',
    },
    {
      icon: '🎨',
      title: 'Картинки и голос',
      text: 'Нарисовать или изменить изображение, надиктовать вопрос голосом вместо набора текста.',
    },
    {
      icon: '⏰',
      title: 'Расписание',
      text: 'Задачи по расписанию: утренний отчёт, еженедельный мониторинг цен, напоминания.',
    },
    {
      icon: '🆓',
      title: 'Бесплатные модели',
      text: 'Проверенные бесплатные модели работают всегда — даже когда пробный баланс закончился.',
    },
  ];

function useReveal(key: unknown) {
  useEffect(() => {
    // Тарифы приходят с сервера позже — наблюдаем и за новыми блоками.
    void key;
    const items = document.querySelectorAll('.lp [data-reveal]:not(.in)');
    if (!('IntersectionObserver' in window)) {
      for (const item of items) item.classList.add('in');
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.15 },
    );
    for (const item of items) observer.observe(item);
    return () => observer.disconnect();
  }, [key]);
}

/** Печатает подсказки по очереди, как будто пользователь набирает вопрос. */
function useTyping(lines: string[]) {
  const [text, setText] = useState('');
  useEffect(() => {
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (reduce) {
      setText(lines[0] ?? '');
      return;
    }
    let line = 0;
    let char = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const current = lines[line] ?? '';
      if (!deleting) {
        char += 1;
        setText(current.slice(0, char));
        if (char >= current.length) {
          deleting = true;
          timer = setTimeout(step, 1800);
          return;
        }
        timer = setTimeout(step, 38 + Math.random() * 40);
      } else {
        char -= 2;
        setText(current.slice(0, Math.max(0, char)));
        if (char <= 0) {
          deleting = false;
          line = (line + 1) % lines.length;
          timer = setTimeout(step, 350);
          return;
        }
        timer = setTimeout(step, 18);
      }
    };
    timer = setTimeout(step, 600);
    return () => clearTimeout(timer);
  }, [lines]);
  return text;
}

export function Landing({
  onLogin,
  onRegister,
}: {
  onLogin: () => void;
  onRegister: () => void;
}) {
  const typed = useTyping(PROMPTS);
  const [pricing, setPricing] = useState<{
    enabled: boolean;
    trialUsd: number;
    plans: BillingPlan[];
  } | null>(null);
  const [menu, setMenu] = useState(false);
  useReveal(pricing);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch('/api/public/plans')
      .then((response) => (response.ok ? response.json() : null))
      .then(setPricing, () => setPricing(null));
  }, []);

  const trial = pricing?.trialUsd ?? 2;
  const go = (id: string) => {
    setMenu(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="lp" ref={top}>
      <header className="lp-nav">
        <a
          className="lp-logo"
          href="#top"
          onClick={(event) => (event.preventDefault(), go('top'))}
        >
          <BeaconMark />
          <span>QASTOM AGENT</span>
        </a>
        <nav className={menu ? 'lp-links open' : 'lp-links'}>
          <button type="button" onClick={() => go('features')}>
            Возможности
          </button>
          <button type="button" onClick={() => go('compare')}>
            Сравнение
          </button>
          <button type="button" onClick={() => go('how')}>
            Как это работает
          </button>
          <button type="button" onClick={() => go('pricing')}>
            Тарифы
          </button>
        </nav>
        <div className="lp-auth">
          <button type="button" className="lp-ghost" onClick={onLogin}>
            Войти
          </button>
          <button type="button" className="lp-primary" onClick={onRegister}>
            Регистрация
          </button>
          <button
            type="button"
            className="lp-burger"
            aria-label="Меню"
            onClick={() => setMenu(!menu)}
          >
            ☰
          </button>
        </div>
      </header>

      <section className="lp-hero" id="top">
        <div className="lp-rain">
          <MatrixRain />
        </div>
        <div className="lp-hero-inner">
          <span className="lp-badge" data-reveal>
            <i /> ИИ-агенты · {MODELS.length}+ моделей в одном окне
          </span>
          <h1 data-reveal>
            Агенты, которые <em>думают</em>, ищут, пишут код и&nbsp;работают
            с&nbsp;вашими сервисами
          </h1>
          <p className="lp-lead" data-reveal>
            QASTOM AGENT — рабочее место с ИИ: лучшие модели мира рядом, честная
            цена каждого ответа, агенты с навыками и коннекторами, код в
            песочнице и файлы — в облаке или на вашем компьютере.
          </p>
          <div className="lp-cta" data-reveal>
            <button
              type="button"
              className="lp-primary big"
              onClick={onRegister}
            >
              Начать бесплатно — ${trial} на старте
            </button>
            <button type="button" className="lp-ghost big" onClick={onLogin}>
              У меня есть аккаунт
            </button>
          </div>
          <div className="lp-demo" data-reveal>
            <div className="lp-composer">
              <span className="lp-orbit" aria-hidden="true">
                <span>Q</span>
              </span>
              <div className="lp-input">
                {typed}
                <span className="lp-caret" />
              </div>
              <div className="lp-row">
                <span className="lp-chip">GPT-5.5 · MCP ✓</span>
                <span className="lp-chip on">⚖ Сравнить · 2</span>
                <span className="lp-chip">☁ Облако</span>
                <span className="lp-send">↑</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-models" aria-label="Модели">
        <div className="lp-marquee">
          {[...MODELS, ...MODELS].map((name, index) => (
            <span key={`${name}-${index}`}>{name}</span>
          ))}
        </div>
      </section>

      <section className="lp-section" id="compare">
        <div className="lp-head" data-reveal>
          <span className="lp-kicker">ИИ-фишка №1</span>
          <h2>Один вопрос — несколько моделей. Берёте лучший ответ.</h2>
          <p>
            Grok и ChatGPT показывают одну модель. Мы — сразу несколько, с ценой
            и временем, и подсказываем, какая ответила быстрее и дешевле.
          </p>
        </div>
        <div className="lp-compare" data-reveal>
          {[
            {
              name: 'Claude Sonnet',
              badge: 'лучший',
              time: '38 с',
              cost: '$0.041',
              steps: [
                'github_clone acme/web',
                'workspace_search loginUser',
                'shell: pnpm test — 1 failed',
                'workspace_edit src/auth.ts:42',
                'shell: pnpm test — 48 passed',
              ],
              answer:
                'Причина в auth.ts:42 — токен сравнивался до await. Исправил, все 48 тестов проходят.',
            },
            {
              name: 'DeepSeek V4',
              badge: 'дешевле',
              time: '21 с',
              cost: '$0.003',
              steps: [
                'github_clone acme/web',
                'workspace_read src/auth.ts',
                'shell: pnpm test — 1 failed',
              ],
              answer:
                'Похоже, тест ждёт 200, а получает 401. Предлагаю обновить фикстуру мок-сервера.',
            },
          ].map((lane, index) => (
            <div
              key={lane.name}
              className={index === 0 ? 'lp-lane win' : 'lp-lane'}
              style={{ animationDelay: `${index * 0.25}s` }}
            >
              <header>
                <strong>{lane.name}</strong>
                <span className="lp-tag">{lane.badge}</span>
              </header>
              <ul>
                {lane.steps.map((step, stepIndex) => (
                  <li
                    key={step}
                    style={{
                      animationDelay: `${0.4 + stepIndex * 0.35 + index * 0.2}s`,
                    }}
                  >
                    {step}
                  </li>
                ))}
              </ul>
              <p>{lane.answer}</p>
              <footer>
                <span>{lane.time}</span>
                <span className="lp-cost">{lane.cost}</span>
                <span className="lp-take">Взять этот ответ</span>
              </footer>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section" id="thinking">
        <div className="lp-split">
          <div className="lp-head left" data-reveal>
            <span className="lp-kicker">ИИ-фишка №2</span>
            <h2>Видно, как агент думает и работает</h2>
            <p>
              Пока модель размышляет, окно мыслей заливает «матрица». Каждый шаг
              — поиск, чтение файла, запуск тестов — виден одной строкой, а
              подробности открываются по клику.
            </p>
            <ul className="lp-points">
              <li>Шаги агента и инструменты в реальном времени</li>
              <li>Модель знает текущую дату и время</li>
              <li>Подтверждение опасных действий</li>
            </ul>
          </div>
          <div className="lp-think" data-reveal>
            <MatrixRain />
            <div className="lp-think-body">
              <span className="lp-think-title">▼ Рассуждение</span>
              <p>
                Разбираю задачу. Нужны свежие цены — вызову поиск. Сравню три
                источника, отброшу устаревшие, соберу таблицу и проверю расчёт…
              </p>
            </div>
            <div className="lp-tool">
              <code>web_search</code>
              <span>цены GPU H100 облака 2026</span>
              <em>выполняется</em>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="features">
        <div className="lp-head" data-reveal>
          <span className="lp-kicker">Возможности</span>
          <h2>Всё, что нужно для работы с ИИ — в одном окне</h2>
        </div>
        <div className="lp-grid">
          {FEATURES.map((item, index) => (
            <article
              key={item.title}
              className="lp-card"
              data-reveal
              style={{ transitionDelay: `${(index % 3) * 0.08}s` }}
            >
              <span className="lp-icon">{item.icon}</span>
              <h3>
                {item.title}
                {item.tag && <span className="lp-tag">{item.tag}</span>}
              </h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section" id="how">
        <div className="lp-head" data-reveal>
          <span className="lp-kicker">Как это работает</span>
          <h2>Три шага до первого результата</h2>
        </div>
        <ol className="lp-steps">
          <li data-reveal>
            <b>01</b>
            <h3>Регистрация</h3>
            <p>
              Создайте аккаунт — после подтверждения получите ${trial} на модели
              OpenAI бесплатно.
            </p>
          </li>
          <li data-reveal>
            <b>02</b>
            <h3>Выберите агента и модель</h3>
            <p>
              Готовые агенты — разработчик, аналитик рынка, ассистент — или
              свой, с навыками и коннекторами.
            </p>
          </li>
          <li data-reveal>
            <b>03</b>
            <h3>Поручите задачу</h3>
            <p>
              Агент ищет, считает, пишет код и файлы, а вы видите каждый шаг и
              цену ответа.
            </p>
          </li>
        </ol>
      </section>

      <section className="lp-section" id="pricing">
        <div className="lp-head" data-reveal>
          <span className="lp-kicker">Тарифы</span>
          <h2>Начните бесплатно, платите за то, что используете</h2>
        </div>
        <div className="lp-prices">
          <div className="lp-price" data-reveal>
            <span className="lp-plan">Пробный</span>
            <strong>${trial}</strong>
            <p>
              на модели OpenAI после регистрации. Бесплатные модели — без
              ограничений по оплате.
            </p>
            <button type="button" className="lp-ghost" onClick={onRegister}>
              Попробовать
            </button>
          </div>
          {(pricing?.plans ?? []).slice(0, 3).map((plan, index) => (
            <div
              key={plan.id}
              className={index === 0 ? 'lp-price hot' : 'lp-price'}
              data-reveal
            >
              <span className="lp-plan">{plan.name}</span>
              <strong>{plan.priceRub.toLocaleString('ru-RU')} ₽</strong>
              <p>
                {plan.days} дн. · модели на{' '}
                {plan.includedRub.toLocaleString('ru-RU')} ₽
                {plan.description ? ` · ${plan.description}` : ''}
              </p>
              <button type="button" className="lp-primary" onClick={onRegister}>
                Подключить
              </button>
            </div>
          ))}
          <div className="lp-price" data-reveal>
            <span className="lp-plan">Баланс</span>
            <strong>от 300 ₽</strong>
            <p>
              Пополняйте, когда нужно: списывается реальная цена ответа. Карта,
              СБП, SberPay.
            </p>
            <button type="button" className="lp-ghost" onClick={onRegister}>
              Начать
            </button>
          </div>
        </div>
      </section>

      <section className="lp-final" data-reveal>
        <h2>Попробуйте агентов, которые доводят дело до конца</h2>
        <button type="button" className="lp-primary big" onClick={onRegister}>
          Создать аккаунт
        </button>
      </section>

      <footer className="lp-footer">
        <span className="lp-logo small">
          <BeaconMark />
          QASTOM AGENT
        </span>
        <span>© {new Date().getFullYear()} QASTOM</span>
        <button type="button" onClick={onLogin}>
          Войти
        </button>
      </footer>
    </div>
  );
}
