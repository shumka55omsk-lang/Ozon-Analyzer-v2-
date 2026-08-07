OZON COMPETITOR ANALYZER v3

Исправлено:
- новый endpoint Ozon entrypoint-api используется первым;
- старый composer-api оставлен как fallback;
- поддержка коротких ссылок Ozon с попыткой разрешить redirect;
- поддержка /product/ и /products/;
- подробная диагностика ошибок Ozon 403/429/разбор;
- HTML/JSON-LD fallback.

Для Vercel загрузите index.html, package.json и папку api в корень проекта.
После Deploy проверьте адрес /api/ozon-product?url=<полная ссылка Ozon>.
