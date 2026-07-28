import { Router } from 'express';
import { getPitchStatus, resetPitchError } from '../controllers/guestController';

const router = Router();

router.get('/pitch/:pltsnr', getPitchStatus);
router.post('/pitch/:pltsnr/reset', resetPitchError);

export default router;
