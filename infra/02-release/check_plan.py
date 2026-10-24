#!/usr/bin/env python3
"""Refuse destructive runtime plans and unexpected managed resource types."""
import json
import sys

ALLOWED = {'yandex_function', 'yandex_api_gateway', 'yandex_function_iam_binding'}


def check(plan):
    for item in plan.get('resource_changes', []):
        if item.get('mode') == 'data':
            continue
        if item['type'] not in ALLOWED or 'delete' in item['change']['actions']:
            raise ValueError(f"Manual review required: {item['address']}")


if __name__ == '__main__':
    check(json.load(open(sys.argv[1])))
    print('Runtime plan contains only allowed non-destructive changes')
