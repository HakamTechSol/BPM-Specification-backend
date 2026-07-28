import { Request, Response, NextFunction } from 'express';

const GATEWAY_URL = 'http://127.0.0.1:9019';
const GATEWAY_TIMEOUT_MS = 3000;

export async function testSwitches(
  req: Request<object, object, { pitchId?: number }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { pitchId } = req.body;

    if (pitchId === undefined || typeof pitchId !== 'number') {
      res.status(400).json({ error: 'pitchId is required and must be a number' });
      return;
    }

    const hardwareBody = `Plts:${pitchId}  -`;

    let gatewayResponded = false;
    try {
      const response = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: hardwareBody,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      gatewayResponded = response.ok || response.status < 500;
    } catch {
      gatewayResponded = false;
    }

    if (gatewayResponded) {
      res.json({
        success: true,
        pitchId,
        message: `Gateway reageerde op plaats ${pitchId}`,
      });
    } else {
      res.json({
        success: false,
        pitchId,
        message: `Gateway reageerde niet op plaats ${pitchId} — controleer de verbinding`,
      });
    }
  } catch (error) {
    next(error);
  }
}
