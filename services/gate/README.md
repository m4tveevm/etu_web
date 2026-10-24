# Закрытый доступ к лабораторным

Gate выдаёт файлы из приватного Object Storage после входа через UpdSpace ID. Доступ определяется точной парой `issuer` и `sub`. Пустой список пользователей закрывает весь сайт. Email и административные признаки ID не участвуют в допуске.

## Вход и сессия

`GET /auth/login` начинает Authorization Code Flow с PKCE S256. Случайные state, nonce и verifier хранятся 5 минут в зашифрованной cookie. Callback проверяет state, обменивает одноразовый код, проверяет RS256-подписи через JWKS, issuer, audience, срок токенов и nonce ID token. Затем он сверяет UserInfo и список разрешённых пользователей.

Сессия содержит access token внутри AES-256-GCM cookie с `Secure`, `HttpOnly`, `SameSite=Lax` и префиксом `__Host-`. Cookie привязана к origin и своему имени, живёт не дольше access token и максимум 30 минут. Значение длиннее 3800 байт отклоняется. JavaScript не получает OAuth-токены. Refresh token не запрашивается.

Каждый запрос файла или API снова проверяет UserInfo. Отозванный токен, заблокированный пользователь или ошибка ID закрывают доступ и очищают cookie. `POST /auth/logout` принимает только Origin сайта, очищает cookie и пытается отозвать access token. При недоступном ID локальный выход сохраняется, но удалённый отзыв не подтверждён; копия ранее выданной cookie остаётся применима до отзыва или истечения access token. Выход не завершает SSO-сессию самого ID.

## Файлы и функция цитат

Runtime читает только `releases/<RELEASE_ID>/<RELEASE_MANIFEST_SHA256>/`. Manifest закреплён SHA-256 в конфигурации. Gate разрешает только перечисленные в нём пути и проверяет размер и хеш каждого объекта перед выдачей. Размер файла ограничен 2 200 000 байт. Cloud Function возвращает тело в Base64, Gateway декодирует его перед отправкой браузеру. JSON функции ограничен 3 400 000 байт, ниже лимита сервиса 3.5 MB; декодированный файл оставляет запас до лимита Gateway 2.5 MB. URL bucket и подписанные ссылки браузеру не выдаются; ответы содержат `private, no-store`.

Доступ к Object Storage и приватной функции цитат выполняется с IAM-токеном service account из metadata service. Статических S3-ключей нет. `GET /api/v1/quote` проходит ту же проверку пользователя и проверяет JSON общим модулем `services/quotes/contract.mjs`. HTML использует CSP без inline scripts/styles. Служебный `GET /healthz` возвращает только `ok` или `unavailable` и не проверяет облачные зависимости.

Gateway вызывает приватную Node.js 22 Cloud Function с `payload_format_version: "1.0"`. Адаптер читает фактический `event.path`, сохраняет повторяющиеся query-параметры и объединяет Cookie из `multiValueHeaders`. Повторяющийся Origin отклоняется. Заголовок `X-Yc-ApiGateway-Operation-Context` не используется. В ответе несколько Set-Cookie передаются отдельными значениями `multiValueHeaders`, PDF и изображения сохраняют исходные байты. HEAD возвращает заголовки файла без тела. Invoker функции должен быть только у service account шлюза. До публикации нужно проверить полный вход, несколько Set-Cookie и загрузку самого большого бинарного файла через настоящий Gateway.

## Конфигурация

| Переменная | Значение |
|---|---|
| `PUBLIC_ORIGIN` | `https://labs.spbetu.ru`, без завершающего `/` |
| `OIDC_ISSUER` | `https://id.updspace.com` |
| `OIDC_CLIENT_ID` | Зарегистрированный confidential client |
| `OIDC_CLIENT_SECRET` | Секрет клиента из закреплённой версии Lockbox |
| `GATE_COOKIE_KEY` | 32 случайных байта в base64url без padding, из Lockbox |
| `OIDC_ALLOWED_SUBJECTS` | JSON-массив `[{"issuer":"https://id.updspace.com","sub":"точный subject"}]`; отсутствие означает `[]` |
| `STATIC_BUCKET` | Имя приватного bucket |
| `RELEASE_ID` | Полный Git SHA: 40 строчных hex-символов |
| `RELEASE_MANIFEST_SHA256` | SHA-256 точных байтов manifest: 64 строчных hex-символа |
| `QUOTE_FUNCTION_URL` | `https://functions.yandexcloud.net/<id>?tag=<release-tag>` |
| `PORT` | Только для локального HTTP-сервера, по умолчанию `8080` |

Callback регистрируется в ID точно как `https://labs.spbetu.ru/auth/callback`. Discovery и все OIDC endpoints должны принадлежать настроенному issuer. Неверная обязательная конфигурация возвращает 503. В журнал попадают только коды событий, без URL callback, токенов, cookie и персональных claims.

## Локальная проверка

Из `services/gate`:

```sh
npm ci --ignore-scripts
npm test
```

Тесты используют синтетический issuer, RSA-ключи и подставные HTTP-ответы. Проверяются подписи, issuer/audience/expiry/nonce, PKCE/state, повтор callback, cookie, отказ чужому пользователю, отзыв, закрытый Object Storage и контракт цитат. Тесты адаптера проверяют дубликаты параметров, несколько Set-Cookie, точность бинарного ответа, HEAD и воспроизводимость ZIP. Они не обращаются к реальному ID или облаку. Для проверки архива нужен Python 3.

Из корня репозитория:

```sh
python3 services/gate/package.py
```

Команда создаёт `services/gate/dist/gate.zip` с entrypoint `index.handler`. В ZIP входят исходники gate, общий контракт цитат и установленная `jose` 6.2.12 из lockfile. Корневой `index.js` использует CommonJS, исходники сохраняют ESM. Архив содержит все зависимости; установка пакетов в облаке не нужна. Порядок файлов, даты и права в ZIP фиксированы. Локальный HTTP-сервер запускается командой `npm start`.

Перед публикацией нужны зарегистрированный OIDC-клиент, subject владельца, Lockbox, приватные IAM-права и проверка полного входа через настоящий Gateway. Локальные тесты этих действий не подтверждают.

Документация: [OIDC discovery](https://id.updspace.com/.well-known/openid-configuration), [IAM-аутентификация Object Storage](https://yandex.cloud/en/docs/storage/api-ref/authentication), [формат Gateway](https://yandex.cloud/en/docs/api-gateway/concepts/extensions/cloud-functions), [ответ функции](https://yandex.cloud/en/docs/functions/concepts/function-invoke#response), [зависимости Node.js](https://yandex.cloud/en/docs/functions/lang/nodejs/dependencies), [IAM в Node.js Functions](https://yandex.cloud/en/docs/functions/lang/nodejs/context), [лимиты Functions](https://yandex.cloud/en/docs/functions/concepts/limits), [лимиты Gateway](https://yandex.cloud/en/docs/api-gateway/concepts/limits).
