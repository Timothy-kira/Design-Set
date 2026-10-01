"""Build examples/wave.html from src/unfazed-shader.webgl.js.

The three upstream implementations are ES modules, and a file:// page cannot
import another file:// module - the browser blocks it under CORS. The sources
stay untouched; the demo carries its own copy of the WebGL2 one so it still
opens by double-click. Generating the copy instead of hand-writing it means the
demo cannot drift from the source it came from.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "unfazed-shader.webgl.js"
OUT = ROOT / "examples" / "wave.html"

source = SRC.read_text(encoding="utf-8")

# Drop the upstream header comment; the demo page states its own provenance.
body = re.sub(r"^/\*.*?\*/\s*", "", source, count=1, flags=re.S)
# The demo calls createShader directly, so there is nothing to export.
body = body.replace("export function createShader", "function createShader")
assert "export " not in body, "an export survived - the demo would not load"

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unfazed Wave</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #07070b; }
  #stage { display: block; width: 100vw; height: 100vh; }
  #toggle {
    position: fixed; top: 14px; right: 14px; z-index: 2; cursor: pointer;
    font: 12px/1 ui-monospace, Menlo, Consolas, monospace;
    color: rgba(255,255,255,.66); background: rgba(255,255,255,.10);
    border: 1px solid rgba(255,255,255,.16); border-radius: 999px;
    padding: 8px 14px;
  }
  #toggle:hover { color: #fff; background: rgba(255,255,255,.18); }
  #status {
    position: fixed; left: 14px; bottom: 14px; z-index: 2; margin: 0;
    font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
    color: rgba(255,255,255,.5); max-width: 60ch;
  }
  #status.ok::after { content: "  ready"; color: #6ee7a8; }
  #status.err { color: #ff9a9a; }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<button id="toggle" data-theme="dark">light</button>
<p id="status"></p>
<script type="module">
/* ------------------------------------------------------------------
 * WebGL2 implementation, inlined from src/unfazed-shader.webgl.js
 * by tools/build_demo.py. The source file is the one to edit; rerun
 * that script to regenerate this page.
 *
 * @unfazed / OpenShaders - https://openshaders.com/@unfazed
 * ------------------------------------------------------------------ */

__SHADER__

const canvas = document.getElementById("stage");
const status = document.getElementById("status");
const toggle = document.getElementById("toggle");

function fail(error) {
  status.className = "err";
  status.textContent = error instanceof Error ? error.message : String(error);
  toggle.hidden = true;
}
function ready(label) {
  status.className = "ok";
  status.textContent = label;
}

let shader = null;
try {
  shader = createShader(canvas, {
    theme: "dark",
    background: { dark: "#07070b", light: "#f3efe6" },
    onError: fail,
  });
  ready("WebGL2");
} catch (error) {
  fail(error);
}

if (shader) {
  toggle.addEventListener("click", () => {
    const light = toggle.dataset.theme !== "light";
    toggle.dataset.theme = light ? "light" : "dark";
    toggle.textContent = light ? "dark" : "light";
    shader.setTheme(light ? "light" : "dark");
  });
  window.shader = shader;
}
</script>
</body>
</html>
"""

OUT.write_text(PAGE.replace("__SHADER__", body), encoding="utf-8")
print(f"wrote {OUT.relative_to(ROOT)}  ({OUT.stat().st_size} bytes)")
print(f"shader body inlined: {len(body)} chars")
