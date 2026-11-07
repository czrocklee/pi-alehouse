import {
  buildContextEntries,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Opaque history identity. Compared by session object; this cache does not own a session. */
export interface TranscriptHistoryIdentity {
  readonly session: object;
  readonly leaf: string | null;
}
export interface TranscriptMessageSource {
  entries(): readonly unknown[] | undefined;
  historyState?(): TranscriptHistoryIdentity | undefined;
}
export interface TranscriptMessageCache {
  messages(source: TranscriptMessageSource | undefined): readonly unknown[];
}

/** One component's projected messages. A session-identity change drops the WeakMap. */
export function createTranscriptMessageCache(): TranscriptMessageCache {
  let state: TranscriptHistoryIdentity | undefined;
  let cached: readonly unknown[] | undefined;
  let projected = new WeakMap<SessionEntry, readonly unknown[]>();
  return {
    messages(source) {
      if (!source) return [];
      const next = source.historyState?.();
      if (next && state === next && cached) return cached;
      const entries = source.entries();
      if (!entries) return [];
      // Preserve source-entry identity even for summaries/custom messages whose
      // SDK projection creates new objects. A branch change still rebuilds its
      // raw, compaction-aware path; model context edits never hide attempts here.
      if (state?.session !== next?.session) projected = new WeakMap();
      try {
        const messages = buildContextEntries(entries as SessionEntry[], next?.leaf).flatMap(
          (entry) => {
            let row = projected.get(entry);
            if (!row) {
              row = sessionEntryToContextMessages(entry);
              projected.set(entry, row);
            }
            return row;
          },
        );
        state = next;
        cached = messages;
        return messages;
      } catch {
        return [];
      }
    },
  };
}

export interface TranscriptMounts<T extends { dispose(): void }> {
  /** Visit live mounts. Theme refresh does not dispose them. */
  each(visit: (content: T) => void): void;
  /** Dispose mounts whose agent left the roster. */
  dropAbsent(present: ReadonlySet<string>): void;
  /**
   * Live component for this cwd, or undefined after disposing a cwd change so
   * the caller can construct a replacement with a fresh message cache.
   */
  current(id: string, cwd: string): T | undefined;
  /** Record cwd before construction, matching a throw that never mounts. */
  noteCwd(id: string, cwd: string): void;
  remember(id: string, content: T): void;
  /** Dispose each mount in isolation, then drop the table. */
  disposeEach(onError: (error: unknown) => void): void;
}

export function createTranscriptMounts<T extends { dispose(): void }>(): TranscriptMounts<T> {
  const mounted = new Map<string, T>();
  const cwds = new Map<string, string>();
  return {
    each(visit) {
      for (const content of mounted.values()) visit(content);
    },
    dropAbsent(present) {
      for (const [id, content] of mounted) {
        if (present.has(id)) continue;
        content.dispose();
        mounted.delete(id);
        cwds.delete(id);
      }
    },
    current(id, cwd) {
      const content = mounted.get(id);
      if (content && cwds.get(id) !== cwd) {
        content.dispose();
        mounted.delete(id);
        cwds.delete(id);
        return undefined;
      }
      return content;
    },
    noteCwd(id, cwd) {
      cwds.set(id, cwd);
    },
    remember(id, content) {
      mounted.set(id, content);
    },
    disposeEach(onError) {
      for (const content of [...mounted.values()]) {
        try {
          content.dispose();
        } catch (error) {
          onError(error);
        }
      }
      mounted.clear();
      cwds.clear();
    },
  };
}
