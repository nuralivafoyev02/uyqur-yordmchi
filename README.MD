# 📁 Loyiha Strukturasi

## Folder tuzilmasi

```
uyqur-yordamchi/
│
├── api/                          # Serverless Functions
│   └── webhook.js                # Telegram Bot webhook handler
│                                 # - Bot logikasi
│                                 # - Supabase integratsiyasi
│                                 # - Callback handlers
│
├── public/                       # Static files
│   └── index.html                # Mini App (Telegram Web App)
│                                 # - Zamonaviy glassmorphism dizayn
│                                 # - Real-time updates
│                                 # - Interactive UI
│
├── supabase/                     # Database files (opsional)
│   └── schema.sql                # Database schema va migrations
│
├── node_modules/                 # Dependencies (git ignore)
│
├── package.json                  # NPM dependencies va scripts
├── package-lock.json            # NPM lock file
├── vercel.json                   # Vercel deployment configuration
├── .env                          # Environment variables (git ignore)
├── .env.example                  # Environment template
├── .gitignore                    # Git ignore rules
└── README.md                     # Deploy qo'llanmasi
```

## Muhim fayllar tavsifi

### 1. `api/webhook.js`
**Maqsad:** Telegram bot webhook handler

**Funksiyalar:**
- `/start` - Botni ishga tushirish
- `/help` - Yordam ko'rsatish
- `/send` - Hisobotlarni preview va yuborish
- `/stats` - Statistika
- `/clear` - Yuborilmagan hisobotlarni o'chirish
- Matn va rasm qabul qilish
- Inline keyboard callbacks
- Supabase CRUD operations

**Dependencies:**
- `telegraf` - Telegram Bot framework
- `@supabase/supabase-js` - Database client

### 2. `public/index.html`
**Maqsad:** Telegram Mini App

**Xususiyatlari:**
- Glassmorphism dizayn
- Real-time data
- Responsive layout
- Haptic feedback
- Telegram Web App API integratsiyasi

**Texnologiyalar:**
- Pure HTML/CSS/JavaScript
- Telegram Web App JS SDK
- Supabase Client JS

### 3. `vercel.json`
**Maqsad:** Vercel deployment sozlamalari

**Sozlamalar:**
- Serverless function routing
- Static file serving
- Environment variables
- CORS headers

### 4. `package.json`
**Maqsad:** NPM package va scripts

**Scripts:**
- `dev` - Local development
- `deploy` - Production deployment

**Dependencies:**
- Production: `telegraf`, `@supabase/supabase-js`
- Development: `vercel`

## Environment Variables

Quyidagi o'zgaruvchilar kerak:

| Variable | Description | Example |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram bot token | `1234567890:ABC...` |
| `WEBAPP_URL` | Mini App URL | `https://app.vercel.app` |
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon key | `eyJhbGc...` |

## Git Ignore

`.gitignore` da bo'lishi kerak:

```
node_modules/
.env
.vercel
*.log
.DS_Store
```

## Deploy Flow

```
1. Local Development
   ├── npm install
   ├── .env yaratish
   └── vercel dev

2. Supabase Setup
   ├── Project yaratish
   ├── SQL schema yuklash
   └── API keys olish

3. Telegram Bot Setup
   ├── BotFather orqali bot yaratish
   ├── Commands sozlash
   └── Menu button qo'shish

4. Vercel Deploy
   ├── GitHub push
   ├── Vercel import
   ├── Environment variables
   └── Deploy

5. Webhook Setup
   └── setWebhook API call
```

## Database Schema

### `users` table
```sql
- id (BIGINT, PK)
- first_name (TEXT)
- username (TEXT)
- created_at (TIMESTAMPTZ)
- updated_at (TIMESTAMPTZ)
```

### `reports` table
```sql
- id (BIGSERIAL, PK)
- user_id (BIGINT, FK)
- type (TEXT: 'text' | 'photo')
- content (TEXT)
- caption (TEXT)
- created_at (TIMESTAMPTZ)
- sent_at (TIMESTAMPTZ)
```

## API Endpoints

### Webhook
```
POST /api/webhook
- Telegram webhook handler
- Barcha bot updates bu yerga keladi
```

### Static Files
```
GET /
GET /index.html
- Mini App interface
```

## Funksional Oqim

### Hisobot Qo'shish
```
User → Matn/Rasm yuboring
  ↓
Bot → Supabase INSERT
  ↓
User ← Tasdiqlash xabari
```

### Hisobot Yuborish
```
User → /send buyrug'i
  ↓
Bot → Supabase SELECT (pending reports)
  ↓
User ← Preview + Inline keyboard
  ↓
User → "Tasdiqlash" tugmasi
  ↓
Bot → Guruhga yuborish
  ↓
Bot → Supabase UPDATE (sent_at)
  ↓
User ← Muvaffaqiyat xabari
```

### Mini App
```
User → Mini App ochish
  ↓
App → Supabase SELECT (user reports)
  ↓
User ← Hisobotlar ro'yxati
  ↓
User → O'chirish/Yuborish
  ↓
App → Supabase DELETE/UPDATE
```

## Security

- ✅ Row Level Security (RLS) - Supabase
- ✅ Environment variables - Maxfiy ma'lumotlar
- ✅ HTTPS only - Vercel
- ✅ Bot token validation - Telegram
- ✅ User authentication - Telegram Web App

## Performance

- ⚡ Serverless functions - Vercel
- ⚡ Global CDN - Vercel Edge Network
- ⚡ Database indexes - Supabase
- ⚡ Connection pooling - Supabase
- ⚡ Static file caching - Vercel

## Monitoring

- 📊 Vercel Analytics
- 📊 Supabase Logs
- 📊 Telegram Bot API logs
- 📊 Custom SQL queries

---

**To'liq sozlangan va ishga tayyor! 🚀**