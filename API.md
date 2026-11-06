# Banglar Biriyani API

Base address: `https://banglarbiriyani.netlify.app/api` (Netlify forwards `/api` to the Supabase Edge Function).
There is no version number in the path. A change that breaks existing callers (renaming or removing a field,
changing a meaning) must go under a new `/api/v2` and keep the old one running for a while.

## How every answer looks

- Success: `{ "data": ... }`. Lists may add `"meta": { "limit", "offset" }` (admin orders also add `total`).
- Error: `{ "error": { "code": "SOME_CODE", "message": "plain words", "details": null } }`.
  `details` holds field errors for validation problems and is `null` otherwise. It never holds internal error text on the live site.
- Status codes: 200 ok, 201 created, 400 broken JSON or bad id, 401 not signed in, 403 not allowed,
  404 not found, 409 already exists, 422 data not valid (or a rule such as a closed meal), 429 too many tries, 500 server problem.
- Sign-in is a cookie (`bb_session`, HttpOnly, SameSite=Lax). A `Authorization: Bearer <token>` header also works.
- Lists take `?limit=` and `?offset=`. Anything that is not a number falls back to the default.

## Public

| Method and path | What it does |
| --- | --- |
| `GET /api/health` | `{ data: { status: "ok" } }`. Use it to check the API is up. |
| `GET /api/menu` | All dishes and categories. |
| `GET /api/menu/:day` | Dishes for one day (`SATURDAY` .. `FRIDAY`), with `mealTime` (`LUNCH` or `DINNER`), price and portions left. |
| `GET /api/offers` | Offers shown on the home page. |
| `POST /api/offers/validate` | `{ code, subtotalBdt }` gives the discount. 60 tries per 15 minutes per address. |
| `GET /api/delivery-zones` | Delivery points and delivery time. Delivery is free. |
| `GET /api/meal-hours` | Hours (Bangladesh time) when same-day lunch and dinner orders are taken: `{ LUNCH: { startHour, endHour }, DINNER: {...} }`. |
| `GET /api/images/:id` | A photo uploaded by the owner (cached for a year). |
| `POST /api/orders` | Place an order (see below). 10 orders per 15 minutes per address. Sets `Location: /api/orders/<number>`. |
| `GET /api/orders/:orderNumber?phone=` | Track one order. Needs the phone number used for the order, unless signed in as its owner or staff. 20 wrong tries per 15 minutes per address. |
| `POST /api/auth/signup` | Create a customer account (name, mobile, password; email is optional). 20 per 15 minutes per address. |
| `POST /api/auth/login` | `{ identifier, password }`. 5 wrong passwords per address and 10 per account in 15 minutes. |
| `GET /api/auth/config` | `{ googleClientId }` (`null` until `GOOGLE_CLIENT_ID` is set). |
| `POST /api/auth/google` | `{ credential }`: Google ID token from the browser. Signs in or creates a CUSTOMER account and sets the session cookie. 401 invalid token, 409 email already has a password account, 503 not set up. |

### Placing an order

`POST /api/orders` with `customerName`, `customerPhone` (Bangladesh mobile), `customerAddress`, `scheduledDay`,
`paymentMethod` (`COD`, `BKASH`, `NAGAD`; `paymentTrxId` is required for the last two), optional `deliveryZoneId`, `offerCode`, `notes`, and
`items: [{ menuItemId, quantity, mealTime }]`. Prices always come from the server.

- `mealTime` (`LUNCH` or `DINNER`) says which meal a dish is for. The same dish can be on both, and each meal has its own portion count.
- For today, lunch orders are taken 12:00 pm to 4:00 pm and dinner orders 6:00 pm to 10:00 pm (Bangladesh time). Outside that, the answer is `422 MEAL_CLOSED`.
  Orders for another day can be placed at any time.
- Other 422 codes: `QUOTA_EXCEEDED`, `ITEM_UNAVAILABLE`, `ITEM_NOT_SCHEDULED`, `ZONE_UNAVAILABLE`, `OFFER_*`, `VALIDATION_ERROR`.

## Signed in (customer)

| Method and path | What it does |
| --- | --- |
| `GET /api/auth/me` | The signed-in user. |
| `PATCH /api/auth/profile` | Change name, phone or saved address. |
| `POST /api/auth/logout` | Ends the session. |
| `GET /api/orders/my-orders` | The customer's orders (newest first). `limit` default 50, max 100. |

## Admin panel

All need sign-in. `ADMIN` can do everything. `STAFF` can read and handle orders and edit dishes and daily meals, but cannot delete dishes or change users, offers or delivery points.

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /api/admin/stats` | ADMIN, STAFF | Counts and sales. |
| `GET /api/admin/schedule` | ADMIN, STAFF | The 7-day lunch and dinner plan. |
| `PUT /api/admin/schedule/:day` | ADMIN, STAFF | Replace one day's meals (up to 12 dishes per meal). |
| `GET /api/admin/menu` | ADMIN, STAFF | All dishes. |
| `POST /api/admin/menu` | ADMIN | Add a dish. |
| `PATCH /api/admin/menu/:id` | ADMIN, STAFF | Edit a dish. |
| `DELETE /api/admin/menu/:id` | ADMIN | Remove a dish (hidden instead if it has orders). |
| `GET /api/admin/orders` | ADMIN, STAFF | List orders. Filters: `day`, `status`, `paymentMethod`, `search`, `limit` (max 100), `offset`. An unknown `status` or `paymentMethod` gives `422 INVALID_QUERY`. |
| `PATCH /api/admin/orders/:id/status` | ADMIN, STAFF | Change order status (the customer gets an email for some). |
| `PATCH /api/admin/orders/:id/verify-payment` | ADMIN, STAFF | Mark an online payment as checked. |
| `GET /api/admin/users` | ADMIN | Accounts with order counts. `limit` default 200, max 500. |
| `PATCH /api/admin/users/:id/role` | ADMIN | Change a role or switch an account on or off. |
| `GET/POST/PATCH/DELETE /api/admin/offers` | read: ADMIN, STAFF; write: ADMIN | Promo offers. |
| `GET/POST/PATCH/DELETE /api/admin/delivery-zones` | read: ADMIN, STAFF; write: ADMIN | Delivery points. |
| `GET/PUT /api/admin/meal-hours` | read: ADMIN, STAFF; change: ADMIN | Lunch and dinner order hours (whole hours, 0-24, end after start). |
| `POST /api/admin/images` | ADMIN | Upload a dish photo `{ dataUrl }` (jpeg/png/webp, about 180 KB at most; the admin page shrinks it first). Returns `{ url: "/api/images/12" }`. |
| `GET /api/admin/push/config` | ADMIN, STAFF | `{ publicKey }` for phone notifications (`null` until the VAPID keys are set on the server). |
| `POST /api/admin/push/subscribe` | ADMIN, STAFF | Register this phone `{ endpoint }` (only real push-service addresses are accepted). |
| `POST /api/admin/push/unsubscribe` | ADMIN, STAFF | Remove this phone `{ endpoint }`. |
| `POST /api/admin/push/test` | ADMIN, STAFF | Send a test notification to your own phones. Returns `{ sent, failed }`. |
| `GET /api/order-push/config` | public | `{ publicKey }` for customer order notifications (`null` until the VAPID keys are set). |
| `POST /api/order-push/subscribe` | owner, or order number + phone | `{ endpoint, keys: { p256dh, auth }, lang, orders: [{ orderNumber, phone? }] }`. The customer's phone gets a push (Bangla or English) each time an admin changes one of these orders' status. Orders that are not theirs are skipped. Finished orders are dropped automatically. |
| `POST /api/order-push/unsubscribe` | public | `{ endpoint }`: stop all order notifications for this phone. |

## Rate limits

Limits are counted per visitor address (Netlify passes the real address) and kept in memory, so they reset when the function restarts.
A blocked call gets `429` with a `Retry-After` header (seconds).
