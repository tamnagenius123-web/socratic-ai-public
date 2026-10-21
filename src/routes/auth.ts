// Auth API Routes - Registration, Login, Logout, Token Refresh
import { Hono } from 'hono';
import type { Bindings } from '../types';
import {
  createUser, authenticateUser, getUserById, generateTokens,
  verifyRefreshToken, changePassword, userToPublic,
} from '../services/auth';
import { requireAuth, getAuthUser } from '../middleware/auth';

const authRoute = new Hono<{ Bindings: Bindings }>();

authRoute.use('/api/auth/me', requireAuth);
authRoute.use('/api/auth/change-password', requireAuth);

// POST /api/auth/register - Register new user (open or admin-invite)
authRoute.post('/api/auth/register', async (c) => {
  try {
    const { username, email, password, studentId, grade } = await c.req.json();

    if (!username || !email || !password) {
      return c.json({ error: '이름, 이메일, 비밀번호는 필수입니다.' }, 400);
    }
    if (password.length < 6) {
      return c.json({ error: '비밀번호는 최소 6자 이상이어야 합니다.' }, 400);
    }

    const secret = c.env.JWT_SECRET;
    if (!secret) return c.json({ error: '인증 서비스가 안전하게 구성되지 않았습니다.' }, 503);

    const db = c.env.DB;

    // Check duplicate email
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
    if (existing) {
      return c.json({ error: '이미 등록된 이메일입니다.' }, 409);
    }
    // Check duplicate username
    const existingName = await db.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first();
    if (existingName) {
      return c.json({ error: '이미 사용 중인 이름입니다.' }, 409);
    }

    const user = await createUser(db, username, email, password, 'student', studentId, grade);
    const tokens = await generateTokens(user, secret);

    return c.json({
      success: true,
      user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (error) {
    console.error('Register error:', error);
    return c.json({ error: '회원가입에 실패했습니다.' }, 500);
  }
});

// POST /api/auth/login
authRoute.post('/api/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json();

    if (!email || !password) {
      return c.json({ error: '이메일과 비밀번호를 입력하세요.' }, 400);
    }

    const db = c.env.DB;
    const user = await authenticateUser(db, email, password);

    if (!user) {
      return c.json({ error: '이메일 또는 비밀번호가 잘못되었습니다.' }, 401);
    }

    const secret = c.env.JWT_SECRET;
    if (!secret) return c.json({ error: '인증 서비스가 안전하게 구성되지 않았습니다.' }, 503);
    const tokens = await generateTokens(user, secret);

    return c.json({
      success: true,
      user: userToPublic(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: '로그인에 실패했습니다.' }, 500);
  }
});

// POST /api/auth/refresh
authRoute.post('/api/auth/refresh', async (c) => {
  try {
    const { refreshToken } = await c.req.json();
    if (!refreshToken) {
      return c.json({ error: 'refreshToken이 필요합니다.' }, 400);
    }

    const secret = c.env.JWT_SECRET;
    if (!secret) return c.json({ error: '인증 서비스가 안전하게 구성되지 않았습니다.' }, 503);
    const payload = await verifyRefreshToken(refreshToken, secret);

    if (!payload) {
      return c.json({ error: '유효하지 않거나 만료된 토큰입니다.' }, 401);
    }

    const db = c.env.DB;
    const user = await getUserById(db, payload.sub);
    if (!user || !user.isActive) {
      return c.json({ error: '사용자를 찾을 수 없습니다.' }, 401);
    }

    const tokens = await generateTokens(user, secret);

    return c.json({
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (error) {
    console.error('Refresh error:', error);
    return c.json({ error: '토큰 갱신에 실패했습니다.' }, 500);
  }
});

// GET /api/auth/me - Get current user info
authRoute.get('/api/auth/me', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) {
    return c.json({ error: '인증이 필요합니다.' }, 401);
  }

  const db = c.env.DB;
  const user = await getUserById(db, auth.userId);
  if (!user) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
  }

  return c.json({ user: userToPublic(user) });
});

// POST /api/auth/change-password
authRoute.post('/api/auth/change-password', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) {
    return c.json({ error: '인증이 필요합니다.' }, 401);
  }

  try {
    const { oldPassword, newPassword } = await c.req.json();
    if (!oldPassword || !newPassword) {
      return c.json({ error: '현재 비밀번호와 새 비밀번호를 입력하세요.' }, 400);
    }
    if (newPassword.length < 6) {
      return c.json({ error: '새 비밀번호는 최소 6자 이상이어야 합니다.' }, 400);
    }

    const db = c.env.DB;
    const success = await changePassword(db, auth.userId, oldPassword, newPassword);
    if (!success) {
      return c.json({ error: '현재 비밀번호가 일치하지 않습니다.' }, 400);
    }

    return c.json({ success: true, message: '비밀번호가 변경되었습니다.' });
  } catch (error) {
    console.error('Password change error:', error);
    return c.json({ error: '비밀번호 변경에 실패했습니다.' }, 500);
  }
});

export default authRoute;
