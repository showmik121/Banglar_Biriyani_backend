# Banglar Biriyani — Backend API

Hono + Neon PostgreSQL + Drizzle ORM. Serves the menu, login/sign-up, orders and the admin panel
for the [frontend](https://github.com/showmik121/Banglar_Biriyani_frontend).

## প্রথমবার চালানো

1. `.env.example` ফাইলটা কপি করে নাম দিন `.env`, তারপর ভেতরে আপনার Neon `DATABASE_URL` আর একটা লম্বা `JWT_SECRET` বসান।
2. টেবিল তৈরি ও নমুনা মেনু:
   ```bash
   npm install
   npm run db:push
   npm run db:seed
   ```
3. সার্ভার চালু: `npm run dev` (অথবা `run-backend.bat`-এ ডাবল-ক্লিক)। API চলবে http://localhost:3001-এ।

`.env` কখনো GitHub-এ যাবে না, `.gitignore` সেটা আটকে রাখে।

## টেস্ট

| কমান্ড | কী চেক করে | ডাটাবেস লাগে? |
| --- | --- | --- |
| `npm run test:unit` | phone/email/password যাচাই, order validation, login token, health route, `.env` সুরক্ষা | না |
| `npm run test:integration` | আসল API: menu, sign-up, login, order, admin role | হ্যাঁ (আলাদা test database) |
| `npm run typecheck` | TypeScript-এ ভুল আছে কিনা | না |

`verify.bat`-এ ডাবল-ক্লিক করলে GitHub-এর মতো একই চেকগুলো আপনার কম্পিউটারে চলে।

## GitHub Actions (CI)

প্রতিটা push-এ `.github/workflows/ci.yml` চলে:

1. **Type check & unit tests**: সবসময় চলে।
2. **Integration tests**: শুধু তখনই চলে যখন GitHub-এ `TEST_DATABASE_URL` secret দেওয়া থাকে।
   Neon-এ একটা আলাদা *test branch* বানিয়ে তার connection string দিন, আসল ডাটাবেস নয়,
   কারণ এই টেস্ট ডাটাবেসের ডেটা মুছে নতুন করে বসায়।
   Repository → Settings → Secrets and variables → Actions → New repository secret → নাম `TEST_DATABASE_URL`।

## Admin panel

Open `/admin` on the website and sign in with an ADMIN or STAFF account.

| পাতা | কী করা যায় | কে পারে |
| --- | --- | --- |
| Live Orders | অর্ডার দেখা, স্ট্যাটাস বদলানো (Confirmed → Preparing → Out for delivery → Delivered), bKash/Nagad পেমেন্ট যাচাই | ADMIN, STAFF |
| Menu & Dishes | খাবার যোগ, ছবি ও দাম বদলানো, চালু/বন্ধ | ADMIN (যোগ/মুছা), STAFF (এডিট) |
| Offers | প্রোমো কোড (যেমন DIU10), % বা ৳ ছাড়, সর্বনিম্ন অর্ডার, শুরু/শেষ তারিখ | ADMIN (STAFF শুধু দেখে) |
| Delivery Points | ডেলিভারি এলাকা, প্রতিটার ফি আর সময় | ADMIN (STAFF শুধু দেখে) |
| Customers & Staff | কাউকে STAFF/ADMIN বানানো বা বন্ধ করা | ADMIN |

নিরাপত্তা: পাসওয়ার্ড bcrypt দিয়ে hash করা, login session HttpOnly cookie-তে, ৫ বার ভুল পাসওয়ার্ডে ১৫ মিনিট বন্ধ,
প্রতিটা admin API-তে role যাচাই, আর প্রতিটা পরিবর্তন `audit_logs` টেবিলে লেখা থাকে।
দাম, ছাড় আর ডেলিভারি ফি সবসময় server-এ হিসাব হয়, browser থেকে বদলানো যায় না।

### নতুন টেবিল যোগ করা (একবার)

এই আপডেটে `offers` আর `delivery_zones` টেবিল যোগ হয়েছে। ডাটাবেসে বসাতে:

```bash
npm run db:push
```

নমুনা ডেলিভারি পয়েন্ট আর DIU10 অফারসহ সব নতুন করে বসাতে চাইলে (পুরোনো ডেটা মুছে যাবে):

```bash
npm run db:seed
```

Live-এ যাওয়ার আগে `.env`-এ `SEED_ADMIN_PASSWORD` দিয়ে শক্ত admin পাসওয়ার্ড সেট করুন।
