import { realpath } from "node:fs";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { sep } from "node:path";
import { looksLikeDefiniteWindowsPath, normalizePathPreservingCase } from "../utils/path.js";

const nativeRealpath = promisify(realpath.native);
const jsRealpath = promisify(realpath);
const identityIo = pLimit(2);

/** A subscription owns its lexical namespace, including the OS's real-root alias. */
export class GitObservationPaths {
  private constructor(
    private readonly root: string,
    private readonly aliases: string[],
    private readonly windows: boolean,
  ) {}

  static async create(root: string): Promise<GitObservationPaths> {
    const windows = looksLikeDefiniteWindowsPath(root);
    const normalizePath = (value: string) =>
      windows
        ? normalizePathPreservingCase(value, true).replaceAll("\\", "/").toLowerCase()
        : normalizePathPreservingCase(value, false);
    const aliases = new Set([normalizePath(root)]);
    // Sequential: foreign paths must not fan out into the shared libuv pool.
    for (const resolve of [nativeRealpath, jsRealpath]) {
      try {
        aliases.add(normalizePath(await identityIo(() => resolve(root))));
      } catch {
        /* Missing roots retain lexical identity. */
      }
    }
    return new GitObservationPaths(root, [...aliases], windows);
  }

  relative(candidate: string): string | null {
    const normalized = this.normalizeEventPath(candidate);
    const comparable = this.windows ? normalized.toLowerCase() : normalized;
    for (const alias of this.aliases) {
      if (comparable === alias) return "";
      const prefix = alias.endsWith("/") ? alias : `${alias}/`;
      if (comparable.startsWith(prefix)) {
        // Slice the original spelling, preserving case in ref names on Windows.
        return normalized.slice(prefix.length);
      }
    }
    return null;
  }

  // Compile excluded subtrees in every established root namespace. The event callback
  // only compares strings; neither an ignored root nor an event needs another realpath.
  createEventFilter(excludedRoots: Iterable<string>): (candidate: string) => boolean {
    const excluded: string[] = [];
    for (const root of excludedRoots) {
      const relative = this.relative(root);
      if (relative === null) continue;
      for (const alias of this.aliases) {
        const subtree = relative ? `${alias}/${relative}` : alias;
        excluded.push(this.windows ? subtree.toLowerCase() : subtree);
      }
    }
    const prefixes = excluded.map((root) => `${root}/`);
    return (candidate) => {
      const normalized = this.normalizeEventPath(candidate);
      const comparable = this.windows ? normalized.toLowerCase() : normalized;
      if (this.aliases.includes(comparable)) return false;
      for (let i = 0; i < excluded.length; i++) {
        if (comparable === excluded[i] || comparable.startsWith(prefixes[i])) return false;
      }
      return true;
    };
  }

  private normalizeEventPath(candidate: string): string {
    if (this.windows) return normalizePathPreservingCase(candidate, true).replaceAll("\\", "/");
    if (candidate.includes("/.") || candidate.includes("//") || candidate.endsWith("/"))
      return normalizePathPreservingCase(candidate, false);
    return candidate;
  }

  matches = (candidate: string): boolean => this.relative(candidate) === "";

  toWatchPath(candidate: string): string {
    const relative = this.relative(candidate);
    if (relative === null) return candidate;
    return relative ? `${this.root}${sep}${relative}` : this.root;
  }
}
