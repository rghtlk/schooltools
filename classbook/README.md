# classbook

Classes, seating plans, participation marks and course planning — prepared
on the computer, used on the iPhone in the middle of a lesson, **with or without a
network**.

* a class has students (first name, surname, optional photo) and a seating plan
* a class has courses; in a course you pick a date (today by default) and give
  each student **any number of `+` and `−`**, comments, and mark them **absent**
* a **summary** per course: totals, a day-by-day grid, CSV export
* **planning** (formerly `planer`): school years with their free days, a
  course's weekly slots, the teaching hours that follow from them, topics with
  markdown/LaTeX notes and figures placed on those hours — and the syllabus,
  day sheets and the course script as HTML, PDF and LaTeX

Nothing leaves your devices. The computer keeps the data in one SQLite file; the
phone keeps a full copy in its own browser storage and syncs with the computer
directly, over your Wi-Fi or the phone's hotspot. No cloud, no account, no
third party.

```
 Computer                                      iPhone
 ┌────────────────────────────┐   same Wi-Fi   ┌───────────────────────────┐
 │ browser  http://127.0.0.1  │   or hotspot   │ Classbook (home screen)   │
 │ server   data/classbook.db │◄──── sync ────►│ full copy in IndexedDB    │
 │          data/backups/     │    (HTTPS)     │ works offline, sends later│
 └────────────────────────────┘                └───────────────────────────┘
```

---

## Quick start

```bash
./start.sh              # opens http://127.0.0.1:8000 on the computer
```

On a fresh computer, `start.sh` checks what is missing and asks before installing
anything — first **pixi** (the tool that installs Python and the packages into
this folder, nothing system-wide; https://pixi.sh), then the **environment**
(Python, the packages and the headless Chromium for the PDFs, a few hundred MB
in `.pixi/`). Answer anything but *y* and it stops, printing the command to
run yourself (`curl -fsSL https://pixi.sh/install.sh | bash`, then
`pixi install && pixi run postinstall`). Started without a terminal (from a
script), it never installs — it only says what is missing.

The script PDF is compiled by the TeX on this computer (MacTeX / TeX Live / MiKTeX:
`pdflatex`, else `xelatex` or `lualatex`); without one, the `.zip` and `.tex`
still work.

The terminal prints the phone's address, the **pairing code** and the
fingerprint of the local certificate authority. `./start.sh --no-https` runs
it for the computer alone, with nothing listening on the network. `pixi run test`
runs the tests.

### On Windows

Double-click **`start.bat`** (or run `.\start.ps1` in PowerShell). It does the
same as `start.sh`: asks before installing **pixi** (per user, no admin
rights) and the **environment**, then starts the server and opens
`http://127.0.0.1:8000` in the default browser. Options: `.\start.ps1 -NoHttps`
(this PC only), `-Port 8080 -HttpsPort 9443`. When Windows asks whether
Python may communicate on networks, allow it on **private** networks — the
phones need that. The certificate for the phones is made on first start, as
on the computer; the phone setup under ⚙ Settings applies unchanged (*Show in
Explorer* instead of *Show in Finder*). Phones are best pointed at the PC's
IP address: Windows does not answer to `….local` names on every network.

## Setting up the iPhone (once)

The same steps, with your addresses filled in, are under **Settings** (⚙) in
the computer's browser.

1. Computer and iPhone on the same network. School Wi-Fi often blocks devices
   from seeing each other — then connect the computer to the iPhone's
   **Personal Hotspot**. The sync traffic stays between the two devices.
2. Get the certificate onto the phone. **By AirDrop** (the most reliable way):
   in the computer's browser, ⚙ Settings → *Show in Finder* (Windows: *Show in Explorer*) (or open
   `data/certs/classbook-ca.cer`), then right-click it → Share → AirDrop → your
   iPhone. **Or with Safari** on the phone: open
   `https://<your-mac>.local:8443/classbook-ca.crt` (Safari warns once — "Show
   Details" → "visit this website") and allow the download.
3. Settings → General → **VPN & Device Management** → *Downloaded Profile* →
   *classbook local CA* → Install. Do it within a few minutes — iOS drops a
   downloaded profile after about 8 minutes; then send it again. Check the
   SHA-256 fingerprint under *More Details* against the one on the computer.
4. Settings → General → About → **Certificate Trust Settings** → switch on
   *classbook local CA*. It only appears there once the profile is installed.
5. **Install it as an app** — this is what makes it work offline:
   open `https://<your-mac>.local:8443` in Safari (no warning now), tap
   **Share** (the square with the arrow; at the bottom, or behind `⋯` next to
   the address bar) → **Add to Home Screen** → leave *Open as Web App* on →
   **Add**.
6. Open Classbook **from the home-screen icon** — not from Safari; the app
   keeps its own data, separate from Safari's — and type the pairing code.
   Wait for the pill to say *Synced*.
7. Check: Airplane Mode on, open Classbook — it opens with all classes and
   says *Offline*. Give a `+`, Airplane Mode off: *1 to send*, then *Synced*.

On the phone, ⚙ Settings → *This device* shows whether it runs as the
installed app and is ready to open without a network.

**If the iPhone stops syncing** (the app says *Offline* although the computer is on)
— check, in this order (also in ⚙ Settings, on the computer and on the phone):

1. iPhone Settings → General → About → **Certificate Trust Settings**:
   *classbook local CA* must be listed and **switched on**. iOS sometimes
   switches it off again, e.g. after an update. Not listed → install it again
   (AirDrop, step 2 above).
2. Classbook running on the computer (`./start.sh`), and the computer awake.
3. Same Wi-Fi — not a guest network, which keeps devices apart.
4. In Safari on the iPhone open `https://<address>:8443/api/pair/local` (the
   address the app was installed from): a short text means the connection
   works; "This Connection Is Not Private" means 1; "can't connect" means 2 or 3.

**Updates reach the phone in the background.** The installed app always
opens from its own copy, instantly — also on a network where the computer cannot be
reached, where a request would otherwise just hang. When the computer is reachable
the app quietly downloads a new version, all files together — when it opens,
and when it comes back to the foreground — and then shows a banner, *A new
version of Classbook is ready — Reload*, which stays until you tap it (or ✕).
Otherwise the new version is used the next time the app opens. Until then the
phone runs the version it has: data from a newer version (say, a student
marked as dropped out) arrives, but is only understood after the reload.

**Why the certificate step:** the phone works offline because Classbook is
installed as a web app with a service worker, and iOS runs one only on a
connection it trusts. So classbook makes its own small certificate authority
(`data/certs/ca.pem`, valid ten years, its key never leaves the computer) and signs
the server's certificate with it. When the computer turns up on a new address, the
server certificate is re-made on the next start; the phone trusts the CA, so
it doesn't notice.

**Use the `.local` name, not the IP address.** The phone keeps its data per
address; the `.local` name is the same on every network.

## Setting up an Android phone (once)

The same steps, with your addresses filled in, are under ⚙ Settings in the
the computer's browser → *Set up a phone* → **Android**. Use **Chrome** (it trusts
certificates you install; Firefox does not by default). The phone needs a
screen lock — Android asks for one before it installs a certificate.

1. Same network as the computer (or the computer on the phone's hotspot).
2. **Download the certificate:** in Chrome open
   `https://<mac-ip>:8443/classbook-ca.crt` → "Your connection is not
   private" → Advanced → Proceed. (Or copy `data/certs/classbook-ca.cer` to
   the phone's Download folder with a USB cable.)
3. **Install it in Settings** — tapping the file does not work for this kind of
   certificate: Settings → Security & privacy → More security settings →
   **Encryption & credentials → Install a certificate → CA certificate** →
   Install anyway → choose the file. (Names vary by maker; searching Settings
   for "CA certificate" finds it.) Check under *Trusted credentials → User*
   that *classbook local CA* is listed, with the fingerprint shown on the computer.
4. **Install the app:** open `https://<mac-ip>:8443` in Chrome → menu ⋮ →
   **Install app** (or "Add to Home screen"). On the phone's own Settings page
   Classbook also offers an *Install Classbook* button when Chrome allows it.
5. Open Classbook from its icon, enter the pairing code, wait for *Synced*.

**Use the IP address on Android.** Android resolves `….local` names only from
version 12 on, and not on every network; the IP address works everywhere —
keep it fixed in the router, since the phone keeps its data per address.
Everything else — offline use, sync, the size settings, pasting photos —
works on Android as on the iPhone. If it stops syncing: *Trusted credentials
→ User* must still list *classbook local CA* (Android removes user
certificates when the screen lock is turned off).

## Using it

**Classes → Students.** Add one by one, or paste a class list, one per line:
`Surname, First name` or `First name Surname`. Tap the circle to add a photo
(on the phone this can be the camera) — or **paste one**: copy an image
(a screenshot, a picture from a web page or the school system), then press
⌘V in a name field or tap *Paste photo* / *Paste*. That works in the *Add*
form, on every student in the list, and on the card an empty seat opens.
Text pasted into a name field stays text. Photos are cropped square and shrunk
to ~20 kB. The list follows the **seating plan** — top left to bottom right,
row by row, as the plan is shown — once every student has a seat; until then
it is sorted by surname.

**A student who drops out** — *Dropped out* in the Students tab, or in the
card a double-click on their seat opens — is left out everywhere from then on:
marking, the seating plan (the seat becomes free), the student list, the
summary, the grades and the exports. Nothing is deleted. The Students tab
lists them at the end under **Dropped out**, with the date; *Back in class*
restores them with all their marks (they then wait under *Not seated* for a
seat), *Delete* removes them for good.

**Seating plan.** Set rows × seats per row (making it smaller removes **empty**
rows and columns first, wherever they are, and closes the gap; only if there
are not enough does it ask before taking anyone's seat), then tap a student and tap a seat
(an occupied seat swaps). On the computer you can also drag. **Double-click (on
the phone: double-tap) a student** to open their card — surname, first name
and photo (choose, paste or remove). *Seat the rest
alphabetically* fills the gaps.

**Tap an empty seat** (marked `+`) to add a student right there: first name,
surname, optionally a photo (📷). *Add & next seat* — or Enter — saves and
moves on to the next empty seat, so you can type a class in seat by seat as
they sit. The same card lists everyone who has no seat yet; tap a name to put
them on this seat.

The plan is shown **from the teacher's desk: board at the bottom**, the front
row nearest to it, left and right as you see them from the front. Switch off
*Board at the bottom* (per device) to see it from the back of the room instead.

**Entered a plan the wrong way round?** *Flip front ↔ back* mirrors the rows,
*Flip left ↔ right* the seats in each row; both together turn the plan by
180°. Each can be undone from the toast, or by pressing it again.

**Names / Photos** switches on the seating plan and the marking screen hide
either (per device — e.g. names off when the screen is projected). With both
off, initials remain.

**Marking** (tap a course). The date defaults to today; ‹ › step through days.
The mode bar decides what a tap does:

| mode | a tap on a student |
|---|---|
| Details | opens their card: big `+` / `★` / `−`, *absent*, a comment, and today's entries (✕ removes one) |
| `+` / `★` / `−` | gives a `+` / `★` / `−` at once — tap again for another; *Undo* in the toast |
| Absent | toggles absent / present |

**Size** (bottom of the marking screen, or ⚙ Settings; per device) makes the
whole screen smaller so a full seating plan fits on the phone: *Compact*
shrinks the seats and the controls above them and hides the hint line; *Mini*
also drops the title and surnames and shows absence as a dot. On an iPhone a
class of 30 in 5 × 8 seats fits on one screen in both.

**Days with marks:** next to the date, a dropdown lists every day of the course
that has marks, comments or absences, newest first and with what is recorded
(*Tue, 29 Sep · 3 marks, 1 comment, 1 absent*); picking one goes there.

**Who is here:** next to the date the screen shows *present / total* — e.g.
**28 / 30 present · 2 absent** — the class minus those marked absent for that
day; it changes as you mark someone absent, and for every day you step to.

**Tile colours** show where each student stands in the course: their net
score (every `+` and `★` minus every `−`, all dates) against the class average. Green
above it, red below; the further away, the stronger — measured in standard
deviations of the class (at least one mark counting as one), full colour at
about two. Students near the average stay neutral, absent ones stay yellow.
Hover or long-press a tile for the numbers. *Colours* (bottom of the screen,
per device) switches it off, e.g. when the screen is projected.

**Symbols.** By default a plus is shown as **●**, a super-plus as **★** and a
minus as **✕**. ⚙ Settings → *Symbols for the marks* changes how each looks —
type any symbol (up to three characters, emoji included) or tap a suggestion.
The choice syncs to every device. Only the look changes: marks are stored by
meaning (plus, super-plus, minus), so existing marks, the colours and *Net* stay
as they were. The CSV exports keep the words *Plus*, *Star*, *Minus*.

**Reasons for a minus.** Whenever you give a ✕, a small panel offers your
preset reasons as one-tap buttons, plus a field for one of your own (Enter
saves). It never blocks: the minus is saved already — ignore the panel and
keep marking, and the next minus takes it over; *Undo* takes the minus back.
The reason is kept as the entry's text: in the student's card (where *Reason*
adds or changes it later), in the summary's history and *By date* tooltips,
and in the CSV export. The presets are edited under ⚙ Settings → *Reasons for
a minus* (add, rename, reorder, remove, back to the defaults) and shared by
all devices.

A **★** is a super-plus: it has its own count on the tile, its own column in
the summary and the CSV, and it counts like a `+` in the tile colours and in
*Net* (`+` and `★` minus `−`).

**Export day (JSON)** (bottom of the marking screen) saves the day shown: for
every student of the class their ID, name, whether they were absent, the
number of `plus`, `star` and `minus` marks, and the IDs (UUIDs) of those
entries — named by meaning, whatever the symbols are set to. Works offline.

```json
{"classbook": 1, "kind": "day-scores", "date": "2026-09-29", "exported": "…",
 "class": {"id": "…", "name": "2D"}, "course": {"id": "…", "name": "Mathematik"},
 "students": [{"id": "…", "lastName": "Musterfrau", "firstName": "Erika", "absent": false,
               "plus": 2, "star": 1, "minus": 1,
               "entries": {"plus": ["…", "…"], "star": ["…"], "minus": ["…"]}}]}
```

**Export course (JSON)** (next to it, and on the *Summary* tab) does the same
for the whole course: per student the totals over all dates, `absent` as the
number of days absent, all entry IDs, and `days` — the same breakdown for each
date with a mark or an absence. The file also lists `dates`, `from` and `to`.

```json
{"classbook": 1, "kind": "course-scores", "exported": "…", "class": {…}, "course": {…},
 "from": "2026-09-29", "to": "2026-10-01", "dates": ["2026-09-29", "…"],
 "students": [{"id": "…", "lastName": "Musterfrau", "firstName": "Erika", "absent": 0,
               "plus": 2, "star": 1, "minus": 1, "entries": {"plus": ["…"], …},
               "days": [{"date": "2026-09-29", "absent": false, "plus": 1, "star": 1,
                         "minus": 0, "entries": {…}}, …]}]}
```

There is no limit on marks per student per day. Each seat shows today's
count (`+3 −1`), ✎ for a comment, and absent students are greyed out.

**Summary.** Per course, optionally for a date range: `+`, `−`, net, days
absent, comments, last entry — sortable, and a row opens that student's
history. *By date* shows the grid of days (`A` = absent). Rows are coloured like
the marking tiles — green above the class average, red below — over the date
range shown (the whole course if none); *Colours* switches it off. CSV exports use `;`
and UTF-8, which Excel in a German locale opens directly.

**Export overview (CSV)…** (marking screen, Summary, Grades table) is the raw
data of the whole course, one row per student, without any calculation. A short
dialog asks what goes in; ticked by default is everything except *Star* and
*Absent*. Per date the chosen columns of *Plus*, *Star*, *Minus* (number of
marks), *Absent* (`1`), *Reasons* (the texts given for the − marks) and
*Comments* (several of one day joined by ` | `), for every day with something recorded — and, if the course has a school
year and a timetable, for every day a lesson was or is planned, left empty
until something is recorded (can be switched off). Then one column per chosen submission
(*Category: Name (date) [max points]*) with the points as given or imported,
or `absent` / `missing`. Decimals use a comma.

## Grades

A course's **Grades** tab holds everything beyond participation:

* **Categories** (exams, homework, labs, …), each with a **weight**.
  *Participation* is a category too, with its own weight: its percentage is
  the share of positive marks, (● + ★) / (● + ★ + ✕), over the whole course.
* **Submissions** per category: a name, the **maximum points**, an optional
  date. Open one to enter **points** per student — type, Enter, next student.
  Empty means *not graded* (it does not count); enter 0 for zero points. More
  than the maximum is kept as bonus points.
* **Grade scale**: the lowest final percentage for 1, 2, 3 and 4 (default
  87.5 / 75 / 62.5 / 50); below that a 5.

How it adds up, per student:

| | |
|---|---|
| submission % | 100 · points / max points |
| category % | Σ points / Σ max points over the submissions graded — a 50-point exam counts more than a 10-point quiz |
| final % | Σ weight · category % / Σ weight, over the categories the student has results in |
| grade | from the scale |

**Importing points from a CSV file** (e.g. a Moodle grade export): choose the
file, check the surname and first-name columns (recognised automatically:
*Nachname*, *Vorname*, *Surname*, *First name*, …), pick the **points column**
(only columns with points are offered — not IDs or timestamps), and the
target: an existing submission, or a new one (category, name — taken from the
column — and max points, which the file does not contain). Separators `,` `;`
or tab and decimal `9.5` or `9,5` are recognised; `-` or empty means not graded.

The names are matched to the class — tolerant of accents and spelling
(ä / ae / a, ß / ss, hyphens), extra first names, small typos and swapped
first/last names, each name used once. **If anyone is missing on either side,
nothing is imported**: the warning lists who is in the class but not in the
file, and who is in the file but not in the class. Otherwise a preview shows
every match; those that are not exactly the same name are highlighted to
check. Importing into a submission that already has points asks first.

**Summary → Grades** shows it all in one table: per category each submission's
% and the category's %, then the final % and the grade — and *Export grades
(CSV)*.

## Planning

A course has four tabs: **Marking**, **Plan**, **Summary** and **Setup**.

**School years** (start page). A year is a date range with its **free days**:
on the year's calendar, click a day to make it free and again to clear it
(inside a longer range the range is trimmed or split); longer stretches get a
label and a range ("Christmas break", 24 Dec – 6 Jan). Weekends need no
marking. Deleting a year keeps its courses — they carry marks — without a year.

**Setup.** The course's school year (a new course gets the current one), its
**weekly slots** — one row per weekday with the number of consecutive hours,
optionally a start time (`Tue 2h` + `Thu 1h` = 3 hours a week) — teacher,
room, colour and a markdown description for the syllabus. Plus the changes
during the year: **cancelled dates** (this course only) and **extra sessions**.

**Teaching hours are derived, never stored**: year − free days − cancellations
+ extra sessions, over the weekly slots. Change the calendar and every course
follows at once.

**Plan.** Every teaching hour on the left, the **topic pool** on the right (on
the phone: pool first). *+ Add topic*, or *Add a list…* — one topic per line,
list markers stripped, ⌘/Ctrl+Enter adds. To place a topic, tap its **⋮⋮**
handle, then tap an hour — or drag it on the computer; back onto the pool takes it
off. An hour can hold several topics, and nothing is ever displaced. *+ topic*
on an hour creates one right there. A topic whose day stops being a teaching
day goes back to the pool marked *was 8 Dec* — never lost. *Jump to today*
scrolls to the next teaching day.

**Notes** open in a large editor: markdown with LaTeX (`$…$`, `$$…$$`) on the
left, the result on the right. Paste or drop an image, or *Add image or PDF…*
(PNG, JPEG, GIF, WEBP, PDF up to 20 MB): the file is stored on the computer under
`data/files/<year>/<course>/<topic>/` and the markdown is inserted. Notes sync
to the phone like everything else; the preview and files need the computer (a
figure the phone has shown once stays available offline).

**Documents** (made by the computer, open in a new tab):

| | |
|---|---|
| Syllabus — *Preview* / *PDF* | the overview for the class: table + notes, compact, or including free hours |
| Day sheet — *Page* / *PDF* on each day | every hour of that day with its full notes, to teach from; ‹ › step through the days |
| Script — PDF / `.zip` / `.tex` | the course material as a real LaTeX document: one section per hour, figures included |

**Marking and planning meet** on the Marking tab: ‹ › step through the days
the course actually meets, the day's planned topics are shown above the seats
with a link to its day sheet, and a date off the timetable is flagged.

**JSON import/export** uses planer's format, so planer's own exports work:
a **calendar** (year + free days: *Import a calendar* on the start page, or
*Import free days…* into an existing year — outside days skipped, edges
clipped), a **course** (*Export course* under Setup; *Import a course…* on a
class's Courses tab — into the current school year, topics whose dates don't
fit land in the pool), and a **topic list** (*Export/Import topics* in the pool;
a course export is accepted too, without its dates). *Duplicate plan* copies a
course's plan, never its marks.

## Sync

Syncing happens by itself: after every change, every 20 s while the app is
open, when it comes back to the foreground, and when the network returns. The
pill at the top shows the state and how many changes are waiting ("Offline ·
3 to send"); tap it to sync now.

* Every record (class, student, course, mark, absence) carries a UUID, when
  it was last changed and on which device.
* If two devices changed the same record, the later change wins, on both sides.
  Marks are separate records, so marks given on the phone and the computer at the
  same time are never in conflict — both are kept.
* An absence has a fixed id per course, student and day, so marking the same
  student absent on both devices gives one absence, not two.
* Deletions are kept as tombstones so that they travel too.
* A record the computer cannot accept (too large, say) is turned away on its
  own: the rest of the sync goes through, and the device says which change
  could not be saved instead of failing every sync from then on.
* If the computer's database is replaced (a restored backup, a fresh start) the
  phone notices and sends its whole copy again, so nothing it knows is lost.

## Where the data is

| | |
|---|---|
| `data/classbook.db` | everything, on the computer |
| `data/files/` | files attached to topics, by year / course / topic (not encrypted, like the rest); files whose topic or record was deleted are moved to `data/files/.trash/`, never deleted automatically |
| `data/backups/` | a copy of the database **at every start**, without photos (`classbook-YYYY-MM-DD_HH-MM-SS.db`, ~50 kB each); never deleted automatically |
| `data/pairing-code` | the code the phone needs (`chmod 600`) |
| `data/certs/` | the local CA and the server certificate (keys `chmod 600`); `classbook-ca.cer` is the copy to AirDrop |
| the iPhone | Classbook's own storage; removed with the app, or under ⚙ → *Remove data from this device* |

Set `CLASSBOOK_DATA=/some/folder` to keep the data elsewhere. Don't put it in
a folder that iCloud or Dropbox syncs if the data must stay off the cloud —
that includes `~/Documents` when *Desktop & Documents Folders* is switched on
in iCloud settings. ⚙ → *Download JSON* saves everything as one readable file.

**Start-up backups:** every time the server starts, it saves a copy of the
database to `data/backups/classbook-YYYY-MM-DD_HH-MM-SS.db` — complete except
for the student photos, which are most of the size, so each copy is only about
50 kB. Nothing is deleted automatically; remove old copies by hand when you
like. In an emergency a copy can replace `data/classbook.db` (with the server
stopped); the photos then have to be added again. The terminal shows where each
start's copy went.

**Restoring a backup:** ⚙ → *Import a backup (JSON)…*, on the computer or the phone
— for a file from *Download JSON* or the computer's export. A backup holds no dates
of change, so the import is careful: records this device has never seen are
added (e.g. marks from a phone whose data was lost before they reached the
computer); records deleted since stay deleted; records that exist in a different
version are kept as they are, unless you choose to take the backup's. It shows
what it found before changing anything, and the result syncs as usual.

## Security, briefly

* The app's files are public (they hold no data); every `/api` call needs the
  pairing code. Wrong codes are slowed down, and locked out after five.
* A browser on the computer itself is given the code automatically. Only requests
  addressed to an IP, `localhost` or a `.local` name are answered, so a web
  page can't use DNS tricks to pose as local.
* Notes are markdown, and may come from imported files: once rendered they are
  cleaned (nh3) — no scripts, event handlers, `javascript:` links or iframes —
  before they are shown in the app or printed. Topic titles are escaped.
* This computer is never locked out by wrong codes (it can read the code
  anyway); a request without any code is not counted as a guess. Only
  `localhost`, IP addresses and this computer's own `.local` name are answered.
* The phone is reached over HTTPS only. On the computer, the HTTP port listens on
  127.0.0.1 only.
* The data is **not encrypted by classbook itself**: on the computer it relies on
  disk encryption (FileVault on a Mac, BitLocker on Windows), on the iPhone on the device passcode (iOS encrypts app storage).
  Keep both switched on.
* The syllabus, day sheets and files open in a browser tab, which cannot send
  the pairing code as a header; for those read-only GET requests the app's own
  browser holds it as a cookie (HttpOnly, SameSite=Strict). A cookie is never
  accepted for a change.
* Meant for your own network. Don't expose the port to the internet.

## Layout

```
start.sh              start the server (and open the browser) — macOS / Linux
start.ps1, start.bat  the same for Windows (double-click start.bat)
app/serve.py          two listeners: 127.0.0.1:8000 (this computer), 0.0.0.0:8443 (phone, HTTPS)
app/main.py           FastAPI: pairing, /api/sync, /api/export, the static app
app/store.py          SQLite record store, last-writer-wins sync, start-up backup
app/tls.py            the local CA and server certificate
app/planning.py       teaching hours and the board, from the synced records (mirrors js/plan.js)
app/exports.py        notes preview, syllabus, day sheet, script, file upload/serving
app/files.py          attached files on disk, their checks and tidy-up
app/render.py         markdown + LaTeX -> HTML       } from planer,
app/latex.py          markdown + LaTeX -> LaTeX      } unchanged
app/script.py         the course script: .tex, .zip, PDF
app/pdf.py            HTML -> PDF via Playwright's Chromium
app/templates/        syllabus.html, day.html (print layouts)
app/static/           the web app — no build step, no external requests
  js/db.js            IndexedDB copy, outbox, sync
  js/model.js         classes, seats, marks, absences, summary, CSV
  js/plan.js          years, free days, teaching hours, topics, planer JSON
  js/app.js           screens: classes, marking, summary, settings
  js/planviews.js     screens: year calendar, plan board, setup, notes editor
  vendor/katex/       KaTeX, for the notes preview and the documents
  sw.js               offline cache of the app itself
tools/make_icons.py   draws the app icons
tests/                pytest: sync rules, API and access, certificates, planning,
                      documents and files, markdown -> LaTeX
```
