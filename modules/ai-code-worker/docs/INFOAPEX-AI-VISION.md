# infoapex-ai — viziune (decisă 2026-08-15, nu implementată)

Acest document înregistrează o decizie de produs luată de user într-o discuție directă
(nu derivată din cod sau dintr-un alt document), separată de `IMPLEMENTATION-PLAN.md`
al lui `ai-code-worker` (care rămâne autoritatea pentru worker însuși). Nimic din acest
document nu e implementat — e context pentru sesiuni viitoare, în orice repo din
familia asta.

## Ce este infoapex-ai

Un proiect umbrelă care leagă cinci tool-uri independente într-un pipeline coerent de
dezvoltare asistată de AI:

```text
ai-code-architect  →  ai-code-worker  →  ai-code-control  →  ai-code-review  →  ai-code-docs
   (planifică)          (implementează)    (indexează,          (audit)          (documentează)
                                             documentează,
                                             controlează)
```

- **ai-code-architect** — identifică o cerință și produce un plan, împărțit în task-uri.
  Alege ȘI modelul LLM folosit per task (optimizare cost/efort per task, nu un singur
  model pentru tot planul). Folosește el însuși un model LLM avansat pentru a produce
  planul. Proiect nou, independent, gândit temeinic — nu un generator subțire de
  planuri.
- **ai-code-worker** (acest repo) — execută planul. Neschimbat de viziunea asta.
- **ai-code-control** — indexează, documentează și controlează codul (pare deja un
  produs matur — vezi tool-urile MCP disponibile în alte sesiuni: `memory_health`,
  `memory_brief`, `find_symbol`, `impact_analysis`, `refresh_context` etc.).
- **ai-code-review** — audit independent, **la nivelul întregului milestone produs de
  worker, NU per task**. Folosește un model mai performant decât cele folosite per task,
  pentru că trebuie să înțeleagă imaginea globală a proiectului, nu doar task-uri
  individuale izolate.
- **ai-code-docs** — alcătuiește documentația finală a codului implementat.

## Decizii explicite (2026-08-15)

1. **`ai-code-review` e distinct de reviewer-ul independent construit deja în
   `ai-code-worker`** (Task A, 2026-08-15, `src/review/independent-reviewer-cli.ts`).
   Cel din worker rămâne exact cum e: per-task, gates bucla de repair, parte din
   `IMPLEMENTATION-PLAN.md` §9.3 al worker-ului. `ai-code-review` e un tool separat,
   de nivel superior — audit pe tot milestone-ul, cu context global de proiect, nu doar
   diff-ul unui task. Nu se contopesc, nu se înlocuiesc reciproc.
2. **`ai-code-architect` alege modelul LLM per task**, nu doar scrie planul — parte din
   designul lui e optimizarea cost/efort per task (unele task-uri pot merge pe un model
   mai ieftin/rapid, altele au nevoie de unul mai capabil). E independent de worker.
3. **Fiecare componentă a infoapex-ai e un repo Git independent** — `ai-code-worker`,
   `ai-code-control`, `ai-code-architect`, `ai-code-review`, `ai-code-docs`, fiecare cu
   propriul ciclu de release, versionare, teste. `infoapex-ai` însuși e un repo
   subțire: submodule-uri + installer + configurare + meniu CLI interactiv de
   instalare — fără cod de business propriu.
4. **Contractul architect → worker e formatul deja existent al lui worker** —
   `Plan/*.md` cu frontmatter `status: accepted` și blocul JSON `ai-code-worker-plan`
   (schema deja validată de `manifest.schema.json`/`compile.ts`). Architect produce
   exact acest format; worker nu se schimbă deloc pentru asta. Interoperabilitate prin
   fișier, niciodată prin cuplare de cod.
5. **Installer-ul orchestrează, nu duplică** — fiecare tool își păstrează propriul
   `init`/`doctor`/`update` (worker le are deja, vezi Part B/Faza 4 Etapa 4). Installer-ul
   din `infoapex-ai` doar le apelează în ordine și scrie configurările combinate
   (bloc AGENTS.md comun, `.mcp.json` etc.) — nu reimplementează logica niciunui tool.
6. **architect/review/docs se implementează independent, unul câte unul** — nu
   simultan. Ordinea exactă nu e decisă încă.

## Principiu transversal (extins de la worker la toată familia)

`IMPLEMENTATION-PLAN.md` al lui `ai-code-worker` afirmă independența ca principiu de
bază: "El nu este o extensie a ai-code-control și nu îi va referenția proiectele, bazele
de date sau tipurile interne." Acest principiu se extinde la **toate** perechile din
infoapex-ai, nu doar worker↔control: fiecare tool comunică cu celelalte exclusiv prin
CLI JSON și/sau fișiere pe disc (ca `Plan/*.md`), niciodată prin import de cod sau acces
direct la baza de date/starea internă a altui tool. Fiecare tool trebuie să funcționeze
și dacă toate celelalte patru sunt șterse.

## Ce nu e decis încă

- Ordinea de implementare pentru ai-code-architect / ai-code-review / ai-code-docs.
- Dacă `consumer-project-ai-code-worker-integration`
  (`C:\Users\enach\source\consumer-project-ai-code-worker-integration`, deja are
  ai-code-worker + ai-code-control ca submodule-uri, dar fixat pe un commit vechi al
  worker-ului) devine nucleul lui `infoapex-ai`, sau se pornește un repo nou separat.
- Forma exactă a installer-ului/meniului CLI interactiv.
- Task B din `ai-code-worker` (detecție dinamică de versiune Claude/Codex, vezi
  `todo.md` #10) — user a confirmat direcția arhitecturală (fără listă de versiuni
  hardcodată, smoke test comportamental ca gate principal), dar a legat-o explicit de
  installer-ul de la punctul C: cine folosește ce LLM-uri și cum se configurează asta
  probabil printr-un fișier de init-config al installer-ului, nu doar în `ai-code-worker`
  izolat. Implementarea rămâne deschisă până se clarifică forma installer-ului.

## Pasul următor (confirmat de user, 2026-08-15)

**Se revine la finalizarea `ai-code-worker`** — acest document e doar o înregistrare a
contextului mai larg, nu o comandă de a începe `infoapex-ai` acum.
