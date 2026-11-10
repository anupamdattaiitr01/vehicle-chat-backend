// src/routes/messageRoutes.ts
import { Router } from 'express';
import { getMessagesByRoom } from '../controllers/messageController.js';

const router = Router();

// Endpoint: GET /api/messages/:roomId
router.get('/:roomId', getMessagesByRoom);

export default router;