#!/usr/bin/env python3
"""Generate the isometric architecture diagram for the WA-BOT README / Pages site.

Flat dimetric projection (x: 0.866, y: 0.25) — reads as 3D without eating
the canvas. One travelling dot per flow segment, SMIL-animated.

Run: python3 docs/assets/build-architecture.py
"""
import math
import os

W, H = 900, 560
CARD = "#0e1513"
EDGE = "#1f2a26"
GREEN = "#25D366"
TEAL = "#2dd4bf"
AMBER = "#f0b429"
TXT = "#e9edef"
DIM = "#8696a0"
FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

CX = 0.866  # cos(30deg)
CY = 0.25   # flat dimetric: shallow depth so 3 rows fit


def iso(x, y, z, ox, oy):
    return (ox + (x - y) * CX, oy + (x + y) * CY - z)


def pts(points):
    return " ".join(f"{a:.1f},{b:.1f}" for a, b in points)


def box(out, cx, top_y, w, d, h, stroke, label, sub=""):
    """cx: screen x of the box centre (top face). top_y: screen y of the
    top-face centre. w/d/h: box size in iso units."""
    # top face corners in iso coords, centred on (0,0)
    ox, oy = cx, top_y + h  # project from the box base centre
    top = [iso(-w / 2, -d / 2, h, ox, oy), iso(w / 2, -d / 2, h, ox, oy),
           iso(w / 2, d / 2, h, ox, oy), iso(-w / 2, d / 2, h, ox, oy)]
    left = [iso(-w / 2, d / 2, h, ox, oy), iso(w / 2, d / 2, h, ox, oy),
            iso(w / 2, d / 2, 0, ox, oy), iso(-w / 2, d / 2, 0, ox, oy)]
    right = [iso(w / 2, -d / 2, h, ox, oy), iso(w / 2, d / 2, h, ox, oy),
             iso(w / 2, d / 2, 0, ox, oy), iso(w / 2, -d / 2, 0, ox, oy)]
    out.append(f'<polygon points="{pts(left)}" fill="#141f1a" stroke="{stroke}" stroke-width="1.2"/>')
    out.append(f'<polygon points="{pts(right)}" fill="#0f1713" stroke="{stroke}" stroke-width="1.2"/>')
    out.append(f'<polygon points="{pts(top)}" fill="#1c2b24" stroke="{stroke}" stroke-width="1.5"/>')
    out.append(f'<text x="{cx}" y="{top_y + 1}" font-size="13" font-weight="700" fill="{TXT}" text-anchor="middle">{label}</text>')
    if sub:
        out.append(f'<text x="{cx}" y="{top_y + 17}" font-size="10.5" fill="{DIM}" text-anchor="middle">{sub}</text>')
    # bottom-front corner (for connectors): the lowest point of the box
    bottom = iso(w / 2, d / 2, 0, ox, oy)
    return {"top": (cx, top_y), "bottom": bottom, "cx": cx}


def cylinder(out, cx, top_y, rx, ry, h, stroke, label):
    out.append(f'<ellipse cx="{cx}" cy="{top_y + h}" rx="{rx}" ry="{ry}" fill="#0f1713" stroke="{stroke}" stroke-width="1.2"/>')
    out.append(f'<path d="M {cx - rx} {top_y + h} L {cx - rx} {top_y} A {rx} {ry} 0 0 0 {cx + rx} {top_y} L {cx + rx} {top_y + h}" fill="#141f1a" stroke="{stroke}" stroke-width="1.2"/>')
    out.append(f'<ellipse cx="{cx}" cy="{top_y}" rx="{rx}" ry="{ry}" fill="#1c2b24" stroke="{stroke}" stroke-width="1.5"/>')
    out.append(f'<text x="{cx}" y="{top_y + 4}" font-size="13" font-weight="700" fill="{TXT}" text-anchor="middle">{label}</text>')
    return {"top": (cx, top_y), "bottom": (cx, top_y + h + ry), "cx": cx}


def main():
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}" role="img" aria-label="WA-BOT architecture: WhatsApp, Baileys, command registry, controllers, services, MongoDB">']
    out.append(f'<rect x="0" y="0" width="{W}" height="{H}" rx="16" fill="{CARD}" stroke="{EDGE}"/>')
    out.append(f'<text x="28" y="36" font-size="12" letter-spacing="2.5" font-weight="700" fill="{GREEN}">HOW IT IS BUILT — ONE INSTANCE, ONE SESSION</text>')

    # Row 1: WhatsApp -> Baileys -> Registry (horizontal flow)
    r1y = 118
    wa = box(out, 155, r1y, 170, 90, 36, GREEN, "WhatsApp", "user · group · DM")
    bl = box(out, 450, r1y, 170, 90, 36, TEAL, "Baileys 7", "WebSocket · multi-device")
    rg = box(out, 745, r1y, 170, 90, 36, GREEN, "Command registry", "routes + access rules")
    # connectors row 1 (short arrows in the gaps)
    for (a, b) in [(wa, bl), (bl, rg)]:
        x0 = a["cx"] + 108
        x1 = b["cx"] - 108
        out.append(f'<line x1="{x0}" y1="{r1y}" x2="{x1}" y2="{r1y}" stroke="{GREEN}" stroke-width="2" marker-end="url(#arr)"/>')
    out.append('<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#25D366"/></marker></defs>')
    # travelling dot, row 1
    out.append(f'<circle r="6" fill="{GREEN}"><animateMotion dur="5s" repeatCount="indefinite" path="M {wa["cx"]} {r1y} L {rg["cx"]} {r1y}"/></circle>')

    # Row 1 -> Row 2: spine + bus + drops
    r2y = 268
    bus_y = 208
    spine_x = rg["cx"]
    out.append(f'<line x1="{spine_x}" y1="{rg["bottom"][1]}" x2="{spine_x}" y2="{bus_y}" stroke="{EDGE}" stroke-width="2"/>')
    out.append(f'<line x1="105" y1="{bus_y}" x2="795" y2="{bus_y}" stroke="{EDGE}" stroke-width="2"/>')
    ctrl_centers = [105, 277, 450, 622, 795]
    ctrl_labels = [("Movie / Bypass", "search + links"), ("Instagram", "download · auto"),
                   ("Stickers", "make · steal · route"), ("Trade", "alerts · signals"),
                   ("News · GitHub", "digests · trending")]
    ctrls = []
    for cx, (label, sub) in zip(ctrl_centers, ctrl_labels):
        out.append(f'<line x1="{cx}" y1="{bus_y}" x2="{cx}" y2="{r2y - 18}" stroke="{EDGE}" stroke-width="2"/>')
        ctrls.append(box(out, cx, r2y, 140, 80, 32, TEAL, label, sub))
    # travelling dot down the spine
    out.append(f'<circle r="6" fill="{TEAL}"><animateMotion dur="4s" begin="1s" repeatCount="indefinite" path="M {spine_x} {rg["bottom"][1]} L {spine_x} {bus_y} L 105 {bus_y}"/></circle>')

    # Row 2 -> Row 3: spine + bus + drops
    r3y = 418
    bus2_y = 358
    spine2_x = 450
    out.append(f'<line x1="{spine2_x}" y1="{ctrls[2]["bottom"][1]}" x2="{spine2_x}" y2="{bus2_y}" stroke="{EDGE}" stroke-width="2"/>')
    out.append(f'<line x1="115" y1="{bus2_y}" x2="800" y2="{bus2_y}" stroke="{EDGE}" stroke-width="2"/>')
    svc_centers = [115, 295, 475, 655]
    svc_labels = [("HdHubBypass", "resolve + TLD detect"), ("ShortLink", "self-hosted /d/ links"),
                  ("LLM router", "Gemini · Groq · …"), ("Schedulers", "polls · digests · recap")]
    for cx, (label, sub) in zip(svc_centers, svc_labels):
        out.append(f'<line x1="{cx}" y1="{bus2_y}" x2="{cx}" y2="{r3y - 18}" stroke="{EDGE}" stroke-width="2"/>')
        box(out, cx, r3y, 150, 85, 32, AMBER, label, sub)
    out.append(f'<line x1="800" y1="{bus2_y}" x2="800" y2="{r3y - 18}" stroke="{EDGE}" stroke-width="2"/>')
    cylinder(out, 800, r3y, 62, 18, 44, GREEN, "MongoDB")
    out.append(f'<text x="800" y="{r3y + 34}" font-size="10.5" fill="{DIM}" text-anchor="middle">session + data</text>')
    # travelling dot, row 3
    out.append(f'<circle r="6" fill="{AMBER}"><animateMotion dur="6s" begin="2s" repeatCount="indefinite" path="M 115 {r3y} L 800 {r3y}"/></circle>')

    out.append(f'<text x="28" y="{H - 18}" font-size="11.5" fill="{DIM}">Node.js 22 · Baileys 7 · MongoDB — one live instance holds the WhatsApp session, so deploys keep it.</text>')
    out.append("</svg>")
    here = os.path.dirname(os.path.abspath(__file__))
    open(os.path.join(here, "architecture.svg"), "w").write("\n".join(out) + "\n")
    print("architecture.svg written")


if __name__ == "__main__":
    main()
