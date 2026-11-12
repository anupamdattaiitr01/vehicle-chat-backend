import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  phone: string;       // ADDED: For phone number authentication
  password: string;    // ADDED: For secure login
  role: 'manager' | 'driver';
  managerId?: mongoose.Types.ObjectId;
}

const UserSchema: Schema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true }, // ADDED: Must be unique so we can look up the user
  password: { type: String, required: true },            // ADDED: Will store the bcrypt hash
  role: { type: String, enum: ['manager', 'driver'], required: true },
  managerId: { type: Schema.Types.ObjectId, ref: 'User', required: false }
}, { timestamps: true });

export default mongoose.model<IUser>('User', UserSchema);