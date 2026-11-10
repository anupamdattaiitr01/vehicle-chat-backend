import express, { Application, Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';
import { setupChatSockets } from './sockets/chatHandler.js'; // Import the new handler

dotenv.config();
connectDB();

const app: Application = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Pass the io instance to your modular handler
setupChatSockets(io);

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'API is running' });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});