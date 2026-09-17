/**
 * Tools for Task Parsing
 * - parse_time_expression: handles "in 2 days", "tomorrow", "from today for next 5 days", etc.
 * - calculate_travel_time: calculates distance and travel duration using Google Maps
 */

import { GoogleService } from './GoogleService';
import type { UserProfile } from '../types/index';
import { parseTimeExpression, type TimeExpression } from '../utils/timeParser';

// Re-export for convenience
export { parseTimeExpression };
export type { TimeExpression };

/** Travel details parsed out of a task sentence (destination, mode, arrival time). */
export interface TravelInfo {
  destinationAddress: string;
  transportType: 'transit' | 'bus' | 'train' | 'car' | 'walk' | 'bike';
  travelMinutes: number;
  departureTime?: string; // HH:MM (when to leave)
  arrivalTime?: string; // HH:MM (when you arrive)
  leaveHomeBy?: string; // HH:MM
  wakeUpBy?: string; // HH:MM
  transitDetails?: {
    type: string; // 'bus', 'walk', 'train'
    lineNumber?: string;
    stopName?: string;
  }[];
}

/**
 * Tool: Calculate travel time and wake/leave times
 * Uses Google Maps API for real transit data
 */
export async function calculateTravelTime(
  destination: string,
  userProfile: UserProfile,
  arrivalTime?: string, // HH:MM (when you need to arrive)
  referenceDate: string = getTodayString()
): Promise<TravelInfo | null> {
  console.log('[TRAVEL_TOOL] Calculating travel for:', destination, 'arrival:', arrivalTime);

  try {
    // Use GoogleService to get transit plan
    const plan = await GoogleService.getTransitPlan(destination, arrivalTime || '09:00', userProfile, referenceDate);

    if (!plan) {
      console.warn('[TRAVEL_TOOL] No transit plan returned');
      return null;
    }

    return {
      destinationAddress: destination,
      transportType: userProfile.transportType || 'transit',
      travelMinutes: plan.totalDurationMinutes,
      departureTime: plan.leaveHomeAt,
      arrivalTime: plan.arriveAt,
      leaveHomeBy: plan.leaveHomeAt,
      wakeUpBy: calculateWakeUpTime(plan.leaveHomeAt, userProfile.morningRoutineMinutes || 30),
      transitDetails: plan.legs.map(leg => ({
        type: leg.type,
        lineNumber: leg.lineNumber,
        stopName: leg.stopName,
      })),
    };
  } catch (e) {
    console.error('[TRAVEL_TOOL] Error calculating travel:', e);
    return null;
  }
}

/**
 * Helper: Calculate wake up time from leave time
 */
function calculateWakeUpTime(leaveTime: string, morningRoutineMinutes: number): string {
  const [h, m] = leaveTime.split(':').map(Number);
  const leaveMs = h * 60 + m;
  const wakeMs = leaveMs - morningRoutineMinutes;
  const wakeH = Math.floor(wakeMs / 60);
  const wakeM = wakeMs % 60;
  return `${String(wakeH).padStart(2, '0')}:${String(wakeM).padStart(2, '0')}`;
}

function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

