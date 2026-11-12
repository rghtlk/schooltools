"""Markdown (with maths) -> LaTeX, for the course script."""

from app.latex import Ctx, escape, markdown_to_latex as tex


def test_escapes_latex_specials_in_plain_text():
    out = tex("100% of a & b_c #tag ~x ^y {z}")
    assert r"100\%" in out and r"a \& b\_c" in out and r"\#tag" in out
    assert r"\textasciitilde{}" in out and r"\textasciicircum{}" in out
    assert r"\{z\}" in out


def test_escape_helper_is_idempotent_on_safe_text():
    assert escape("plain words 123") == "plain words 123"


def test_inline_and_display_maths_pass_through_untouched():
    out = tex("Recall $a^2+b^2=c^2$ and\n\n$$\\int_0^1 x\\,dx = \\tfrac12$$")
    assert "\\(a^2+b^2=c^2\\)" in out
    assert "\\[" in out and "\\int_0^1 x\\,dx" in out
    # the maths must not have been escaped
    assert "\\_" not in out.split("\\[")[1]


def test_maths_next_to_special_characters():
    out = tex("50% is $\\frac{1}{2}$ & that is fine")
    assert r"50\%" in out and r"\&" in out
    assert "\\(\\frac{1}{2}\\)" in out


def test_headings_become_sections_at_an_offset():
    out = tex("# Top\n\n## Second", Ctx(heading_offset=1))
    assert "\\subsection*{Top}" in out
    assert "\\subsubsection*{Second}" in out


def test_emphasis_and_code():
    out = tex("**bold** and *italic* and `x_1` here")
    assert r"\textbf{bold}" in out
    assert r"\emph{italic}" in out
    assert r"\texttt{x\_1}" in out          # escaped inside code too


def test_lists_nest():
    out = tex("- one\n- two\n\n1. first\n2. second")
    assert "\\begin{itemize}" in out and "\\item one" in out
    assert "\\begin{enumerate}" in out and "\\item second" in out


def test_fenced_code_becomes_verbatim():
    out = tex("```\nfor i in range(3):\n    print(i)\n```")
    assert "\\begin{verbatim}" in out
    assert "for i in range(3):" in out      # untouched inside verbatim
    assert "\\end{verbatim}" in out


def test_blockquote_and_rule():
    out = tex("> remember this\n\n---\n\nafter")
    assert "\\begin{quote}" in out and "remember this" in out
    assert "\\hrule" in out


def test_table_with_header():
    out = tex("| a | b |\n|---|---|\n| 1 | 2 |")
    assert "\\begin{tabular}{ll}" in out
    assert "\\textbf{a} & \\textbf{b}" in out
    assert "1 & 2 \\\\" in out
    assert "\\end{tabular}" in out


def test_links_keep_the_text_and_footnote_the_url():
    out = tex("see [the docs](https://example.org/a_b) please")
    assert "the docs" in out
    assert "\\footnote{\\url{https://example.org/a_b}}" in out


def test_bare_url_becomes_url_macro():
    out = tex("<https://example.org>")
    assert "\\url{https://example.org}" in out


def test_images_are_resolved_through_the_context():
    seen = []

    def resolve(src):
        seen.append(src)
        return "figures/diagram.png"

    out = tex("![A diagram](/imgs/y/c/t/diagram.png)", Ctx(image_path=resolve))
    assert seen == ["/imgs/y/c/t/diagram.png"]
    assert "\\includegraphics" in out and "{figures/diagram.png}" in out
    assert "\\caption*{A diagram}" in out
    assert "\\begin{figure}" in out


def test_image_without_a_resolved_path_is_dropped():
    out = tex("![x](/imgs/missing.png)", Ctx(image_path=lambda s: None))
    assert "includegraphics" not in out


def test_empty_and_whitespace_input():
    assert tex("") == "" and tex("   \n\n ") == ""


def test_raw_html_does_not_break_the_document():
    out = tex("before <div><span>unclosed notes")
    assert "before" in out and "<" not in out


def test_realistic_note_converts_end_to_end():
    note = """## Goal

Add fractions with **different** denominators.

$$\\frac{a}{b} + \\frac{c}{d} = \\frac{ad + bc}{bd}$$

- find the common denominator
- expand both fractions
- reduce the result if you can

> Always reduce. 100% of the marks depend on it.

| step | example |
|------|---------|
| expand | $\\frac{1}{2} = \\frac{2}{4}$ |

Homework: worksheet 3, exercises 1_a to 4_c."""
    out = tex(note, Ctx(heading_offset=1))
    for expected in [
        "\\subsubsection*{Goal}",
        "\\textbf{different}",
        "\\[",
        "\\begin{itemize}",
        "\\begin{quote}",
        "100\\%",
        "\\begin{tabular}",
        "1\\_a",
    ]:
        assert expected in out, expected
    # no stray HTML survived
    assert "<" not in out and ">" not in out.replace("\\textgreater", "")


def test_trailing_line_break_is_dropped():
    r"""A dangling \\ is 'There's no line here to end' in LaTeX."""
    out = tex("A line\n")
    assert not out.strip().endswith("\\\\")


def test_line_break_never_precedes_an_environment():
    out = tex("Homework: ex. 1\n\n![x](/imgs/a.png)", Ctx(image_path=lambda s: "f/a.png"))
    assert "\\\\\n\\begin{figure}" not in out
    assert "\\begin{figure}" in out


def test_internal_line_breaks_are_kept():
    out = tex("first line\nsecond line")
    assert "\\\\" in out and "second line" in out
