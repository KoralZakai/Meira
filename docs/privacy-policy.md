# Privacy Policy — Lumi

**Last updated:** 15 September 2026
**App:** Lumi (`com.lumi.app`)
**Contact:** koralzakai1@gmail.com

> **Draft — have a person read this before you publish it.** Every factual
> claim below was checked against the code on 2026-09-15 (permissions in
> `app.json`, the tables in `supabase/migrations`, the routes in `server/`), so
> the *technical* content is accurate. Whether it satisfies GDPR, Israeli
> privacy law, or Google Play's policy as written is a legal question, and I am
> not a lawyer. The riskiest thing you can do with a privacy policy is publish
> one that promises more than the app does.

---

## What Lumi is

Lumi is a personal scheduling assistant. It keeps your tasks, works out when you
need to wake up and leave to reach them on time, and lets you talk to an
assistant about your day — in the app or over WhatsApp.

## What we collect, and why

We only collect what a feature needs. If you never use a feature, we never
collect its data.

| Data | Why | Where it goes |
|---|---|---|
| **Email address and name** | To sign you in and keep your data yours | Supabase (authentication) |
| **Your tasks, goals, schedules and notes** | The product | Supabase, and our server |
| **Location** (precise, while the app is open) | Travel times, when to leave, and confirming you arrived | Our server; coordinates are sent to Google Directions to plan a route |
| **Location in the background** (only if you turn on "Nearby errands") | Near an open errand's place; reminders you set by place; "still going?" when an appointment's leave time passed and you haven't left — all decided on the phone | **Stays on your phone.** Never sent to our server or anyone else |
| **Microphone audio** | Only while you are dictating a task, and only to turn speech into text | Converted to text on your device or by our server; the recording is not kept |
| **Contacts** (read only) | So you can attach a person to a task. Lumi never modifies your contacts | Stays on your device unless you attach a contact to a task |
| **Your messages to the assistant** | To answer them | Our server, and the AI provider that generates the reply |
| **Phone number** | Only if you link WhatsApp, so both channels are one account | Our server and Meta (WhatsApp) |
| **Notification token** | To send you reminders | Google (Firebase Cloud Messaging) |

**Background location is off unless you turn on "Nearby errands"** (Profile ›
Alerts). Then Android watches the places of your open errands and of reminders
you set by place, on your phone, and Meira tells you when you are near one, also
when the app is closed; when an appointment's leave time has passed and you are
still where the trip starts, she asks if you are still going — decided on the
phone, without routing. Your
location is never sent to our server or to any third party and is not kept as a
history. Never at night. Turn it off in the same card, or remove the location
permission in Android Settings.

## What we do NOT collect

- Payment or financial information of any kind
- Health or fitness data
- Your browsing history, or data from other apps
- Advertising identifiers — **Lumi contains no advertising and no analytics SDK**
- Your contacts as a list. We do not upload your address book

## Who else processes your data

Lumi runs on services that process data on our behalf:

| Service | What it handles |
|---|---|
| **Supabase** | Your account and the tasks/goals/settings we sync |
| **Fly.io** | The server that runs the assistant, in Amsterdam |
| **Nebius AI** | Generates the assistant's replies. Receives your message and relevant context |
| **Google** | Sign-in, Maps/Directions for routes, Firebase for notifications |
| **Meta (WhatsApp)** | Only if you choose to link WhatsApp |

We do not sell your data. We do not share it with advertisers. We do not share
it with anyone except the services above, which need it to make a feature work.

## How your data is protected

- Every record is tied to your account, and the database enforces that: one
  user cannot read another user's rows, even with a valid login.
- The server requires a verified sign-in token on every request, and derives
  who you are from that token — never from anything the app claims.
- Personal data stored on the server is encrypted at rest.
- Traffic is HTTPS throughout.

No system is perfect, and we will not claim otherwise. If something goes wrong
we will tell affected users.

## How long we keep it

We keep your data while your account exists. Delete your account and we delete
it — see below.

## Your rights, and how to use them

You can ask us to:

- **Show you** the data we hold about you
- **Correct** anything wrong
- **Delete** your account and everything in it
- **Export** your data

**To delete your account and all your data:** use *Settings → Delete my account*
in the app, or email **koralzakai1@gmail.com** with the subject "Delete my
account". We will delete your account, tasks, conversations, profile and
location history within 30 days and confirm when it is done.

You can also revoke individual permissions (location, microphone, contacts) at
any time in Android Settings. Lumi will keep working without them; the features
that need them will not.

## Children

Lumi is not directed at children under 13 and we do not knowingly collect their
data. If you believe a child has given us data, email us and we will delete it.

## Where your data is processed

Our server and database are hosted in the European Union. If you are outside the
EU, your data is transferred there.

## Changes to this policy

If we change this policy we will update the date at the top, and tell you in the
app if the change is significant.

## Contact

**koralzakai1@gmail.com**
