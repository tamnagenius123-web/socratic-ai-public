// Auth Service - JWT-based authentication for Cloudflare Workers
// Uses Web Crypto API (no bcrypt - not available in Workers)

import type { User, UserPublic, JWTPayload, UserRole, Bindings } from '../types';

type AuthDatabaseUserRow = {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  student_id: string | null;
  grade: number | null;
  role: UserRole;
  created_at: number;
  last_login: number | null;
  is_active: number;
  metadata: string | null;
};

type AuthDatabasePublicUserRow = Omit<AuthDatabaseUserRow, 'password_hash' | 'metadata'>;

// =============================================
// Password Hashing (Web Crypto API)
// =============================================

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  
  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Sentinel accounts must be provisioned out of band with a real password hash.
  if (storedHash === '__ADMIN_INITIAL__') return false;
  
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  
  const saltHex = parts[1];
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  
  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === parts[2];
}

// =============================================
// JWT Token Management (Web Crypto API)
// =============================================

function base64UrlEncode(data: Uint8Array): string {
  const str = String.fromCharCode(...data);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
}

async function createJWT(payload: JWTPayload, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  
  const signingInput = `${headerB64}.${payloadB64}`;
  
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  
  return `${signingInput}.${signatureB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const encoder = new TextEncoder();
    const signingInput = `${parts[0]}.${parts[1]}`;
    
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    
    const signature = base64UrlDecode(parts[2]);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));
    
    if (!valid) return null;
    
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as JWTPayload;
    
    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    
    return payload;
  } catch (e) { console.error("[P1-004] Caught:", e);
    return null;
  }
}

// =============================================
// User Database Operations
// =============================================

export async function createUser(
  db: D1Database,
  username: string,
  email: string,
  password: string,
  role: UserRole = 'student',
  studentId?: string,
  grade?: number
): Promise<UserPublic> {
  const id = `usr_${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(password);
  const now = Date.now();
  
  await db.prepare(`
    INSERT INTO users (id, username, email, password_hash, student_id, grade, role, created_at, is_active, metadata)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, '{}')
  `).bind(id, username, email, passwordHash, studentId || null, grade || null, role, now).run();
  
  return { id, username, email, studentId: studentId || null, grade: grade || null, role, createdAt: now, lastLogin: null, isActive: true };
}

export async function authenticateUser(db: D1Database, email: string, password: string): Promise<User | null> {
  const row = await db.prepare('SELECT * FROM users WHERE email = ?1 AND is_active = 1').bind(email).first<AuthDatabaseUserRow>();
  if (!row) return null;
  
  const valid = await verifyPassword(password, row.password_hash as string);
  if (!valid) return null;
  
  // Update last login
  await db.prepare('UPDATE users SET last_login = ?2 WHERE id = ?1').bind(row.id, Date.now()).run();
  
  return rowToUser(row);
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<AuthDatabaseUserRow>();
  return row ? rowToUser(row) : null;
}

export async function getAllUsers(db: D1Database): Promise<UserPublic[]> {
  const result = await db.prepare('SELECT id, username, email, student_id, grade, role, created_at, last_login, is_active FROM users ORDER BY created_at DESC').all<AuthDatabasePublicUserRow>();
  return (result.results || []).map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    studentId: row.student_id,
    grade: row.grade,
    role: row.role as UserRole,
    createdAt: row.created_at,
    lastLogin: row.last_login,
    isActive: !!row.is_active,
  }));
}

export async function updateUser(db: D1Database, id: string, updates: Partial<{ username: string; email: string; studentId: string; grade: number; role: UserRole; isActive: boolean }>): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 2;
  
  if (updates.username !== undefined) { sets.push(`username = ?${idx}`); values.push(updates.username); idx++; }
  if (updates.email !== undefined) { sets.push(`email = ?${idx}`); values.push(updates.email); idx++; }
  if (updates.studentId !== undefined) { sets.push(`student_id = ?${idx}`); values.push(updates.studentId); idx++; }
  if (updates.grade !== undefined) { sets.push(`grade = ?${idx}`); values.push(updates.grade); idx++; }
  if (updates.role !== undefined) { sets.push(`role = ?${idx}`); values.push(updates.role); idx++; }
  if (updates.isActive !== undefined) { sets.push(`is_active = ?${idx}`); values.push(updates.isActive ? 1 : 0); idx++; }
  
  if (sets.length === 0) return false;
  
  const result = await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?1`).bind(id, ...values).run();
  return result.meta.changes > 0;
}

export async function deleteUser(db: D1Database, id: string): Promise<boolean> {
  // Soft delete - set is_active to false
  const result = await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?1').bind(id).run();
  return result.meta.changes > 0;
}

export async function changePassword(db: D1Database, userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(userId).first();
  if (!row) return false;
  
  const valid = await verifyPassword(oldPassword, row.password_hash as string);
  if (!valid) return false;
  
  const newHash = await hashPassword(newPassword);
  await db.prepare('UPDATE users SET password_hash = ?2 WHERE id = ?1').bind(userId, newHash).run();
  return true;
}

// =============================================
// Token Generation
// =============================================

export async function generateTokens(user: User | UserPublic, secret: string): Promise<{ accessToken: string; refreshToken: string }> {
  const now = Math.floor(Date.now() / 1000);
  
  const accessPayload: JWTPayload = {
    sub: user.id,
    username: user.username,
    email: user.email,
    studentId: ('studentId' in user ? user.studentId : null) || null,
    role: user.role,
    iat: now,
    exp: now + 3600, // 1 hour (longer for edge app)
    iss: 'socratic-ai',
  };
  
  const refreshPayload: JWTPayload = {
    sub: user.id,
    username: user.username,
    email: user.email,
    studentId: ('studentId' in user ? user.studentId : null) || null,
    role: user.role,
    iat: now,
    exp: now + 604800, // 7 days
    iss: 'socratic-ai-refresh',
  };
  
  const accessToken = await createJWT(accessPayload, secret);
  const refreshToken = await createJWT(refreshPayload, secret + '_refresh');
  
  return { accessToken, refreshToken };
}

export async function verifyAccessToken(token: string, secret: string): Promise<JWTPayload | null> {
  return verifyJWT(token, secret);
}

export async function verifyRefreshToken(token: string, secret: string): Promise<JWTPayload | null> {
  return verifyJWT(token, secret + '_refresh');
}

// =============================================
// Helpers
// =============================================

function rowToUser(row: AuthDatabaseUserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    studentId: row.student_id,
    grade: row.grade,
    role: row.role as UserRole,
    createdAt: row.created_at,
    lastLogin: row.last_login,
    isActive: !!row.is_active,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  };
}

export function userToPublic(user: User): UserPublic {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    studentId: user.studentId,
    grade: user.grade,
    role: user.role,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    isActive: user.isActive,
  };
}
