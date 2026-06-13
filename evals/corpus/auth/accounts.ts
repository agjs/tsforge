import { validatePassword, type PasswordReason } from "./passwords";
import { issueSession } from "./sessions";

interface IAccountRecord {
  email: string;
  passwordHash: string;
  failedAttempts: number;
  lastFailureTime: number;
}

interface ISignupSuccess {
  ok: true;
}

interface ISignupError {
  ok: false;
  reasons: PasswordReason[];
}

export type SignupResult = ISignupSuccess | ISignupError;

interface ILoginSuccess {
  ok: true;
  token: string;
  expiry: number;
}

interface ILoginError {
  ok: false;
}

export type LoginResult = ILoginSuccess | ILoginError;

const accounts = new Map<string, IAccountRecord>();

export function resetAccounts(): void {
  accounts.clear();
}

export function signup(
  email: string,
  password: string,
  now: number
): SignupResult {
  const validation = validatePassword(password);
  if (!validation.ok) {
    return { ok: false, reasons: validation.reasons };
  }

  if (accounts.has(email)) {
    return { ok: false, reasons: [] };
  }

  const record: IAccountRecord = {
    email,
    passwordHash: hashPassword(password),
    failedAttempts: 0,
    lastFailureTime: 0,
  };

  accounts.set(email, record);
  return { ok: true };
}

export function login(
  email: string,
  password: string,
  now: number
): LoginResult {
  const record = accounts.get(email);

  if (!record) {
    return { ok: false };
  }

  const lockoutWindow = 15 * 60 * 1000;
  const timeSinceLastFailure = now - record.lastFailureTime;

  if (record.failedAttempts >= 5 && timeSinceLastFailure < lockoutWindow) {
    return { ok: false };
  }

  if (record.failedAttempts >= 5 && timeSinceLastFailure >= lockoutWindow) {
    record.failedAttempts = 0;
    record.lastFailureTime = 0;
  }

  const passwordCorrect = record.passwordHash === hashPassword(password);

  if (passwordCorrect) {
    record.failedAttempts = 0;
    record.lastFailureTime = 0;

    const ttl = 60 * 60 * 1000;
    const { token, expiry } = issueSession(email, now, ttl);

    return { ok: true, token, expiry };
  }

  record.failedAttempts += 1;
  record.lastFailureTime = now;

  return { ok: false };
}

function hashPassword(password: string): string {
  const buffer = Buffer.from(password);
  return buffer.toString("base64");
}
