import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  phone: string;
  password: string;
  role: 'manager' | 'driver';
  managerId?: mongoose.Types.ObjectId;
  fcmToken?: string;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['manager', 'driver'], required: true },
    managerId: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    fcmToken: { type: String, required: false, trim: true, index: true, sparse: true },
  },
  { timestamps: true }
);

export default mongoose.model<IUser>('User', UserSchema);