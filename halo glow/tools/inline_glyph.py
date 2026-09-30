"""Injects assets/glyph.svg into examples/studio.html as window.__HALO_GLYPH__.

The page tries fetch('../assets/glyph.svg') first so the file on disk stays the
single source of truth. That fetch is blocked on file://, so the same markup is
also inlined as a fallback - which means the two can drift apart unless this
script runs after every change to the glyph.

Run:  python tools/inline_glyph.py          (rewrite)
      python tools/inline_glyph.py --check  (exit 1 if the inline copy is stale)
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GLYPH = os.path.join(ROOT, "assets", "glyph.svg")
PAGE = os.path.join(ROOT, "examples", "studio.html")

MARKER_START = "<script>/* inline-glyph:start */"
MARKER_END = "/* inline-glyph:end */</script>"


def build_block(svg_text):
    # </script> inside a string literal would close the host tag early.
    safe = svg_text.replace("</script", "<\\/script")
    return "%s\nwindow.__HALO_GLYPH__ = %s;\n%s" % (
        MARKER_START, json.dumps(safe), MARKER_END
    )


def read_page(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def replace_block(html, block):
    start = html.find(MARKER_START)
    if start == -1:
        return None
    end = html.find(MARKER_END, start)
    if end == -1:
        return None
    after = end + len(MARKER_END)
    # MARKER_START already begins with the <script> opening tag, so the
    # replacement owns the whole host tag - no separate search for it.
    return html[:start] + block + html[after:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    with open(GLYPH, "r", encoding="utf-8") as handle:
        svg_text = handle.read()

    block = build_block(svg_text)
    html = read_page(PAGE)
    updated = replace_block(html, block)

    if updated is None:
        print("no inline-glyph block found in studio.html; add the marker first")
        return 1

    if args.check:
        if updated != html:
            print("STALE: examples/studio.html does not match assets/glyph.svg")
            return 1
        print("ok: examples/studio.html is in sync with assets/glyph.svg")
        return 0

    if updated == html:
        print("already in sync")
        return 0
    with open(PAGE, "w", encoding="utf-8") as handle:
        handle.write(updated)
    print("inlined %d bytes of glyph into examples/studio.html" % len(svg_text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
