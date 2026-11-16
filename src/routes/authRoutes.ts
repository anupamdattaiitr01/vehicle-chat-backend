import { Router } from 'express';
import {
  registerUser,
  loginUser,
  updateFcmToken,
  removeFcmToken,
} from '../controllers/authController.js';

const router = Router();

// Endpoint: POST /api/auth/register
router.post('/register', registerUser);

// Endpoint: POST /api/auth/login
router.post('/login', loginUser);

// ADDED: Save or refresh the device FCM token for push notifications
router.post('/fcm-token', updateFcmToken);

// ADDED: Clear the device FCM token when the driver logs out
router.delete('/fcm-token', removeFcmToken);

export default router;