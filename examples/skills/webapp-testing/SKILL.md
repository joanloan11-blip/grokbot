---
description: "Тестирование локальных веб-приложений через Playwright: разведка DOM, действия, скриншоты, логи; helper with_server.py для запуска серверов."
enabled: true
---

# Web Application Testing

## Обзор
Тестирование локальных веб-приложений через Playwright (Python): проверка фронтенда, отладка поведения UI, скриншоты, логи браузера.

## Инструменты
- `scripts/with_server.py` — управляет жизнью сервера(ов) (поддерживает несколько). Запускай с `--help` первым делом; не читай исходник, если не нужна кастомизация — скрипт большой и засоряет контекст.
- Playwright Python — для самих сценариев.

## Дерево решений
```
Задача → статичный HTML?
  ├─ Да → читай HTML и найди селекторы
  │        ├─ Успех → пиши Playwright-скрипт по селекторам
  │        └─ Нет/неполно → как динамическое (ниже)
  └─ Нет (динамическое) → сервер уже запущен?
       ├─ Нет → python scripts/with_server.py --help, затем helper + скрипт
       └─ Да → разведка, потом действие:
            1. goto + wait_for_load_state('networkidle')
            2. скриншот или DOM
            3. найти селекторы в отрендеренном состоянии
            4. действия по найденным селекторам
```

## with_server.py
```bash
# один сервер
python scripts/with_server.py --server "npm run dev" --port 5173 -- python your_automation.py

# несколько (backend + frontend)
python scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

## Скрипт автоматизации (серверами управляет helper)
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)  # всегда headless
    page = browser.new_page()
    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')      # КРИТИЧНО: ждём JS
    # ... действия и проверки ...
    page.screenshot(path='shot.png')
    browser.close()
```

## Правила
- Всегда жди networkidle перед действиями — иначе селекторов ещё нет
- Селекторы — по data-testid/role, а не хрупкие CSS-цепи
- Сохраняй скриншот при падении — «картинка стоит 1000 токенов»
- Смотри логи консоли на ошибки/404/warning
- Не запускай headful, среда без дисплея

## Требования
```bash
pip install playwright && playwright install chromium
```
