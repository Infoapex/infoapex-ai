# Assets

| Fișier | Dimensiune | Utilizare |
|---|---|---|
| `infoapex-ai-splash-architecture.svg` | 1672 × 941 | infografic principal |
| `infoapex-ai-splash-architecture.png` | 1672 × 941 | hero-ul din README |
| `infoapex-logo.png` / `.svg` | 327 × 271, RGBA | marca InfoApex, fundal transparent |
| `infoapex-logo-lockup.png` / `.svg` | 1144 × 281, RGBA | marca + wordmark, transparent |
| `src/` | — | randările sursă ale logo-ului, înainte de cheiere |

PNG-ul infograficului este sub limita de 1 MB a GitHub, deci poate fi folosit și
ca social preview al repository-ului.

## Regenerare

```bash
npm run generate:splash          # sau: python scripts/splash/build.py
```

Sursa este [`scripts/splash/`](../../scripts/splash/). Unealta este **doar
design-time** — nimic din bundle-ul livrat nu depinde de ea. Cere Python 3.10+
cu `fonttools`, `Pillow` și `numpy`, plus Chrome sau Edge pentru rasterizare.
Fonturile se descarcă o singură dată în `scripts/splash/fonts/`, director
ignorat de Git.

Pipeline-ul rulează în ordine: cheiere logo → infografic (care încorporează
rezultatul) → rasterizare.

## Marca InfoApex — raster cheiat, nu reconstrucție

Marca este randarea originală de tip *light painting*. Sursele stau în
[`src/`](src/) și sunt procesate de
[`scripts/splash/raster_logo.py`](../../scripts/splash/raster_logo.py).

Logo-ul vine pictat cu lumină pe o placă închisă. Tăierea dură a pixelilor
întunecați nu funcționează: glow-ul se stinge *în* fundal, deci un prag lasă
halou pe margine. Placa este citită ca sursă aditivă:

```text
lit   = sursă − placă            ce a adăugat efectiv lumina
alpha = max_canal(lit) · gain    cât de multă lumină e acolo
rgb   = lit / alpha              unpremultiply
```

Compus cu „over" normal peste orice fundal, rezultatul reproduce exact ce ar fi
dat blending-ul aditiv, deci marca se topește în fundal fără plăcuță vizibilă.

Două detalii contează:

- **alpha urmează canalul cel mai puternic, nu luminanța.** Marca e albastră,
  iar albastrul are doar `0.0722` din luma — un alpha pe luminanță ar fi mult
  mai mic decât albastrul pe care trebuie să-l poarte, `lit/alpha` ar depăși 1
  și s-ar clipa. Max-canal garantează `lit/alpha ≤ 1`, deci unpremultiply-ul e
  exact: eroarea de reconstrucție scade de la ~72/255 la ~1/255, adică doar
  cuantizare.
- **placa nu e plată** — are vinietă. `--plate fit` ajustează o suprafață
  polinomială pe pixelii cei mai închiși și o modelează, în loc să scadă o
  constantă care ar lăsa gradientul în alpha ca pâclă.

Culoarea lui „AI" din header este eșantionată din „Apex" al randării
(`#0091E1`), iar corpul de literă și linia de bază sunt aliniate la metricile
măsurate pe asset (`LOCK_BASELINE`, `LOCK_CAP` în `splash_architecture.py`),
nu potrivite din ochi.

Marca e proiectată pentru fundal închis. Pe alb rămâne lizibilă, dar palidă —
pentru tipar pe fond deschis ar trebui o variantă cu contrast inversat, care nu
există încă.

### Consecință asupra formatului

Infograficul conține două elemente `<image>` cu PNG încorporat base64, iar
SVG-urile de logo sunt învelișuri peste raster. Asta **încalcă cerința „true
vector, no embedded raster"** din specul original: zona logo-ului nu mai e
infinit scalabilă, iar SVG-ul a crescut de la 864 KB la 1258 KB. E o alegere
deliberată — randarea light-painted nu poate fi reprodusă parametric cu
fidelitate. Restul infograficului rămâne vector integral.

## Fluxul reprezentat

Diagrama urmează un singur traseu continuu, `OBIECTIV → planner → worker →
review → docs → ȚINTĂ`, verificat față de `docs/ARCHITECTURE.md` și README-urile
modulelor. Trei lucruri sunt desenate deliberat așa:

- **Motoarele atârnă doar de worker.** `ai-code-worker` este singurul component
  care poate invoca un provider care scrie; `ai-code-review` și `ai-code-docs`
  deleagă acolo. Centralizarea asta e chiar teza de guvernanță — un singur
  punct unde se aplică scope, bugete, gate-uri și dovezi.
- **Planner-ul rutează logic, nu alege modelul.** Emite profile de tip
  `mechanical-fast-v1` / `balanced-default-v1`; worker-ul le rezolvă în
  motor/model concret din politica locală de rutare și le îngheață în manifest.
  Planul rămâne portabil și neutru față de provider.
- **`ai-code-control` este advisory și opțional**, desenat ca bandă sub flux cu
  legături punctate: absența lui reduce contextul, nu blochează execuția.

Bucla `replan` merge de la worker înapoi la planner și este opt-in
(`--mode integrated`), pe fișiere. Nu există buclă automată de reparare pornită
din review: providerul de review e read-only și nu primește niciodată capacitate
de reparare.

## Restul infograficului

Textul este convertit în contururi (`<path>`), deci nu există `<text>`,
`font-family` sau dependență de fonturi instalate la vizualizare. Nu există
`<filter>`; glow-ul vectorial vine din straturi de contur suprapuse. Nicio
referință externă — toate `url(#…)` și `href="#…"` se rezolvă local.

Verificat: Chromium vs. Edge → **zero pixeli diferiți**, iar PNG-ul livrat este
identic pixel cu pixel cu randarea SVG-ului.

Generatorul măsoară fiecare șir de text și eșuează build-ul dacă depășește
regiunea alocată, deci textele tăiate sau suprapuse sunt prinse automat.

## Licență fonturi

Contururile de text provin din **Poppins**, **Inter** și **JetBrains Mono**,
toate sub SIL Open Font License 1.1, care permite încorporarea în documente. În
assets sunt încorporate doar contururi vectoriale, nu fișiere de font.
