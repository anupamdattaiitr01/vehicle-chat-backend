import mongoose, { Schema, Document } from 'mongoose';

export interface IRoom extends Document {
  type: 'personal' | 'community';
  participants: mongoose.Types.ObjectId[];
}

const RoomSchema: Schema = new Schema({
  type: { type: String, enum: ['personal', 'community'], required: true },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

export default mongoose.model<IRoom>('Room', RoomSchema);