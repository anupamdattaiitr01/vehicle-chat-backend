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
  if (!isFirebaseInitialized) {
    console.warn('[FCM] Push skipped: Firebase Admin SDK is not initialized.');
    return;
  }

  if (tokens.length === 0) {
    console.warn('[FCM] Push skipped: No recipient FCM tokens provided.');
    return;
  }

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
          priority: 'max',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
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

    console.log(
      `[FCM] Dispatch complete: ${response.successCount} succeeded, ${response.failureCount} failed`
    );

    // Log errors and clean up stale/uninstalled FCM tokens automatically
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          console.error(`[FCM] Delivery error for token[${idx}]:`, code, resp.error?.message);
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

/**
 * High-priority data-only FCM push for ride assignments.
 * Omitting the top-level `notification` object ensures Android invokes
 * Flutter's background isolate even when the app is terminated so a
 * Full-Screen Intent booking card can wake the screen.
 */
export const sendBookingAlertPush = async ({
  token,
  data,
}: {
  token: string;
  data: Record<string, string>;
}): Promise<void> => {
  if (!isFirebaseInitialized || !token || !token.trim()) {
    console.warn('[FCM Booking] Push skipped: SDK uninitialized or missing driver token.');
    return;
  }

  try {
    const messageId = await getMessaging().send({
      token: token.trim(),
      data,
      android: {
        priority: 'high',
        ttl: 60 * 1000, // 60 seconds urgency window
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default',
          },
        },
      },
    });

    console.log(`[FCM Booking] High-priority booking alert sent: ${messageId}`);
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    console.error('[FCM Booking] Failed to send booking alert:', err.code, err.message);
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      await User.updateOne({ fcmToken: token.trim() }, { $unset: { fcmToken: '' } });
    }
  }
};