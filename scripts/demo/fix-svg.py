import re, html, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
CELL = 1.002
def fix(m):
    attrs, body = m.group(1), m.group(2)
    n = len(html.unescape(body))
    if n < 2 or 'textLength' in attrs:
        return m.group(0)
    return f'<text{attrs} textLength="{n*CELL:.3f}" lengthAdjust="spacingAndGlyphs">{body}</text>'
s2, k = re.subn(r'<text([^>]*)>([^<]*)</text>', fix, s)
open(dst, 'w').write(s2)
print("fixed", k, "text nodes")
