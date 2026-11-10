#!/usr/bin/env python3
"""Generate the animated stepper diagrams for the WA-BOT README / Pages site.

Outputs (dark cards, SMIL-animated, self-contained):
  bypass-flow.svg   — paste link -> detect -> resolve -> shorten -> reply
  channel-flow.svg  — channel link -> invite -> fetch post -> extract -> bypass all
  schedule.svg      — a day with the bot (09:00 open, through-the-day jobs, 23:55 close)

Run: python3 docs/assets/build-flows.py
"""
import html

CARD = "#0e1513"
EDGE = "#1f2a26"
GREEN = "#25D366"
AMBER = "#f0b429"
TXT = "#e9edef"
DIM = "#8696a0"
FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"


def esc(s):
    return html.escape(s)


def stepper(path, title, accent, steps, dot_dur="6s"):
    """steps: list of (label, detail). 5 nodes on a horizontal line."""
    w, h = 900, 220
    xs = [90, 260, 430, 600, 780]
    y = 122
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="{FONT}" role="img" aria-label="{esc(title)}">']
    out.append(f'<rect x="0" y="0" width="{w}" height="{h}" rx="16" fill="{CARD}" stroke="{EDGE}"/>')
    out.append(f'<text x="28" y="36" font-size="12" letter-spacing="2.5" font-weight="700" fill="{accent}">{esc(title)}</text>')
    out.append(f'<line x1="70" y1="{y}" x2="830" y2="{y}" stroke="{EDGE}" stroke-width="3" stroke-linecap="round"/>')
    # travelling dot
    out.append(f'<circle r="7" fill="{accent}">'
               f'<animateMotion dur="{dot_dur}" repeatCount="indefinite" path="M 90 {y} L 780 {y}"/></circle>')
    out.append(f'<circle r="12" fill="{accent}" opacity="0.25">'
               f'<animateMotion dur="{dot_dur}" repeatCount="indefinite" path="M 90 {y} L 780 {y}"/></circle>')
    for i, (label, detail) in enumerate(steps):
        x = xs[i]
        # halo pulse, staggered to roughly track the travelling dot
        begin = f"{i * 1.2:.1f}s"
        out.append(f'<circle cx="{x}" cy="{y}" r="31" fill="none" stroke="{accent}" stroke-width="1.5">'
                   f'<animate attributeName="opacity" values="0.08;0.65;0.08" dur="6s" begin="{begin}" repeatCount="indefinite"/></circle>')
        out.append(f'<circle cx="{x}" cy="{y}" r="24" fill="#122019" stroke="{accent}" stroke-width="2"/>')
        out.append(f'<text x="{x}" y="{y + 6}" font-size="16" font-weight="700" fill="{accent}" text-anchor="middle">{i + 1}</text>')
        out.append(f'<text x="{x}" y="{y - 48}" font-size="14" font-weight="700" fill="{TXT}" text-anchor="middle">{esc(label)}</text>')
        out.append(f'<text x="{x}" y="{y + 58}" font-size="11.5" fill="{DIM}" text-anchor="middle">{esc(detail)}</text>')
    out.append("</svg>")
    open(path, "w").write("\n".join(out) + "\n")


def schedule(path):
    w, h = 900, 200
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="{FONT}" role="img" aria-label="A day with the bot">']
    out.append(f'<rect x="0" y="0" width="{w}" height="{h}" rx="16" fill="{CARD}" stroke="{EDGE}"/>')
    out.append(f'<text x="28" y="34" font-size="12" letter-spacing="2.5" font-weight="700" fill="{GREEN}">A DAY WITH THE BOT</text>')
    x0, x1, y = 60, 840, 108
    out.append(f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" stroke="{EDGE}" stroke-width="3" stroke-linecap="round"/>')
    # hour ticks every 3h
    for hr in range(0, 25, 3):
        x = x0 + (x1 - x0) * hr / 24
        out.append(f'<line x1="{x:.0f}" y1="{y - 6}" x2="{x:.0f}" y2="{y + 6}" stroke="{DIM}" stroke-width="1.5"/>')
        out.append(f'<text x="{x:.0f}" y="{y + 30}" font-size="11" fill="{DIM}" text-anchor="middle">{hr:02d}:00</text>')

    def mark(hr, color, label, detail, above=True, anchor="middle", lx=None):
        x = x0 + (x1 - x0) * hr / 24
        lx = x if lx is None else lx
        ly = y - 34 if above else y + 58
        dy = y - 18 if above else y + 74
        out.append(f'<circle cx="{x:.0f}" cy="{y}" r="8" fill="{color}"/>')
        out.append(f'<circle cx="{x:.0f}" cy="{y}" r="13" fill="none" stroke="{color}" stroke-width="1.5" opacity="0.5"/>')
        out.append(f'<text x="{lx:.0f}" y="{ly}" font-size="13" font-weight="700" fill="{TXT}" text-anchor="{anchor}">{esc(label)}</text>')
        out.append(f'<text x="{lx:.0f}" y="{dy}" font-size="11.5" fill="{DIM}" text-anchor="{anchor}">{esc(detail)}</text>')

    mark(9, GREEN, "09:00 · chat opens", "groups unlock + greeting")
    mark(21.5, GREEN, "evening · recap", "AI summary of the day")
    mark(23.92, AMBER, "23:55 · chat closes", "groups lock for the night", anchor="end", lx=872)
    # through-the-day band
    bx0 = x0 + (x1 - x0) * 9.5 / 24
    bx1 = x0 + (x1 - x0) * 21 / 24
    out.append(f'<rect x="{bx0:.0f}" y="{y + 46}" width="{bx1 - bx0:.0f}" height="18" rx="9" fill="#122019"/>')
    out.append(f'<text x="{(bx0 + bx1) / 2:.0f}" y="{y + 59}" font-size="11" fill="{GREEN}" text-anchor="middle">all day · courses poll · news digests · GitHub trending</text>')
    # slow travelling dot (one full day per loop)
    out.append(f'<circle r="6" fill="{GREEN}"><animateMotion dur="24s" repeatCount="indefinite" path="M {x0} {y} L {x1} {y}"/></circle>')
    out.append("</svg>")
    open(path, "w").write("\n".join(out) + "\n")


def router(path):
    """Two LLM fallback chains: Assist router and Trade router."""
    w, h = 900, 280
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="{FONT}" role="img" aria-label="The LLM brain: two fallback chains">']
    out.append(f'<rect x="0" y="0" width="{w}" height="{h}" rx="16" fill="{CARD}" stroke="{EDGE}"/>')
    out.append(f'<text x="28" y="36" font-size="12" letter-spacing="2.5" font-weight="700" fill="{GREEN}">THE LLM BRAIN — TWO ROUTERS, ONE FALLBACK IDEA</text>')

    def chain(y, tag, providers, caption, dot_dur):
        out.append(f'<text x="28" y="{y + 5}" font-size="12" font-weight="700" fill="{AMBER}">{esc(tag)}</text>')
        x = 110
        pw, ph, gap = 140, 40, 12
        x_end = x + len(providers) * (pw + gap) - gap
        out.append(f'<line x1="{x}" y1="{y}" x2="{x_end}" y2="{y}" stroke="{EDGE}" stroke-width="3" stroke-linecap="round"/>')
        out.append(f'<circle r="6" fill="{GREEN}"><animateMotion dur="{dot_dur}" repeatCount="indefinite" path="M {x} {y} L {x_end} {y}"/></circle>')
        for p in providers:
            out.append(f'<rect x="{x}" y="{y - ph // 2}" width="{pw}" height="{ph}" rx="10" fill="#122019" stroke="{GREEN}" stroke-width="1.5"/>')
            out.append(f'<text x="{x + pw // 2}" y="{y + 5}" font-size="13" font-weight="700" fill="{TXT}" text-anchor="middle">{esc(p)}</text>')
            x += pw + gap
        out.append(f'<text x="{(110 + x_end) // 2}" y="{y + 52}" font-size="12" fill="{DIM}" text-anchor="middle">{esc(caption)}</text>')

    chain(96, "ASSIST", ["Gemini", "Groq", "NVIDIA", "OpenRouter"],
          "DM persona · summaries · greetings · self-heal — on error or quota, falls through", "7s")
    chain(196, "TRADE", ["OrcaRouter", "Gemini", "Groq", "NVIDIA", "OpenRouter"],
          "DeepSeek V4 Flash first · LlmRateGate spreads bursts · dead providers cool down", "9s")
    out.append("</svg>")
    open(path, "w").write("\n".join(out) + "\n")


if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    stepper(os.path.join(here, "bypass-flow.svg"), "BYPASS PIPELINE", GREEN, [
        ("Paste a link", "DM or /bypasson group"),
        ("Detect the host", "hubcloud · hubdrive · gdflix"),
        ("Resolve it", "TLD auto-detected"),
        ("Mint a short link", "/d/ link · 7h expiry"),
        ("Reply with links", "never gets stuck"),
    ])
    stepper(os.path.join(here, "channel-flow.svg"), "CHANNEL LINK · BYPASSED POST", AMBER, [
        ("Paste channel link", "channel link /2289"),
        ("Resolve the invite", "invite to @newsletter"),
        ("Fetch the post", "125 posts deep"),
        ("Extract hubcloud links", "every link in it"),
        ("Bypass them all", "5 at once"),
    ])
    schedule(os.path.join(here, "schedule.svg"))
    router(os.path.join(here, "llm-router.svg"))
    print("bypass-flow.svg, channel-flow.svg, schedule.svg, llm-router.svg written")
