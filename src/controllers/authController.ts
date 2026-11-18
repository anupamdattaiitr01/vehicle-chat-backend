import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import CryptoJS from 'crypto-js';
import User from '../models/User.js';
import Room from '../models/Room.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'fleet_payload_secret_2026';

export const registerUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { data } = req.body;

    if (!data) {
      res.status(400).json({ error: 'Missing encrypted payload' });
      return;
    }

    const bytes = CryptoJS.AES.decrypt(data, ENCRYPTION_KEY);
    const decryptedPayload = bytes.toString(CryptoJS.enc.Utf8);

    if (!decryptedPayload) {
      res.status(400).json({ error: 'Invalid encryption payload' });
      return;
    }

    const { name, phone, password, role } = JSON.parse(decryptedPayload);

    if (!name || !phone || !password) {
      res.status(400).json({ error: 'Name, phone number, and password are required' });
      return;
    }

    // Block driver self-registration; only managers may register publicly
    if (role && role !== 'manager') {
      res.status(403).json({
        error: 'Driver self-registration is disabled. Please ask your fleet manager to add your account.',
      });
      return;
    }

    const normalizedPhone = phone.trim();
    const existingUser = await User.findOne({ phone: normalizedPhone });
    if (existingUser) {
      if (existingUser.role === 'driver') {
        res.status(409).json({
          error: 'This phone number is already registered as a Driver account.',
        });
        return;
      }

      res.status(409).json({
        error: 'This phone number is already registered as a Manager.',
      });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password.trim(), salt);

    const newManager = await User.create({
      name: name.trim(),
      phone: normalizedPhone,
      password: hashedPassword,
      role: 'manager',
    });

    // Ensure shared Community Hub room exists
    const communityRoom = await Room.findOne({ type: 'community' });
    if (!communityRoom) {
      await Room.create({
        type: 'community',
        participants: [],
      });
    }

    res.status(201).json({
      message: 'Manager account created successfully. Please log in.',
      userId: newManager._id,
    });
  } catch (error) {
    console.error('Manager registration error:', error);
    res.status(500).json({ error: 'Failed to register manager account' });
  }
};

export const loginUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { data } = req.body;

    if (!data) {
      res.status(400).json({ error: 'Missing encrypted payload' });
      return;
    }

    const bytes = CryptoJS.AES.decrypt(data, ENCRYPTION_KEY);
    const decryptedPayload = bytes.toString(CryptoJS.enc.Utf8);

    if (!decryptedPayload) {
      res.status(400).json({ error: 'Invalid encryption payload' });
      return;
    }

    const { phone, password } = JSON.parse(decryptedPayload);

    const user = await User.findOne({ phone: phone?.trim() });
    if (!user) {
      res.status(400).json({ error: 'Invalid phone number or password' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(400).json({ error: 'Invalid phone number or password' });
      return;
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        _id: user._id,
        name: user.name,
        role: user.role,
        phone: user.phone,
        managerId: user.managerId,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to log in' });
  }
};

export const updateFcmToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization token required' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== 'string') {
      res.status(400).json({ error: 'Valid fcmToken is required' });
      return;
    }

    await User.updateMany(
      { _id: { $ne: decoded.userId }, fcmToken: fcmToken.trim() },
      { $unset: { fcmToken: '' } }
    );

    const updatedUser = await User.findByIdAndUpdate(
      decoded.userId,
      { fcmToken: fcmToken.trim() },
      { new: true }
    );

    console.log(
      `[FCM Token] Saved for user ${updatedUser?.name || decoded.userId} (token present: ${Boolean(updatedUser?.fcmToken)})`
    );

    res.status(200).json({ message: 'FCM token updated successfully' });
  } catch (error) {
    console.error('Error updating FCM token:', error);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
};

export const removeFcmToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization token required' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    await User.findByIdAndUpdate(decoded.userId, {
      $unset: { fcmToken: '' },
    });

    console.log(`[FCM Token] Removed for user ${decoded.userId}`);

    res.status(200).json({ message: 'FCM token removed successfully' });
  } catch (error) {
    console.error('Error removing FCM token:', error);
    res.status(500).json({ error: 'Failed to remove FCM token' });
  }
};