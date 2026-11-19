import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Room from '../models/Room.js';
import Message from '../models/Message.js';
import { sendBookingAlertPush } from '../config/firebase.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';

interface AuthenticatedUser {
  userId: string;
  role: 'manager' | 'driver';
  name: string;
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

// Inline JWT Verification Middleware matching chatHandler.ts
const verifyToken = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token missing' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthenticatedUser;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// 1. Manager assigns a ride booking to a driver
router.post('/', verifyToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (req.user?.role !== 'manager') {
      res.status(403).json({ error: 'Only managers can assign bookings.' });
      return;
    }

    const managerId = String(req.user.userId);
    const managerName = req.user.name || 'Manager';
    const {
      driverId,
      passengerName,
      passengerPhone,
      pickupLocation,
      dropLocation,
      scheduledTime,
      notes,
    } = req.body;

    if (
      !driverId ||
      !passengerName?.trim() ||
      !passengerPhone?.trim() ||
      !pickupLocation?.trim() ||
      !dropLocation?.trim() ||
      !scheduledTime?.trim()
    ) {
      res.status(400).json({
        error: 'Driver, passenger details, pickup/drop locations, and scheduled time are required.',
      });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      res.status(400).json({ error: 'Invalid driver ID.' });
      return;
    }

    // Verify driver exists and belongs to this manager
    const driver = await User.findOne({
      _id: driverId,
      role: 'driver',
      managerId,
    });

    if (!driver) {
      res.status(404).json({ error: 'Driver not found or not assigned to your fleet.' });
      return;
    }

    // Find or create the personal room between this manager and driver
    let personalRoom = await Room.findOne({
      type: 'personal',
      participants: { $all: [managerId, driver._id] },
    });

    if (!personalRoom) {
      personalRoom = await Room.create({
        type: 'personal',
        participants: [managerId, driver._id],
      });
    }

    const booking = await Booking.create({
      managerId,
      driverId: driver._id,
      roomId: personalRoom._id,
      passengerName: passengerName.trim(),
      passengerPhone: passengerPhone.trim(),
      pickupLocation: pickupLocation.trim(),
      dropLocation: dropLocation.trim(),
      scheduledTime: scheduledTime.trim(),
      notes: notes?.trim() || '',
      status: 'pending',
    });

    const bookingPayload = {
      _id: String(booking._id),
      managerId,
      managerName,
      driverId: String(driver._id),
      driverName: driver.name,
      roomId: String(personalRoom._id),
      passengerName: booking.passengerName,
      passengerPhone: booking.passengerPhone,
      pickupLocation: booking.pickupLocation,
      dropLocation: booking.dropLocation,
      scheduledTime: booking.scheduledTime,
      notes: booking.notes || '',
      status: booking.status,
      queryMessage: booking.queryMessage || '',
      createdAt: booking.createdAt.toISOString(),
    };

    // Emit live Socket.io event to the driver if currently connected
    const io = req.app.get('io') as Server | undefined;
    if (io) {
      io.to(`user:${driver._id}`).emit('booking_assigned', bookingPayload);
    }

    // Send high-priority data-only FCM push so terminated/locked Android phones wake up
    if (driver.fcmToken) {
      await sendBookingAlertPush({
        token: driver.fcmToken,
        data: {
          type: 'BOOKING_ASSIGNED',
          bookingId: bookingPayload._id,
          managerId: bookingPayload.managerId,
          managerName: bookingPayload.managerName,
          driverId: bookingPayload.driverId,
          roomId: bookingPayload.roomId,
          passengerName: bookingPayload.passengerName,
          passengerPhone: bookingPayload.passengerPhone,
          pickupLocation: bookingPayload.pickupLocation,
          dropLocation: bookingPayload.dropLocation,
          scheduledTime: bookingPayload.scheduledTime,
          notes: bookingPayload.notes,
          status: bookingPayload.status,
          createdAt: bookingPayload.createdAt,
        },
      });
    }

    res.status(201).json(bookingPayload);
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: 'Failed to assign ride booking.' });
  }
});

// 2. Fetch bookings for the logged-in driver or manager
router.get('/my-bookings', verifyToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = String(req.user?.userId);
    const role = req.user?.role;

    const filter = role === 'manager' ? { managerId: userId } : { driverId: userId };

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .limit(30)
      .populate('managerId', 'name')
      .populate('driverId', 'name');

    const formatted = bookings.map((b) => {
      const mgr = b.managerId as unknown as { _id?: mongoose.Types.ObjectId; name?: string };
      const drv = b.driverId as unknown as { _id?: mongoose.Types.ObjectId; name?: string };

      return {
        _id: String(b._id),
        managerId: String(mgr?._id || b.managerId),
        managerName: mgr?.name || 'Manager',
        driverId: String(drv?._id || b.driverId),
        driverName: drv?.name || 'Driver',
        roomId: String(b.roomId),
        passengerName: b.passengerName,
        passengerPhone: b.passengerPhone,
        pickupLocation: b.pickupLocation,
        dropLocation: b.dropLocation,
        scheduledTime: b.scheduledTime,
        notes: b.notes || '',
        status: b.status,
        queryMessage: b.queryMessage || '',
        createdAt: b.createdAt.toISOString(),
      };
    });

    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings.' });
  }
});

// 3. Driver confirms booking or raises a query (auto-posts query to personal chat room)
router.patch(
  '/:bookingId/respond',
  verifyToken,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (req.user?.role !== 'driver') {
        res.status(403).json({ error: 'Only drivers can respond to bookings.' });
        return;
      }

      const driverId = String(req.user.userId);
      const bookingId = Array.isArray(req.params.bookingId)
        ? req.params.bookingId[0]
        : String(req.params.bookingId ?? '');
      const { action, queryText } = req.body as {
        action?: 'confirm' | 'raise_query';
        queryText?: string;
      };

      if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
        res.status(400).json({ error: 'Invalid booking ID.' });
        return;
      }

      if (action !== 'confirm' && action !== 'raise_query') {
        res.status(400).json({ error: 'Action must be "confirm" or "raise_query".' });
        return;
      }

      if (action === 'raise_query' && (!queryText || !queryText.trim())) {
        res.status(400).json({ error: 'Please enter your query before submitting.' });
        return;
      }

      const booking = await Booking.findOne({ _id: bookingId, driverId });
      if (!booking) {
        res.status(404).json({ error: 'Booking not found.' });
        return;
      }

      const io = req.app.get('io') as Server | undefined;
      let createdChatMessage = null;

      if (action === 'confirm') {
        booking.status = 'confirmed';
        await booking.save();
      } else {
        const cleanQuery = queryText!.trim();
        booking.status = 'query_raised';
        booking.queryMessage = cleanQuery;
        await booking.save();

        // Automatically post the driver's query into their personal Manager chat room
        const formattedChatContent =
          `📋 Booking Query (${booking.passengerName} • ${booking.scheduledTime}):\n${cleanQuery}`;

        createdChatMessage = await Message.create({
          roomId: booking.roomId,
          senderId: driverId,
          content: formattedChatContent,
        });

        if (io) {
          io.to(String(booking.roomId)).emit('receive_message', createdChatMessage);
        }
      }

      const updatedPayload = {
        _id: String(booking._id),
        managerId: String(booking.managerId),
        driverId: String(booking.driverId),
        roomId: String(booking.roomId),
        passengerName: booking.passengerName,
        passengerPhone: booking.passengerPhone,
        pickupLocation: booking.pickupLocation,
        dropLocation: booking.dropLocation,
        scheduledTime: booking.scheduledTime,
        notes: booking.notes || '',
        status: booking.status,
        queryMessage: booking.queryMessage || '',
        createdAt: booking.createdAt.toISOString(),
        chatMessage: createdChatMessage,
      };

      if (io) {
        io.to(`user:${booking.managerId}`).emit('booking_status_updated', updatedPayload);
        io.to(`user:${booking.driverId}`).emit('booking_status_updated', updatedPayload);
      }

      res.status(200).json(updatedPayload);
    } catch (error) {
      console.error('Error responding to booking:', error);
      res.status(500).json({ error: 'Failed to update booking response.' });
    }
  }
);

export default router;