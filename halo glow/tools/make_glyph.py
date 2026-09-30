"""Draws the default glyph: a twelve-lobed halo with a concentric core ring and
seven satellite holes.

Every subpath is closed, so the renderer can treat the artwork as a filled
region. The multiple boundaries (outer rim, annulus, satellites) are the point:
they give the signed distance field edges to light from both the inside and the
outside.
"""
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "assets", "glyph.svg")

CX = CY = 500.0


def f(n):
    return round(n, 2)


def pt(r, deg):
    a = math.radians(deg)
    return (CX + r * math.cos(a), CY + r * math.sin(a))


def contour(base_radius, amplitude, lobes, step=7.5):
    """Cubic approximation of a radius-modulated closed contour."""
    def radius_at(deg):
        return base_radius + amplitude * math.cos(lobes * math.radians(deg))

    count = int(round(360.0 / step))
    nodes = []
    for i in range(count):
        deg = i * step
        nxt = deg + step
        r = radius_at(deg)
        a = math.radians(deg)
        # dr/ddeg of the polar profile.
        dr = -amplitude * lobes * math.pi * math.sin(lobes * a) / 180.0
        tx = dr * math.cos(a) - r * math.sin(a)
        ty = dr * math.sin(a) + r * math.cos(a)
        length = math.hypot(tx, ty) or 1.0
        k = (4.0 / 3.0) * math.tan(math.radians(step) / 4.0) * r
        node = pt(r, deg)
        end = pt(radius_at(nxt), nxt)
        nodes.append((
            node,
            (node[0] + tx / length * k * 0.5, node[1] + ty / length * k * 0.5),
            (end[0] - tx / length * k * 0.5, end[1] - ty / length * k * 0.5),
            end,
        ))

    parts = ["M %s %s" % (f(nodes[0][0][0]), f(nodes[0][0][1]))]
    for node, c1, c2, end in nodes:
        parts.append(
            "C %s %s %s %s %s %s"
            % (f(c1[0]), f(c1[1]), f(c2[0]), f(c2[1]), f(end[0]), f(end[1]))
        )
    parts.append("Z")
    return " ".join(parts)


def circle(radius, center=(CX, CY), phase=0.0):
    a = math.radians(phase)
    cos_a, sin_a = math.cos(a), math.sin(a)
    x, y = center
    k = radius * 0.5522847498

    def rot(px, py):
        return (x + px * cos_a - py * sin_a, y + px * sin_a + py * cos_a)

    def seg(c1, c2, end):
        c1, c2 = rot(*c1), rot(*c2)
        return "C %s %s %s %s %s %s" % (
            f(c1[0]), f(c1[1]), f(c2[0]), f(c2[1]), f(end[0]), f(end[1])
        )

    # phase rotates the handles so overlapping circles never share a visible seam.
    return " ".join([
        "M %s %s" % (f(x + radius), f(y)),
        seg((radius, k), (k, radius), (x, y + radius)),
        seg((-k, radius), (-radius, k), (x - radius, y)),
        seg((-radius, -k), (-k, -radius), (x, y - radius)),
        seg((k, -radius), (radius, -k), (x + radius, y)),
        "Z",
    ])


def main():
    parts = [("outer", contour(base_radius=452, amplitude=26, lobes=12))]
    # A real annulus: the ring only resolves as a ring under fill-rule evenodd.
    parts.append(("ring-outer", circle(radius=168, phase=0)))
    parts.append(("ring-inner", circle(radius=112, phase=90)))

    # Seven satellites on a tilted orbit, radii deliberately uneven.
    orbit = [
        (-90, 74), (-38, 46), (8, 62), (52, 38),
        (104, 56), (168, 44), (226, 66),
    ]
    for i, (deg, radius) in enumerate(orbit):
        a = math.radians(deg)
        center = (CX + 306 * math.cos(a), CY + 306 * math.sin(a))
        parts.append(("satellite", circle(radius=radius, center=center, phase=i * 45.0)))

    # Every boundary lives in ONE path element. fill-rule only cancels between
    # subpaths of the same element - split across elements the disc fills solid
    # and the holes and the annulus simply disappear.
    d = " ".join(geometry for _, geometry in parts)
    body = '  <path d="%s"/>' % d
    legend = "  <!-- " + ", ".join(role for role, _ in parts) + " -->"
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"'
        ' width="1000" height="1000">\n'
        "  <title>Twelve-Phase Halo</title>\n"
        '  <path fill="#ffffff" fill-rule="evenodd" d="%s"/>\n'
        "%s\n"
        "</svg>\n" % (d, legend)
    )

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(svg)
    print("wrote %s" % OUT)
    print("%d closed subpaths, %d bytes" % (len(parts), len(svg)))


if __name__ == "__main__":
    main()
