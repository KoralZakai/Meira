import { NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET() {
  const url = process.env.WHATSAPP_SERVER_URL;
  if (!url) return NextResponse.json({ error: 'WHATSAPP_SERVER_URL not set' }, { status: 500 });
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'ping failed' }, { status: 502 });
  }
}
