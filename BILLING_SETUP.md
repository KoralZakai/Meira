# מעקב חיוב יומי — מה קורל צריכה לעשות

מטרה: דוח יומי אחד עם העלויות של Vercel, Supabase, Fly.io ו‑Nebius.

**חשוב:** אל תדביקי טוקנים בצ'אט. רק לתוך הקובץ בשלב 2.

---

## שלב 1 — ליצור 4 טוקנים

| # | פלטפורמה | איפה | שם המשתנה |
|---|-----------|------|------------|
| 1 | Vercel | vercel.com/account/settings/tokens → Create Token (scope = הטים שלך, expiry = No Expiration) | `VERCEL_TOKEN` |
| 2 | Supabase | supabase.com/dashboard/account/tokens → Generate new token (מתחיל ב‑`sbp_`) | `SUPABASE_PAT` |
| 3 | Fly.io | אחרי התקנת flyctl: `fly auth login` ואז `fly auth token` | `FLY_API_TOKEN` |
| 4 | Nebius Cloud | console.nebius.com → IAM → Service accounts → New → Authorized key → הורדת JSON | `NEBIUS_SA_KEY_FILE` (נתיב לקובץ) |

צריך גם:
- `VERCEL_TEAM_ID` — vercel.com/account/settings → Team ID
- `SUPABASE_ORG_SLUG` — מה‑URL של הדשבורד של הארגון
- `FLY_ORG` — `fly orgs list`
- `NEBIUS_TENANT_ID` / `NEBIUS_PROJECT_ID` — console.nebius.com, למעלה

---

## שלב 2 — קובץ אחד עם כל הסודות

מחוץ לריפו, כדי שלא ייכנס ל‑git:

```bash
mkdir -p ~/.config && touch ~/.config/lumi-billing.env && chmod 600 ~/.config/lumi-billing.env && open -e ~/.config/lumi-billing.env
```

ואז להדביק פנימה ולמלא:

```
VERCEL_TOKEN=
VERCEL_TEAM_ID=
SUPABASE_PAT=
SUPABASE_ORG_SLUG=
FLY_API_TOKEN=
FLY_ORG=
NEBIUS_SA_KEY_FILE=/Users/user/.config/nebius-sa.json
NEBIUS_TENANT_ID=
NEBIUS_PROJECT_ID=
```

---

## שלב 3 — להתקין CLIs

```bash
brew install flyctl supabase/tap/supabase && npm i -g vercel
```

Nebius CLI (רק אם רוצים גם את Nebius Cloud):

```bash
curl -sSL https://storage.eu-north1.nebius.cloud/cli/install.sh | bash
```

---

## שלב 4 — להגיד לי "רוץ"

ואז אני:
1. כותב `scripts/daily-billing.sh` שמושך את כל המספרים.
2. מגדיר launchd שירוץ כל בוקר ב‑08:00 וכותב `~/.config/lumi-billing-latest.json`.
3. בכל סשן שאני נפתח — אני קורא את הקובץ ומראה לך את המצב.

---

## מה עובד טוב ומה חלקי

| פלטפורמה | סטטוס | הערה |
|-----------|--------|------|
| **Vercel** | ✅ מלא | API רשמי `/billing/charges` (פורמט FOCUS, גרנולריות יומית) + `vercel usage` |
| **Fly.io** | 🟡 חלקי | אין billing API רשמי. GraphQL לא מתועד ב‑api.fly.io/graphql — עובד אבל עלול להישבר |
| **Supabase** | 🟡 חלקי | Management API נותן פרויקטים ומנוי; פירוט צריכה מלא לא מתועד — נאמת בזמן ריצה |
| **Nebius Cloud** | 🟡 חלקי | gRPC API עם service account. דורש CLI |
| **Nebius Token Factory** | 🔴 ידני | אין API ציבורי לצריכה. רק studio.nebius.com → Billing |

---

## אזהרה אחת

אני לא רץ ברקע. גם אחרי ההגדרה — ה‑launchd הוא זה שאוסף כל יום; אני מראה לך את זה כשאת פותחת סשן. אם את רוצה התראה אקטיבית (מייל/WhatsApp) כשעוברים סף — תגידי ואוסיף.
