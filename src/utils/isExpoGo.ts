/**
 * isExpoGo — single flag telling native-only features (push, STT, background
 * location) to no-op inside Expo Go.
 * Dependencies: expo-constants. Consumed by NotificationService, PushService,
 * SpeechService.
 */
import Constants from 'expo-constants';

export const isExpoGo =
  Constants.appOwnership === 'expo' ||
  Constants.executionEnvironment === 'storeClient';