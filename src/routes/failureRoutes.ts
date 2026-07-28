import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { getAllFailures, resolveFailure, resolveAllFailures } from '../controllers/failureController';

const router = Router();

router.get('/',              authenticateToken, getAllFailures);
router.post('/resolve-all',  authenticateToken, resolveAllFailures);
router.post('/:id/resolve',  authenticateToken, resolveFailure);

export default router;
