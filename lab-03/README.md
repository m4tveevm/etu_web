# Лабораторная работа №3. Относительное и абсолютное позиционирование

Матвеев М. А., группа 4372. Преподаватель: Нечитайленко Р. А.

## Просмотр

Откройте `index.html` в браузере либо из корня репозитория запустите:

```sh
python3 -m http.server 8000
```

Адрес: <http://localhost:8000/lab-03/>.

Композиция имеет размер 600×400 px и прокручивается внутри контейнера на узком экране. Изображения из архива задания находятся в `img/`.

## Отчёт

[PDF](report/report.pdf), [исходник LaTeX](report/report.tex).

Для сборки нужны XeLaTeX, пакеты TeX Live, Times New Roman, FreeMono и Python 3 с Pygments:

```sh
python3 -m pip install -r lab-03/report/requirements.txt
bash lab-03/report/build.sh
```

Если Times New Roman хранится отдельно, укажите каталог с `Times.TTF`, `Timesbd.TTF`, `Timesi.TTF` и `Timesbi.TTF`:

```sh
FONT_DIR=/path/to/fonts bash lab-03/report/build.sh
```

## Проверка

В Chromium 153 проверены загрузка изображений, их координаты и наложение на ширинах 320, 375, 768 и 1440 px. Снимки композиции находятся в `report/assets/`.

## Сборка стилей

Исходники стилей хранятся в `style.scss`. Для изменения оформления установите зависимости и запустите Sass:

```sh
cd lab-03
npm ci
npm run build:css
```

`style.css` содержит результат минификации. Этот файл подключается к HTML и хранится в репозитории, поэтому готовую страницу можно открыть без Node.js. В отчёте приведены читаемые исходники SCSS с подсветкой синтаксиса.
