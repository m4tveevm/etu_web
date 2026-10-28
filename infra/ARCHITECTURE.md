# Сайт лабораторных

`labs.spbetu.ru` публикует лабораторные и PDF-отчёты из `site/labs.json`.
Работы с `access: "admin"` доступны после входа через UpdSpace ID пользователям
из списка администраторов. Основной ЛК работает отдельно на `spbetu.ru`.

```mermaid
flowchart LR
    Browser[Браузер] --> Gateway[API Gateway и TLS]
    Gateway -->|gateway SA| Gate[Приватная gate-функция]
    Gate -->|Вход admin: OIDC и UserInfo| ID[UpdSpace ID]
    Gate -->|gate SA| Storage[Приватный Object Storage]
    Gate -->|gate SA| Quotes[Приватная Cloud Function]
```
