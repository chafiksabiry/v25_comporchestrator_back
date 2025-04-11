import { phoneNumberService } from '../services/phoneNumberService.js';

class PhoneNumberController {
  async searchNumbers(req, res) {
    try {
      const { countryCode, type, features } = req.query;
      const numbers = await phoneNumberService.searchAvailableNumbers(req.telnyx, {
        countryCode,
        type,
        features
      });
      res.json(numbers);
    } catch (error) {
      console.error('Error searching phone numbers:', error);
      res.status(500).json({ error: 'Failed to search phone numbers' });
    }
  }

  async purchaseNumber(req, res) {
    try {
      const { phoneNumber } = req.body;
      const newNumber = await phoneNumberService.purchaseNumber(
        req.telnyx,
        phoneNumber,
        process.env.TELNYX_CONNECTION_ID,
        process.env.TELNYX_MESSAGING_PROFILE_ID,
        process.env.BASE_URL
      );
      res.json(newNumber);
    } catch (error) {
      console.error('Error purchasing phone number:', error);
      res.status(500).json({ error: 'Failed to purchase phone number' });
    }
  }

  async getAllNumbers(req, res) {
    try {
      const numbers = await phoneNumberService.getAllPhoneNumbers();
      res.json(numbers);
    } catch (error) {
      console.error('Error fetching phone numbers:', error);
      res.status(500).json({ error: 'Failed to fetch phone numbers' });
    }
  }

  async deleteNumber(req, res) {
    try {
      const result = await phoneNumberService.deletePhoneNumber(req.telnyx, req.params.id);
      res.json(result);
    } catch (error) {
      console.error('Error deleting phone number:', error);
      if (error.message === 'Phone number not found') {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to delete phone number' });
      }
    }
  }
}

export const phoneNumberController = new PhoneNumberController(); 