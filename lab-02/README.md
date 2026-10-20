# Лабораторная работа №2. Работа с таблицами

Матвеев М. А., группа 4372. Преподаватель: Нечитайленко Р. А.

## Просмотр

Откройте `index.html` в браузере либо из корня репозитория запустите:

```sh
python3 -m http.server 8000
```

Адрес: <http://localhost:8000/lab-02/>.

Таблица сохраняет ширину 500 px. На узком экране прокручивается её контейнер.

## Отчёт

[PDF](report/report.pdf), [исходник LaTeX](report/report.tex).

Для сборки нужны XeLaTeX, пакеты TeX Live, Times New Roman и FreeMono:

```sh
bash lab-02/report/build.sh
```

Если Times New Roman хранится отдельно, укажите каталог с `Times.TTF`, `Timesbd.TTF`, `Timesi.TTF` и `Timesbi.TTF`:

```sh
FONT_DIR=/path/to/fonts bash lab-02/report/build.sh
```

## Проверка

Страница проверена в Chromium 153 на ширинах 320, 375, 768 и 1440 px. Проверены загрузка ресурсов и параметры задания. Снимки результата находятся в `report/assets/`.
