# Quizmaster

A small local web app for creating, viewing, practising and managing quizzes, with
import and export in the **Moodle XML** format.

## Start

```bash
./start.sh                 # installs the pixi env on first run, starts the server, opens the browser
./start.sh --port 9000     # other port (a free port is chosen automatically if it is taken)
./start.sh --no-browser
```

The server only listens on `127.0.0.1` and rejects requests that do not come from this machine
(or that carry a foreign `Host` header), so it is not reachable from the network.

Data is stored in `data/quizmaster.db` (SQLite). Use `--db path/to/file.db` for another file.

## Organisation

- **Catalog**: all questions live in a category tree (any depth) and carry tags. Moodle category
  paths are recreated on import; drag questions onto a category to move them.
- **Quizzes**: ordered selections of catalog questions (references, not copies — editing a question
  changes it in every quiz). Points can be overridden per quiz. Add questions with
  *Add from catalog*, or create new ones on the fly (they are stored in the catalog, too).

## Export

- **Moodle XML**: a whole quiz (as one category, or keeping the catalog categories), a catalog
  category subtree, or selected questions.
- **PDF** via LaTeX `exam` class: exam and answer key (same source, `answers` option), plus the
  LaTeX source as .zip. Settings per quiz: title, subtitle, date, instructions, language (en/de),
  grade table, font size, engine. Requires a TeX installation (pdflatex/xelatex/lualatex with
  latexmk, or tectonic).

## Supported question types

| Moodle type      | In Quizmaster                       |
|------------------|-------------------------------------|
| `truefalse`      | True/False                          |
| `multichoice`    | Multiple choice (single or multiple answers, graded per choice) |
| `multichoiceset` | Multiple choice, all-or-nothing     |
| `shortanswer`    | Short answer (`*` wildcard, case sensitivity) |
| `matching`       | Matching (pairs with empty question = distractor) |
| `ddimageortext`  | Drag and drop onto image (visual drop-zone editor) |
| `gapselect`      | Select missing words: `[[n]]` drop-downs in the text, grouped options |
| `cloze`          | Embedded answers: `{1:SHORTANSWER:=…}`, `NUMERICAL`, `MULTICHOICE`(`_V`/`_H`/`_S`), `MULTIRESPONSE`, … — mark = sum of gap weights |
| `essay`          | Essay (graded manually): response options, template, information for graders |

Other question types in an imported file are kept unchanged and written back on export.
Images embedded in question text (`@@PLUGINFILE@@`) are preserved; you can also insert or
paste images in the editor.

Preview with solutions and an interactive practice mode with automatic grading are available
for all of these.

## Development

```bash
pixi run -e test test      # run the tests (incl. round trip of the sample XML)
```
