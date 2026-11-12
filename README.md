# HTL Tools

A small collection of local tools for everyday teaching work.

> **Read this first:** everything in this repository was **vibe coded**, written
> largely with an AI coding assistant, and has had little formal review. Treat it
> as an experiment, not as finished, audited software. See the
> [Disclaimer](#disclaimer--no-warranty--no-liability) and [Support](#support)
> sections below before you use any of it.

## Projects

| Project | What it is | Stack |
|---|---|---|
| [`classbook/`](classbook/) | A classroom companion: classes, seating plans, students, participation marks (plus/star/minus), absences, lesson planning and syllabus, grades, and PDF/CSV/JSON exports. Runs as a local server with an offline-capable web app (PWA) that syncs between devices on the local network over TLS with a pairing code. | Python (FastAPI), SQLite, vanilla JS, KaTeX, LaTeX |
| [`quizmaster/`](quizmaster/) | A local web app for creating, managing, previewing and practising quizzes. Imports and exports **Moodle XML** (many question types including cloze, drag-and-drop and select-missing-words) and builds printable exams and answer keys as PDF via LaTeX. Listens on localhost only. | Python (FastAPI), SQLite, vanilla JS, LaTeX |
| [`examscreen/`](examscreen/) | A single self-contained HTML page to put on the projector during exams: a large countdown timer (by duration or until a time of day, turning amber and then red near the end), title and subtitle, and editable info blocks such as notes and links. Has light/dark mode and fullscreen. No server and no install: open `index.html` in a browser. | HTML/CSS/JS |

### How to use them

The subproject READMEs explain how to install, start and use each tool:

- **classbook**: see [`classbook/README.md`](classbook/README.md)
- **quizmaster**: see [`quizmaster/README.md`](quizmaster/README.md)
- **examscreen**: has no README. Open [`examscreen/index.html`](examscreen/index.html) in a browser and click *Edit* to set it up.

`classbook` and `quizmaster` use [pixi](https://pixi.sh) to manage their environments and are started with their `start.*` scripts.

## Data and privacy

This repository contains **code only**. No personal data, student data, class data,
grades, quiz content or certificates are, or ever should be, committed. All runtime data
lives in each project's `data/` directory, which is excluded by `.gitignore`, along with
databases, backups, keys, certificates and exports.

If you use these tools, **you** are responsible for the data you put into them. That
includes complying with the GDPR/DSGVO and any rules of your school or employer, keeping
backups, and securing the machines and networks the tools run on.

## Disclaimer / No warranty / No liability

This software is provided **"as is", without warranty of any kind**, express or
implied. That includes, but is not limited to, warranties of merchantability, fitness
for a particular purpose, correctness, security and non-infringement.

- **Vibe coded.** The code was produced largely through AI-assisted "vibe coding". It
  may contain bugs, security holes, wrong calculations, odd edge cases and design
  decisions nobody has thought through. Nobody has audited it professionally.
- **No responsibility for usage.** The author is not responsible for how this
  software is used, by whom, or for what purpose.
- **No responsibility for data loss.** The author is not liable for lost, corrupted,
  leaked or wrongly synced data. That covers databases, backups, grades, marks,
  attendance records, quizzes, exams and anything else. Keep your own independent
  backups.
- **No responsibility for results, even when used correctly.** The author is also
  not responsible for any outcome when the software is used exactly as intended
  and documented. Correct usage does not guarantee correct results. Wrong grades,
  wrong point totals, wrong timers, missed or misprinted exam questions, wrong
  planning, or any decision based on the tool's output are entirely the user's
  responsibility. Always verify anything that matters.
- **No responsibility for security or compliance.** The author makes no claim that
  the software is secure or that it meets any legal, data-protection,
  accessibility or school-administration requirements.
- **No liability for damages.** Under no circumstances shall the author be liable
  for any direct, indirect, incidental, special, consequential or exemplary
  damages, including loss of data, time, grades, reputation or employment,
  arising in any way out of the use of, or inability to use, this software, even
  if advised of the possibility of such damage.
- **Not official software.** These are personal tools. They are not endorsed,
  provided or supported by any school, institution or authority.

By using any part of this repository, you accept these terms and take full
responsibility for that use.

## Support

**There is no support.** The author has no time to address issues, answer
questions, review pull requests or implement feature requests. Issues may go
unanswered indefinitely. If something does not work for you, fork it and fix it
yourself.

## License

All three projects are released under the **BSD 3-Clause License**. See
[`LICENSE`](LICENSE) for the full text.

Third-party code bundled in this repository keeps its own license. For example,
`classbook/app/static/vendor/katex/` is [KaTeX](https://katex.org), which is MIT-licensed.
