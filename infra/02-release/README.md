# Выпуск приложения

Изменение HTML, CSS, PDF или кода сервиса проходит `validate.yml`. Workflow проверяет YAML через actionlint 1.7.12 с закреплённой контрольной суммой, собирает стили, запускает тесты, проверяет Terraform и сохраняет артефакт конкретного Git commit. `release.yml` получает именно этот артефакт. Для публикации нужны успешный push в `main`, включённый `ETU_DEPLOY_ENABLED` и доступ к GitHub environment `production`.

Состояние ресурсов приложения хранится отдельно от foundation. Обновление страницы не запускает первый этап и не меняет общий DNS, ЛК или промосайт. Ресурсами двух функций и Gateway владеет Terraform этого каталога. Выпускать их версии параллельно через CLI нельзя.

## Проверка и упаковка

```sh
python3 -m unittest discover -s infra/02-release -p 'test_*.py' -v
python3 infra/02-release/build.py --release-id "$(git rev-parse HEAD)" --output dist/site
python3 infra/02-release/upload.py --directory dist/site
python3 services/quotes/package.py
python3 services/gate/package.py
```

`dist/site` должен быть новым каталогом. В него входят только страницы, готовые стили, скрипты, изображения и шесть PDF. Исходники заданий, LaTeX, зависимости, настройки окружения и Terraform state не публикуются. Размер каждого файла ограничен 2 200 000 байт с запасом относительно лимитов Gateway.

`manifest.json` содержит версию контракта, SHA коммита, пути, MIME-типы, размеры и SHA256 файлов. Каталог бакета имеет вид `releases/<git-sha>/<manifest-sha256>/`. Разные сборки одного коммита получают разные пути. Gate проверяет manifest по закреплённому хешу и проверяет каждый файл перед выдачей.

## Первый выпуск

1. Подготовить приватный versioned remote state с `use_lockfile=true` и выполнить двухпроцессную проверку lock на отдельном тестовом key. Первый foundation и runtime применяет владелец через существующий вход YC после просмотра планов. См. [первый этап](../01-foundation/README.md).
2. Зарегистрировать отдельный confidential клиент ID с точным callback `https://labs.spbetu.ru/auth/callback`, grant `authorization_code`, scope `openid` и PKCE S256. Внести его secret и ключ шифрования cookie в новую версию Lockbox. Значения не передаются Terraform.
3. Подготовить `ETU_RUNTIME_CONFIG`: объект `foundation` из `tofu output -json release_config`, `gate_secret_version_id`, `oidc_client_id` и `allowed_subjects`. Последний содержит только подтверждённые пары `issuer`/`sub`. Email не используется для доступа. Поля определены в [variables.tf](variables.tf), ресурсы приложения в [runtime.tf](runtime.tf).
4. Настроить GitHub environments `infrastructure` и `production`: разрешить только `main`, назначить проверяющего, ограничить изменение переменных и секретов. В этом репозитории GitHub использует immutable subject: `repo:m4tveevm@43579963/etu_web@1427391869:environment:infrastructure` и `repo:m4tveevm@43579963/etu_web@1427391869:environment:production`. При настройке сверить префикс через GitHub API `repos/m4tveevm/etu_web/actions/oidc/customization/sub`; вариант без постоянных ID не совпадает с выдаваемым токеном. Долгоживущий облачный ключ в workflow не нужен.
5. Заполнить переменные `YC_RELEASE_SERVICE_ACCOUNT_ID`, `YC_RUNTIME_SERVICE_ACCOUNT_ID`, `TF_RUNTIME_BACKEND_CONFIG` и секреты `TF_RUNTIME_STATE_ACCESS_KEY_ID`, `TF_RUNTIME_STATE_SECRET_ACCESS_KEY`, `ETU_RUNTIME_CONFIG`. Для загрузки и Terraform нужны разные service accounts. State credentials относятся только к отдельному хранилищу состояния.
6. После первого apply владельцем назначить WIF-операторам роли только на созданные ресурсы, проверить их доступ и бюджет. Включить `ETU_DEPLOY_ENABLED=true` только после успешного cloud smoke блокировки state и приёмки входа. До этого workflow облако не меняет.
7. После первого выпуска проверить вход разрешённого и постороннего аккаунтов, отзыв доступа, выход, PDF и обновление цитаты. `check_public.py` проверяет только отказ анонимному посетителю. Он не заменяет вход через браузер.

Загрузчик сначала проверяет локальные хеши. Затем загружает ресурсы, HTML и manifest последним. Объекты с другим содержимым по существующему пути вызывают ошибку. Ответы Object Storage проверяются по размеру и ETag. MD5 здесь служит проверке передачи; целостность релиза закреплена SHA256 manifest и файлов.

Gate и quotes упаковываются из того же commit в ZIP; зависимости gate устанавливаются через `npm ci` перед упаковкой. Оба архива проверяются по SHA256 перед передачей Terraform. Gate tag зависит от ZIP и всей конфигурации, включая manifest, allowlist и Lockbox version; Gateway вызывает этот тег вместо `$latest`. Отдельный quote tag зависит от ZIP сервиса. Для CI используется официальный YC CLI 1.41.0, его бинарник закреплён хешем в `install-yc.sh`.

## Учётные записи CI

| Переменная | Назначение |
|---|---|
| `YC_INFRA_SERVICE_ACCOUNT_ID` | Первый этап в environment `infrastructure`: ресурсы foundation и их IAM. Выдаётся отдельно при bootstrap. |
| `YC_RELEASE_SERVICE_ACCOUNT_ID` | Только загрузка файлов в `releases/`. Должен точно совпадать с `foundation.release_service_account_id`. Terraform и IAM не меняет. |
| `YC_RUNTIME_SERVICE_ACCOUNT_ID` | Второй этап в environment `production`: две функции и Gateway и необходимые привязки к ним. Это отдельный actor с правами на управление этими ресурсами и использование их service accounts. |

Workflow получает отдельный краткоживущий IAM-токен для каждого этапа публикации. Учётные данные remote state доступны только шагу Terraform. Перед облачной авторизацией workflow проверяет ID учётной записи загрузчика и отклоняет совпадающие upload/runtime accounts.

Список `allowed_subjects` хранится в GitHub secret `ETU_RUNTIME_CONFIG`, временных файлах с правами 0600 и защищённом Terraform state. Переменная Terraform помечена sensitive. Она не входит в `release_tuple` и артефакт `deployed-*`; plan JSON и tfvars удаляются в конце job. Terraform state и служебная конфигурация функции всё равно содержат список, поэтому доступ к ним ограничивается отдельно.

## Откат

Сохранить `release_tuple` после каждого успешного выпуска: Git SHA, SHA manifest и обоих ZIP, hash конфигурации gate, теги и IDs версий функций, ссылку на артефакт. GitHub хранит сборку 30 дней, сведения о выпуске 90 дней. Бакет не очищается автоматически.

Для отката взять сохранённый артефакт с обоими ZIP, сформировать переменные второго этапа через `prepare_runtime.py` и проверить новый `tofu plan`. Использовать действующую версию Lockbox и актуальный список разрешённых пользователей. Применить сохранённый план. Первый этап, DNS и данные других сервисов остаются прежними. Отдельно проверить авторизацию и содержимое файлов после переключения.

Повторная загрузка подтверждённого артефакта допустима. Откат нельзя собирать заново из старого исходника: зависимости или упаковка могли измениться. Автоматическое удаление старых релизов не настроено.

## Статус

Сайт развёрнут на `labs.spbetu.ru`: настроены environments, WIF, отдельные remote state, клиент ID, Lockbox и DNS. Вход владельца, закрытый каталог, выдача PDF и получение цитат проверены. Результат каждого следующего выпуска подтверждается его GitHub Actions run и артефактом `deployed-<SHA>`. Секреты, state, планы и приватный список пользователей не следует прикладывать к публичному PR.
