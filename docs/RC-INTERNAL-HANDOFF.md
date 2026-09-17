# Handoff: RC v1 intern (trusted-host, fără Docker)

Data: 2026-09-16. Candidat: `1.0.0-rc.1-internal`. Commit calificat: `0ade79ee83cc1549a095a6d3f4f9b372bb8ed9a7`
(branch `docs/rc-hardening-test-optimization-plan`).

Acesta este livrabilul LOCAL-RC-05 din [todo.md](../todo.md): închide scope-ul RC intern
trusted-host cu dovezi verificabile și limitările lui explicite. Nu autorizează
publicare și nu înlocuiește planurile amânate de izolare/optimizare.

## Stare la momentul handoff-ului

| Item | Stare |
|---|---|
| LOCAL-RC-01 (profil trusted-host + acknowledgement) | DONE |
| LOCAL-RC-02 (teste transport/mediu/limite worker) | DONE |
| LOCAL-RC-03 (documentare instalare/limitări) | DONE — [TRUSTED-HOST-RC.md](TRUSTED-HOST-RC.md) |
| LOCAL-RC-04 (audit solo, ZIP/npm smoke, checksum/provenance) | DONE — vezi evidence mai jos |
| LOCAL-RC-05 (acest document) | DONE |

`todo.md` nu marca LOCAL-RC-04 ca bifat la data acestui handoff, deși auditul rulat la
commit-ul curent era deja PASS; a fost corectat odată cu acest document.

## Evidence (LOCAL-RC-04)

Sursă: `dist-release/trusted-host-rc-audit.json`, generat de
`node scripts/solo-release-audit.mjs --candidate v1.0.0-rc.1-internal`.

- `status: PASS`, `code: SOLO_INTERNAL_RC_READY`, `publicationAllowed: false`.
- Toate cele 12 verificări PASS: `package-version`, `tracked-tree-clean`, `npm-test`
  (73,3 s), `trusted-host-regression` (17,8 s), `p6-verify` (27,2 s),
  `upgrade-rollback-tests` (25,0 s), `reproducible-release-zip`, `cyclonedx-sbom`,
  `policy-manifest`, `npm-package-smoke` (36,2 s), `clean-install-smoke` (371,5 s),
  `artifact-metadata`.
- Artefacte produse și verificate (checksum + provenance + SBOM concordante cu
  commit-ul candidatului):
  - `dist-release/infoapex-ai-v1.0.0-rc.1-internal.zip`
    (`sha256: 08a1b158a2d1cafc7f2f9d4c7b766cfd7c4023c0a7ae244b6507a2c6f7d62193`)
  - `dist-release/infoapex-ai-v1.0.0-rc.1-internal.zip.manifest.json`
  - `dist-release/infoapex-ai-v1.0.0-rc.1-internal.cdx.json` (CycloneDX SBOM)
  - `dist-release/infoapex-ai-v1.0.0-rc.1-internal.policy.json` (policy manifest)
- `commit` înregistrat în audit: `0ade79ee83cc1549a095a6d3f4f9b372bb8ed9a7` — identic cu
  HEAD-ul acestui branch la data handoff-ului.

Un rulaj anterior la commit `c3226b6` a produs `BLOCKED`
(`dist-release/trusted-host-rc-audit.c3226b6.blocked.json`); cauza a fost separarea
insuficientă între gate-ul de izolare a checkout-ului și ținta ZIP curată, corectată
prin commit-ul `0ade79e` ("test: distinguish checkout isolation gate from clean ZIP
target"). Nu se reinterpretează acel fișier vechi ca dovadă curentă.

## Limitări cunoscute (neschimbate față de profil)

Din `validation/p6/solo-release-policy.json` (`knownLimitations`):

- Nicio izolare de sistem de fișiere sau rețea la nivel de OS — permisiunile sunt cele
  ale contului local ce rulează providerul.
- Cleanup al arborelui de procese este best-effort, nu garantat.
- SBOM-ul este un inventar de fingerprints de lockfile, nu un inventar tranzitiv complet.
- Nicio calificare nouă de provider live inclusă în acest audit — autentificarea și
  execuția reală LLM rămân autorizate separat.

Detalii complete despre ce protejează/nu protejează profilul: [TRUSTED-HOST-RC.md](TRUSTED-HOST-RC.md#ce-protejează-și-ce-nu-protejează).

## Ce NU e inclus (backlog aprobat, amânat explicit)

- **RC-00 → RC-08** — izolare Docker completă, scor calificat ≥8,5/10:
  [RC-HARDENING-IMPLEMENTATION-PLAN.md](plans/RC-HARDENING-IMPLEMENTATION-PLAN.md).
  0/9 pachete de lucru; estimare 29–46 zile + 25% rezervă (36–58 zile).
- **OPT-00 → OPT-06** — optimizare onboarding/context/cache:
  [POST-RC-OPTIMIZATION-PLAN.md](plans/POST-RC-OPTIMIZATION-PLAN.md). 0/7.
- **Pilot consumator / audit independent** — opționale post-release pentru profilul
  solo-maintainer, nu blochează acest RC intern
  ([P6-SOLO-PROFILE.md](P6-SOLO-PROFILE.md)).
- **Publicare publică (`v1.0.0` stabil)** — decizie separată a maintainerului, cu
  `validation/p6/solo-go-no-go.json` completat și `public-release-preflight.mjs` PASS.
  Acest audit nu tag-uiește, nu face push, nu publică — `publicationAllowed: false`
  este explicit în rezultat.

## Ce poate face oricine preia acest RC

- Instalare/activare pentru un proiect țintă de încredere: pași exacți în
  [TRUSTED-HOST-RC.md](TRUSTED-HOST-RC.md#activare).
- Rerulare audit după orice commit nou pe acest branch:
  `node scripts/solo-release-audit.mjs --candidate v1.0.0-rc.1-internal --out dist-release/trusted-host-rc-audit.json`.
  Un `BLOCKED` nou nu se rezolvă prin repetare fără corecție — vezi precedentul de la
  `c3226b6` de mai sus.
- Pentru a merge spre calificarea completă (izolare Docker, scor ≥8,5/10): pornește de
  la RC-00 din planul de hardening; acesta e aprobat dar neînceput.
