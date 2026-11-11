import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
  roomId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  content: string;
}

const MessageSchema: Schema = new Schema({
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true }
}, { timestamps: true });

export default mongoose.model<IMessage>('Message', MessageSchema);
