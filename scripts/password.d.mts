export const PASSWORD_ITERATIONS: number;
export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, stored: string): Promise<boolean>;
export function generatePassword(length?: number): string;
