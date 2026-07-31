/**
 * Tiny cross-extension signal for "the git branch just changed".
 *
 * Extensions that switch branches (e.g. the gh-stack picker) emit this so
 * status-bar extensions (PR status, issue status, stack status) can refresh
 * immediately instead of waiting for their next poll interval.
 *
 * State lives on globalThis so it is shared even if extensions are loaded as
 * separate module instances. This file is not auto-discovered as an extension
 * (the package glob only matches ./extensions/*.ts).
 */

type Listener = () => void;

const KEY = "__pi_branch_change_signal__";

function listeners(): Set<Listener> {
	const g = globalThis as Record<string, unknown> & { [KEY]?: Set<Listener> };
	if (!g[KEY]) g[KEY] = new Set<Listener>();
	return g[KEY];
}

/** Subscribe to branch-change notifications. Returns an unsubscribe function. */
export function onBranchChange(listener: Listener): () => void {
	listeners().add(listener);
	return () => listeners().delete(listener);
}

/** Notify all subscribers that the current git branch changed. */
export function emitBranchChange(): void {
	for (const listener of [...listeners()]) {
		try {
			listener();
		} catch {
			// Subscribers must not break the emitter
		}
	}
}
