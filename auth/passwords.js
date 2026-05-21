import bcrypt from 'bcryptjs';

const ROUNDS = 10;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}
