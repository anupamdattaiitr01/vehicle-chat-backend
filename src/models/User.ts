import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  phone: string;       // ADDED: For phone number authentication
  password: string;    // ADDED: For secure login
  role: 'manager' | 'driver';
  managerId?: mongoose.Types.ObjectId;
  fcmToken?: string;   // ADDED: Stores the device FCM token for background/killed push notifications
}

const UserSchema: Schema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true }, // ADDED: Must be unique so we can look up the user
  password: { type: String, required: true },            // ADDED: Will store the bcrypt hash
  role: { type: String, enum: ['manager', 'driver'], required: true },
  managerId: { type: Schema.Types.ObjectId, ref: 'User', required: false },
  fcmToken: { type: String, required: false }            // ADDED: Updated on login and cleared on logout
}, { timestamps: true });

export default mongoose.model<IUser>('User', UserSchema);