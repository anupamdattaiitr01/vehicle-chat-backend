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

function formatDisplaySchedule(date: Date, durationMinutes: number): string {
  const datePart = date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const hrs = durationMinutes / 60;
  const durationLabel =
    durationMinutes < 60
      ? `${durationMinutes} mins`
      : Number.isInteger(hrs)
      ? `${hrs} hr${hrs > 1 ? 's' : ''}`
      : `${hrs.toFixed(1)} hrs`;

  return `${datePart}, ${timePart} (${durationLabel})`;
}

// 1. Manager assigns a ride booking to a driver (future-only & zero cross-timing)
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
      scheduledAt,
      scheduledTime,
      durationMinutes,
      notes,
    } = req.body;

    if (
      !driverId ||
      !passengerName?.trim() ||
      !passengerPhone?.trim() ||
      !pickupLocation?.trim() ||
      !dropLocation?.trim() ||
      !scheduledAt
    ) {
      res.status(400).json({
        error: 'Driver, passenger details, pickup/drop locations, and pickup date & time are required.',
      });
      return;
    }

    if (!/^\d{10}$/.test(String(passengerPhone).trim())) {
      res.status(400).json({ error: 'Passenger phone number must be exactly 10 digits.' });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      res.status(400).json({ error: 'Invalid driver ID.' });
      return;
    }

    const parsedStart = new Date(scheduledAt);
    if (Number.isNaN(parsedStart.getTime())) {
      res.status(400).json({ error: 'Invalid pickup date and time format.' });
      return;
    }

    if (parsedStart.getTime() < Date.now() - 60_000) {
      res.status(400).json({
        error: 'Pickup date and time cannot be in the past. Please select present or future time.',
      });
      return;
    }

    const parsedDuration = Math.min(
      720,
      Math.max(15, Number(durationMinutes) || 60)
    );
    const parsedEnd = new Date(parsedStart.getTime() + parsedDuration * 60_000);

    const driver = await User.findOne({
      _id: driverId,
      role: 'driver',
      managerId,
    });

    if (!driver) {
      res.status(404).json({ error: 'Driver not found or not assigned to your fleet.' });
      return;
    }

    // Prevent cross-timing with any non-cancelled upcoming ride
    const conflictingBooking = await Booking.findOne({
      driverId: driver._id,
      status: { $in: ['pending', 'confirmed', 'query_raised'] },
      scheduledAt: { $lt: parsedEnd },
      estimatedEndAt: { $gt: parsedStart },
    }).sort({ scheduledAt: 1 });

    if (conflictingBooking) {
      res.status(409).json({
        error: `Schedule conflict: ${driver.name} already has a ride for ${conflictingBooking.passengerName} at ${conflictingBooking.scheduledTime}.`,
      });
      return;
    }

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

    const displaySchedule =
      typeof scheduledTime === 'string' && scheduledTime.trim().length > 0
        ? scheduledTime.trim()
        : formatDisplaySchedule(parsedStart, parsedDuration);

    const booking = await Booking.create({
      managerId,
      driverId: driver._id,
      roomId: personalRoom._id,
      passengerName: passengerName.trim(),
      passengerPhone: String(passengerPhone).trim(),
      pickupLocation: pickupLocation.trim(),
      dropLocation: dropLocation.trim(),
      scheduledTime: displaySchedule,
      scheduledAt: parsedStart,
      estimatedEndAt: parsedEnd,
      durationMinutes: parsedDuration,
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
      scheduledAt: booking.scheduledAt.toISOString(),
      estimatedEndAt: booking.estimatedEndAt.toISOString(),
      durationMinutes: booking.durationMinutes,
      notes: booking.notes || '',
      status: booking.status,
      queryMessage: booking.queryMessage || '',
      createdAt: booking.createdAt.toISOString(),
    };

    const io = req.app.get('io') as Server | undefined;
    if (io) {
      io.to(`user:${driver._id}`).emit('booking_assigned', bookingPayload);
    }

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
          scheduledAt: bookingPayload.scheduledAt,
          estimatedEndAt: bookingPayload.estimatedEndAt,
          durationMinutes: String(bookingPayload.durationMinutes),
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

// 2. Fetch ONLY upcoming non-cancelled bookings sorted in ASCENDING order
router.get('/my-bookings', verifyToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = String(req.user?.userId);
    const role = req.user?.role;
    const now = new Date();

    const ownerFilter = role === 'manager' ? { managerId: userId } : { driverId: userId };

    const bookings = await Booking.find({
      ...ownerFilter,
      status: { $ne: 'cancelled' },
      scheduledAt: { $exists: true },
      estimatedEndAt: { $gte: now },
    })
      .sort({ scheduledAt: 1 })
      .limit(50)
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
        scheduledAt: b.scheduledAt.toISOString(),
        estimatedEndAt: b.estimatedEndAt.toISOString(),
        durationMinutes: b.durationMinutes || 60,
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

// 3. Driver confirms booking or raises a query (allowed even after confirmation)
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

      if (booking.status === 'cancelled') {
        res.status(400).json({ error: 'This ride has been cancelled by your manager.' });
        return;
      }

      const wasConfirmed = booking.status === 'confirmed';
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

        const prefix = wasConfirmed
          ? `📋 Post-Confirmation Query (${booking.passengerName} • ${booking.scheduledTime}):`
          : `📋 Booking Query (${booking.passengerName} • ${booking.scheduledTime}):`;

        createdChatMessage = await Message.create({
          roomId: booking.roomId,
          senderId: driverId,
          content: `${prefix}\n${cleanQuery}`,
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
        scheduledAt: booking.scheduledAt
          ? booking.scheduledAt.toISOString()
          : booking.createdAt.toISOString(),
        estimatedEndAt: booking.estimatedEndAt
          ? booking.estimatedEndAt.toISOString()
          : booking.createdAt.toISOString(),
        durationMinutes: booking.durationMinutes || 60,
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

// 4. Manager cancels an upcoming ride
router.patch(
  '/:bookingId/cancel',
  verifyToken,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (req.user?.role !== 'manager') {
        res.status(403).json({ error: 'Only managers can cancel rides.' });
        return;
      }

      const managerId = String(req.user.userId);
      const bookingId = Array.isArray(req.params.bookingId)
        ? req.params.bookingId[0]
        : String(req.params.bookingId ?? '');

      if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
        res.status(400).json({ error: 'Invalid booking ID.' });
        return;
      }

      const booking = await Booking.findOne({ _id: bookingId, managerId });
      if (!booking) {
        res.status(404).json({ error: 'Ride booking not found.' });
        return;
      }

      if (booking.status === 'cancelled') {
        res.status(400).json({ error: 'Ride is already cancelled.' });
        return;
      }

      booking.status = 'cancelled';
      await booking.save();

      const io = req.app.get('io') as Server | undefined;

      const cancelNotice = await Message.create({
        roomId: booking.roomId,
        senderId: managerId,
        content: `🚫 Ride Cancelled (${booking.passengerName} • ${booking.scheduledTime}): This trip has been cancelled by the manager.`,
      });

      if (io) {
        io.to(String(booking.roomId)).emit('receive_message', cancelNotice);
      }

      const cancelledPayload = {
        _id: String(booking._id),
        managerId: String(booking.managerId),
        driverId: String(booking.driverId),
        roomId: String(booking.roomId),
        passengerName: booking.passengerName,
        passengerPhone: booking.passengerPhone,
        pickupLocation: booking.pickupLocation,
        dropLocation: booking.dropLocation,
        scheduledTime: booking.scheduledTime,
        scheduledAt: booking.scheduledAt.toISOString(),
        estimatedEndAt: booking.estimatedEndAt.toISOString(),
        durationMinutes: booking.durationMinutes || 60,
        notes: booking.notes || '',
        status: 'cancelled' as const,
        queryMessage: booking.queryMessage || '',
        createdAt: booking.createdAt.toISOString(),
      };

      if (io) {
        io.to(`user:${booking.managerId}`).emit('booking_status_updated', cancelledPayload);
        io.to(`user:${booking.driverId}`).emit('booking_status_updated', cancelledPayload);
      }

      res.status(200).json(cancelledPayload);
    } catch (error) {
      console.error('Error cancelling booking:', error);
      res.status(500).json({ error: 'Failed to cancel ride.' });
    }
  }
);

// 5. Manager reallocates an upcoming ride to another driver
router.patch(
  '/:bookingId/reallocate',
  verifyToken,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (req.user?.role !== 'manager') {
        res.status(403).json({ error: 'Only managers can reallocate rides.' });
        return;
      }

      const managerId = String(req.user.userId);
      const managerName = req.user.name || 'Manager';
      const bookingId = Array.isArray(req.params.bookingId)
        ? req.params.bookingId[0]
        : String(req.params.bookingId ?? '');
      const { newDriverId } = req.body as { newDriverId?: string };

      if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
        res.status(400).json({ error: 'Invalid booking ID.' });
        return;
      }

      if (!newDriverId || !mongoose.Types.ObjectId.isValid(newDriverId)) {
        res.status(400).json({ error: 'Please select a valid target driver.' });
        return;
      }

      const booking = await Booking.findOne({ _id: bookingId, managerId });
      if (!booking) {
        res.status(404).json({ error: 'Ride booking not found.' });
        return;
      }

      if (booking.status === 'cancelled') {
        res.status(400).json({ error: 'Cannot reallocate a cancelled ride.' });
        return;
      }

      const previousDriverId = String(booking.driverId);
      const previousRoomId = String(booking.roomId);

      if (previousDriverId === String(newDriverId)) {
        res.status(400).json({ error: 'Ride is already assigned to this driver.' });
        return;
      }

      const targetDriver = await User.findOne({
        _id: newDriverId,
        role: 'driver',
        managerId,
      });

      if (!targetDriver) {
        res.status(404).json({ error: 'Target driver not found in your fleet.' });
        return;
      }

      // Check cross-timing conflict on the target driver
      const conflictingBooking = await Booking.findOne({
        _id: { $ne: booking._id },
        driverId: targetDriver._id,
        status: { $in: ['pending', 'confirmed', 'query_raised'] },
        scheduledAt: { $lt: booking.estimatedEndAt },
        estimatedEndAt: { $gt: booking.scheduledAt },
      }).sort({ scheduledAt: 1 });

      if (conflictingBooking) {
        res.status(409).json({
          error: `Schedule conflict: ${targetDriver.name} already has a ride for ${conflictingBooking.passengerName} at ${conflictingBooking.scheduledTime}.`,
        });
        return;
      }

      // Find or create personal chat room with the new driver
      let targetRoom = await Room.findOne({
        type: 'personal',
        participants: { $all: [managerId, targetDriver._id] },
      });

      if (!targetRoom) {
        targetRoom = await Room.create({
          type: 'personal',
          participants: [managerId, targetDriver._id],
        });
      }

      booking.driverId = targetDriver._id;
      booking.roomId = targetRoom._id;
      booking.status = 'pending';
      booking.queryMessage = '';
      await booking.save();

      const io = req.app.get('io') as Server | undefined;

      // Notify previous driver in their chat room
      const reallocateNotice = await Message.create({
        roomId: previousRoomId,
        senderId: managerId,
        content: `🔄 Ride Reallocated (${booking.passengerName} • ${booking.scheduledTime}): This trip has been reassigned to ${targetDriver.name}.`,
      });

      if (io) {
        io.to(previousRoomId).emit('receive_message', reallocateNotice);
      }

      const reallocatedPayload = {
        _id: String(booking._id),
        managerId,
        managerName,
        driverId: String(targetDriver._id),
        driverName: targetDriver.name,
        roomId: String(targetRoom._id),
        passengerName: booking.passengerName,
        passengerPhone: booking.passengerPhone,
        pickupLocation: booking.pickupLocation,
        dropLocation: booking.dropLocation,
        scheduledTime: booking.scheduledTime,
        scheduledAt: booking.scheduledAt.toISOString(),
        estimatedEndAt: booking.estimatedEndAt.toISOString(),
        durationMinutes: booking.durationMinutes || 60,
        notes: booking.notes || '',
        status: booking.status,
        queryMessage: '',
        createdAt: booking.createdAt.toISOString(),
      };

      if (io) {
        // Remove from previous driver & update manager
        io.to(`user:${previousDriverId}`).emit('booking_reallocated', {
          bookingId: String(booking._id),
          previousDriverId,
          booking: reallocatedPayload,
        });
        io.to(`user:${managerId}`).emit('booking_reallocated', {
          bookingId: String(booking._id),
          previousDriverId,
          booking: reallocatedPayload,
        });

        // Dispatch live incoming alert to the newly allocated driver
        io.to(`user:${targetDriver._id}`).emit('booking_assigned', reallocatedPayload);
      }

      if (targetDriver.fcmToken) {
        await sendBookingAlertPush({
          token: targetDriver.fcmToken,
          data: {
            type: 'BOOKING_ASSIGNED',
            bookingId: reallocatedPayload._id,
            managerId: reallocatedPayload.managerId,
            managerName: reallocatedPayload.managerName,
            driverId: reallocatedPayload.driverId,
            roomId: reallocatedPayload.roomId,
            passengerName: reallocatedPayload.passengerName,
            passengerPhone: reallocatedPayload.passengerPhone,
            pickupLocation: reallocatedPayload.pickupLocation,
            dropLocation: reallocatedPayload.dropLocation,
            scheduledTime: reallocatedPayload.scheduledTime,
            scheduledAt: reallocatedPayload.scheduledAt,
            estimatedEndAt: reallocatedPayload.estimatedEndAt,
            durationMinutes: String(reallocatedPayload.durationMinutes),
            notes: reallocatedPayload.notes,
            status: reallocatedPayload.status,
            createdAt: reallocatedPayload.createdAt,
          },
        });
      }

      res.status(200).json(reallocatedPayload);
    } catch (error) {
      console.error('Error reallocating booking:', error);
      res.status(500).json({ error: 'Failed to reallocate ride.' });
    }
  }
);

export default router;