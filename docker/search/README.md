# تشغيل OpenSERP (أساسي) وSearXNG (احتياطي) عبر Docker Compose

هذا الدليل مخصّص لتشغيل محركي البحث الطبيين **بشكل مستقل تمامًا** عن حاوية تطبيق **PharmaGuard AI** الحالية، ودون كشف منافذهما للإنترنت العام، ودون أي تعديل على قاعدة بيانات Supabase أو إعدادات التطبيق.

---

## الملفات المضمنة
- `docker-compose.search.yml` (في جذر المشروع): يُشغّل 3 حاويات معزولة:
  - `pharmaguard-openserp` (المحرك الأساسي على المنفذ الداخلي `7000`)
  - `pharmaguard-searxng` (المحرك الاحتياطي مع تفعيل `format=json` على المنفذ الداخلي `8080`)
  - `pharmaguard-searxng-valkey` (ذاكرة مساعدة داخلية لـ SearXNG دون أي منفذ خارجي)
- `docker/search/searxng/settings.yml`: يفعّل صيغة `json` والبحث ثنائي اللغة (`default_lang: all`).
- `docker/search/.env.search.example`: نموذج متغيرات بيئة التشغيل لحاويات البحث (يربط المنافذ على `127.0.0.1` فقط).

> ملاحظة: يبقى `OPENSERP_URL` و`SEARXNG_URL` متغيرين اختياريين تمامًا في تطبيق PharmaGuard AI.

---

## أولًا: تثبيت Docker وDocker Compose (إن لم يكونا مثبّتين على خادم Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl openssl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```
> أعد تسجيل الدخول بالـ SSH (أو نفّذ `newgrp docker`) ثم تحقق بـ:
```bash
docker --version
docker compose version
```

---

## ثانيًا: تجهيز ملف البيئة وتشغيل المحركين على الخادم

من داخل مجلد المشروع (أو المجلد الذي نُقلت إليه الملفات):

```bash
cp docker/search/.env.search.example docker/search/.env
sed -i "s/^SEARXNG_SECRET=.*/SEARXNG_SECRET=$(openssl rand -hex 32)/" docker/search/.env
docker compose --env-file docker/search/.env -f docker-compose.search.yml up -d
```

للتحقق من أن الحاويات تعمل وبحالة صحية (`healthy`):
```bash
docker compose --env-file docker/search/.env -f docker-compose.search.yml ps
```

---

## ثالثًا: اختبار المحركين فعليًا على الخادم (قبل ربط التطبيق)

1. **اختبار OpenSERP (محليًا عبر `127.0.0.1`):**
```bash
curl -sS "http://127.0.0.1:7000/health"
curl -sS "http://127.0.0.1:7000/mega/search?text=simvastatin+clarithromycin+interaction&limit=3" | head -c 500
```

2. **اختبار SearXNG بصيغة JSON (محليًا عبر `127.0.0.1`):**
```bash
curl -sS "http://127.0.0.1:8080/search?q=simvastatin+clarithromycin&format=json" | head -c 500
```

3. **التأكد من عدم كشف المنافذ للإنترنت العام:**
```bash
ss -tulnp | grep -E ':(7000|8080)\b'
```
يجب أن يظهر العنوان `127.0.0.1:7000` و`127.0.0.1:8080` فقط، وليس `0.0.0.0` أو `[::]`.

---

## رابعًا: ربط تطبيق PharmaGuard AI بالمحركين دون كشف منافذ عامة

اختر الطريقة المطابقة لطريقة تشغيل PharmaGuard AI على خادم صديقك:

### الحالة (أ): التطبيق يعمل مباشرة على الخادم (Node.js / PM2 / systemd)
استخدم العنوانين المحليين التاليين في ملف بيئة التطبيق (أو لوحة الاستضافة)، ثم أعد تشغيل خدمة التطبيق فقط:
```env
OPENSERP_URL=http://127.0.0.1:7000
SEARXNG_URL=http://127.0.0.1:8080
```

### الحالة (ب): التطبيق يعمل داخل حاوية Docker مستقلة
1. اضبط في بيئة حاوية التطبيق العنوانين الداخليين التاليين (عبر أسماء حاويات البحث داخل الشبكة المشتركة):
```env
OPENSERP_URL=http://pharmaguard-openserp:7000
SEARXNG_URL=http://pharmaguard-searxng:8080
```
2. اربط حاوية التطبيق الحالية بالشبكة الداخلية الخاصة بالبحث (استبدل `pharmaguard-app` باسم حاوية التطبيق الفعلي من `docker ps`):
```bash
docker network connect pharmaguard-search-net pharmaguard-app
```
> **ملاحظة مهمة عند إعادة إنشاء حاوية التطبيق:** إذا كان التطبيق يعمل داخل حاوية Docker وأُعيد إنشاء حاويته (مثلًا بعد إضافة متغيرات البيئة أو التحديث)، فيجب إعادة ربطها بشبكة `pharmaguard-search-net` بالأمر أعلاه، ما لم تُضف الشبكة إلى ملف Compose الخاص بالتطبيق بوصفها شبكة خارجية (`external: true`).

3. للتحقق من وصول حاوية التطبيق إليهما داخليًا:
```bash
docker exec pharmaguard-app wget -qO- "http://pharmaguard-searxng:8080/search?q=aspirin&format=json" | head -c 300
```

### التحقق النهائي من داخل PharmaGuard AI
بعد تسجيل الدخول إلى التطبيق، اطلب مسار الفحص الحي للمصادر (أو من واجهة لوحة سلامة الأدوية):
```text
GET /api/agent/safety/status?probe=1
```
يُظهر هذا المسار الحالة الحقيقية المختبرة مباشرةً لكل من `OpenSERP` و`SearXNG` (`connected` أو سبب التعثر دون كشف الروابط الداخلية).

---

## خامسًا: نقل الملفات إلى خادم صديقك

### الطريقة 1: عبر Git (الأسهل إذا كان المشروع مرفوعًا على مستودع)
على خادم صديقك داخل مجلد المشروع:
```bash
git pull
```

### الطريقة 2: عبر `scp` من جهازك إلى خادم صديقك
اضغط الملفات المطلوبة فقط أو انسخها مباشرة:
```bash
tar -czf pharmaguard-search-stack.tar.gz docker-compose.search.yml docker/search/
scp pharmaguard-search-stack.tar.gz user@SERVER_IP:/path/to/pharmaguard/
```
وعلى خادم صديقك:
```bash
cd /path/to/pharmaguard/
tar -xzf pharmaguard-search-stack.tar.gz
```
ثم نفّذ خطوات القسمين **ثانيًا** و**ثالثًا**.
