/**
 * Management API key lookup. The key itself never leaves the Host process and is
 * never logged; only a one-way fingerprint is used to detect a key change.
 *
 * @module dsh-zenmux-quota/key-source
 */

import { createHash } from 'node:crypto'

/**
 * Read the Management key from an environment variable.
 *
 * The value is re-read on every call so editing `~/.dsh/.env` and restarting
 * the launch environment is enough; nothing is cached here. A value containing
 * anything outside printable ASCII is rejected, which also rules out header
 * injection through a malformed `.env` line.
 *
 * @param env - the environment to read (injectable for tests).
 * @param name - the variable name.
 * @returns the key, or `undefined` when unset, blank, or malformed.
 */
export function readManagementKey(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const key = raw.trim()
  if (key.length === 0 || !/^[\x21-\x7e]+$/u.test(key)) return undefined
  return key
}

/**
 * One-way fingerprint for change detection.
 * @param key - the Management key.
 * @returns eight hex characters of a SHA-256 digest (not a key prefix).
 */
export function fingerprintOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}
