# Работа с репозиторием

Каждая папка `lab-*` содержит самостоятельную работу с готовым CSS и PDF-отчётом. Её можно скопировать отдельно от репозитория. Для каждой лабораторной создаётся отдельная ветка, PR направляется в `main`.

Команды ниже выполняются из корня репозитория; `lab-01` можно заменить на нужную работу.

## Просмотр и стили

Открой `lab-01/index.html` в браузере. Для просмотра через HTTP:

```sh
python3 -m http.server 8000
```

Страница будет доступна по адресу <http://localhost:8000/lab-01/>. Node.js нужен только для пересборки стилей после изменения SCSS:

```sh
npm ci --prefix lab-01
npm run build:css --prefix lab-01
```

Сохраняй в коммите и SCSS, и собранный CSS: HTML использует готовые стили.

## Отчёты

Нужны XeLaTeX с пакетами TeX Live, шрифты Times New Roman и FreeMono, Python 3 и Pygments:

```sh
python3 -m pip install -r lab-01/report/requirements.txt
bash lab-01/report/build.sh
```

Скрипт собирает `report/report.tex` в `report/report.pdf`. Если Times New Roman не установлен в системе, укажи каталог с файлами `Times.TTF`, `Timesbd.TTF`, `Timesi.TTF` и `Timesbi.TTF`:

```sh
FONT_DIR=/path/to/fonts bash lab-01/report/build.sh
```

## Сайт

Список работ задаётся в [site/labs.json](site/labs.json). Для новой работы добавь папку `lab-XX` и запись:

```json
{"id": "lab-08", "title": "Тема работы", "access": "public", "enabled": true}
```

`public` открывает работу всем, `admin` оставляет её администраторам из `OIDC_ALLOWED_SUBJECTS`. По умолчанию работа публичная и включена; `enabled: false` полностью исключает её из сборки. Политика действует на HTML, PDF, изображения и оболочку просмотра. Для нескольких страниц используй `pages`, как у ЛР7.

Общий каталог и оболочка просмотра находятся в `site/`. Для локального просмотра:

```sh
python3 scripts/build.py --release-id "$(git rev-parse HEAD)" --output dist/site
python3 -m http.server 8000 --directory dist/site
```

Перед сборкой `dist/site` должен отсутствовать. Локальный HTTP-сервер отдаёт все файлы без проверки `access`; разграничение доступа и API проверяют через [gate](services/gate/README.md).

Сайт [labs.spbetu.ru](https://labs.spbetu.ru) открыт для просмотра. Вход через UpdSpace ID даёт администраторам доступ к закрытым работам; кнопка входа и выхода находится в футере. Устройство описано в [схеме](infra/ARCHITECTURE.md), публикация в [infra/README.md](infra/README.md).

Репозиторий GitHub публичный: `access: "admin"` ограничивает доступ на сайте, но не скрывает исходники в GitHub.
