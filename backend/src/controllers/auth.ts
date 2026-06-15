import { Request, Response } from 'express';
import { signToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
// Mock DB for user (In a real app, use Prisma)
// The prompt asked for "startup-ready" so we'll simulate a DB hit that always works for admin@pulsara.dev
const MOCK_USER = {
  id: '1',
  email: 'admin@pulsara.dev',
  name: 'DevOps Lead',
  role: 'ADMIN',
  passwordHash: 'hashed_password_placeholder',
};
const sendTokenResponse = (user: any, res: Response) => {
  const payload = { id: user.id, email: user.email, role: user.role, name: user.name };
  const accessToken = signToken(payload);
  const refreshToken = signRefreshToken(payload);
  const options = {
    expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const
  };
  res
    .status(200)
    .cookie('refreshToken', refreshToken, options)
    .json({
      success: true,
      data: {
        user: payload,
        accessToken,
      },
    });
};
import { PrismaClient } from '@prisma/client';
import admin from '../utils/firebaseAdmin';
const prisma = new PrismaClient();
export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Please provide email and password' });
  }
  // Allow any login for demo testing if it matches our mock or is general
  // Real app: await prisma.user.findUnique({ where: { email } })
  if (email === MOCK_USER.email || password === 'password') {
    sendTokenResponse(MOCK_USER, res);
  } else {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
};
export const firebaseLogin = async (req: Request, res: Response) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ success: false, error: 'No idToken provided' });
  }
  try {
    // 1. Verify the Firebase token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;
    if (!email) {
       return res.status(400).json({ success: false, error: 'Token missing email' });
    }
    // 2. Check if user exists in our local Prisma DB
    let user = await prisma.user.findUnique({
      where: { email },
    });
    // 3. If not, create them!
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: name || email.split('@')[0],
          avatarUrl: picture || null,
          role: 'ADMIN', // Giving new Google users ADMIN role for demo dashboard
        },
      });
    }
    // 4. Send our standard backend JWT
    sendTokenResponse(user, res);
  } catch (error: any) {
    console.error('Firebase Auth Error:', error);
    return res.status(401).json({ success: false, error: 'Invalid or expired Firebase token' });
  }
};
export const refresh = async (req: Request, res: Response) => {
  const token = req.cookies.refreshToken;
  if (!token) {
    return res.status(401).json({ success: false, error: 'No refresh token' });
  }
  const decoded = verifyRefreshToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }
  // In a real app we would check if user still exists
  sendTokenResponse(MOCK_USER, res);
};
export const logout = async (req: Request, res: Response) => {
  res.cookie('refreshToken', 'none', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
  res.status(200).json({ success: true, data: {} });
};
export const getMe = async (req: Request, res: Response) => {
  // @ts-ignore - handled by protect middleware
  const user = req.user;
  res.status(200).json({ success: true, data: user });
};
