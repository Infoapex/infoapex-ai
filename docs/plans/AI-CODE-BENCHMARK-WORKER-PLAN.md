---
status: accepted
---

# Implement, validate, integrate, and baseline the independent ai-code-benchmark module as Infoapex P4.5 before continuing P5.

```ai-code-worker-plan
{
  "workerContractVersion": "1.1",
  "goal": "Implement, validate, integrate, and baseline the independent ai-code-benchmark module as Infoapex P4.5 before continuing P5.",
  "tasks": [
    {
      "id": "BENCH-00",
      "kind": "other",
      "role": "Freeze architecture, threat model, experimental protocol, and feasibility of all benchmark arms.",
      "dependsOn": [],
      "requiredInputs": [
        "docs/plans/AI-CODE-BENCHMARK-IMPLEMENTATION-PLAN.md"
      ],
      "allowedPaths": [
        "docs/**",
        "validation/benchmark/**"
      ],
      "forbiddenPaths": [
        "modules/ai-code-control/**"
      ],
      "expectedArtifacts": [],
      "acceptanceCriteria": [
        "ADR, threat model, preregistration rules, and arm feasibility decision are versioned."
      ],
      "verify": [
        "npm run docs-gate:internal"
      ],
      "concurrencyKeys": [
        "docs/**",
        "validation/benchmark/**"
      ],
      "risk": "high",
      "executionProfile": "sol-high",
      "traceability": {
        "acceptanceCriteria": [
          {
            "criterionId": "AC-00",
            "text": "ADR, threat model, preregistration rules, and arm feasibility decision are versioned."
          }
        ],
        "gates": [
          {
            "gateId": "G-00",
            "command": "npm run docs-gate:internal",
            "evidenceContract": "Documentation gate exits successfully.",
            "criterionIds": [
              "AC-00"
            ]
          }
        ]
      }
    },
    {
      "id": "BENCH-01-03",
      "kind": "contract",
      "role": "Create the standalone package, versioned contracts, dataset loader, and subprocess arm adapters.",
      "dependsOn": [
        "BENCH-00"
      ],
      "requiredInputs": [
        "docs/plans/AI-CODE-BENCHMARK-IMPLEMENTATION-PLAN.md"
      ],
      "allowedPaths": [
        "modules/ai-code-benchmark/**"
      ],
      "forbiddenPaths": [
        "modules/ai-code-control/**",
        "modules/ai-code-worker/**"
      ],
      "expectedArtifacts": [],
      "acceptanceCriteria": [
        "The package builds and contract, dataset, and adapter tests pass."
      ],
      "verify": [
        "npm test --prefix modules/ai-code-benchmark"
      ],
      "concurrencyKeys": [
        "modules/ai-code-benchmark/**"
      ],
      "risk": "high",
      "executionProfile": "terra-high",
      "traceability": {
        "acceptanceCriteria": [
          {
            "criterionId": "AC-01-03",
            "text": "The package builds and contract, dataset, and adapter tests pass."
          }
        ],
        "gates": [
          {
            "gateId": "G-01-03",
            "command": "npm test --prefix modules/ai-code-benchmark",
            "evidenceContract": "Package tests exit successfully.",
            "criterionIds": [
              "AC-01-03"
            ]
          }
        ]
      }
    },
    {
      "id": "BENCH-04-07",
      "kind": "other",
      "role": "Implement isolated scheduling, recovery, metrics, independent evaluation, statistics, and reports.",
      "dependsOn": [
        "BENCH-01-03"
      ],
      "requiredInputs": [
        "modules/ai-code-benchmark/schemas/experiment.schema.json"
      ],
      "allowedPaths": [
        "modules/ai-code-benchmark/**"
      ],
      "forbiddenPaths": [
        "modules/ai-code-control/**"
      ],
      "expectedArtifacts": [],
      "acceptanceCriteria": [
        "Runtime and analysis are deterministic, resumable, and covered by failure-path tests."
      ],
      "verify": [
        "npm test --prefix modules/ai-code-benchmark"
      ],
      "concurrencyKeys": [
        "modules/ai-code-benchmark/**"
      ],
      "risk": "high",
      "executionProfile": "sol-high",
      "traceability": {
        "acceptanceCriteria": [
          {
            "criterionId": "AC-04-07",
            "text": "Runtime and analysis are deterministic, resumable, and covered by failure-path tests."
          }
        ],
        "gates": [
          {
            "gateId": "G-04-07",
            "command": "npm test --prefix modules/ai-code-benchmark",
            "evidenceContract": "All package tests exit successfully.",
            "criterionIds": [
              "AC-04-07"
            ]
          }
        ]
      }
    },
    {
      "id": "BENCH-08",
      "kind": "frontend",
      "role": "Build and execute the hermetic deterministic benchmark harness.",
      "dependsOn": [
        "BENCH-04-07"
      ],
      "requiredInputs": [
        "modules/ai-code-benchmark/README.md"
      ],
      "allowedPaths": [
        "modules/ai-code-benchmark/**",
        "validation/benchmark/**"
      ],
      "forbiddenPaths": [
        "modules/ai-code-control/**"
      ],
      "expectedArtifacts": [],
      "acceptanceCriteria": [
        "The deterministic three-arm suite passes with reproducible artifacts and expected score ordering."
      ],
      "verify": [
        "npm run benchmark:deterministic --prefix modules/ai-code-benchmark"
      ],
      "concurrencyKeys": [
        "modules/ai-code-benchmark/**",
        "validation/benchmark/**"
      ],
      "risk": "medium",
      "executionProfile": "terra-high",
      "traceability": {
        "acceptanceCriteria": [
          {
            "criterionId": "AC-08",
            "text": "The deterministic three-arm suite passes with reproducible artifacts and expected score ordering."
          }
        ],
        "gates": [
          {
            "gateId": "G-08",
            "command": "npm run benchmark:deterministic --prefix modules/ai-code-benchmark",
            "evidenceContract": "Harness exits successfully and writes a verified report.",
            "criterionIds": [
              "AC-08"
            ]
          }
        ]
      }
    },
    {
      "id": "BENCH-09",
      "kind": "other",
      "role": "Run a preregistered bounded live pilot and publish an explicitly non-authoritative verdict.",
      "dependsOn": [
        "BENCH-08"
      ],
      "requiredInputs": [
        "validation/benchmark/pilot-preregistration.json"
      ],
      "allowedPaths": [
        "modules/ai-code-benchmark/**",
        "validation/benchmark/**"
      ],
      "forbiddenPaths": [
        "modules/ai-code-control/**"
      ],
      "expectedArtifacts": [],
      "acceptanceCriteria": [
        "Pilot preflight, raw observations, report, limitations, and verdict are preserved."
      ],
      "verify": [
        "npm run benchmark:pilot:verify --prefix modules/ai-code-benchmark"
      ],
      "concurrencyKeys": [
        "modules/ai-code-benchmark/**",
        "validation/benchmark/**"
      ],
      "risk": "high",
      "executionProfile": "sol-high",
      "traceability": {
        "acceptanceCriteria": [
          {
            "criterionId": "AC-09",
            "text": "Pilot preflight, raw observations, report, limitations, and verdict are preserved."
          }
        ],
        "gates": [
          {
            "gateId": "G-09",
            "command": "npm run benchmark:pilot:verify --prefix modules/ai-code-benchmark",
            "evidenceContract": "Pilot evidence verifier exits successfully.",
            "criterionIds": [
              "AC-09"
            ]
          }
        ]
      }
    },
    {
      "id": "BENCH-10",
      "kind": "other",
      "role": "Integrate the pinned module into the bundle, update release gates and roadmap, and publish the P5 baseline.",
      "dependsOn": [
        "BENCH-09"
      ],
      "requiredInputs": [
        "validation/benchmark/IMPLEMENTATION-REPORT.md"
      ],
      "allowedPaths": [
        "**"
      ],
      "forbiddenPaths": [],
      "expectedArtifacts": [],
      "acceptanceCriteria": [
        "Bundle, provenance, documentation, release smoke, and P4.5 gates pass."
      ],
      "verify": [
        "npm test"
      ],
      "concurrencyKeys": [
        "**"
      ],
      "risk": "high",
      "executionProfile": "terra-high",
      "traceability": {
        "acceptanceCriteria": [
          {
            "criterionId": "AC-10",
            "text": "Bundle, provenance, documentation, release smoke, and P4.5 gates pass."
          }
        ],
        "gates": [
          {
            "gateId": "G-10",
            "command": "npm test",
            "evidenceContract": "Root test and bundle gates exit successfully.",
            "criterionIds": [
              "AC-10"
            ]
          }
        ]
      }
    }
  ],
  "globalGates": [],
  "budgets": {
    "maximumParallelWriters": 1,
    "maximumRepairCycles": 2,
    "maximumTaskMinutes": 90,
    "maximumRunMinutes": 300,
    "maximumAgentInvocations": 4,
    "maximumRunInputUncachedTokens": 200000,
    "maximumRunCacheReadTokens": 200000,
    "maximumRunCacheWriteTokens": 200000,
    "maximumRunOutputTokens": 50000,
    "maximumRunCostUsd": 2,
    "onUnknownUsage": "warn"
  }
}
```
