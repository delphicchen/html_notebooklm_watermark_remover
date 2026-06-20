#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Assemble the offline single-file app.

Inlines CSS + the vendored UMD libraries + the application JS into one
self-contained HTML file that runs from file:// with no server and no network.

    python3 build.py            # -> dist/notebooklm-watermark-remover.html

The pdf.js worker is embedded as base64 and turned into a Blob URL at runtime
(see app.js), so even PDF processing needs no external files.
"""
import base64
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
VENDOR = os.path.join(ROOT, "vendor")
DIST = os.path.join(ROOT, "dist")

# Application modules, in load order. Each extends the global NLM namespace.
APP_MODULES = [
    "core.js",
    "engine.js",
    "detect.js",
    "process.js",
    "image.js",
    "pptx.js",
    "pdf.js",
    "manual.js",
    "ui.js",
    "app.js",
]

# UMD libraries, in load order (must precede the app modules).
VENDOR_LIBS = ["jszip.min.js", "pdf.min.js", "pdf-lib.min.js"]

OUTPUT = os.path.join(DIST, "notebooklm-watermark-remover.html")


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def guard_script(js):
    """Prevent a stray </script> inside a JS string/regex from closing the tag.

    `</script` is not valid JS except inside strings/regex, where `<\\/script`
    is equivalent — so this rewrite is safe and keeps the HTML parser happy.
    """
    return js.replace("</script", "<\\/script")


def main():
    missing = [p for p in
               [os.path.join(VENDOR, v) for v in VENDOR_LIBS + ["pdf.worker.min.js"]]
               if not os.path.exists(p)]
    if missing:
        sys.stderr.write("Missing vendor files:\n  " + "\n  ".join(missing) + "\n")
        sys.stderr.write("Run the download step first (see README).\n")
        return 1

    template = read(os.path.join(SRC, "index.template.html"))
    css = read(os.path.join(SRC, "css", "styles.css"))

    vendor_js = "\n".join(read(os.path.join(VENDOR, v)) for v in VENDOR_LIBS)
    app_js = "\n".join(
        "/* === %s === */\n%s" % (m, read(os.path.join(SRC, "js", m)))
        for m in APP_MODULES
    )

    with open(os.path.join(VENDOR, "pdf.worker.min.js"), "rb") as f:
        worker_b64 = base64.b64encode(f.read()).decode("ascii")
    worker_js = 'window.__NLM_PDF_WORKER_B64__="%s";' % worker_b64

    html = template
    html = html.replace("<!--INJECT:CSS-->", css)
    html = html.replace("<!--INJECT:VENDOR-->", guard_script(vendor_js))
    html = html.replace("<!--INJECT:PDF_WORKER-->", worker_js)
    html = html.replace("<!--INJECT:APP-->", guard_script(app_js))

    # sanity: every placeholder consumed
    leftovers = [tok for tok in ("INJECT:CSS", "INJECT:VENDOR", "INJECT:PDF_WORKER", "INJECT:APP")
                 if tok in html]
    if leftovers:
        sys.stderr.write("Unfilled placeholders: %s\n" % ", ".join(leftovers))
        return 1

    os.makedirs(DIST, exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(html)

    size = os.path.getsize(OUTPUT)
    print("Built %s (%.2f MB)" % (OUTPUT, size / 1048576.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
