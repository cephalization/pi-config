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

- `github-pr-status.ts` — shows the pull request associated with the current Git branch in Pi's footer.
