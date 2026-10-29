// Meira site — shared by / (Hebrew) and /en/ (English).
// The page's language is <html lang>; every string the script writes comes
// from STR[L] or EVENTS[L], so the two pages can never drift apart in logic.
(function () {
  "use strict";

  const L = document.documentElement.lang === "he" ? "he" : "en";

  // ---------- remember an explicit language choice ----------
  // Only a click on the switch is a choice; the auto-detect in the Hebrew
  // page's <head> reads this. Storage can be blocked: the page works without it.
  document.querySelectorAll("[data-lang]").forEach((a) => {
    a.addEventListener("click", () => {
      try { localStorage.setItem("meira.lang", a.dataset.lang); } catch (e) { /* private mode: no memory, still navigates */ }
    });
  });

  // ---------- strings ----------
  const STR = {
    en: {
      min: " min",
      wake: "Wake-up alarm", wakeSmall: (b) => "set on your phone, " + b + " min before you start",
      prepSmall: (m) => m + " min, on the morning itself",
      ready: "Get ready", readySmall: (m) => m + " min, learned from your mornings",
      leave: "Leave home",
      drive: (d, p) => "about " + d + " min at that hour, plus " + p + " to park",
      park: "Park and walk in", spare: (m) => m + " min to spare",
      walk: (w, mode) => w + " min walk to the " + (mode === "train" ? "station" : "stop"),
      arrives: (t, early) => "arrives " + t + ", " + early + " min early",
      mode: { train: "the train", bus: "the bus", car: "the car" },
      fallback: (pref, dep, arr, time, picked) =>
        "You prefer " + pref + ", but the " + dep + " arrives " + arr + ", too late for " + time +
        ". So Meira picked " + picked + " instead, and tells you why.",
      bad: "That email doesn't look right. Check it and try again.",
      preview: "This is a preview link, so sign-up isn't open here.",
      saving: "Saving…",
      ok: "You're in ✓ We'll email you when the Google Play version opens.",
      dup: "You're already on the list ✓",
      notOpen: "Couldn't save: sign-up isn't open yet. Please try again later.",
      err: (s) => "Couldn't save (error " + s + "). Please try again in a minute.",
      net: "Couldn't reach the server. Check your connection and try again."
    },
    he: {
      min: " דק׳",
      wake: "שעון מעורר", wakeSmall: (b) => "מכוון בטלפון, " + b + " דק׳ לפני שמתחילים",
      prepSmall: (m) => m + " דק׳, באותו בוקר",
      ready: "להתארגן", readySmall: (m) => m + " דק׳, נלמד מהבקרים שלכם",
      leave: "לצאת מהבית",
      drive: (d, p) => "בערך " + d + " דק׳ בשעה הזו, ועוד " + p + " לחניה",
      park: "לחנות ולהיכנס", spare: (m) => m + " דק׳ מרווח",
      walk: (w, mode) => w + " דק׳ הליכה " + (mode === "train" ? "לתחנת הרכבת" : "לתחנה"),
      arrives: (t, early) => "מגיע ב-" + t + ", " + early + " דק׳ לפני",
      mode: { train: "רכבת", bus: "אוטובוס", car: "רכב" },
      fallback: (pref, dep, arr, time, picked) =>
        "אתם מעדיפים " + pref + ", אבל היציאה של " + dep + " מגיעה רק ב-" + arr + ", מאוחר מדי ל-" + time +
        ". לכן מאירה בחרה " + picked + ", ואומרת לכם למה.",
      bad: "המייל לא נראה תקין. בדקו ונסו שוב.",
      preview: "זה קישור תצוגה, ההרשמה לא פתוחה כאן.",
      saving: "שומר…",
      ok: "נרשמתם ✓ נשלח לכם מייל כשגרסת Google Play תיפתח.",
      dup: "אתם כבר ברשימה ✓",
      notOpen: "לא נשמר: ההרשמה עוד לא פתוחה. נסו שוב מאוחר יותר.",
      err: (s) => "לא נשמר (שגיאה " + s + "). נסו שוב בעוד דקה.",
      net: "אין חיבור לשרת. בדקו את האינטרנט ונסו שוב."
    }
  }[L];

  // ---------- time helpers ----------
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const fmt = (min) => { const h = Math.floor(min / 60), m = min % 60; return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"); };

  const GET_READY = 45;   // learned, per the "what Meira knows" box
  const WAKE_BUFFER = 8;  // minutes between the alarm and starting to get ready

  // Sample data. Transit options are timetable departures; car is a drive
  // estimate plus parking. `early` is how early she aims to arrive. Times are
  // the same in both languages; only the words differ.
  const WORDS = {
    en: {
      interview: { title: "Job interview", place: "Ra'anana", prep: "Review your notes", train: "Train + bus hop", bus: "Bus 29",
        note: "She'll ask how it went, and plan your review time around the next one." },
      meeting: { title: "Client meeting", place: "Haifa", train: "Train to Haifa", bus: "Intercity bus",
        note: "She looks up the company and the person before you go, and gives you three questions to ask." },
      exam: { title: "Exam", place: "Tel Aviv University", prep: "Last look at your summary", train: "Train to University", bus: "Bus 25",
        note: "Exams get 15 min of margin, not 10, because you need time to find your seat." }
    },
    he: {
      interview: { title: "ראיון עבודה", place: "רעננה", prep: "לעבור על החומר", train: "רכבת + אוטובוס קצר", bus: "קו 29",
        note: "היא תשאל איך היה, ותתכנן את זמן ההכנה סביב הראיון הבא." },
      meeting: { title: "פגישה עם לקוח", place: "חיפה", train: "רכבת לחיפה", bus: "אוטובוס בין־עירוני",
        note: "היא בודקת את החברה ואת האדם לפני שאתם יוצאים, ונותנת לכם שלוש שאלות לשאול." },
      exam: { title: "מבחן", place: "אוניברסיטת תל אביב", prep: "מבט אחרון בסיכום", train: "רכבת לאוניברסיטה", bus: "קו 25",
        note: "למבחנים יש 15 דק׳ מרווח ולא 10, כי צריך זמן למצוא את המקום." }
    }
  }[L];

  const EVENTS = {
    interview: {
      time: "10:00", early: 10, prep: { min: 25 },
      modes: {
        train: [{ dep: "08:32", arr: "10:04", walk: 12 }],
        bus: [{ dep: "08:36", arr: "09:44", walk: 8 }, { dep: "08:51", arr: "09:59", walk: 8 }],
        car: { drive: 55, park: 5 }
      }
    },
    meeting: {
      time: "09:30", early: 10, prep: null,
      modes: {
        train: [{ dep: "07:44", arr: "09:02", walk: 10 }, { dep: "08:14", arr: "09:32", walk: 10 }],
        bus: [{ dep: "07:10", arr: "09:12", walk: 6 }],
        car: { drive: 95, park: 5 }
      }
    },
    exam: {
      time: "09:00", early: 15, prep: { min: 25 },
      modes: {
        train: [{ dep: "08:07", arr: "08:31", walk: 9 }],
        bus: [{ dep: "07:50", arr: "08:24", walk: 5 }, { dep: "08:05", arr: "08:40", walk: 5 }],
        car: { drive: 30, park: 10 }
      }
    }
  };

  // A preference is a ladder, not a constraint: the preferred way first, and
  // the next rung only when the preferred one can't get you there in time.
  const LADDER = { train: ["train", "bus"], bus: ["bus", "train"], car: ["car"] };

  function planTrip(ev, words, pref) {
    const arriveBy = toMin(ev.time) - ev.early;
    let missed = null;
    for (const mode of LADDER[pref]) {
      if (mode === "car") {
        const c = ev.modes.car;
        return { mode, leave: arriveBy - c.drive - c.park, arrive: arriveBy, detail: STR.drive(c.drive, c.park), missed };
      }
      const inTime = ev.modes[mode].filter((o) => toMin(o.arr) <= arriveBy);
      if (inTime.length) {
        const best = inTime.reduce((a, b) => (toMin(b.dep) > toMin(a.dep) ? b : a));
        return { mode, leave: toMin(best.dep) - best.walk, dep: toMin(best.dep), arrive: toMin(best.arr), label: words[mode], walk: best.walk, missed };
      }
      if (!missed) {
        const late = ev.modes[mode].slice().sort((a, b) => toMin(a.arr) - toMin(b.arr))[0];
        missed = { mode, late };
      }
    }
    return null;
  }

  function row(k, time, what, small) {
    const li = document.createElement("li");
    li.className = "step";
    if (k) li.dataset.k = k;
    li.innerHTML = '<span class="t"></span><i class="pin"></i><span class="what"><span class="w"></span><small></small></span>';
    li.querySelector(".t").textContent = time;
    li.querySelector(".w").textContent = what;
    li.querySelector("small").textContent = small;
    return li;
  }

  const $ = (id) => document.getElementById(id);

  function render() {
    const evKey = document.querySelector('input[name="ev"]:checked').value;
    const pref = document.querySelector('input[name="mode"]:checked').value;
    const ev = EVENTS[evKey];
    const words = WORDS[evKey];
    const trip = planTrip(ev, words, pref);
    const chain = $("r-chain");
    chain.textContent = "";

    $("r-title").textContent = words.title;
    $("r-when").textContent = ev.time + " · " + words.place;

    const readyStart = trip.leave - GET_READY;
    const prepStart = ev.prep ? readyStart - ev.prep.min : readyStart;
    const wake = prepStart - WAKE_BUFFER;

    const rows = [row("wake", fmt(wake), STR.wake, STR.wakeSmall(WAKE_BUFFER))];
    if (ev.prep) rows.push(row("", fmt(prepStart), words.prep, STR.prepSmall(ev.prep.min)));
    rows.push(row("", fmt(readyStart), STR.ready, STR.readySmall(GET_READY)));
    if (trip.mode === "car") {
      rows.push(row("leave", fmt(trip.leave), STR.leave, trip.detail));
      rows.push(row("", fmt(trip.arrive), STR.park, STR.spare(ev.early)));
    } else {
      rows.push(row("leave", fmt(trip.leave), STR.leave, STR.walk(trip.walk, trip.mode)));
      rows.push(row("", fmt(trip.dep), trip.label, STR.arrives(fmt(trip.arrive), toMin(ev.time) - trip.arrive)));
    }
    rows.push(row("event", ev.time, words.title, words.place));
    rows.forEach((r) => chain.appendChild(r));

    const fb = $("r-fallback");
    if (trip.missed) {
      $("r-fallback-text").textContent =
        STR.fallback(STR.mode[trip.missed.mode], trip.missed.late.dep, trip.missed.late.arr, ev.time, STR.mode[trip.mode]);
      fb.hidden = false;
    } else {
      fb.hidden = true;
    }
    $("r-note-text").textContent = words.note;

    const res = $("result");
    res.classList.remove("flash"); void res.offsetWidth; res.classList.add("flash");
  }

  if ($("r-chain")) {
    document.querySelectorAll('input[name="ev"], input[name="mode"]').forEach((i) => i.addEventListener("change", render));
    render();
  }

  // ---------- beta sign-up ----------
  // Public by construction: the Supabase anon key ships in every APK too, and
  // RLS on public.waitlist allows INSERT only (supabase/migrations/0012).
  // Success is shown only after the server confirms the write. A failure
  // says it failed and what to do, never a quiet "thanks".
  const cfg = {
    url: "https://ybagugvwqtjtbllgxyin.supabase.co/rest/v1/waitlist",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InliYWd1Z3Z3cXRqdGJsbGd4eWluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzgzNDYsImV4cCI6MjA5Njc1NDM0Nn0.oKT2aQ3B056_Q20ltp2dPWJvMrd9v1p4dOgLFisLCLk"
  };
  const live = /^https:$/.test(location.protocol) || location.hostname === "localhost";
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function setStatus(el, kind, text) { el.dataset.kind = kind; el.textContent = text; }

  document.querySelectorAll("form.signup").forEach((form) => {
    const input = form.querySelector("input");
    const btn = form.querySelector("button");
    const status = form.querySelector(".signup-status");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = input.value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { setStatus(status, "error", STR.bad); input.focus(); return; }
      if (!live) { setStatus(status, "info", STR.preview); return; }

      btn.disabled = true; const label = btn.textContent; btn.textContent = STR.saving;
      try {
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.key, Authorization: "Bearer " + cfg.key, Prefer: "return=minimal" },
          body: JSON.stringify({ email, source: (form.dataset.source || "site") + "-" + L })
        });
        if (res.ok) { setStatus(status, "ok", STR.ok); form.reset(); }
        else if (res.status === 409) { setStatus(status, "ok", STR.dup); }
        else {
          const body = await res.text().catch(() => "");
          console.warn("[waitlist] insert failed", res.status, body.slice(0, 300));
          setStatus(status, "error", res.status === 404 ? STR.notOpen : STR.err(res.status));
        }
      } catch (err) {
        console.warn("[waitlist] network error", err);
        setStatus(status, "error", STR.net);
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    });
  });
})();

// ---------- feature tiles → detail + animated demo ----------
// Each tile opens one dialog: a short explanation and Meira's messages
// appearing one by one, the way they would on the phone. `me` marks the
// user's own reply; `warn` / `ok` colour a message by what it means.
(function () {
  "use strict";
  const dlg = document.getElementById("feat-dialog");
  if (!dlg) return;
  const L = document.documentElement.lang === "he" ? "he" : "en";

  const F = {
    he: {
      replay: "↻ עוד פעם",
      calendars: { ic: "🗓️", title: "כל היומנים במקום אחד", detail: "מחברים את Google Calendar, את Outlook ו-Teams ואת היומנים שבטלפון, גם כמה חשבונות. מאירה רואה הכול יחד, פגישה כפולה נספרת פעם אחת, ובין פגישות היא מוסיפה את הנסיעה.", demo: [
        { m: "✓ גוגל, Outlook והטלפון מחוברים", k: "ok" }, { m: "09:30 · פגישת צוות (Teams)" }, { m: "12:45 · 🚌 נסיעה לחולון, 35 דק׳" }, { m: "13:20 · 🦷 רופא שיניים בחולון" } ] },
      backwards: { ic: "⏪", title: "גוזרת זמנים אחורה", detail: "מהשעה של הפגישה מאירה סופרת אחורה: הנסיעה, ההתארגנות, ההכנה, ועד השעון המעורר. אתם רק מקבלים את השעות.", demo: [
        { m: "10:00 · 🎯 ראיון ברעננה" }, { m: "08:36 · 🚌 קו 29 (מגיע 09:44)" }, { m: "08:28 · 🚪 יציאה מהבית" }, { m: "07:43 · 👕 התארגנות, 45 דק׳" }, { m: "07:10 · ⏰ השכמה", k: "ok" } ] },
      alarm: { ic: "⏰", title: "שעון מעורר שמכוון את עצמו", detail: "שעון אמיתי בשעון של הטלפון, מחושב מהשעה שצריך לצאת. הוא מופיע תמיד במסך היום, ואפשר לכבות או להזיז אותו בלחיצה.", demo: [
        { m: "⏰ כיוונתי שעון למחר ב-07:10", k: "ok" }, { m: "למה? האוטובוס של 08:36, ו-45 דק׳ להתארגן" }, { m: "אפשר 06:45? רוצה לרוץ לפני", k: "me" }, { m: "⏰ עודכן ל-06:45 ✓", k: "ok" } ] },
      route: { ic: "🚌", title: "הדרך הכי טובה", detail: "מאירה מתחילה מהדרך שאתם אוהבים. אם היא לא מביאה אתכם בזמן, היא בוחרת את הבאה ואומרת למה. היא משווה דלת לדלת, כולל הליכה, המתנה וחניה.", demo: [
        { m: "🚆 רכבת 08:32 · מגיעה 10:04", k: "warn" }, { m: "🚌 קו 29 ב-08:36 · מגיע 09:44", k: "ok" }, { m: "🚗 ברכב · יציאה 08:50, עם חניה" }, { m: "אין רכבת בזמן, אז קו 29 🚌" } ] },
      disruptions: { ic: "🚧", title: "תקלות בדרך", detail: "לפני שיוצאים מאירה בודקת בחדשות שיבושים במסלול שלכם: עבודות ברכבת, סגירות, שביתות, תאונות ועומסים. יש משהו? תשמעו לפני שיוצאים, עם קישור לכתבה.", demo: [
        { m: "🔎 בודקת את המסלול לחיפה…" }, { m: "⚠️ דווח על עבודות בקו לחיפה הבוקר", k: "warn" }, { m: "כדאי לבדוק לפני שיוצאים · לכתבה ›" } ] },
      clash: { ic: "📍", title: "התנגשות בין מקומות", detail: "שתי פגישות לא חופפות ביומן, אבל בערים שונות? מאירה בודקת אם יש מספיק זמן לנסיעה ביניהן, ומתריעה מראש.", demo: [
        { m: "12:00–12:45 · פגישה בהרצליה" }, { m: "13:00 · רופא בחולון" }, { m: "🚗 35 דק׳ נסיעה, מגיעים ב-13:20" }, { m: "⚠️ לא מספיקים. להזיז ל-13:30?", k: "warn" } ] },
      moved: { ic: "🔁", title: "פגישה זזה?", detail: "כשפגישה זזה או מתבטלת, מאירה מזהה לבד, גם כשהאפליקציה סגורה. היא מספרת לכם ומציעה שעות שבאמת אפשריות, לפי איפה תהיו לפני ואחרי.", demo: [
        { m: "🗓️ הפגישה של 14:00 בוטלה", k: "warn" }, { m: "התפנו לך שעתיים. ללמוד לראיון?" }, { m: "כן", k: "me" }, { m: "📚 14:00–15:30 למידה ✓", k: "ok" } ] },
      prep: { ic: "🎯", title: "מכינה לראיון", detail: "כשיש ראיון או מבחן, מאירה קובעת זמני הכנה יומיים לפני, יום לפני ובבוקר עצמו. היא מחפשת באינטרנט על החברה, התפקיד והמראיין, ויום לפני מגיע סיכום של מה שהיה בפעם הקודמת.", demo: [
        { m: "📚 ראיון בעוד יומיים. הכנה הערב ב-19:00" }, { m: "🔎 3 דברים על החברה (עם מקורות)" }, { m: "❓ 3 שאלות שכדאי לשאול" }, { m: "🗂️ בפעם הקודמת דיברתם על התקציב", k: "ok" } ] },
      knows: { ic: "🧠", title: "מכירה אתכם", detail: "מאירה לומדת כמה זמן לוקח לכם להתארגן, מתי אתם מתאמנים, באילו ימים אתם פנויים ואם יש לכם רכב. כשהיא טועה, היא מתקנת את עצמה.", demo: [
        { m: "יש לך רכב?" }, { m: "לא", k: "me" }, { m: "✓ אז אתכנן בתחבורה ציבורית", k: "ok" }, { m: "⏱️ התארגנות לקחה 45 דק׳, לא 30. נרשם" } ] },
      nudge: { ic: "🔔", title: "מדד נודניקיות", detail: "בסרגל בפרופיל בוחרים כמה מאירה דוחפת, ממזכירה עדינה ועד מאמנת שלא מוותרת. אותה משימה, שלוש דרכים להגיד אותה:", demo: [
        { m: "🔔 עדין · אולי כדאי ללמוד היום?" }, { m: "🔔🔔 באמצע · קבעתי לך זמן ללמוד ב-19:00" }, { m: "🔔🔔🔔 חזק · 19:00 לומדים. בלי תירוצים 💪", k: "warn" } ] },
      focus: { ic: "📵", title: "מצב למידה", detail: "כשמגיע זמן למידה ביומן, מאירה חוסמת את וואטסאפ, אינסטגרם, טיקטוק וכל אפליקציה שתבחרו. מנסים להתגנב? נזיפה קצרה. לסיים מוקדם אפשר רק אחרי ספירה של 10 שניות.", demo: [
        { m: "📚 19:00 · מתחילים ללמוד" }, { m: "🔒 וואטסאפ, אינסטגרם וטיקטוק חסומים", k: "ok" }, { m: "📱 פותחים את אינסטגרם…", k: "me" }, { m: "😤 אמרנו שלומדים! חוזרים?", k: "warn" } ] },
      group: { ic: "🤝", title: "זמן משותף לקבוצה · בקרוב", detail: "בקרוב: מאירה תסתכל על היומנים של כל המשתתפים ותמצא שעה שמתאימה לכולם, כולל הנסיעה של כל אחד.", demo: [
        { m: "👥 5 משתתפים" }, { m: "🔎 בודקת את היומנים של כולם…" }, { m: "🤝 חמישי 17:00 מתאים לכולם", k: "ok" } ] }
    },
    en: {
      replay: "↻ Play again",
      calendars: { ic: "🗓️", title: "Every calendar, one place", detail: "Connect Google Calendar, Outlook and Teams, and the calendars on your phone, even several accounts. Meira sees them together, a meeting in two calendars counts once, and she adds the trip between meetings.", demo: [
        { m: "✓ Google, Outlook and phone connected", k: "ok" }, { m: "09:30 · Team meeting (Teams)" }, { m: "12:45 · 🚌 Trip to Holon, 35 min" }, { m: "13:20 · 🦷 Dentist in Holon" } ] },
      backwards: { ic: "⏪", title: "Works backwards", detail: "From the meeting's start time Meira counts back through the trip, getting ready and prep, all the way to your alarm. You just get the times.", demo: [
        { m: "10:00 · 🎯 Interview in Ra'anana" }, { m: "08:36 · 🚌 Bus 29 (arrives 09:44)" }, { m: "08:28 · 🚪 Leave home" }, { m: "07:43 · 👕 Get ready, 45 min" }, { m: "07:10 · ⏰ Wake up", k: "ok" } ] },
      alarm: { ic: "⏰", title: "An alarm that sets itself", detail: "A real alarm in your phone's Clock, worked out from when you need to leave. It always shows on the Today screen, and one tap turns it off or moves it.", demo: [
        { m: "⏰ Alarm set for tomorrow, 07:10", k: "ok" }, { m: "Why? The 08:36 bus, and 45 min to get ready" }, { m: "Make it 06:45? I want a run first", k: "me" }, { m: "⏰ Moved to 06:45 ✓", k: "ok" } ] },
      route: { ic: "🚌", title: "The best way there", detail: "Meira starts with the way you like. If it won't get you there on time, she picks the next one and says why. She compares door to door, including walking, waiting and parking.", demo: [
        { m: "🚆 Train 08:32 · arrives 10:04", k: "warn" }, { m: "🚌 Bus 29 at 08:36 · arrives 09:44", k: "ok" }, { m: "🚗 By car · leave 08:50, parking included" }, { m: "No train in time, so Bus 29 🚌" } ] },
      disruptions: { ic: "🚧", title: "Trouble on your route", detail: "Before you leave, Meira checks the news for disruptions on your route: train works, closures, strikes, accidents and heavy traffic. If there's something, you hear about it first, with a link to the story.", demo: [
        { m: "🔎 Checking your route to Haifa…" }, { m: "⚠️ Works reported on the Haifa line this morning", k: "warn" }, { m: "Worth checking before you leave · Read ›" } ] },
      clash: { ic: "📍", title: "Clashes between places", detail: "Two meetings don't overlap on the calendar, but they're in different cities? Meira checks there's enough time for the trip between them, and warns you early.", demo: [
        { m: "12:00–12:45 · Meeting in Herzliya" }, { m: "13:00 · Doctor in Holon" }, { m: "🚗 35 min drive, you'd arrive 13:20" }, { m: "⚠️ You won't make it. Move it to 13:30?", k: "warn" } ] },
      moved: { ic: "🔁", title: "Meeting moved?", detail: "When a meeting moves or is cancelled, Meira notices on her own, even with the app closed. She tells you and suggests times that actually work, based on where you'll be before and after.", demo: [
        { m: "🗓️ Your 14:00 was cancelled", k: "warn" }, { m: "You have 2 free hours. Study for the interview?" }, { m: "Yes", k: "me" }, { m: "📚 14:00–15:30 study ✓", k: "ok" } ] },
      prep: { ic: "🎯", title: "Interview prep", detail: "For an interview or exam, Meira books prep time two days before, the day before and on the morning itself. She searches the web for the company, the role and the interviewer, and the day before you get a recap of last time.", demo: [
        { m: "📚 Interview in 2 days. Prep tonight at 19:00" }, { m: "🔎 3 things about the company (with sources)" }, { m: "❓ 3 questions worth asking" }, { m: "🗂️ Last time you discussed the budget", k: "ok" } ] },
      knows: { ic: "🧠", title: "Knows you", detail: "Meira learns how long you take to get ready, when you work out, which days you're free and whether you have a car. When she's wrong, she corrects herself.", demo: [
        { m: "Do you have a car?" }, { m: "No", k: "me" }, { m: "✓ Then I'll plan with public transport", k: "ok" }, { m: "⏱️ Getting ready took 45 min, not 30. Noted" } ] },
      nudge: { ic: "🔔", title: "Nudge meter", detail: "A slider in your profile sets how hard Meira pushes, from a gentle reminder to a coach who doesn't let go. One task, three ways to say it:", demo: [
        { m: "🔔 Gentle · Maybe study today?" }, { m: "🔔🔔 Medium · I booked you study time at 19:00" }, { m: "🔔🔔🔔 Firm · 19:00 we study. No excuses 💪", k: "warn" } ] },
      focus: { ic: "📵", title: "Study mode", detail: "When study time on your calendar starts, Meira blocks WhatsApp, Instagram, TikTok and any app you pick. Try to sneak in and you get a short pep talk. Ending early takes a 10-second countdown.", demo: [
        { m: "📚 19:00 · Study time starts" }, { m: "🔒 WhatsApp, Instagram and TikTok blocked", k: "ok" }, { m: "📱 Opening Instagram…", k: "me" }, { m: "😤 You said you were studying! Back to it?", k: "warn" } ] },
      group: { ic: "🤝", title: "Group time · coming soon", detail: "Coming soon: Meira will look at every participant's calendar and find a time that works for everyone, including each person's trip.", demo: [
        { m: "👥 5 participants" }, { m: "🔎 Checking everyone's calendar…" }, { m: "🤝 Thursday 17:00 works for all", k: "ok" } ] }
    }
  }[L];

  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let timers = [];
  let current = null;

  function play(key) {
    timers.forEach(clearTimeout); timers = [];
    const list = $("fd-msgs");
    list.textContent = "";
    F[key].demo.forEach((d, i) => {
      const li = document.createElement("li");
      li.className = "fd-msg" + (d.k ? " fd-" + d.k : "");
      li.textContent = d.m;
      if (reduce) { list.appendChild(li); return; }
      timers.push(setTimeout(() => { list.appendChild(li); }, 350 + i * 750));
    });
  }

  function open(key) {
    const f = F[key]; if (!f) return;
    current = key;
    $("fd-ic").textContent = f.ic;
    $("fd-title").textContent = f.title;
    $("fd-detail").textContent = f.detail;
    $("fd-replay").textContent = F.replay;
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    play(key);
  }

  function close() {
    timers.forEach(clearTimeout); timers = [];
    if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open");
  }

  document.querySelectorAll(".tile[data-f]").forEach((t) => {
    t.addEventListener("click", () => open(t.dataset.f));
    t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(t.dataset.f); } });
  });
  dlg.querySelector(".fd-close").addEventListener("click", close);
  $("fd-replay").addEventListener("click", () => current && play(current));
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });   // tap outside the card
  dlg.addEventListener("close", () => { timers.forEach(clearTimeout); timers = []; });
})();
