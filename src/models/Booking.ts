import mongoose, { Schema, Document } from 'mongoose';

export type BookingStatus = 'pending' | 'confirmed' | 'query_raised';

export interface IBooking extends Document {
  managerId: mongoose.Types.ObjectId;
  driverId: mongoose.Types.ObjectId;
  roomId: mongoose.Types.ObjectId;
  passengerName: string;
  passengerPhone: string;
  pickupLocation: string;
  dropLocation: string;
  scheduledTime: string;
  notes?: string;
  status: BookingStatus;
  queryMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BookingSchema = new Schema<IBooking>(
  {
    managerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    roomId: {
      type: Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    passengerName: {
      type: String,
      required: true,
      trim: true,
    },
    passengerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    pickupLocation: {
      type: String,
      required: true,
      trim: true,
    },
    dropLocation: {
      type: String,
      required: true,
      trim: true,
    },
    scheduledTime: {
      type: String,
      required: true,
      trim: true,
    },
    notes: {
      type: String,
      required: false,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'query_raised'],
      default: 'pending',
    },
    queryMessage: {
      type: String,
      required: false,
      trim: true,
    },
  },
  { timestamps: true }
);

BookingSchema.index({ driverId: 1, createdAt: -1 });
BookingSchema.index({ managerId: 1, createdAt: -1 });

export default mongoose.model<IBooking>('Booking', BookingSchema);