# Сайт лабораторных

Лабы и отчёты открыты на `labs.spbetu.ru`. Работы с `access: "admin"` в `site/labs.json` доступны после входа через UpdSpace ID. ЛК на `spbetu.ru` работает отдельно.

```mermaid
flowchart LR
    Browser[Браузер] --> Gateway[API Gateway]
    Gateway --> Gate[Gate]
    Gate --> ID[UpdSpace ID]
    Gate --> Storage[Object Storage]
    Gate --> Quotes[Цитаты]
```
