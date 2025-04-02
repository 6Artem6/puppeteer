#!/bin/bash

# Ззапускаем браузер
/usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf &

# Запускаем Node-приложение
node ./browser/browser.mjs