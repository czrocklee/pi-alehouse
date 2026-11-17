# Pi Alehouse documentation

**First session?** [Build, install and start Alehouse](getting-started.md), then [configure a preset](routing.md#preset-configuration). Without an active preset, new delegation is off.

## Use Alehouse

| I want to…                                                         | Read                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Understand what persists when I reuse, stop or release an Agent    | [Agents, tasks and sessions](orchestration.md)                                   |
| Choose models, thinking effort and delegation mode                 | [Routing and presets](routing.md)                                                |
| Follow a task, steer a worker, answer an approval or inspect usage | [Panel and command guide](interface.md)                                          |
| Know what can access files, the network or credentials             | [Security and data handling](security.md) · [Git permissions](git-read-proof.md) |
| Decide whether this preview supports my workflow                   | [Limits and support](limitations.md)                                             |

## Delegate a task

Start with the [agent tools quickstart](agent-tools-quickstart.md) for worked examples. For exact fields, budgets, pending questions and result paging, use the [tool contract](tool-contract.md). [Task dispatch](task-dispatch.md) explains how to coordinate paths, dependencies and checks; [runtime feedback](runtime-feedback.md) explains what a managed-block alert means.

## Operate and troubleshoot

- **Upgrading an installation:** [reconcile a matched package and resources](development.md#matched-resource-migration) before restarting Pi. `init` is not an updater.
- **Investigating spend or a past Run:** [analyze explicit local journals](session-analysis.md). History cannot resume a worker.
- **Jev cannot write its audit:** follow the [offline recovery procedure](jev-audit-recovery.md); do not remove a lock to make approvals proceed.
- **Declarative installation:** [Build with Nix or configure Home Manager](nix.md).

## Develop and verify

[Architecture](architecture.md) maps each responsibility to its source. [Development](development.md) covers builds, tests and package maintenance. Use [performance](performance.md) for offline benchmarks, and [validation scope](validation-evidence.md) to choose the right check. Consult [third-party integrations](third-party-integrations.md) for upstream dependencies and [README image provenance](assets/README.md) when updating the screenshots.
