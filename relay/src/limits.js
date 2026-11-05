// Login limits, kept in memory. A successful sign-in clears both its IP/account pair and
// the account-wide counter, so a person who mistyped a password is not punished twice.
const WINDOW_MS = 15 * 60_000
const IP_ATTEMPTS = 10
const PAIR_FAILURES = 5
const ACCOUNT_FAILURES = 50
const MAX_ENTRIES = 10_000

const keyOf = (ip, username) => `${ip}\u0000${String(username).toLowerCase()}`

export class LoginLimiter {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.entries = new Map()
    this.cleanup = setInterval(() => this.prune(), 60_000)
    this.cleanup.unref?.()
  }

  prune() {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.resetAt < now && (entry.lockedUntil ?? 0) < now) this.entries.delete(key)
    }
    while (this.entries.size > MAX_ENTRIES) {
      // Prefer the oldest unlocked entry; a lock must keep protecting the account.
      let victim
      for (const [key, entry] of this.entries) {
        if ((entry.lockedUntil ?? 0) > now) continue
        if (victim === undefined || entry.updatedAt < victim.entry.updatedAt) victim = { key, entry }
      }
      if (victim === undefined) break
      this.entries.delete(victim.key)
    }
  }

  entry(key, window = WINDOW_MS) {
    const now = this.now()
    let entry = this.entries.get(key)
    if (entry === undefined || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + window, lockedUntil: 0, updatedAt: now }
      this.entries.set(key, entry)
    }
    return entry
  }

  check(ip, username) {
    const now = this.now()
    const pair = this.entries.get(keyOf(ip, username))
    const account = this.entries.get(`account\u0000${String(username).toLowerCase()}`)
    const ipEntry = this.entries.get(`ip\u0000${ip}`)
    const lockedUntil = Math.max(pair?.lockedUntil ?? 0, account?.lockedUntil ?? 0)
    if (lockedUntil > now) return { allowed: false, retryAfterSec: Math.ceil((lockedUntil - now) / 1000) }
    if ((ipEntry?.count ?? 0) >= IP_ATTEMPTS) return { allowed: false, retryAfterSec: Math.ceil((ipEntry.resetAt - now) / 1000) }
    return { allowed: true, retryAfterSec: 0 }
  }

  failure(ip, username) {
    const now = this.now()
    const pair = this.entry(keyOf(ip, username))
    pair.count += 1
    pair.updatedAt = now
    if (pair.count >= PAIR_FAILURES) pair.lockedUntil = now + WINDOW_MS
    const ipEntry = this.entry(`ip\u0000${ip}`)
    ipEntry.count += 1
    ipEntry.updatedAt = now
    const account = this.entry(`account\u0000${String(username).toLowerCase()}`)
    account.count += 1
    account.updatedAt = now
    if (account.count >= ACCOUNT_FAILURES) account.lockedUntil = now + WINDOW_MS
  }

  success(ip, username) {
    this.entries.delete(keyOf(ip, username))
    this.entries.delete(`account\u0000${String(username).toLowerCase()}`)
  }

  stop() {
    clearInterval(this.cleanup)
  }
}
