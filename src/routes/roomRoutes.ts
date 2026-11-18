import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import CryptoJS from 'crypto-js';
import User from '../models/User.js';
import Room from '../models/Room.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'fleet_payload_secret_2026';

// 1. Protected endpoint (Manager only): Provision a new driver & assign to the logged-in manager
router.post('/add-driver', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization token required' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; role: string };

    if (decoded.role !== 'manager') {
      res.status(403).json({ error: 'Access denied: Only managers can add drivers.' });
      return;
    }

    const manager = await User.findOne({ _id: decoded.userId, role: 'manager' });
    if (!manager) {
      res.status(404).json({ error: 'Manager account not found.' });
      return;
    }

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

    const { name, phone, password } = JSON.parse(decryptedPayload);

    if (!name?.trim() || !phone?.trim() || !password?.trim()) {
      res.status(400).json({ error: 'Driver name, phone number, and password are required.' });
      return;
    }

    const normalizedPhone = phone.trim();

    // Mandatory check: verify if phone belongs to an existing user or is already assigned to a manager
    const existingUser = await User.findOne({ phone: normalizedPhone });
    if (existingUser) {
      if (existingUser.role === 'manager') {
        res.status(409).json({
          error: 'This phone number is already registered as a Manager account.',
        });
        return;
      }

      if (existingUser.managerId) {
        if (existingUser.managerId.toString() === manager._id.toString()) {
          res.status(409).json({
            error: 'This driver is already assigned to your fleet.',
          });
          return;
        }

        res.status(409).json({
          error: 'This driver is already assigned to another manager.',
        });
        return;
      }

      res.status(409).json({
        error: 'A driver account with this phone number already exists.',
      });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password.trim(), salt);

    const newDriver = await User.create({
      name: name.trim(),
      phone: normalizedPhone,
      password: hashedPassword,
      role: 'driver',
      managerId: manager._id,
    });

    // Ensure shared Community Hub room exists
    let communityRoom = await Room.findOne({ type: 'community' });
    if (!communityRoom) {
      communityRoom = await Room.create({
        type: 'community',
        participants: [],
      });
    }

    // Create dedicated 1-on-1 Personal Chat room between Manager and Driver
    const personalRoom = await Room.create({
      type: 'personal',
      participants: [manager._id, newDriver._id],
    });

    res.status(201).json({
      message: 'Driver added and assigned successfully',
      driver: {
        driverId: newDriver._id,
        driverName: newDriver.name,
        driverPhone: newDriver.phone,
        roomId: personalRoom._id,
      },
    });
  } catch (error) {
    console.error('Error adding driver:', error);
    res.status(500).json({ error: 'Failed to add driver' });
  }
});

// 2. Protected endpoint: Fetch dynamic rooms based on the logged-in user's role
router.get('/my-rooms', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization token required' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; role: string };

    const currentUser = await User.findById(decoded.userId);
    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Ensure shared Community Hub room exists
    let communityRoom = await Room.findOne({ type: 'community' });
    if (!communityRoom) {
      communityRoom = await Room.create({
        type: 'community',
        participants: [],
      });
    }

    // Case A: Logged in as a Manager -> return all drivers under this manager & their private rooms
    if (currentUser.role === 'manager') {
      const drivers = await User.find({
        role: 'driver',
        managerId: currentUser._id,
      })
        .select('_id name phone')
        .sort({ name: 1 });

      const driverRooms = await Promise.all(
        drivers.map(async (driver) => {
          let personalRoom = await Room.findOne({
            type: 'personal',
            participants: { $all: [currentUser._id, driver._id] },
          });

          // Self-heal: create the private room if it doesn't exist yet
          if (!personalRoom) {
            personalRoom = await Room.create({
              type: 'personal',
              participants: [currentUser._id, driver._id],
            });
          }

          return {
            driverId: driver._id,
            driverName: driver.name,
            driverPhone: driver.phone,
            roomId: personalRoom._id,
          };
        })
      );

      res.status(200).json({
        communityRoomId: communityRoom._id,
        drivers: driverRooms,
      });
      return;
    }

    // Case B: Logged in as a Driver -> return their single assigned manager & private room
    if (currentUser.role === 'driver') {
      if (!currentUser.managerId) {
        res.status(200).json({
          communityRoomId: communityRoom._id,
          manager: null,
        });
        return;
      }

      const manager = await User.findOne({
        _id: currentUser.managerId,
        role: 'manager',
      }).select('_id name phone');

      if (!manager) {
        res.status(200).json({
          communityRoomId: communityRoom._id,
          manager: null,
        });
        return;
      }

      let personalRoom = await Room.findOne({
        type: 'personal',
        participants: { $all: [manager._id, currentUser._id] },
      });

      if (!personalRoom) {
        personalRoom = await Room.create({
          type: 'personal',
          participants: [manager._id, currentUser._id],
        });
      }

      res.status(200).json({
        communityRoomId: communityRoom._id,
        manager: {
          managerId: manager._id,
          managerName: manager.name,
          managerPhone: manager.phone,
          roomId: personalRoom._id,
        },
      });
      return;
    }

    res.status(400).json({ error: 'Invalid user role' });
  } catch (error) {
    console.error('Error fetching user rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

export default router;