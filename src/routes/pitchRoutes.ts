import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { getAllPitches, triggerSyncCommand, resolveHash } from '../controllers/pitchController';

const router = Router();

router.get('/', authenticateToken, getAllPitches);
router.post('/trigger-sync', authenticateToken, triggerSyncCommand);
router.get('/resolve/:hash', resolveHash);

export default router;
