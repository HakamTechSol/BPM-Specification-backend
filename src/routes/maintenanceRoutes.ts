import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { testSwitches } from '../controllers/maintenanceController';

const router = Router();

router.post('/test-switches',  authenticateToken, testSwitches);

export default router;
