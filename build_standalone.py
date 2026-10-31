#!/usr/bin/env python3
"""
Bundle TX100 Digital Twin HTML, CSS, and JS into a 100% self-contained standalone HTML file.
"""

import os

base_dir = os.path.dirname(os.path.abspath(__file__))
index_path = os.path.join(base_dir, 'index.html')
css_path = os.path.join(base_dir, 'styles.css')
js_path = os.path.join(base_dir, 'sim_engine.js')
out_path = os.path.join(base_dir, 'standalone_tx100_twin.html')

with open(index_path, 'r', encoding='utf-8') as f:
    html = f.read()

with open(css_path, 'r', encoding='utf-8') as f:
    css = f.read()

with open(js_path, 'r', encoding='utf-8') as f:
    js = f.read()

# Replace external CSS and JS with inline tags
html = html.replace('<link rel="stylesheet" href="styles.css">', f'<style>\n{css}\n</style>')
html = html.replace('<script src="sim_engine.js"></script>', f'<script>\n{js}\n</script>')

with open(out_path, 'w', encoding='utf-8') as f:
    f.write(html)

size_kb = os.path.getsize(out_path) / 1024
print(f"[OK] Standalone Single-File Digital Twin built successfully: {out_path} ({size_kb:.1f} KB)")
