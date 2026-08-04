# Tony's Pi Config

Personal extensions and configuration for [Pi](https://github.com/badlogic/pi-mono).

## Install

From a local checkout:

```bash
pi install ~/repos/pi-config
```

From GitHub over SSH:

```bash
pi install git:git@github.com:YOUR_USERNAME/pi-config
```

Reload Pi after changing an extension:

```text
/reload
```

Update a GitHub-installed copy:

```bash
pi update --extensions
```

## Extensions

- `council.ts` — `/council <models...>` enables a persistent council of randomly named, independently opinionated model advisers. While enabled, each prompt is sent to every elder in a randomized sequential order using read-only repository tools. Use `/council` to toggle, `/council off`, or `/council status`.
- `github-pr-status.ts` — shows the pull request associated with the current Git branch in Pi's footer.
- `issue-pickup.ts` — `/pickup [filter]` finds assigned issues in the current GitHub repository, optionally creates a `<github-login>/issue/...` branch from a fuzzy-searchable base, loads the issue into the session context, and restores or infers the active issue status from the branch and its PR.
- `native-web-search.ts` — enables provider-hosted web search on every request for OpenAI Responses, OpenAI Codex, OpenAI Chat Completions, and Anthropic Messages models. Unsupported models surface their provider API error normally.

### Council examples

```text
/council fable sol opus-4-5
/council status
/council off
/council          # re-enable the configured elders
```

Model arguments are fuzzy-matched against authenticated models. While deliberating, a live widget above the editor shows per-elder progress (✓ done, spinner active, ○ pending, ✗ failed) with elapsed times and per-elder token/cost usage (plus a running round total), and the status bar shows the active elder and round progress, ending with a brief `adjourned` state. Messages sent mid-round are queued and put to the council as a follow-up round when the current one finishes; `/council off` stops an in-flight deliberation and clears the queue. The speaking order is reshuffled for every prompt. The first elder gets an unbiased first pass; each later elder also sees the earlier contributions from that round and is instructed to engage, refine, or challenge them rather than merely agree. This creates a bounded single-pass debate without paying for a separate rebuttal round. After the elders finish, an implicit **Council Chair** — your current session model, run in-process — synthesizes the round into a short brief (verdict, consensus, disputes with tie-break rulings, and pointers to which elders are worth reading in full); the chair is skipped when fewer than two elders respond. Council subprocesses can inspect the project with `read`, `grep`, `find`, and `ls`, plus a gated `bash` tool (`extensions/council/bash-gate.ts`) that allows read-only `gh` subcommands (`issue view`, `pr diff`, `api` GET, `search`, …), read-only `git` subcommands, and pipe filters like `jq`/`head` — while blocking mutating commands, write flags, and shell control operators. Elders cannot edit files or run arbitrary shell commands.
