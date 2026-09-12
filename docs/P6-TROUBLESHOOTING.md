# P6 troubleshooting

Răspunsurile CLI sunt JSON și includ un `code` stabil. Nu copia stack trace-uri sau output
de provider într-un ticket; atașează doar codul, `runId`, commitul și hash-ul unui bundle
de diagnostics revizuit.

| Cod | Cauză uzuală | Acțiune sigură |
|---|---|---|
| `RUN_NOT_FOUND` | `resume` nu găsește run-ul | verifică `runId` și folosește `status` al worker-ului |
| `PLAN_NOT_ACCEPTED` | planul nu are `status: accepted` | revizuiește și acceptă planul înainte de execuție |
| `ENGINE_UNAVAILABLE` | motorul cerut nu este disponibil | oprește run-ul și obține autorizarea pentru un motor suportat |
| `PATH_UNSAFE` | cale absolută, traversal sau symlink | folosește o cale repository-relative și verifică părinții |
| `POLICY_INVALID` | policy lipsă sau modificată | reconstruiește profilul full și rulează `preflight` |
| `LEASE_ACTIVE` | există un run concurent | nu șterge lease-ul; așteaptă sau recuperează explicit unul stale |
| `LEASE_INVALID` | lease corupt | păstrează fișierul pentru incident review și oprește execuțiile |
| `UPGRADE_FAILED` | upgrade incomplet | rulează rollback din jurnalul verificat |
| `BACKUP_INVALID` | backup/jurnal inconsistent | nu suprascrie ținta; escaladează cu hash-urile locale |
| `BUNDLE_SIZE_LIMIT` | diagnostics depășește limita | redu evidența locală și exclude output brut |
| `SYMLINK_UNSAFE` | retenția a întâlnit un symlink | investighează și nu folosi `--apply` până la clarificare |

## Incident, restore și rollback

Pentru scope escape, secret leak sau recovery distructiv: oprește execuțiile noi, păstrează
evidence-ul local, notează codul și hash-ul și escaladează către Security + Runtime. Nu
șterge manual `.infoapex-ai/runs`, backup-uri sau lease-uri.

Pentru un rollback de configurație:

```bash
node dist/src/cli.js rollback --repo /cale/catre/proiect --migration config-v1 --dry-run
node dist/src/cli.js rollback --repo /cale/catre/proiect --migration config-v1
```

Pentru un rollback de release, folosește jurnalul upgrade-ului și `--release`; operația
refuză backup-urile invalide sau țintele schimbate. Restore-ul trebuie să fie verificat prin
hash înainte de aplicare.
