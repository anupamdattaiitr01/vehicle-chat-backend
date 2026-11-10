import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  role: 'manager' | 'driver';
  managerId?: mongoose.Types.ObjectId; // Null for managers, required for drivers
}

const UserSchema: Schema = new Schema({
  name: { type: String, required: true },
  role: { type: String, enum: ['manager', 'driver'], required: true },
  managerId: { type: Schema.Types.ObjectId, ref: 'User', required: false }
}, { timestamps: true });

export default mongoose.model<IUser>('User', UserSchema);