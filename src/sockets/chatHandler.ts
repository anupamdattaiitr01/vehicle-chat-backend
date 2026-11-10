import { Server, Socket } from 'socket.io';
import Message from '../models/Message.js'; // ESM requires the .js extension

export const setupChatSockets = (io: Server) => {
  io.on('connection', (socket: Socket) => {
    console.log(`User connected to socket: ${socket.id}`);

    // 1. Room Management
    socket.on('join_room', (data: { roomId: string, userId: string }) => {
      socket.join(data.roomId);
      console.log(`User ${data.userId} joined room: ${data.roomId}`);
    });

    // 2. Message Handling
    socket.on('send_message', async (data: { roomId: string, senderId: string, content: string }) => {
      try {
        // Save the message to MongoDB first to ensure persistence
        const newMessage = await Message.create({
          roomId: data.roomId,
          senderId: data.senderId,
          content: data.content,
        });

        // Broadcast the saved message to EVERYONE in the room, including the sender
        // The frontend will listen for 'receive_message' to append it to the chat UI
        io.to(data.roomId).emit('receive_message', newMessage);
      } catch (error) {
        console.error('Error saving message:', error);
        socket.emit('message_error', { error: 'Failed to send message' });
      }
    });

    // 3. Typing Indicators
    socket.on('typing', (data: { roomId: string, userName: string }) => {
      // socket.to() broadcasts to everyone in the room EXCEPT the person typing
      socket.to(data.roomId).emit('display_typing', { userName: data.userName, isTyping: true });
    });

    socket.on('stop_typing', (data: { roomId: string }) => {
      socket.to(data.roomId).emit('display_typing', { isTyping: false });
    });

    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.id}`);
    });
  });
};