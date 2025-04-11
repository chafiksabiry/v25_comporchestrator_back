import express from 'express';
import { PhoneNumber } from '../models/PhoneNumber.js';

const router = express.Router();

// Handle voice webhooks
router.post('/voice', async (req, res) => {
  try {
    const event = req.body;
    const { data } = event;

    switch (event.type) {
      case 'call.initiated':
        // Handle incoming call
        console.log('Incoming call from:', data.payload.from);
        
        // Answer the call
        await req.telnyx.calls.create({
          connection_id: process.env.TELNYX_CONNECTION_ID,
          to: data.payload.to,
          from: data.payload.from,
          answer_url: `${process.env.BASE_URL}/api/calls/answer`
        });
        break;

      case 'call.answered':
        console.log('Call answered:', data.payload.call_control_id);
        break;

      case 'call.hangup':
        console.log('Call ended:', data.payload.call_control_id);
        break;

      case 'call.recording.saved':
        console.log('Recording saved:', data.payload.recording_url);
        break;

      default:
        console.log('Unhandled event type:', event.type);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Update webhook URL for a phone number
router.put('/update-url/:phoneNumberId', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const phoneNumber = await PhoneNumber.findById(req.params.phoneNumberId);

    if (!phoneNumber) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    // Update webhook URL in Telnyx
    await req.telnyx.phoneNumbers.update(phoneNumber.telnyxId, {
      voice: {
        webhook_url: webhookUrl
      }
    });

    // Update in database
    phoneNumber.webhookUrl = webhookUrl;
    await phoneNumber.save();

    res.json(phoneNumber);
  } catch (error) {
    console.error('Error updating webhook URL:', error);
    res.status(500).json({ error: 'Failed to update webhook URL' });
  }
});

export const webhookRoutes = router;