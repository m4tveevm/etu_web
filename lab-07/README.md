# Лабораторная работа №7. Адаптивная вёрстка и медиазапросы

Матвеев М. А., группа 4372. Преподаватель: Нечитайленко Р. А.

## Просмотр

Откройте `index.html` в браузере либо из корня репозитория запустите:

```sh
python3 -m http.server 8000
```

Адрес: <http://localhost:8000/lab-07/>.

В `index.html` размещена адаптивная сетка карточек, в `media.html` показана смена цвета текста при ширине окна 480 и 800 px.

## Отчёт

[PDF](report/report.pdf), [исходник LaTeX](report/report.tex).

Для сборки нужны XeLaTeX, пакеты TeX Live, Times New Roman, FreeMono и Python 3 с Pygments:

```sh
python3 -m pip install -r lab-07/report/requirements.txt
bash lab-07/report/build.sh
```

Если Times New Roman хранится отдельно, укажите каталог с `Times.TTF`, `Timesbd.TTF`, `Timesi.TTF` и `Timesbi.TTF`:

```sh
FONT_DIR=/path/to/fonts bash lab-07/report/build.sh
```

## Проверка

В Chromium 153 проверены медиазапросы, загрузка ресурсов и отображение страницы на ширинах 320, 375, 768 и 1440 px. Снимки страницы находятся в `report/assets/`.

## Сборка стилей

Исходники стилей хранятся в `style.scss` и `media.scss`. Для изменения оформления установите зависимости и запустите Sass:

```sh
cd lab-07
npm ci
npm run build:css
```

`style.css` и `media.css` содержат результат минификации. Эти файлы подключаются к HTML и хранятся в репозитории, поэтому готовую страницу можно открыть без Node.js. В отчёте приведены читаемые исходники SCSS с подсветкой синтаксиса.

## Содержание страниц

«Манга после занятий» содержит шесть заметок читательского клуба.
Иллюстрация в `assets/reading-night.png` показывает кофе и раскрытую книгу.
Карточки сохраняют сетку и квадратную область иллюстрации из образца задания.

На странице `media.html` цвет меняет короткая реплика Кэна Канеки
«Сколько будет тысяча минус семь?» из первого сезона, серии 12.
[Серия на Crunchyroll](https://www.crunchyroll.com/watch/GK9U34MXN/ghoul),
[текст реплики](https://transcripts.foreverdreaming.org/viewtopic.php?t=108005).
