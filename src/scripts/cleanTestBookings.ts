import 'dotenv/config';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  'mongodb://127.0.0.1:27017/vehicle_chat';

async function cleanTestBookings() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    const result = await Booking.deleteMany({});
    console.log(`Deleted ${result.deletedCount} test/legacy booking(s) from database.`);
  } catch (error) {
    console.error('Failed to clean test bookings:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

cleanTestBookings();