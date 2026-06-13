export type PasswordReason =
  | "MIN_LENGTH"
  | "NEEDS_UPPER"
  | "NEEDS_LOWER"
  | "NEEDS_DIGIT"
  | "NEEDS_SYMBOL";

export interface IPasswordValidationResult {
  ok: true;
}

export interface IPasswordValidationError {
  ok: false;
  reasons: PasswordReason[];
}

export type PasswordValidationResult =
  | IPasswordValidationResult
  | IPasswordValidationError;

export function validatePassword(password: string): PasswordValidationResult {
  const reasons: PasswordReason[] = [];

  if (password.length < 10) {
    reasons.push("MIN_LENGTH");
  }

  if (!/[A-Z]/.test(password)) {
    reasons.push("NEEDS_UPPER");
  }

  if (!/[a-z]/.test(password)) {
    reasons.push("NEEDS_LOWER");
  }

  if (!/[0-9]/.test(password)) {
    reasons.push("NEEDS_DIGIT");
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    reasons.push("NEEDS_SYMBOL");
  }

  if (reasons.length === 0) {
    return { ok: true };
  }

  return { ok: false, reasons };
}
