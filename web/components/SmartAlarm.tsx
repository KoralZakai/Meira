'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@/lib/types';
import type { UserProfile } from '@/lib/profile';

// Smart clock alarm: from today's earliest fixed task, derive wake-up and
// leave-home times using the user's routine/buffer, show a live countdown, and
// (optionally) fire a browser notification + chime when it's time to leave.

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function fromMin(total: number): string {
  const t = ((total % 1440) + 1440) % 1440;
  return `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toString().padStart(2, '0')}`;
}

export default function SmartAlarm({
  tasks,
  profile,
  dateKey,
}: {
  tasks: Task[];
  profile: UserProfile | null;
  dateKey: string;
}) {
  const [now, setNow] = useState(() => new Date());
  const [armed, setArmed] = useState(false);
  const [fired, setFired] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const plan = useMemo(() => {
    const fixed = tasks
      .filter((t) => t.date === dateKey && t.fixedTime && t.status !== 'complete')
      .sort((a, b) => (a.fixedTime! < b.fixedTime! ? -1 : 1));
    const first = fixed[0];
    if (!first) return null;

    const routine = profile?.morningRoutineMinutes ?? 45;
    const buffer = profile?.wakeBufferMinutes ?? 15;
    const travel = 30; // web has no live transit; assume a 30-min commute buffer
    const arrive = toMin(first.fixedTime!);
    const leaveBy = arrive - travel;
    const wakeBy = leaveBy - routine - buffer;
    return { first, wakeBy: fromMin(wakeBy), leaveBy: fromMin(leaveBy), leaveByMin: leaveBy };
  }, [tasks, profile, dateKey]);

  // Fire the alarm at leave-home time (only for today).
  useEffect(() => {
    if (!armed || fired || !plan) return;
    const isToday = dateKey === new Date().toISOString().slice(0, 10);
    if (!isToday) return;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= plan.leaveByMin && nowMin <= plan.leaveByMin + 2) {
      setFired(true);
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('🚪 Time to leave!', { body: `${plan.first.text} at ${plan.first.fixedTime}` });
        }
        // Short chime via WebAudio (no asset needed).
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        osc.start();
        osc.stop(ctx.currentTime + 0.8);
      } catch {
        /* best-effort */
      }
    }
  }, [armed, fired, plan, now, dateKey]);

  if (!plan) return null;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const minsToLeave = plan.leaveByMin - nowMin;
  const countdown =
    dateKey !== new Date().toISOString().slice(0, 10)
      ? null
      : minsToLeave > 0
        ? `in ${Math.floor(minsToLeave / 60) ? `${Math.floor(minsToLeave / 60)}h ` : ''}${minsToLeave % 60}m`
        : 'now';

  const arm = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
    setArmed(true);
  };

  return (
    <div className="smart-alarm">
      <div className="alarm-icon">⏰</div>
      <div className="alarm-body">
        <div className="alarm-times">
          <span>Wake by <b>{plan.wakeBy}</b></span>
          <span className="dot">·</span>
          <span>🚪 Leave by <b>{plan.leaveBy}</b>{countdown && <em> ({countdown})</em>}</span>
        </div>
        <div className="alarm-task muted">First: {plan.first.text} @ {plan.first.fixedTime}</div>
      </div>
      <button className={`btn ${armed ? 'btn-ghost' : 'btn-primary'} alarm-btn`} onClick={arm} disabled={armed}>
        {fired ? '🔔 Go!' : armed ? 'Alarm set' : 'Set alarm'}
      </button>
    </div>
  );
}
