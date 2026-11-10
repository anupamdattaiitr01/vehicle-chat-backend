// src/controllers/messageController.ts
import { Request, Response } from 'express';
import Message from '../models/Message.js';// Ensure .js extension is present for ES Modules

export const getMessagesByRoom = async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomId } = req.params;

    // Find all messages for the room and sort them chronologically (oldest first)
    const messages = await Message.find({ roomId }).sort({ createdAt: 1 });

    res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch message history' });
  }
};