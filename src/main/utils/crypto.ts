import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto'
import { getDeviceId } from '../subscription/device-id'

const ALGO = 'aes-256-gcm'
const SALT = 'inkess-ccp-v1' // static salt — key uniqueness comes from deviceId

/** Derive a stable AES-256 key from device fingerprint */
function deriveKey(): Buffer {
  return pbkdf2Sync(getDeviceId(), SALT, 100_000, 32, 'sha256')
}

/** Encrypt plaintext → base64 string (iv + tag + ciphertext) */
export function encrypt(plaintext: string): string {
  const key = deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv(12) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/** Decrypt base64 string → plaintext. Returns null on failure. */
export function decrypt(encoded: string): string | null {
  try {
    const key = deriveKey()
    const buf = Buffer.from(encoded, 'base64')
    if (buf.length < 28) return null // iv(12) + tag(16) minimum
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const ciphertext = buf.subarray(28)
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf-8')
  } catch {
    return null
  }
}
