import { test, expect, beforeEach } from "bun:test";
import { validatePassword } from "./passwords";
import { issueSession, validateSession } from "./sessions";
import { signup, login, resetAccounts } from "./accounts";

beforeEach(() => {
  resetAccounts();
});

// ============================================================================
// PASSWORD VALIDATION TESTS (5 test cases)
// ============================================================================

test("password: rejects empty string", () => {
  const result = validatePassword("");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toContain("MIN_LENGTH");
  }
});

test("password: rejects too short (< 10 chars)", () => {
  const result = validatePassword("Short1!a");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toContain("MIN_LENGTH");
  }
});

test("password: rejects missing uppercase", () => {
  const result = validatePassword("password123!");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toContain("NEEDS_UPPER");
  }
});

test("password: rejects missing lowercase", () => {
  const result = validatePassword("PASSWORD123!");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toContain("NEEDS_LOWER");
  }
});

test("password: rejects missing digit", () => {
  const result = validatePassword("Password!abc");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toContain("NEEDS_DIGIT");
  }
});

test("password: rejects missing symbol", () => {
  const result = validatePassword("Password1abc");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toContain("NEEDS_SYMBOL");
  }
});

test("password: accepts valid password", () => {
  const result = validatePassword("ValidPass123!");
  expect(result.ok).toBe(true);
});

test("password: accepts valid with multiple symbols", () => {
  const result = validatePassword("Complex@Pass#2024");
  expect(result.ok).toBe(true);
});

// ============================================================================
// SESSION TOKEN TESTS (8 test cases)
// ============================================================================

test("session: issues token with expiry", () => {
  const now = 1000;
  const ttl = 60000;
  const { token, expiry } = issueSession("user123", now, ttl);
  expect(typeof token).toBe("string");
  expect(token.length).toBeGreaterThan(0);
  expect(expiry).toBe(now + ttl);
});

test("session: validates token before expiry", () => {
  const now = 1000;
  const ttl = 60000;
  const { token, expiry } = issueSession("user123", now, ttl);
  const valid = validateSession(token, expiry - 1);
  expect(valid).toBe(true);
});

test("session: validates token at exactly now", () => {
  const now = 1000;
  const ttl = 60000;
  const { token, expiry } = issueSession("user123", now, ttl);
  const valid = validateSession(token, now);
  expect(valid).toBe(true);
});

test("session: rejects token at exactly expiry", () => {
  const now = 1000;
  const ttl = 60000;
  const { token, expiry } = issueSession("user123", now, ttl);
  const valid = validateSession(token, expiry);
  expect(valid).toBe(false);
});

test("session: rejects token after expiry", () => {
  const now = 1000;
  const ttl = 60000;
  const { token, expiry } = issueSession("user123", now, ttl);
  const valid = validateSession(token, expiry + 1);
  expect(valid).toBe(false);
});

test("session: rejects invalid token", () => {
  const now = 1000;
  const valid = validateSession("invalid.token.here", now);
  expect(valid).toBe(false);
});

test("session: tokens are deterministic (same inputs = same token)", () => {
  const now = 5000;
  const ttl = 3600000;
  const token1 = issueSession("alice", now, ttl).token;
  const token2 = issueSession("alice", now, ttl).token;
  expect(token1).toBe(token2);
});

test("session: different users produce different tokens", () => {
  const now = 5000;
  const ttl = 3600000;
  const token1 = issueSession("alice", now, ttl).token;
  const token2 = issueSession("bob", now, ttl).token;
  expect(token1).not.toBe(token2);
});

// ============================================================================
// ACCOUNT LOCKOUT TESTS (8 test cases)
// ============================================================================

test("account: signup creates account", () => {
  const now = 10000;
  const result = signup("user@example.com", "ValidPass123!", now);
  expect(result.ok).toBe(true);
});

test("account: signup rejects invalid password", () => {
  const now = 10000;
  const result = signup("user@example.com", "weak", now);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toContain("NEEDS_UPPER");
  }
});

test("account: signup rejects duplicate email", () => {
  const now = 10000;
  const signup1 = signup("user@example.com", "ValidPass123!", now);
  const signup2 = signup("user@example.com", "ValidPass456!", now);
  expect(signup1.ok).toBe(true);
  expect(signup2.ok).toBe(false);
});

test("account: login succeeds with correct password", () => {
  const now = 10000;
  signup("alice@test.com", "ValidPass123!", now);
  const result = login("alice@test.com", "ValidPass123!", now);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.token).toBeDefined();
    expect(result.expiry).toBeDefined();
  }
});

test("account: login rejects wrong password", () => {
  const now = 10000;
  signup("bob@test.com", "ValidPass123!", now);
  const result = login("bob@test.com", "WrongPass456!", now);
  expect(result.ok).toBe(false);
});

test("account: login locks after 5 consecutive failed attempts", () => {
  const now = 20000;
  signup("charlie@test.com", "ValidPass123!", now);
  for (let i = 0; i < 5; i++) {
    login("charlie@test.com", "WrongPass456!", now);
  }
  const lockedResult = login("charlie@test.com", "ValidPass123!", now);
  expect(lockedResult.ok).toBe(false);
});

test("account: login succeeds on 4 fails then correct password", () => {
  const now = 30000;
  signup("dave@test.com", "ValidPass123!", now);
  for (let i = 0; i < 4; i++) {
    login("dave@test.com", "WrongPass456!", now);
  }
  const successResult = login("dave@test.com", "ValidPass123!", now);
  expect(successResult.ok).toBe(true);
  if (successResult.ok) {
    expect(successResult.token).toBeDefined();
  }
});

test("account: correct password during lockout window rejected", () => {
  const now = 40000;
  signup("eve@test.com", "ValidPass123!", now);
  for (let i = 0; i < 5; i++) {
    login("eve@test.com", "WrongPass456!", now);
  }
  const duringWindowResult = login("eve@test.com", "ValidPass123!", now + 100);
  expect(duringWindowResult.ok).toBe(false);
});

test("account: lockout unlocks after window expires (15 min)", () => {
  const now = 50000;
  const lockoutWindow = 15 * 60 * 1000;
  signup("frank@test.com", "ValidPass123!", now);
  for (let i = 0; i < 5; i++) {
    login("frank@test.com", "WrongPass456!", now);
  }
  const afterWindowResult = login(
    "frank@test.com",
    "ValidPass123!",
    now + lockoutWindow + 1
  );
  expect(afterWindowResult.ok).toBe(true);
});

test("account: successful login resets fail counter", () => {
  const now = 60000;
  signup("grace@test.com", "ValidPass123!", now);
  login("grace@test.com", "WrongPass456!", now);
  login("grace@test.com", "WrongPass456!", now + 100);
  const successResult = login("grace@test.com", "ValidPass123!", now + 200);
  expect(successResult.ok).toBe(true);
  for (let i = 0; i < 4; i++) {
    login("grace@test.com", "WrongPass456!", now + 300 + i * 100);
  }
  const stillNotLockedResult = login(
    "grace@test.com",
    "ValidPass123!",
    now + 700
  );
  expect(stillNotLockedResult.ok).toBe(true);
});

// ============================================================================
// INTEGRATION TESTS (4 test cases)
// ============================================================================

test("integration: signup then login produces valid session", () => {
  const now = 70000;
  signup("helen@test.com", "SecurePass123!", now);
  const loginResult = login("helen@test.com", "SecurePass123!", now);
  expect(loginResult.ok).toBe(true);
  if (loginResult.ok) {
    const sessionValid = validateSession(loginResult.token, now);
    expect(sessionValid).toBe(true);
  }
});

test("integration: session expires independent of login", () => {
  const now = 80000;
  signup("ivan@test.com", "SecurePass123!", now);
  const loginResult = login("ivan@test.com", "SecurePass123!", now);
  expect(loginResult.ok).toBe(true);
  if (loginResult.ok) {
    const sessionInvalid = validateSession(
      loginResult.token,
      loginResult.expiry + 1
    );
    expect(sessionInvalid).toBe(false);
  }
});

test("integration: lockout affects only target email", () => {
  const now = 90000;
  signup("jack@test.com", "ValidPass123!", now);
  signup("jill@test.com", "ValidPass456!", now);
  for (let i = 0; i < 5; i++) {
    login("jack@test.com", "WrongPass999!", now);
  }
  const otherUnlocked = login("jill@test.com", "ValidPass456!", now);
  expect(otherUnlocked.ok).toBe(true);
});

test("integration: non-existent email login fails", () => {
  const now = 100000;
  const result = login("nonexistent@test.com", "AnyPass123!", now);
  expect(result.ok).toBe(false);
});
