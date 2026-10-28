# Инфраструктура

Конфигурация Yandex Cloud для публичного `labs.spbetu.ru`. Gate проверяет доступ к работам по [site/labs.json](../site/labs.json); `admin` означает пользователей из существующего списка `OIDC_ALLOWED_SUBJECTS`. [Схема сервисов](ARCHITECTURE.md).

| Каталог | Содержимое | Ключ state |
| --- | --- | --- |
| [foundation](foundation/) | Бакет, сервисные аккаунты, IAM, Lockbox и TLS-сертификат | `etu-web/prod/foundation.tfstate` |
| [runtime](runtime/) | Функции gate и quotes, API Gateway и домен | `etu-web/prod/release.tfstate` |

У каталогов отдельные state в приватном S3-бакете с `use_lockfile=true`. Параметры backend заданы в `backend.hcl.example` каждого каталога.

Скрипты сборки и публикации находятся в [scripts](../scripts/), тесты сборки в [tests](../tests/). Команды локального просмотра сайта приведены в [CONTRIBUTING.md](../CONTRIBUTING.md#сайт).

## Проверка

В CI используются OpenTofu 1.13.0 и Yandex provider 0.206.0. Из корня репозитория:

```sh
tofu fmt -check -recursive infra
tofu -chdir=infra/foundation init -backend=false -lockfile=readonly
tofu -chdir=infra/foundation validate
tofu -chdir=infra/foundation test
tofu -chdir=infra/runtime init -backend=false -lockfile=readonly
tofu -chdir=infra/runtime validate
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Для этих проверок доступ к облаку не нужен. `foundation` использует mock provider в тестах.

## Развёртывание

[validate.yml](../.github/workflows/validate.yml) проверяет код и собирает сайт с ZIP-архивами сервисов. После успешного push в `main` [release.yml](../.github/workflows/release.yml) публикует этот артефакт и применяет `runtime`, если включён `ETU_DEPLOY_ENABLED=true`.

[foundation.yml](../.github/workflows/foundation.yml) запускается вручную с операцией `plan` или `apply` при `ETU_INFRA_ENABLED=true`. Обновление сайта не запускает этот workflow.

Настройки хранятся в GitHub environments:

| Environment | Variables | Secrets |
| --- | --- | --- |
| `infrastructure` | `YC_INFRA_SERVICE_ACCOUNT_ID`, `TF_FOUNDATION_BACKEND_CONFIG` | `TF_FOUNDATION_CONFIG`, `TF_FOUNDATION_STATE_ACCESS_KEY_ID`, `TF_FOUNDATION_STATE_SECRET_ACCESS_KEY` |
| `production` | `YC_RELEASE_SERVICE_ACCOUNT_ID`, `YC_RUNTIME_SERVICE_ACCOUNT_ID`, `TF_RUNTIME_BACKEND_CONFIG` | `ETU_RUNTIME_CONFIG`, `TF_RUNTIME_STATE_ACCESS_KEY_ID`, `TF_RUNTIME_STATE_SECRET_ACCESS_KEY` |

`YC_RELEASE_SERVICE_ACCOUNT_ID` используется для загрузки файлов, `YC_RUNTIME_SERVICE_ACCOUNT_ID` для Terraform. Это разные аккаунты; загрузчик должен совпадать с `foundation.release_service_account_id`.

`TF_FOUNDATION_CONFIG` соответствует [foundation/variables.tf](foundation/variables.tf). `ETU_RUNTIME_CONFIG` содержит `foundation` из output `release_config`, `gate_secret_version_id`, `oidc_client_id` и `allowed_subjects` с парами `issuer`/`sub` администраторов. Поля описаны в [runtime/variables.tf](runtime/variables.tf). Секреты `OIDC_CLIENT_SECRET` и `GATE_COOKIE_KEY` хранятся в Lockbox.

После публикации `check_public.py` сверяет анонимный доступ с manifest: публичные файлы должны отвечать 200, файлы `admin` 401. Проверка входа администратора выполняется отдельно в браузере.

Workflow сохраняет output `release_tuple` в артефакте `deployed-<SHA>`. Для отката используют сохранённую сборку и её ZIP-архивы: [prepare_runtime.py](../scripts/prepare_runtime.py) формирует входные данные для нового плана с актуальными версией Lockbox и списком доступа. Версии функций и Gateway управляются Terraform.
