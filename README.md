# PharmaGuard AI

نظام إدارة صيدلية ذكي — هذه المرحلة تُنجز **الربط الآمن بقاعدة بيانات Supabase القائمة**، والمصادقة، والأدوار، وسياسات RLS. وظائف المخزون والوكيل الذكي لم تُبنَ بعد (مقصود: بعد التأكد من نجاح الربط).

---

## 1) المشروع الحالي (موجود مسبقًا — لا يُعاد إنشاؤه)

| العنصر | القيمة |
| --- | --- |
| Project URL | `https://ewsqllummpysxovtuqad.supabase.co` |
| Project Ref | `ewsqllummpysxovtuqad` |

الجداول الـ11 في `public` (لم تُنشأ ولم تُحذف ولم تُعدَّل بنيتها):

```
profiles, pharmacies, medicines, inventory_batches, stock_movements,
inventory_alerts, notifications, device_tokens, drug_interactions,
agent_runs, reports
```

كل الجداول **فارغة عمدًا** — لا بيانات تجريبية ولا أدوية وهمية.

---

## 2) طريقة الربط

الربط يتم بمتغيرات بيئة فقط، ولا يوجد أي مفتاح داخل الكود:

| المتغير | مكان الاستخدام | سرّي؟ |
| --- | --- | --- |
| `SUPABASE_URL` | السيرفر + يُمرَّر للمتصفح | لا |
| `SUPABASE_ANON_KEY` | المتصفح (محمي بـ RLS) + السيرفر | لا (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | **السيرفر فقط** — إنشاء أول مالك، إدارة الموظفين، التشخيص | **نعم** |
| `OWNER_BOOTSTRAP_TOKEN` | السيرفر فقط — تصريح إنشاء أول مالك | **نعم** |

أضفها من: **AppJet → Settings → Environment variables** (أو ملف `.env` محليًا، وهو مستثنى في `.gitignore`).

كيف يُمنع تسرّب المفتاح السري:

- الواجهة تبنى عبر Vite ولا تحتوي أي `VITE_*` سري.
- `/api/config` يعيد `supabaseUrl` و`supabaseAnonKey` فقط، مع أعلام `serviceRolePresent` / `bootstrapTokenPresent` كقيم منطقية بلا أي قيمة مفتاح.
- اختبار `tests/api.test.js` يفشل إذا ظهر أي حقل لمفتاح الخدمة في رد `/api/config`.
- لا يوجد أي `import.meta.env` لمفتاح الخدمة في `src/`.

---

## 3) الأدوار وسياسات RLS

الأدوار: `owner` (مالك الصيدلية) · `pharmacist` (صيدلي) · `inventory_manager` (مسؤول المخزون).

### تطبيق السياسات

افتح **Supabase → SQL Editor** والصق كامل الملف:

```
supabase/apply_all.sql
```

أو نزّله من التطبيق نفسه: `GET /api/setup/sql` (أو صفحة «تشخيص الربط» → زر نسخ الملف).

الملف:

- يفعّل `enable row level security` على الجداول الـ11 الموجودة.
- ينشئ `public.pg_role()` و`public.pg_pharmacy()` لقراءة دور المستخدم وصيدليته من `profiles`.
- ينشئ سياسات `select / insert / update / delete` لكل جدول حسب الدور **وحسب صيدلية المستخدم**.
- يمنع `anon` من الوصول المباشر للجداول (`revoke all ... from anon`).
- يضيف trigger يمنع أي مستخدم من تغيير دوره أو صيدليته من العميل.
- **لا** ينشئ أو يحذف أو يعيد تسمية أي جدول، ولا يُدخل بيانات.

### مصفوفة الصلاحيات

| الجدول | قراءة | كتابة |
| --- | --- | --- |
| `profiles` | صفّك + موظفو صيدليتك | صفّك (بدون تغيير الدور) / المالك يعدّل موظفيه |
| `pharmacies` | صيدليتك | المالك فقط |
| `medicines`, `inventory_batches`, `stock_movements`, `inventory_alerts` | كل موظفي الصيدلية | `owner`, `inventory_manager` |
| `drug_interactions`, `agent_runs`, `reports` | كل موظفي الصيدلية | `owner`, `pharmacist` |
| `notifications`, `device_tokens` | صفوف المستخدم نفسه | صفوف المستخدم نفسه |

> السياسات تتكيّف مع أسماء الأعمدة الفعلية: تبحث عن `id`/`user_id`/`profile_id`، وعمود الدور `role`/`user_role`/`account_role`/`role_name`، وعمود الصيدلية `pharmacy_id`/`pharmacy`/`store_id`/`pharmacies_id`. إن كان عمود الصيدلية غير موجود في أحد الجداول تُطبَّق سياسة على مستوى الدور فقط.

---

## 4) منع اختيار دور المالك

ثلاث طبقات مستقلة:

1. **الواجهة:** `src/pages/Register.jsx` يعرض `pharmacist` و`inventory_manager` فقط — لا خيار `owner`.
2. **السيرفر:** `assertSelfRegisterRole()` في `server/roles.js` يرفض `owner` و`pharmacy_owner` و`admin` وأي قيمة غير معروفة (400).
3. **قاعدة البيانات:** سياسة `insert` على `profiles` تسمح فقط بدورين، وtrigger `pg_profiles_guard_insert` يرفض أي صف بدور مالك من العميل.

---

## 5) إنشاء أول حساب مالك (آلية آمنة)

المسار: `POST /api/bootstrap/owner` — يعمل فقط في السيرفر بمفتاح `service_role`.

الشروط:

1. `OWNER_BOOTSTRAP_TOKEN` مضبوط على السيرفر، ويُقارن بالمدخل مقارنة زمنية ثابتة (`timingSafeEqual`).
2. ألا يوجد أي `owner` في `profiles` — بعد وجود مالك يُغلق المسار نهائيًا (`owner_exists`).
3. تحديد معدّل المحاولات (5 محاولات/10 دقائق لكل IP).
4. كلمة المرور 10 أحرف على الأقل.

عند النجاح: إنشاء مستخدم Auth (بريد مؤكَّد) → إنشاء الصيدلية → إدراج ملف المالك بدور `owner` وربطه بالصيدلية → إرجاع جلسة دخول جاهزة. عند فشل أي خطوة يتم التراجع (حذف المستخدم الذي أُنشئ).

استخدم صفحة **`/setup`** في التطبيق. بعد نجاحها، أوقف المسار نهائيًا بحذف `OWNER_BOOTSTRAP_TOKEN` من الإعدادات.

---

## 6) الاختبار

```bash
npm install
npm run build
npm test                     # 12 اختبارًا: الأدوار، منع المالك، حماية المسارات، عدم تسرّب الأسرار
npm run verify:supabase      # فحص حقيقي للاتصال والقراءة والكتابة والصلاحيات
```

`verify:supabase` يحتاج المفاتيح، ويقوم بـ:

- قراءة OpenAPI من PostgREST والتأكد من وجود الجداول الـ11.
- `select=*&limit=0` على كل جدول مع عدّاد الصفوف.
- `rpc('pg_rls_status')` للتأكد من تفعيل RLS ووجود سياسات.
- `rpc('pg_selftest')` بمفتاح الخدمة: يُدرج صفًا فارغًا **ثم يتراجع عنه بالكامل** (لا بيانات تبقى).
- التأكد أن `anon` لا يستطيع تنفيذ `pg_selftest` ولا قراءة `profiles`.

داخل التطبيق: صفحة **«تشخيص الربط»** (`/diagnostics`) تُظهر الحالة الحقيقية من السيرفر (RLS، عدد الصفوف، نتيجة اختبار الكتابة، صلاحيات الدور الحالي).

---

## 7) تشغيل محلي

```bash
cp .env.example .env     # ثم املأ القيم
npm install
npm run build
npm start                # http://localhost:3000
```

للتطوير: `npm run dev` (Vite على 5173 مع proxy إلى `/api`) و`npm run dev:server`.

---

## 8) ما لم يُنفَّذ بعد (مقصود)

- وظائف المخزون: الدفعات، حركات المخزون، تنبيهات النقص، FEFO.
- الوكيل الذكي والتفاعلات الدوائية (جداولها وسياساتها جاهزة، لكن منطق التشغيل لم يُبنى).
- الإشعارات و`device_tokens` (السياسات جاهزة فقط).
- هذه الوظائف تنتظر تأكيد نجاح الربط كما طُلب.
