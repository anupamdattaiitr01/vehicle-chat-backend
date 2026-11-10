import express, { Application, Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';
import { setupChatSockets } from './sockets/chatHandler.js'; 
import messageRoutes from './routes/messageRoutes.js'; // 1. ADDED: Import the new route handler

dotenv.config();
connectDB();

const app: Application = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// 2. ADDED: Mount the route middleware so the frontends can fetch history
app.use('/api/messages', messageRoutes);

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Pass the io instance to your modular handler
setupChatSockets(io);

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'API is running' });
});

// Note: Ensure your Flutter and React apps are targeting this port (5000 or 5001 depending on your .env)
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});