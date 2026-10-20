# Выпуск runtime

Terraform этого этапа создаёт две приватные Cloud Functions (gate и quotes),
назначения invoker и API Gateway с доменом `labs.spbetu.ru`. Он использует
отдельный state key `etu-web/prod/release.tfstate`. Основа и её state
описаны в [01-foundation](../01-foundation/README.md).

API Gateway направляет `/` и `/{proxy+}` для всех HTTP-методов в gate.
Публичного Object Storage integration нет. Gate может вызывать только
gateway SA, функцию quotes только gate SA. Роли `allUsers` не назначаются.

## Входные данные

Перед планированием должны существовать:

- Проверенный статический artifact шести работ (1, 2, 3, 4, 5, 7),
  загруженный в `releases/<gitSHA>/<manifestSHA256>/` и проверенный чтением.
- Архив `services/gate/dist/gate.zip` с установленными зависимостями и его SHA-256.
- Архив `services/quotes/dist/quotes.zip` и его SHA-256 из проверенной сборки.
- Выданный сертификат и заполненная версия Lockbox.
- Отдельный OIDC client и список разрешённых `(issuer, sub)`.

Экспортировать `release_config` из этапа 01 в объект `foundation` файла
`release.auto.tfvars.json`. В том же файле задать `release_id`,
`release_manifest_sha256`, `gate_zip_path`, `gate_zip_sha256`, `quote_zip_path`,
`quote_zip_sha256`, `gate_secret_version_id`, `oidc_client_id`, `allowed_subjects`.
Пути к архивам разрешаются относительно `infra/02-release`; абсолютный путь
runner также подходит. Значений секретов среди inputs нет. Пустой allowlist
допустим и закрывает доступ всем пользователям.

Upload-аккаунт из foundation может опубликовать и проверить artifact, но
не применить этот root. Первый runtime apply выполняет владелец через
существующий вход YC после просмотра плана. Затем отдельный WIF-оператор
получает `functions.admin` только на две созданные функции,
`api-gateway.admin` только на новый Gateway, чтение метаданных сертификата
и `iam.serviceAccounts.user` только на gate/gateway/quote SA.
Административные роли на общий каталог CI не выдаются.

В backend задано `use_lockfile=true` для OpenTofu 1.13.0. До первого apply
нужен [двухпроцессный cloud smoke](../01-foundation/README.md#bootstrap-до-первого-init)
на отдельном тестовом state key. Не включать CI при отказе lock и не обходить
его параметром `-lock=false`.

```sh
tofu -chdir=infra/02-release init -backend=false
tofu -chdir=infra/02-release fmt -check
tofu -chdir=infra/02-release validate
```

После настройки удалённого backend и credentials:

```sh
tofu -chdir=infra/02-release init -reconfigure -backend-config=backend.hcl
tofu -chdir=infra/02-release plan -out=release.tfplan
tofu -chdir=infra/02-release show -no-color release.tfplan
```

План должен пройти просмотр до apply. В первом выпуске он создаёт runtime;
при следующих создаёт версии функций при изменении их кода или конфигурации.
Публиковать версии этих же функций через CLI параллельно с Terraform нельзя.

## Cookies и шлюз

Интеграция `cloud_functions` использует явно заданный
`payload_format_version: "1.0"`. HTTP-метод, путь, query и headers передаются
функции в event. Повторяющиеся заголовки доступны через `multiValueHeaders`;
Cookie и Origin читаются из этого запроса. Контейнерный operation context
не используется. Формат описан в [документации интеграции](https://yandex.cloud/en/docs/api-gateway/concepts/extensions/cloud-functions).

Адаптер gate возвращает бинарные файлы в Base64 с `isBase64Encoded: true`;
API Gateway восстанавливает тело HTTP-ответа. Несколько `Set-Cookie`
передаются отдельными значениями `multiValueHeaders`. Облачная приёмка должна
подтвердить сохранение cookies, точные байты PDF/изображений, итоговые security
headers и лимиты ответа. Локальные тесты адаптера не доказывают свойства
работающего шлюза.

## Переключение и откат

`release_tuple` сохраняет SHA исходников и manifest, SHA обоих ZIP,
полный hash конфигурации gate, IDs и теги версий функций, ID версии Lockbox.
Gate tag содержит префикс `gate-` и 58 hex-символов hash (63 символа всего).
В hash входят ZIP, runtime/entrypoint, ресурсы, environment, runtime SA,
ссылки на Lockbox, metadata и logging options. Поэтому изменение allowlist,
клиента ID, manifest или secret version не переназначает тег старой
конфигурации. Gateway вызывает закреплённый тег, а не `$latest`.
В outputs раскрывается только конечный digest; пары `(issuer, sub)`
остаются sensitive и не включаются в `release_tuple`.

Quote tag зависит от первых 56 hex SHA-256 архива (`quote-...`, 224 бита).
Полный SHA и реальный ID версии сохраняются. Опубликованные теги не должны
назначаться коду или конфигурации с другим hash.

Для отката восстановить release inputs и ZIP-архивы предыдущего tuple,
построить и проверить новый план. Terraform создаст версию gate с прежним
кодом и release-prefix, затем обновит закреплённый тег Gateway. Старые объекты
не удаляются. Актуальный allowlist сохраняется, отозванные секреты не
возвращаются. Возврат только HTML не восстанавливает CSS, изображения и PDF,
которые тоже входят в выпуск.

При первом подключении домена добавить только CNAME из `site_dns_record`,
в режиме Cloudflare DNS-only. Apex `spbetu.ru`, его DNS-записи и Caddy
не меняются. Gateway service domain проходит через тот же gate и не даёт
анонимного доступа к файлам.

Приёмка включает реальный вход, запрет второго аккаунта, отзыв сессии,
HTML/CSS/JS/изображения/PDF, HEAD/Range/conditional requests, прямые
анонимные запросы к бакету и обеим функциям и проверенный откат.
Лимит artifact на файл 2 200 000 байт оставляет запас до
[лимита API Gateway 2.5 MB](https://yandex.cloud/en/docs/api-gateway/concepts/limits).
