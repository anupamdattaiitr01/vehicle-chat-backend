
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken'; // ADDED: Import for JWT verification
// This import helps to define the MongoDB message model
import Message from '../models/Message.js'; 

// ADDED: The same secret key used in authController
const JWT_SECRET = process.env.JWT_SECRET || 'fleet_super_secret_key_2026';

// Server is the whole connection 
// Socket is the individual connection

// The Socket io server connection manages all the connected clients and their communication
// And the socket represent individual client connection
// Each connection has its own socket id

export const setupChatSockets = (io: Server) => {
  
  // ADDED: Socket Authentication Middleware
  // This intercepts the connection request before establishing the socket
  io.use((socket, next) => {
    // The frontend will send the token inside the handshake auth object
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    try {
      // Verify the token is valid and hasn't expired
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Attach the decoded user payload to the socket session for future use
      socket.data.user = decoded; 
      
      next(); // Token is valid, allow connection!
    } catch (err) {
      return next(new Error('Authentication error: Invalid or expired token'));
    }
  });

  // This statement is executed mutiple times, when ever the a new user connects to the server
  // Each connection has its own socket id
  io.on('connection', (socket: Socket) => {
    console.log(`User connected to socket: ${socket.id} (Authenticated as: ${socket.data.user.name})`); // UPDATED: Log the real user name
    // IMP // 
    // Socket IDs can change after reconnection so this is not about the client id, or something like that we can use it as client id

    // This is the room allotment / management code !
    socket.on('join_room', (data: { roomId: string, userId: string }) => {
      socket.join(data.roomId);
      console.log(`User with id: ${data.userId} joined room wih id: ${data.roomId}`);
    });

    // This is the message handling code
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

    // This is the code that handles the typing 
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