import { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import CryptoJS from 'crypto-js'; // For payload decryption
import User from '../models/User.js';
import Room from '../models/Room.js'; // ADDED: To auto-create private rooms on registration

const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';
// Shared secret key for AES encryption (must match the frontend)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'fleet_payload_secret_2026';

export const registerUser = async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Extract and decrypt the AES payload
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

    const { name, phone, password, role, managerId } = JSON.parse(decryptedPayload);

    // 2. Validate required fields
    if (!name || !phone || !password || !role) {
      res.status(400).json({ error: 'Name, phone number, password, and role are required' });
      return;
    }

    if (role !== 'manager' && role !== 'driver') {
      res.status(400).json({ error: 'Role must be either manager or driver' });
      return;
    }

    // 3. Cross-check if phone number already exists (same role OR opposite role)
    const existingUser = await User.findOne({ phone: phone.trim() });
    if (existingUser) {
      if (existingUser.role !== role) {
        const existingRoleLabel = existingUser.role === 'manager' ? 'Manager' : 'Driver';
        const targetRoleLabel = role === 'manager' ? 'Manager' : 'Driver';
        res.status(400).json({
          error: `This phone number is already registered as a ${existingRoleLabel} and cannot be registered as a ${targetRoleLabel}.`
        });
        return;
      }

      res.status(400).json({ error: `This phone number is already registered as a ${role}.` });
      return;
    }

    // 4. If registering a driver, verify they are assigned to exactly one valid manager
    let validManagerId: mongoose.Types.ObjectId | undefined = undefined;
    if (role === 'driver') {
      if (!managerId || !mongoose.Types.ObjectId.isValid(managerId)) {
        res.status(400).json({ error: 'Please select a valid manager before registering as a driver.' });
        return;
      }

      const assignedManager = await User.findOne({ _id: managerId, role: 'manager' });
      if (!assignedManager) {
        res.status(400).json({ error: 'Assigned manager not found.' });
        return;
      }

      validManagerId = assignedManager._id as mongoose.Types.ObjectId;
    }

    // 5. Hash the password for security
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 6. Create the user
    const newUser = await User.create({
      name: name.trim(),
      phone: phone.trim(),
      password: hashedPassword,
      role,
      managerId: validManagerId,
    });

    // 7. Ensure shared Community Hub room exists in DB
    let communityRoom = await Room.findOne({ type: 'community' });
    if (!communityRoom) {
      communityRoom = await Room.create({
        type: 'community',
        participants: [],
      });
    }

    // 8. If a driver registered, automatically create their dedicated 1-on-1 room with their manager
    let personalRoomId = null;
    if (role === 'driver' && validManagerId) {
      const personalRoom = await Room.create({
        type: 'personal',
        participants: [validManagerId, newUser._id],
      });
      personalRoomId = personalRoom._id;
    }

    res.status(201).json({
      message: 'User registered successfully',
      userId: newUser._id,
      personalRoomId,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
};

export const loginUser = async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Extract the encrypted string from the request body
    const { data } = req.body;

    if (!data) {
      res.status(400).json({ error: 'Missing encrypted payload' });
      return;
    }

    // 2. Decrypt the AES ciphertext back into a raw JSON string
    const bytes = CryptoJS.AES.decrypt(data, ENCRYPTION_KEY);
    const decryptedPayload = bytes.toString(CryptoJS.enc.Utf8);

    if (!decryptedPayload) {
      res.status(400).json({ error: 'Invalid encryption payload' });
      return;
    }

    // 3. Parse the decrypted JSON string to extract the phone and password
    const { phone, password } = JSON.parse(decryptedPayload);

    // Proceed with normal login logic using the decrypted credentials
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
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to log in' });
  }
};

// ADDED: Save or refresh the device's FCM token for background/killed push notifications
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

    // Detach this device token from any previous account (e.g., if drivers share a device)
    await User.updateMany(
      { _id: { $ne: decoded.userId }, fcmToken: fcmToken.trim() },
      { $unset: { fcmToken: '' } }
    );

    // Bind the FCM token to the currently authenticated user
    await User.findByIdAndUpdate(decoded.userId, {
      fcmToken: fcmToken.trim(),
    });

    res.status(200).json({ message: 'FCM token updated successfully' });
  } catch (error) {
    console.error('Error updating FCM token:', error);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
};

// ADDED: Remove the device's FCM token on logout so logged-out devices do not receive alerts
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

    res.status(200).json({ message: 'FCM token removed successfully' });
  } catch (error) {
    console.error('Error removing FCM token:', error);
    res.status(500).json({ error: 'Failed to remove FCM token' });
  }
};