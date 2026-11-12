import express, { Application, Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';
import { setupChatSockets } from './sockets/chatHandler.js'; 
import messageRoutes from './routes/messageRoutes.js'; 
import authRoutes from './routes/authRoutes.js';

dotenv.config();
connectDB();

const app: Application = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// The API endpoint that is used to fetch the history of the messages from the mongo DB
app.use('/api/messages', messageRoutes);
// API route for the authentication part !
app.use('/api/auth', authRoutes);

// HTTP server creation and passing the app 
// HTTP server only help in receiving request
// Main logic and request handling and giving response is related to app
const httpServer = createServer(app);

// This is the socket.io server creation!
// Server is the built in class that comes with socket.io
const io = new Server(httpServer, {
  // These are the configuration of the server
  // This helps to allow only allowed origin and certain methods during handshake 
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Pass the io instance to your modular handler
// This is the chat event handler
// Handles all the socket.io evenets
setupChatSockets(io);

// This is the health check point
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'API is running' });
});

// From this the server listening to the requests
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});