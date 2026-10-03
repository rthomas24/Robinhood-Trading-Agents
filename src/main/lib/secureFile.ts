import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../store/json'

/**
 * Encrypt-at-rest via the OS keychain (DPAPI / Keychain / libsecret) with a
 * clearly-marked reversible fallback when no backend exists. The single
 * implementation for every secret file in the app: the encryption AND the
 * file handling, so every store gets the same atomic write. Robinhood and
 * ChatGPT rotate refresh tokens — a write torn by a crash right after a
 * rotation would read back as "no connection" with the old token already spent.
 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptString(plain: string): Buffer {
  return encryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.from(`plain:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8')
}

export function decryptString(buf: Buffer): string {
  if (buf.subarray(0, 6).toString('utf8') === 'plain:') return Buffer.from(buf.subarray(6).toString('utf8'), 'base64').toString('utf8')
  return safeStorage.decryptString(buf)
}

/** `userData/credentials/<name>`: the folder every connection secret lives in, created on first use. */
export function credentialsPath(name: string): string {
  const dir = join(app.getPath('userData'), 'credentials')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

/** A secret file's decrypted contents; null when it is absent or cannot be read. */
export function readSecret(path: string): string | null {
  try {
    return existsSync(path) ? decryptString(readFileSync(path)) : null
  } catch {
    return null
  }
}

/** Encrypt and replace a secret file atomically, or delete it for `null`. */
export function writeSecret(path: string, plain: string | null): void {
  if (plain === null) rmSync(path, { force: true })
  else writeFileAtomic(path, encryptString(plain))
}

/** A secret file holding one JSON value; null when absent, unreadable or not JSON. */
export function readSecretJson<T>(path: string): T | null {
  const raw = readSecret(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function writeSecretJson(path: string, value: unknown): void {
  writeSecret(path, value === null || value === undefined ? null : JSON.stringify(value))
}
