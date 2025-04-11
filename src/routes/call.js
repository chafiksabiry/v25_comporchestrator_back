import express from 'express';
import { callController } from '../controllers/callController.js';

const router = express.Router();

// Handle incoming calls
router.post('/answer', callController.handleAnswer.bind(callController));

// Initiate outbound call
router.post('/dial', callController.initiateCall.bind(callController));

// End active call
router.post('/hangup', callController.hangupCall.bind(callController));

// Start call recording
router.post('/record/start', callController.startRecording.bind(callController));

// Stop call recording
router.post('/record/stop', callController.stopRecording.bind(callController));

export const callRoutes = router;