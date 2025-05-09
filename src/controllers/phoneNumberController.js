import { phoneNumberService } from '../services/phoneNumberService.js';
import { config } from '../config/env.js';

class PhoneNumberController {
  async searchNumbers(req, res) {
    try {
      const { countryCode, type, features } = req.query;
      console.log(countryCode, type, features);
      const numbers = await phoneNumberService.searchAvailableNumbers({
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
        phoneNumber,
        config.telnyxConnectionId,
        config.telnyxMessagingProfileId,
        config.baseUrl
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
      const result = await phoneNumberService.deletePhoneNumber(req.params.id);
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