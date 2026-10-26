# Основа инфраструктуры

Этот root создаёт отдельные ресурсы для `labs.spbetu.ru`: приватный бакет,
четыре сервисных аккаунта, метаданные Lockbox и управляемый TLS-сертификат. Ресурсы ЛК и промо в конфигурацию не входят.

Функции gate и quotes появляются на [этапе выпуска](../02-release/RUNTIME.md),
когда готовы проверенные ZIP-архивы. Provider `0.206.0` требует код уже
при создании функции. Оба этапа управляются Terraform/OpenTofu;
параллельный выпуск версий через CLI создаст расхождение со state.

## Доступ

| Аккаунт | Разрешения, описанные в конфигурации |
|---|---|
| `gate` | GET объектов `releases/*`, чтение своего Lockbox. На этапе 02 получает вызов своей функции. |
| `gateway` | На этапе 02 получает только вызов gate-функции. |
| `quote` | Отдельный runtime-аккаунт без доступа к файлам сайта и секретам входа. |
| `release` | PUT/GET объектов `releases/*`, LIST этого префикса. |

`release` не может удалять объекты, читать Lockbox или управлять IAM.
На самом бакете `gate` получает `storage.viewer`, а `release` —
`storage.uploader`. Policy ограничивает эти базовые права указанными операциями
и префиксом `releases/`; загрузка с заголовками объектного ACL запрещена.
В [Object Storage](https://yandex.cloud/en/docs/storage/security/overview)
одной policy недостаточно: сначала проверяются IAM или ACL бакета.

Обязательная переменная `bucket_management_principal_ids` содержит реальные ID
владельца и оператора foundation. Только для них policy сохраняет управление
бакетом; роли IAM эта переменная не выдаёт. Значения хранятся в закрытых tfvars
и передаются CI через environment secret `TF_FOUNDATION_CONFIG` в
`infrastructure`. Обычная GitHub variable для этого не используется.
Аккаунты `gate` и `release` в этот
список включать нельзя. Права оператора задаются отдельно при bootstrap.
Container Registry
и Serverless Containers в этой конфигурации не используются.

Бакет имеет versioning, лимит 1 GiB и запрет анонимного чтения, листинга
и просмотра конфигурации. Website hosting отсутствует. Удаление бакета,
сертификата и секрета защищено `prevent_destroy`; Lockbox и
Certificate Manager также имеют собственную защиту от удаления.

## Bootstrap до первого init

1. Утвердить реальные cloud/folder и план новых ресурсов. Проверить квоты
   и стоимость. VPC и YDB не требуются.
2. Подготовить отдельный приватный versioned S3-бакет для state. Он должен
   существовать до `init` и не управляется root-модулем, который хранит в нём
   своё состояние. Имена бакетов других проектов не подставляются автоматически.
3. Первый foundation и первый runtime применяет владелец через существующий
   вход YC после просмотра планов. Создание требует прав на каталог; CI не
   получает такие права на общий `catalog-default`. После создания назначить
   операторам `etu-web-prod-infra` и `etu-web-prod-runtime` роли только на
   конкретные новые ресурсы. Upload-аккаунт `release` этих прав не получает.
4. Настроить [GitHub Workload Identity Federation](https://yandex.cloud/en/docs/tutorials/security/wlif-github-integration):
   issuer `https://token.actions.githubusercontent.com`, JWKS
   `https://token.actions.githubusercontent.com/.well-known/jwks`, audience
   `https://github.com/m4tveevm`. Проверить audience фактически используемого action.
   Привязать subject `repo:m4tveevm@43579963/etu_web@1427391869:environment:infrastructure` к оператору,
   а `repo:m4tveevm@43579963/etu_web@1427391869:environment:production` к upload-аккаунту.
   Постоянные ID входят в subject этого репозитория; проверить `sub_claim_prefix`
   через GitHub API `repos/m4tveevm/etu_web/actions/oidc/customization/sub`.
   Для runtime Terraform завести отдельный аккаунт
   `YC_RUNTIME_SERVICE_ACCOUNT_ID` в защищённом environment `production`.
   Выдать ему административные роли только на новые функции и Gateway,
   а `iam.serviceAccounts.user` только на gate/gateway/quote SA. Эти назначения
   появляются после первого apply владельцем. Upload-аккаунт остаётся без них.
   Разрешить environments только для `main`, включить требуемое подтверждение
   и запрет обхода правил. Не использовать wildcard subject.
5. Backend S3 получает отдельные credentials через защищённые переменные
   окружения runner. Федеративный IAM-токен provider и S3-доступ к state
   имеют разные назначения. Ни один из них не относится к OIDC-секрету сайта.
6. Использовать OpenTofu 1.13.0 и native S3 locking: в обоих backend примерах
   задано `use_lockfile=true`. До первого настоящего apply проверить конкуренцию
   двух процессов на отдельном тестовом state key нового бакета: первый
   удерживает lock, второй получает ошибку блокировки, после освобождения
   повторная попытка проходит. Проверить также восстановление после прерывания.
   До успешной проверки CI apply выключен. Не обходить отказ через `-lock=false`.
   GitHub concurrency дополняет S3 lock и не заменяет его.

Основание выбора: [OpenTofu 1.13 S3 backend](https://opentofu.org/docs/v1.13/language/settings/backends/s3/)
описывает lock через conditional PUT, а [YC PutObject](https://yandex.cloud/en/docs/storage/s3/api-ref/object/upload)
поддерживает `If-None-Match: *`. В выделенном бакете проверены конкуренция двух
процессов, освобождение lock и повторное получение после прерывания. YDB для lock не создаётся.
State, бинарные планы и локальные backend-файлы не публикуются как artifacts.
Конфигурация не генерирует ключи сервисных аккаунтов и не читает secret payload.

## Проверка и план

Команды выполняются из корня репозитория. Для локальной проверки credentials
не нужны:

```sh
tofu -chdir=infra/01-foundation init -backend=false
tofu -chdir=infra/01-foundation fmt -check
tofu -chdir=infra/01-foundation validate
tofu -chdir=infra/01-foundation test
```

После bootstrap скопировать `backend.hcl.example` и `terraform.tfvars.example`
в одноимённые файлы без `.example`, заполнить реальные значения, установить
provider/backend credentials через защищённое окружение и подготовить план:

```sh
tofu -chdir=infra/01-foundation init -reconfigure -backend-config=backend.hcl
tofu -chdir=infra/01-foundation plan -out=foundation.tfplan
tofu -chdir=infra/01-foundation show -no-color foundation.tfplan
```

Перед применением проверить точный список новых ресурсов, IAM и отсутствие
изменений ЛК, промо и общей DNS-зоны. Apply выполняется только после просмотра
этого плана. При изменении входных данных или state план строится заново.

После одобренного apply сохранить `release_config` для второго этапа и добавить
только CNAME из `certificate_dns_challenges` в существующую DNS-зону. Дождаться
`ISSUED`. Challenge-запись сохраняется для продления сертификата.

## Секрет входа

Зарегистрировать отдельный confidential client в UpdSpace ID:
redirect URI `https://labs.spbetu.ru/auth/callback`, Authorization Code,
PKCE S256, scope `openid`, token auth `client_secret_basic`.
Оператор отдельно заполняет созданный Lockbox ключами `OIDC_CLIENT_SECRET`
и `GATE_COOKIE_KEY`. Второй ключ содержит 32 случайных байта в base64url
без padding (43 символа). Payload не передаётся Terraform, GitHub artifacts
или терминальному выводу. Второй этап принимает только ID версии секрета.

Для allowlist нужен точный `sub` владельца от issuer `https://id.updspace.com`.
Email и имя не подходят. Пока allowlist пуст, сайт закрыт для всех.

Локальная validation подтверждает схему конфигурации. Реальные IDs, права,
сертификат, secret version и состояние облака проверяются отдельным plan
после bootstrap.

Тесты используют mock provider и проверяют план без облачных запросов.
Они не заменяют проверку реальных разрешений: перед выпуском нужны успешные
GET/PUT/LIST внутри `releases/` и отказы для другого префикса, DELETE,
изменения bucket policy/ACL и загрузки с объектным ACL. Отдельно проверяется
чтение и обновление конфигурации оператором foundation.
