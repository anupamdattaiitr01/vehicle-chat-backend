import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import Message from '../models/Message.js';
import Room from '../models/Room.js';
import User from '../models/User.js';
import { sendPushNotification } from '../config/firebase.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';

// Helper to verify if a user is allowed to access a given room
const canAccessRoom = async (roomId: string, userId: string): Promise<boolean> => {
  if (!mongoose.Types.ObjectId.isValid(roomId)) return false;

  const room = await Room.findById(roomId);
  if (!room) return false;

  // Anyone authenticated can access the shared community room
  if (room.type === 'community') return true;

  // For personal rooms, strictly allow only the assigned manager and driver
  return room.participants.some((participantId) => participantId.toString() === userId);
};

export const setupChatSockets = (io: Server) => {
  // Socket Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.data.user = decoded;
      next();
    } catch (err) {
      return next(new Error('Authentication error: Invalid or expired token'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const connectedUserId = String(socket.data.user.userId);
    const connectedRole = socket.data.user.role;

    // Close any stale zombie sockets for the same driver so ghost sockets never block FCM pushes
    if (connectedRole === 'driver') {
      const existingSockets = await io.fetchSockets();
      for (const s of existingSockets) {
        if (s.id !== socket.id && String(s.data.user?.userId) === connectedUserId) {
          console.log(`Disconnecting stale driver socket: ${s.id}`);
          s.disconnect(true);
        }
      }
    }

    console.log(`User connected to socket: ${socket.id} (Authenticated as: ${socket.data.user.name})`);

    // Room allotment / management
    socket.on('join_room', async (data: { roomId: string; userId: string }) => {
      const authenticatedUserId = String(socket.data.user.userId);
      const roomId = String(data.roomId);
      const allowed = await canAccessRoom(roomId, authenticatedUserId);

      if (!allowed) {
        socket.emit('room_error', { error: 'Unauthorized room access' });
        return;
      }

      // Drivers only view one tab at a time—ensure they leave any previous room first
      if (socket.data.user.role === 'driver') {
        for (const existingRoom of socket.rooms) {
          if (existingRoom !== socket.id && existingRoom !== roomId) {
            socket.leave(existingRoom);
          }
        }
      }

      socket.join(roomId);
      console.log(`User with id: ${authenticatedUserId} joined room with id: ${roomId}`);
    });

    // Leave room when user switches tabs or backgrounds the mobile app
    socket.on('leave_room', (data: { roomId: string; userId?: string }) => {
      if (!data?.roomId) return;
      const roomId = String(data.roomId);
      socket.leave(roomId);
      console.log(`User with id: ${socket.data.user.userId} left room with id: ${roomId}`);
    });

    // Message handling + FCM dispatch
    socket.on('send_message', async (data: { roomId: string; senderId: string; content: string }) => {
      try {
        const authenticatedUserId = String(socket.data.user.userId);
        const senderName = socket.data.user.name || 'Fleet Alert';
        const roomId = String(data.roomId);
        const allowed = await canAccessRoom(roomId, authenticatedUserId);

        if (!allowed) {
          socket.emit('message_error', { error: 'Unauthorized room access' });
          return;
        }

        // Save the message to MongoDB first to ensure persistence
        const newMessage = await Message.create({
          roomId,
          senderId: authenticatedUserId,
          content: data.content,
        });

        // Broadcast the saved message to everyone currently viewing this room
        io.to(roomId).emit('receive_message', newMessage);

        // Check which users are actively viewing THIS exact room right now
        const activeSocketsInRoom = await io.in(roomId).fetchSockets();
        const activeUserIdsInRoom = new Set(
          activeSocketsInRoom.map((s) => String(s.data.user?.userId))
        );

        // Dispatch FCM Push Notifications for drivers on another tab, in background, or offline
        const room = await Room.findById(roomId);
        if (!room) {
          console.warn(`[FCM] Room ${roomId} not found in DB.`);
          return;
        }

        if (room.type === 'personal') {
          const recipientIds = room.participants
            .map((id) => id.toString())
            .filter((id) => id !== authenticatedUserId && !activeUserIdsInRoom.has(id));

          console.log(
            `[FCM Personal] Room ${roomId} | Active in room: [${Array.from(activeUserIdsInRoom).join(', ')}] | Target recipients: [${recipientIds.join(', ')}]`
          );

          if (recipientIds.length > 0) {
            const recipients = await User.find({
              _id: { $in: recipientIds },
              fcmToken: { $exists: true, $ne: '' },
            }).select('name fcmToken');

            const tokens = recipients
              .map((u) => u.fcmToken)
              .filter((t): t is string => Boolean(t));

            console.log(
              `[FCM Personal] Found ${tokens.length}/${recipientIds.length} recipient(s) with saved fcmToken`
            );

            if (tokens.length > 0) {
              await sendPushNotification({
                tokens,
                title: senderName,
                body: data.content,
                data: {
                  roomId,
                  roomType: 'personal',
                  senderName,
                },
              });
            }
          }
        } else if (room.type === 'community') {
          const excludedIds = [
            authenticatedUserId,
            ...Array.from(activeUserIdsInRoom),
          ];

          const drivers = await User.find({
            role: 'driver',
            _id: { $nin: excludedIds },
            fcmToken: { $exists: true, $ne: '' },
          }).select('name fcmToken');

          const tokens = drivers
            .map((d) => d.fcmToken)
            .filter((t): t is string => Boolean(t));

          console.log(
            `[FCM Community] Room ${roomId} | Excluded active IDs: [${excludedIds.join(', ')}] | Drivers with fcmToken: ${tokens.length}`
          );

          if (tokens.length > 0) {
            await sendPushNotification({
              tokens,
              title: `Community Hub • ${senderName}`,
              body: data.content,
              data: {
                roomId,
                roomType: 'community',
                senderName,
              },
            });
          }
        }
      } catch (error) {
        console.error('Error saving message:', error);
        socket.emit('message_error', { error: 'Failed to send message' });
      }
    });

    // Typing indicators
    socket.on('typing', (data: { roomId: string; userName: string }) => {
      socket.to(String(data.roomId)).emit('display_typing', { userName: data.userName, isTyping: true });
    });

    socket.on('stop_typing', (data: { roomId: string }) => {
      socket.to(String(data.roomId)).emit('display_typing', { isTyping: false });
    });

    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.id}`);
    });
  });
};

// import { Server, Socket } from 'socket.io';
// // This import helps to define the MongoDB message model
// import Message from '../models/Message.js'; 

// // Server is the whole connection 
// // Socket is the individual connection

// // The Socket io server connection manages all the connected clients and their communication
// // And the socket represent individual client connection
// // Each connection has its own socket id

// export const setupChatSockets = (io: Server) => {
//   // This statement is executed mutiple times, when ever the a new user connects to the server
//   // Each connection has its own socket id
//   io.on('connection', (socket: Socket) => {
//     console.log(`User connected to socket: ${socket.id}`);
//     // IMP // 
//     // Socket IDs can change after reconnection so this is not about the client id, or something like that we can use it as client id

//     // This is the room allotment / management code !
//     socket.on('join_room', (data: { roomId: string, userId: string }) => {
//       socket.join(data.roomId);
//       console.log(`User with id: ${data.userId} joined room wih id: ${data.roomId}`);
//     });

//     // This is the message handling code
//     socket.on('send_message', async (data: { roomId: string, senderId: string, content: string }) => {
//       try {
//         // Save the message to MongoDB first to ensure persistence
//         const newMessage = await Message.create({
//           roomId: data.roomId,
//           senderId: data.senderId,
//           content: data.content,
//         });

//         // Broadcast the saved message to EVERYONE in the room, including the sender
//         // The frontend will listen for 'receive_message' to append it to the chat UI
//         io.to(data.roomId).emit('receive_message', newMessage);
//       } catch (error) {
//         console.error('Error saving message:', error);
//         socket.emit('message_error', { error: 'Failed to send message' });
//       }
//     });

//     // This is the code that handles the typing 
//     socket.on('typing', (data: { roomId: string, userName: string }) => {
//       // socket.to() broadcasts to everyone in the room EXCEPT the person typing
//       socket.to(data.roomId).emit('display_typing', { userName: data.userName, isTyping: true });
//     });

//     socket.on('stop_typing', (data: { roomId: string }) => {
//       socket.to(data.roomId).emit('display_typing', { isTyping: false });
//     });

//     socket.on('disconnect', () => {
//       console.log(`User disconnected: ${socket.id}`);
//     });
//   });
// };