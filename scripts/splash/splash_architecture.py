# -*- coding: utf-8 -*-
"""InfoApex AI - splash / infografic 'arhitectura control plane'. 1672 x 941."""
import math
import os

import ia_lib as L
from ia_lib import (BG_DEEP, PANEL, PANEL2, EDGE, EDGE_HI, TXT, SUB, DIM, FAINT,
                    BLUE, ICE, DEEP, AMBER, GREEN, n, hexagon, arrow, arrow_head,
                    card, panel, corner_brackets)

W, H = 1672, 941
TITLE = "InfoApex AI — control plane local pentru agenți de programare"

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "..", "docs", "assets")

# Text metrics measured off docs/assets/infoapex-logo-lockup.png, as fractions
# of its height, so " AI" can be matched to the render's own baseline and size.
LOCK_BASELINE = 0.7972
LOCK_CAP = 0.4804
POPPINS_CAP = 0.700

# ================================================================= icons
def ic_target(c, x, y, s, col, sw=1.6):
    c.circle(x, y, s, stroke=col, sw=sw)
    c.circle(x, y, s * 0.34, fill=col)
    for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
        c.line(x + dx * s, y + dy * s, x + dx * s * 1.45, y + dy * s * 1.45,
               col, sw, stroke_linecap="round")

def _shield_d(x, y, s):
    return (f"M{n(x)} {n(y - s)}L{n(x + s * .84)} {n(y - s * .6)}"
            f"L{n(x + s * .74)} {n(y + s * .3)}Q{n(x + s * .68)} {n(y + s * .78)} {n(x)} {n(y + s)}"
            f"Q{n(x - s * .68)} {n(y + s * .78)} {n(x - s * .74)} {n(y + s * .3)}"
            f"L{n(x - s * .84)} {n(y - s * .6)}Z")

def _check(c, x, y, s, col, sw):
    c.path(f"M{n(x - s * .5)} {n(y)}L{n(x - s * .12)} {n(y + s * .4)}L{n(x + s * .56)} {n(y - s * .42)}",
           stroke=col, sw=sw, stroke_linecap="round", stroke_linejoin="round")

def ic_shield(c, x, y, s, col, sw=1.6):
    c.path(_shield_d(x, y, s), stroke=col, sw=sw, stroke_linejoin="round")
    _check(c, x, y + s * .05, s * .68, col, sw)

def ic_doc(c, x, y, s, col, sw=1.6):
    c.path(f"M{n(x - s * .66)} {n(y - s)}H{n(x + s * .22)}L{n(x + s * .68)} {n(y - s * .52)}"
           f"V{n(y + s)}H{n(x - s * .66)}Z", stroke=col, sw=sw, stroke_linejoin="round")
    c.path(f"M{n(x + s * .22)} {n(y - s)}V{n(y - s * .52)}H{n(x + s * .68)}",
           stroke=col, sw=sw, stroke_linejoin="round")
    for k in (0.18, 0.52):
        c.line(x - s * .38, y + s * k, x + s * .4, y + s * k, col, sw, stroke_linecap="round")

def ic_check_circle(c, x, y, s, col, sw=1.6):
    c.circle(x, y, s, stroke=col, sw=sw)
    _check(c, x, y, s * .82, col, sw + .2)

def ic_list(c, x, y, s, col, sw=1.5):
    for k in (-0.62, 0, 0.62):
        c.circle(x - s * .66, y + s * k, s * .17, stroke=col, sw=sw)
        c.line(x - s * .3, y + s * k, x + s * .72, y + s * k, col, sw, stroke_linecap="round")

def ic_book(c, x, y, s, col, sw=1.5):
    c.path(f"M{n(x)} {n(y - s * .62)}Q{n(x - s * .34)} {n(y - s * .92)} {n(x - s * .84)} {n(y - s * .72)}"
           f"V{n(y + s * .66)}Q{n(x - s * .34)} {n(y + s * .44)} {n(x)} {n(y + s * .78)}",
           stroke=col, sw=sw, stroke_linejoin="round")
    c.path(f"M{n(x)} {n(y - s * .62)}Q{n(x + s * .34)} {n(y - s * .92)} {n(x + s * .84)} {n(y - s * .72)}"
           f"V{n(y + s * .66)}Q{n(x + s * .34)} {n(y + s * .44)} {n(x)} {n(y + s * .78)}",
           stroke=col, sw=sw, stroke_linejoin="round")
    c.line(x, y - s * .62, x, y + s * .78, col, sw)

def ic_sliders(c, x, y, s, col, sw=1.5):
    for k, kx in ((-0.6, 0.34), (0, -0.28), (0.6, 0.5)):
        c.line(x - s * .8, y + s * k, x + s * .8, y + s * k, col, sw, stroke_linecap="round")
        c.circle(x + s * kx, y + s * k, s * .21, fill=PANEL2, stroke=col, sw=sw)

def ic_search_doc(c, x, y, s, col, sw=1.5):
    c.path(f"M{n(x - s * .8)} {n(y - s * .86)}H{n(x + s * .18)}V{n(y + s * .3)}"
           f"H{n(x - s * .8)}Z", stroke=col, sw=sw, stroke_linejoin="round")
    for k in (-0.5, -0.14):
        c.line(x - s * .56, y + s * k, x - s * .04, y + s * k, col, sw, stroke_linecap="round")
    c.circle(x + s * .3, y + s * .34, s * .44, fill="none", stroke=col, sw=sw + .1)
    c.line(x + s * .62, y + s * .66, x + s * .92, y + s * .96, col, sw + .3, stroke_linecap="round")

def ic_terminal(c, x, y, s, col, sw=1.5):
    c.rect(x - s * .92, y - s * .74, s * 1.84, s * 1.48, s * .22,
           fill="none", stroke=col, sw=sw)
    c.path(f"M{n(x - s * .5)} {n(y - s * .26)}L{n(x - s * .16)} {n(y + s * .06)}"
           f"L{n(x - s * .5)} {n(y + s * .38)}", stroke=col, sw=sw,
           stroke_linecap="round", stroke_linejoin="round")
    c.line(x + s * .06, y + s * .38, x + s * .56, y + s * .38, col, sw, stroke_linecap="round")

def ic_dag(c, x, y, s, col, sw=1.5):
    a, b, d = (x - s * .72, y + s * .62), (x, y - s * .74), (x + s * .72, y + s * .62)
    c.line(*a, *b, col, sw); c.line(*b, *d, col, sw)
    for p in (a, b, d):
        c.circle(p[0], p[1], s * .26, fill=PANEL2, stroke=col, sw=sw)

def ic_folder(c, x, y, s, col, sw=1.5):
    c.path(f"M{n(x - s * .88)} {n(y + s * .68)}V{n(y - s * .6)}H{n(x - s * .16)}"
           f"L{n(x + s * .1)} {n(y - s * .3)}H{n(x + s * .88)}V{n(y + s * .68)}Z",
           stroke=col, sw=sw, stroke_linejoin="round")
    c.line(x + s * .18, y + s * .68, x + s * .18, y + s * .06, col, sw)
    c.circle(x + s * .18, y - s * .04, s * .2, fill=PANEL2, stroke=col, sw=sw)

def ic_gauge(c, x, y, s, col, sw=1.5):
    c.circle(x, y, s * .92, stroke=col, sw=sw)
    c.line(x, y, x + s * .5, y - s * .42, col, sw + .2, stroke_linecap="round")
    c.circle(x, y, s * .16, fill=col)
    for a in (-140, -90, -40):
        r = math.radians(a)
        c.line(x + s * .92 * math.cos(r), y + s * .92 * math.sin(r),
               x + s * .68 * math.cos(r), y + s * .68 * math.sin(r), col, sw)

def ic_users(c, x, y, s, col, sw=1.5):
    for dx in (-0.42, 0.42):
        c.circle(x + s * dx, y - s * .4, s * .3, stroke=col, sw=sw)
    c.path(f"M{n(x - s * .92)} {n(y + s * .66)}Q{n(x - s * .42)} {n(y - s * .06)} {n(x + s * .08)} {n(y + s * .66)}",
           stroke=col, sw=sw, stroke_linecap="round")
    c.path(f"M{n(x - s * .08)} {n(y + s * .66)}Q{n(x + s * .42)} {n(y - s * .06)} {n(x + s * .92)} {n(y + s * .66)}",
           stroke=col, sw=sw, stroke_linecap="round")

def ic_play(c, x, y, s, col, sw=1.5):
    c.circle(x, y, s * .92, stroke=col, sw=sw)
    c.path(f"M{n(x - s * .26)} {n(y - s * .42)}L{n(x + s * .42)} {n(y)}"
           f"L{n(x - s * .26)} {n(y + s * .42)}Z", stroke=col, sw=sw, stroke_linejoin="round")

def ic_bbox(c, x, y, s, col, sw=1.5):
    c.rect(x - s * .86, y - s * .74, s * 1.72, s * 1.48, 2, fill="none",
           stroke=col, sw=sw, stroke_dasharray="4 3.5")
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        c.circle(x + sx * s * .86, y + sy * s * .74, s * .17, fill=col)


# ================================================================= build
def build():
    f = L.load_fonts()
    c = L.Canvas(W, H, f)

    c.defs.append(f'''
<linearGradient id="wordGrad" x1="0" y1="0" x2="0.4" y2="1">
<stop offset="0" stop-color="#12A3F0"/><stop offset="55%" stop-color="#0091E1"/>
<stop offset="100%" stop-color="#0079C4"/></linearGradient>
<linearGradient id="ruleGrad" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="{BLUE}"/><stop offset="55%" stop-color="{ICE}" stop-opacity="0.85"/>
<stop offset="100%" stop-color="{AMBER}" stop-opacity="0.55"/></linearGradient>
<linearGradient id="spineGrad" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="{BLUE}"/><stop offset="35%" stop-color="{ICE}"/>
<stop offset="70%" stop-color="{AMBER}"/><stop offset="100%" stop-color="{GREEN}"/></linearGradient>
<linearGradient id="cardGrad" x1="0" y1="0" x2="0.6" y2="1">
<stop offset="0" stop-color="#0C1930"/><stop offset="100%" stop-color="{PANEL}"/></linearGradient>
<linearGradient id="panelGrad" x1="0" y1="0" x2="0.5" y2="1">
<stop offset="0" stop-color="#0A1526"/><stop offset="100%" stop-color="#070E1B"/></linearGradient>
<linearGradient id="topBar" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="{DEEP}"/><stop offset="45%" stop-color="{BLUE}"/>
<stop offset="75%" stop-color="{ICE}"/><stop offset="100%" stop-color="{AMBER}"/></linearGradient>
<radialGradient id="coreGlow" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="{BLUE}" stop-opacity="0.26"/>
<stop offset="45%" stop-color="{BLUE}" stop-opacity="0.08"/>
<stop offset="100%" stop-color="{BLUE}" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
<path d="M32 0H0V32" fill="none" stroke="#7FB2E8" stroke-width="0.7" opacity="0.035"/></pattern>''')

    # ---------------------------------------------------------- backdrop
    c.rect(0, 0, W, H, fill=BG_DEEP)
    c.add('<ellipse cx="836" cy="350" rx="820" ry="330" fill="url(#coreGlow)" opacity="0.5"/>')
    c.rect(0, 0, W, H, fill="url(#grid)")
    c.rect(0, 0, W, 2, fill="url(#topBar)")

    # ============================================================ HEADER
    LOCK_W, LOCK_X, LOCK_TOP = 344, 44, 40
    lock = L.raster(c, os.path.join(ASSETS, "infoapex-logo-lockup.png"),
                    LOCK_X + LOCK_W / 2, LOCK_W, top=LOCK_TOP, max_px=760)
    base_y = LOCK_TOP + lock["h"] * LOCK_BASELINE
    c.text("AI", LOCK_X + LOCK_W + 12, base_y, lock["h"] * LOCK_CAP / POPPINS_CAP,
           "url(#wordGrad)", font="display", limit=540)
    c.text("Control plane local pentru agenți de programare", 48, 152, 17.5, SUB,
           font="reg", limit=540)
    c.rect(48, 168, 382, 2, fill="url(#ruleGrad)")
    sx = 48
    for i, word in enumerate(("Planifică", "Limitează", "Execută", "Verifică")):
        sx += c.text(word, sx, 198, 18, TXT, font="display_semi")
        if i < 3:
            sx += 10
            c.path(f"M{n(sx)} {n(190.5)}L{n(sx + 6.5)} {n(194.5)}L{n(sx)} {n(198.5)}",
                   stroke=BLUE, sw=2.1, stroke_linecap="round", stroke_linejoin="round")
            sx += 16

    principles = [
        (ic_target, "Orchestrare deterministă", "Scope explicit și planuri conduse de politici."),
        (ic_shield, "Execuție guvernată", "Muncă delimitată, bugete și worktree-uri izolate."),
        (ic_doc, "Dovezi la fiecare pas", "Artefacte și urme verificabile, păstrate."),
        (ic_check_circle, "Review independent", "Read-only și fail-closed, înainte de livrare."),
    ]
    for i, (icon, title, desc) in enumerate(principles):
        px = 566 + (i % 2) * 528
        py = 96 + (i // 2) * 62
        icon(c, px + 16, py, 14, BLUE)
        c.text(title, px + 42, py - 3, 15.5, TXT, font="semi", limit=px + 512)
        c.text(desc, px + 42, py + 17, 12.5, DIM, font="reg", limit=px + 512)
    c.line(48, 214, 1624, 214, EDGE, 1, opacity="0.8")

    # ====================================================== FLOW: caption
    c.text("FLUXUL UNEI EXECUȚII", 48, 258, 13.5, BLUE, font="display_semi", tracking=2)
    tw = c.measure("FLUXUL UNEI EXECUȚII", 13.5, "display_semi", 2)
    c.text("· de la obiectiv la cod verificat", 48 + tw + 10, 258, 13, DIM,
           font="reg", limit=470)

    # ------------------------------------------------ replan loop (above)
    LOOP_Y, LP_X, LW_X = 250, 460, 690
    c.path(f"M{LW_X} 300L{LW_X} {LOOP_Y}L{LP_X} {LOOP_Y}L{LP_X} 294",
           stroke=AMBER, sw=1.5, opacity="0.85", stroke_linejoin="round",
           stroke_dasharray="6 5")
    arrow_head(c, LP_X, 300, math.pi / 2, 8, AMBER)
    c.text("replan · dependență nouă sau task incomplet", (LP_X + LW_X) / 2, 242,
           11, AMBER, font="med", anchor="middle", opacity="0.9")

    # ------------------------------------------------------- the spine
    SY, SH = 300, 100
    MID = SY + SH / 2
    c.line(198, MID, 1472, MID, "url(#spineGrad)", 2.5, opacity="0.55")

    def terminal(x, w, icon, label, desc, col):
        c.rect(x, SY, w, SH, 14, fill="url(#cardGrad)", stroke=col, sw=1.6)
        icon(c, x + w / 2, SY + 30, 15, col)
        c.text(label, x + w / 2, SY + 66, 14, TXT, font="display_semi",
               tracking=1.2, anchor="middle")
        c.text(desc, x + w / 2, SY + 85, 10.5, DIM, font="reg", anchor="middle",
               limit=x + w - 6)

    def module(x, w, step, name, role, d1, d2, col):
        card(c, x, SY, w, SH, r=13, accent=col)
        c.circle(x + w - 26, SY + 24, 11, fill="#08131F", stroke=col, sw=1.4)
        c.text(str(step), x + w - 26, SY + 29, 12, col, font="mono_bold", anchor="middle")
        c.text(name, x + 18, SY + 29, 13, col, font="mono_bold", limit=x + w - 44)
        c.text(role, x + 18, SY + 54, 17, TXT, font="semi", limit=x + w - 16)
        c.text(d1, x + 18, SY + 74, 11.5, DIM, font="reg", limit=x + w - 16)
        c.text(d2, x + 18, SY + 90, 11.5, DIM, font="reg", limit=x + w - 16)

    terminal(48, 150, ic_target, "OBIECTIV", "prompt + criterii", ICE)
    module(224, 286, 1, "ai-code-planner", "Descompune și rutează",
           "DAG, scope, criterii de acceptare;", "profil logic per task, nu model fix.", BLUE)
    module(536, 286, 2, "ai-code-worker", "Execută și dovedește",
           "worktree izolat, rezolvă profilul,", "gate-uri, reparare mărginită, commit.", ICE)
    module(848, 286, 3, "ai-code-review", "Verifică independent",
           "read-only și fail-closed; provider", "invocat tot prin worker.", AMBER)
    module(1160, 286, 4, "ai-code-docs", "Documentează",
           "ciclu propriu, gated: planner →", "worker → review, altfel nu trece.", GREEN)
    terminal(1472, 150, ic_check_circle, "ȚINTĂ", "cod verificat + dovezi", GREEN)

    for gx in (198, 510, 822, 1134, 1446):
        arrow(c, gx + 3, MID, gx + 23, MID, ICE, sw=2, head=9)

    # ------------------------------------------- engines, owned by worker
    EX0, EY0, EW, EH = 600, 424, 214, 76
    c.path(f"M707 {SY + SH}L707 {EY0}", stroke=ICE, sw=1.6, stroke_dasharray="5 4")
    arrow_head(c, 707, EY0 - 1, math.pi / 2, 8, ICE)
    arrow_head(c, 707, SY + SH + 1, -math.pi / 2, 8, ICE)
    c.text("invocă", 719, 416, 11, ICE, font="med")
    panel(c, EX0, EY0, EW, EH, r=12)
    c.text("MOTOARE LLM", EX0 + 14, EY0 + 19, 10.5, BLUE, font="display_semi", tracking=1.6)
    for i, (glyph, name, col) in enumerate(((">_", "Codex CLI", BLUE),
                                            ("</>", "Claude Code", AMBER),
                                            ("{ }", "Custom LLM", ICE))):
        ry = EY0 + 36 + i * 16
        c.text(glyph, EX0 + 14, ry, 10.5, col, font="mono_bold")
        c.text(name, EX0 + 46, ry, 11.5, SUB, font="med", limit=EX0 + EW - 8)
    c.text("singurul punct din flux care invocă un model care scrie",
           EX0, 520, 11.5, DIM, font="reg", limit=960)
    c.text("review și docs deleagă tot aici", EX0, 536, 11.5, FAINT,
           font="reg", limit=960)

    # ------------------------ what the two verification stages hand over
    for bx, title, chips in ((866, "VERDICT", (("PASS", GREEN), ("FAIL", AMBER),
                                               ("BLOCKED", "#E06C75"))),
                             (1178, "IEȘIRI", (("raport", ICE), ("dovezi", ICE),
                                               ("commit-uri", ICE)))):
        c.line(bx + 34, SY + SH + 2, bx + 34, 452, EDGE_HI, 1.1,
               stroke_dasharray="4 5", opacity="0.8")
        c.text(title, bx, 470, 10.5, DIM, font="display_semi", tracking=1.6)
        chx = bx
        for label, col in chips:
            cwid = c.measure(label, 11, "mono") + 22
            c.rect(chx, 482, cwid, 24, 12, fill="#0B1626", stroke=col, sw=1,
                   stroke_opacity="0.55")
            c.text(label, chx + 11, 498, 11, col, font="mono")
            chx += cwid + 8

    # ------------------------------------------ ai-code-control, advisory
    for sx2 in (367, 560, 1100, 1425):   # kept clear of the engines and chip blocks
        c.line(sx2, 548, sx2, SY + SH + 2, "#3B5D8C", 1.1,
               stroke_dasharray="4 5", opacity="0.85")
        c.circle(sx2, SY + SH + 2, 2.6, fill="#3B5D8C")

    CY0, CH2 = 550, 96
    panel(c, 48, CY0, 1576, CH2, r=14)
    tw2 = c.text("ai-code-control", 76, CY0 + 28, 13, ICE, font="mono_bold")
    c.text("  ·  advisory și opțional — absența lui nu blochează planner-ul sau worker-ul",
           76 + tw2, CY0 + 28, 12.5, DIM, font="reg", limit=1600)
    ctrl = [(ic_doc, "Memorie Markdown + index SQLite"),
            (ic_dag, "Graf de cod, simboluri, impact"),
            (ic_bbox, "Scope guard pe fișiere modificate"),
            (ic_book, "Proiecție Obsidian, unidirecțională")]
    for i, (icon, label) in enumerate(ctrl):
        cx2 = 76 + i * 390
        icon(c, cx2 + 13, CY0 + 66, 12, BLUE, sw=1.5)
        c.text(label, cx2 + 36, CY0 + 71, 12.5, SUB, font="reg", limit=cx2 + 380)

    # ================================================== capability rail
    RX0, RY0, RW, RH = 48, 662, 1576, 138
    panel(c, RX0, RY0, RW, RH, r=16)
    rail = [
        (ic_bbox, "Scope", "Limite explicite și", "liste de permisiuni.", BLUE),
        (ic_dag, "DAG", "Execuție structurată", "cu dependențe.", BLUE),
        (ic_folder, "Worktree", "Medii izolate și", "reproductibile.", ICE),
        (ic_gauge, "Buget", "Limite de timp,", "tokeni și resurse.", ICE),
        (ic_doc, "Dovezi", "Artefacte, jurnale", "și atestări.", AMBER),
        (ic_users, "Review", "Verificare automată", "și umană.", GREEN),
        (ic_shield, "Audit", "Trasee imuabile și", "jurnale de politici.", GREEN),
        (ic_play, "Reluare", "Pauză, reluare și", "recuperare sigură.", BLUE),
    ]
    cw = RW / 8
    for i, (icon, title, d1, d2, col) in enumerate(rail):
        cx2 = RX0 + cw * (i + 0.5)
        if i:
            c.line(RX0 + cw * i, RY0 + 20, RX0 + cw * i, RY0 + RH - 20, FAINT, 1,
                   stroke_dasharray="4 6", opacity="0.6")
        icon(c, cx2, RY0 + 40, 18, col, sw=1.7)
        c.text(title, cx2, RY0 + 84, 15, TXT, font="semi", anchor="middle")
        c.text(d1, cx2, RY0 + 104, 11.5, DIM, font="reg", anchor="middle",
               limit=cx2 + cw / 2 - 8)
        c.text(d2, cx2, RY0 + 120, 11.5, DIM, font="reg", anchor="middle",
               limit=cx2 + cw / 2 - 8)

    # ============================================================ legend
    LY0, LH2 = 816, 96
    panel(c, 48, LY0, 1576, LH2, r=14)
    c.text("LEGENDĂ · ABREVIERI ȘI TERMENI", 72, LY0 + 26, 12, BLUE,
           font="display_semi", tracking=2.2)
    c.line(340, LY0 + 21, 1600, LY0 + 21, FAINT, 1, opacity="0.5")
    legend = [
        ("AI", "inteligență artificială"),
        ("LLM", "model lingvistic mare"),
        ("DAG", "graf orientat aciclic"),
        ("CLI", "interfață în linie de comandă"),
        ("MCP", "Model Context Protocol"),
        ("scope", "domeniul de fișiere autorizat"),
        ("worktree", "copie de lucru Git izolată"),
        ("gate", "poartă de verificare automată"),
        ("manifest", "lista înghețată a fișierelor permise"),
        ("replan", "reluare a planului după feedback"),
    ]
    for i, (term, desc) in enumerate(legend):
        col_x = 72 + (i % 5) * 312
        row_y = LY0 + 52 + (i // 5) * 26
        tw3 = c.text(term, col_x, row_y, 12.5, ICE, font="mono_bold")
        c.text(f" — {desc}", col_x + tw3, row_y, 12.5, DIM, font="reg",
               limit=min(col_x + 300, 1600))

    return c


if __name__ == "__main__":  # standalone: emit just the SVG next to this file
    import sys
    c = build()
    out = sys.argv[1] if len(sys.argv) > 1 else "splash-architecture.svg"
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(c.render(TITLE))
    print(f"wrote {out}")
    for w in c.warn:
        print("  WARN", w)
    if not c.warn:
        print("  layout OK: no overflow")
