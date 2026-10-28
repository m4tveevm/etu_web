# Доступ к лабораторным

Gate отдаёт публичные работы из приватного Object Storage без входа. Для файлов `admin` проверяет сессию UpdSpace ID и пару `issuer`/`sub` в `OIDC_ALLOWED_SUBJECTS`. Политика каждого файла и API цитат закреплена в manifest сборки.

## Настройки

Переменные передаются через окружение. В облаке секрет клиента и ключ cookie поступают из Lockbox.

| Переменная | Значение |
| --- | --- |
| `PUBLIC_ORIGIN` | HTTPS-адрес сайта без завершающего `/`: `https://labs.spbetu.ru` |
| `OIDC_ISSUER` | `https://id.updspace.com` |
| `OIDC_CLIENT_ID` | ID зарегистрированного confidential client |
| `OIDC_CLIENT_SECRET` | Секрет клиента |
| `GATE_COOKIE_KEY` | 32 случайных байта в base64url без padding |
| `OIDC_ALLOWED_SUBJECTS` | Администраторы: JSON-массив `[{"issuer":"https://id.updspace.com","sub":"точный subject"}]`; по умолчанию `[]` |
| `STATIC_BUCKET` | Имя приватного бакета с файлами сайта |
| `RELEASE_ID` | Git SHA сборки: 40 строчных hex-символов |
| `RELEASE_MANIFEST_SHA256` | SHA-256 файла `manifest.json`: 64 строчных hex-символа |
| `QUOTE_FUNCTION_URL` | Необязательно: `https://functions.yandexcloud.net/<id>?tag=<tag>`; без него API цитат недоступен |
| `PORT` | Порт локального HTTP-сервера, по умолчанию `8080` |

Callback клиента: `<PUBLIC_ORIGIN>/auth/callback`. Пустой список администраторов или сбой ID не закрывают публичные работы. Гость видит публичный каталог, вошедший администратор также видит работы `admin`. Кнопка входа и выхода находится в футере.

## Разработка

Нужны Node.js 22 (от 22.12) или 24 и Python 3. Из `services/gate`:

```sh
npm ci --ignore-scripts
npm test
python3 package.py
```

Тесты работают без облака и настоящих токенов. Упаковка создаёт `dist/gate.zip` с зависимостями и entrypoint `index.handler`.

`npm start` запускает HTTP-сервер на порту `PORT`. Для входа нужен HTTPS на `PUBLIC_ORIGIN`, для чтения файлов — доступ к metadata service Yandex Cloud. `/healthz` проверяет конфигурацию, без обращения к облаку.

Настройка облачных ресурсов и публикация описаны в [infra](../../infra/README.md).
