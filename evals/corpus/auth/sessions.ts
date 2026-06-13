export interface ISessionToken {
  token: string;
  expiry: number;
}

export function issueSession(
  userId: string,
  now: number,
  ttlMs: number
): ISessionToken {
  const expiry = now + ttlMs;
  const token = generateDeterministicToken(userId, now, ttlMs);
  return { token, expiry };
}

export function validateSession(token: string, now: number): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return false;
    }

    const expiryEncoded = parts[2];
    const expiryStr = Buffer.from(expiryEncoded, "base64").toString();
    const expiry = parseInt(expiryStr, 10);

    if (Number.isNaN(expiry)) {
      return false;
    }

    return now < expiry;
  } catch {
    return false;
  }
}

function generateDeterministicToken(
  userId: string,
  now: number,
  ttlMs: number
): string {
  const expiry = now + ttlMs;
  const userIdEncoded = Buffer.from(userId).toString("base64");
  const nowEncoded = Buffer.from(now.toString()).toString("base64");
  const expiryEncoded = Buffer.from(expiry.toString()).toString("base64");

  return `${userIdEncoded}.${nowEncoded}.${expiryEncoded}`;
}
