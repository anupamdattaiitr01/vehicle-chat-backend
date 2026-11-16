import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import fs from 'fs';
import path from 'path';
import User from '../models/User.js';

let isFirebaseInitialized = false;

try {
  const serviceAccountPath = path.resolve(
    process.cwd(),
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'serviceAccountKey.json'
  );

  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

    if (getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccount),
      });
    }

    isFirebaseInitialized = true;
    console.log('Firebase Admin SDK initialized for push notifications.');
  } else {
    console.warn(
      `Firebase serviceAccountKey.json not found at ${serviceAccountPath}. Push notifications will be skipped until added.`
    );
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin SDK:', error);
}

interface PushPayload {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
}

export const sendPushNotification = async ({
  tokens,
  title,
  body,
  data,
}: PushPayload): Promise<void> => {
  if (!isFirebaseInitialized || tokens.length === 0) return;

  // Deduplicate and filter empty tokens
  const validTokens = Array.from(new Set(tokens.filter((t) => Boolean(t && t.trim()))));
  if (validTokens.length === 0) return;

  try {
    const response = await getMessaging().sendEachForMulticast({
      tokens: validTokens,
      notification: {
        title,
        body,
      },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'fleet_chat_messages',
          sound: 'default',
          priority: 'high',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            contentAvailable: true,
          },
        },
      },
    });

    // Clean up stale/uninstalled FCM tokens automatically
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(validTokens[idx]);
          }
        }
      });

      if (invalidTokens.length > 0) {
        await User.updateMany(
          { fcmToken: { $in: invalidTokens } },
          { $unset: { fcmToken: '' } }
        );
      }
    }
  } catch (error) {
    console.error('Error dispatching FCM push notification:', error);
  }
};