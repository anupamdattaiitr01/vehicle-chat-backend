import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Room from '../models/Room.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';

// 1. Public endpoint: Fetch all registered managers for the Driver Registration dropdown
router.get('/managers', async (_req: Request, res: Response): Promise<void> => {
  try {
    const managers = await User.find({ role: 'manager' })
      .select('_id name phone')
      .sort({ name: 1 });

    res.status(200).json(managers);
  } catch (error) {
    console.error('Error fetching managers:', error);
    res.status(500).json({ error: 'Failed to fetch managers' });
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