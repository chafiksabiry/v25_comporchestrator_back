import { callService } from '../services/callService.js';

class CallController {
  async handleAnswer(req, res) {
    try {
      const { call_control_id } = req.body;
      await callService.handleIncomingCall(req.telnyx, call_control_id);
      res.sendStatus(200);
    } catch (error) {
      console.error('Error handling call answer:', error);
      res.status(500).json({ error: 'Failed to handle call' });
    }
  }

  async initiateCall(req, res) {
    try {
      const { to, from } = req.body;
      const call = await callService.initiateCall(
        req.telnyx,
        process.env.TELNYX_CONNECTION_ID,
        to,
        from,
        process.env.BASE_URL
      );
      res.json(call);
    } catch (error) {
      console.error('Error initiating call:', error);
      res.status(500).json({ error: 'Failed to initiate call' });
    }
  }

  async hangupCall(req, res) {
    try {
      const { call_control_id } = req.body;
      await callService.hangupCall(req.telnyx, call_control_id);
      res.sendStatus(200);
    } catch (error) {
      console.error('Error hanging up call:', error);
      res.status(500).json({ error: 'Failed to hang up call' });
    }
  }

  async startRecording(req, res) {
    try {
      const { call_control_id } = req.body;
      await callService.startRecording(req.telnyx, call_control_id);
      res.sendStatus(200);
    } catch (error) {
      console.error('Error starting recording:', error);
      res.status(500).json({ error: 'Failed to start recording' });
    }
  }

  async stopRecording(req, res) {
    try {
      const { call_control_id } = req.body;
      await callService.stopRecording(req.telnyx, call_control_id);
      res.sendStatus(200);
    } catch (error) {
      console.error('Error stopping recording:', error);
      res.status(500).json({ error: 'Failed to stop recording' });
    }
  }
}

export const callController = new CallController(); 